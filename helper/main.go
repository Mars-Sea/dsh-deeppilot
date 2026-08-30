// Package main implements the dsh-deeppilot embedded tunnel helper. It owns
// one tsnet node per invocation and exposes a tiny JSON-line protocol on
// stdout for the host process to consume.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

type event struct {
	Phase     string `json:"phase"`
	PublicURL string `json:"publicURL,omitempty"`
	AuthURL   string `json:"authURL,omitempty"`
	Message   string `json:"message,omitempty"`
}

var (
	emitMu  sync.Mutex
	urlExpr = regexp.MustCompile(`https://[^\s]+`)
)

const clientIPHeader = "X-DeepPilot-Client-IP"

type requestState struct {
	requests     []time.Time
	failures     []time.Time
	blockedUntil time.Time
	active       int
	lastSeen     time.Time
}

type requestGate struct {
	mu        sync.Mutex
	clients   map[string]*requestState
	global    []time.Time
	maxState  int
	maxActive int
}

func newRequestGate(maxActive int) *requestGate {
	return &requestGate{clients: make(map[string]*requestState), maxState: 4096, maxActive: maxActive}
}

func (g *requestGate) admit(source string, upgraded bool, now time.Time) (func(), time.Duration, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	state := g.state(source, now)
	if state == nil {
		return func() {}, time.Minute, false
	}
	g.prune(state, now)
	state.lastSeen = now
	if state.blockedUntil.After(now) {
		return func() {}, state.blockedUntil.Sub(now), false
	}
	if upgraded && state.active >= g.maxActive {
		return func() {}, time.Minute, false
	}
	if len(state.requests) >= 60 {
		return func() {}, state.requests[0].Add(time.Minute).Sub(now), false
	}
	g.global = recent(g.global, now.Add(-time.Minute))
	if len(g.global) >= 600 {
		return func() {}, g.global[0].Add(time.Minute).Sub(now), false
	}
	state.requests = append(state.requests, now)
	g.global = append(g.global, now)
	if upgraded {
		state.active++
	}
	released := false
	return func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		if released {
			return
		}
		released = true
		if upgraded && state.active > 0 {
			state.active--
		}
	}, 0, true
}

func (g *requestGate) recordFailure(source string, now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	state := g.state(source, now)
	if state == nil {
		return
	}
	g.prune(state, now)
	state.failures = append(state.failures, now)
	state.lastSeen = now
	if len(state.failures) >= 5 {
		state.blockedUntil = now.Add(15 * time.Minute)
	}
}

func (g *requestGate) state(source string, now time.Time) *requestState {
	if state := g.clients[source]; state != nil {
		return state
	}
	if len(g.clients) >= g.maxState {
		staleBefore := now.Add(-15 * time.Minute)
		for key, state := range g.clients {
			g.prune(state, now)
			if state.active == 0 && !state.blockedUntil.After(now) && state.lastSeen.Before(staleBefore) {
				delete(g.clients, key)
			}
		}
	}
	if len(g.clients) >= g.maxState {
		return nil
	}
	state := &requestState{lastSeen: now}
	g.clients[source] = state
	return state
}

func (g *requestGate) prune(state *requestState, now time.Time) {
	state.requests = recent(state.requests, now.Add(-time.Minute))
	state.failures = recent(state.failures, now.Add(-10*time.Minute))
	if !state.blockedUntil.After(now) {
		state.blockedUntil = time.Time{}
	}
}

func recent(values []time.Time, cutoff time.Time) []time.Time {
	first := 0
	for first < len(values) && !values[first].After(cutoff) {
		first++
	}
	return values[first:]
}

func clientIP(remoteAddress string) string {
	host, _, err := net.SplitHostPort(remoteAddress)
	if err != nil {
		host = remoteAddress
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip == nil {
		return "unknown"
	}
	return ip.String()
}

type sourceContextKey struct{}

func funnelSource(conn net.Conn) string {
	for conn != nil {
		if funneled, ok := conn.(*ipn.FunnelConn); ok && funneled.Src.Addr().IsValid() {
			return funneled.Src.Addr().String()
		}
		wrapped, ok := conn.(interface{ NetConn() net.Conn })
		if !ok || wrapped.NetConn() == conn {
			break
		}
		conn = wrapped.NetConn()
	}
	return ""
}

func requestSource(r *http.Request) string {
	if source, ok := r.Context().Value(sourceContextKey{}).(string); ok && source != "" {
		return source
	}
	return clientIP(r.RemoteAddr)
}

func emit(value event) {
	emitMu.Lock()
	defer emitMu.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(value)
}

func main() {
	originFlag := flag.String("origin", "", "loopback HTTP origin")
	hostnameFlag := flag.String("hostname", "dsh-deeppilot", "tailnet node hostname")
	stateDirFlag := flag.String("state-dir", "", "persistent tsnet state directory")
	portFlag := flag.Int("port", 443, "Funnel port (443, 8443, or 10000)")
	maxConnectionsFlag := flag.Int("max-connections-per-source", 8, "maximum concurrent Funnel connections per public source (1-16)")
	flag.Parse()

	origin, err := url.Parse(*originFlag)
	if err != nil || origin.Scheme != "http" || (origin.Hostname() != "127.0.0.1" && origin.Hostname() != "localhost") {
		fail("origin must be an http://127.0.0.1 URL")
	}
	if *stateDirFlag == "" {
		fail("state-dir is required")
	}
	if *portFlag != 443 && *portFlag != 8443 && *portFlag != 10000 {
		fail("port must be 443, 8443, or 10000")
	}
	if *maxConnectionsFlag < 1 || *maxConnectionsFlag > 16 {
		fail("max-connections-per-source must be between 1 and 16")
	}
	if err := os.MkdirAll(filepath.Clean(*stateDirFlag), 0o700); err != nil {
		fail("cannot create state directory: " + err.Error())
	}
	if err := os.Chmod(filepath.Clean(*stateDirFlag), 0o700); err != nil {
		fail("cannot secure state directory: " + err.Error())
	}

	emit(event{Phase: "starting"})
	srv := &tsnet.Server{
		Dir:      filepath.Clean(*stateDirFlag),
		Hostname: sanitizeHostname(*hostnameFlag),
		UserLogf: func(format string, args ...any) {
			message := fmt.Sprintf(format, args...)
			if authURL := urlExpr.FindString(message); authURL != "" {
				emit(event{Phase: "login_required", AuthURL: strings.TrimRight(authURL, ".")})
			}
		},
	}
	defer srv.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		emit(event{Phase: "stopped"})
		closed := make(chan struct{})
		go func() {
			_ = srv.Close()
			close(closed)
		}()
		select {
		case <-closed:
		case <-time.After(time.Second):
		}
		// tsnet.Up uses an internal background context while waiting for the
		// first browser login and may not return after Close. The helper owns no
		// state outside its configured directory, so a bounded process exit is
		// the deterministic shutdown boundary expected by the Node supervisor.
		os.Exit(0)
	}()

	if err := ensureFunnelAccess(ctx, srv, uint16(*portFlag)); err != nil {
		if ctx.Err() != nil {
			emit(event{Phase: "stopped"})
			return
		}
		fail("Funnel setup failed: " + err.Error())
	}

	listener, err := srv.ListenFunnel("tcp", fmt.Sprintf(":%d", *portFlag), tsnet.FunnelOnly())
	if err != nil {
		if ctx.Err() != nil {
			emit(event{Phase: "stopped"})
			return
		}
		fail("Funnel listener failed: " + err.Error())
	}
	defer listener.Close()

	publicURL := ""
	if localClient, clientErr := srv.LocalClient(); clientErr == nil {
		statusCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		status, statusErr := localClient.StatusWithoutPeers(statusCtx)
		cancel()
		if statusErr == nil && status.Self != nil {
			fqdn := strings.TrimSuffix(status.Self.DNSName, ".")
			if fqdn != "" {
				publicURL = fmt.Sprintf("https://%s", fqdn)
				if *portFlag != 443 {
					publicURL = fmt.Sprintf("%s:%d", publicURL, *portFlag)
				}
			}
		}
	}
	emit(event{Phase: "online", PublicURL: publicURL})

	proxy := httputil.NewSingleHostReverseProxy(origin)
	gate := newRequestGate(*maxConnectionsFlag)
	proxy.ModifyResponse = func(response *http.Response) error {
		if response.StatusCode == http.StatusUnauthorized {
			if source, ok := response.Request.Context().Value(sourceContextKey{}).(string); ok {
				gate.recordFailure(source, time.Now())
			}
		}
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		http.Error(w, "DeepPilot bridge unavailable", http.StatusBadGateway)
		fmt.Fprintln(os.Stderr, "origin proxy error:", proxyErr)
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/phone" && r.URL.Path != "/phone/health" && r.URL.Path != "/phone/pair" {
			http.NotFound(w, r)
			return
		}
		source := requestSource(r)
		upgraded := r.URL.Path == "/phone"
		release, retryAfter, ok := gate.admit(source, upgraded, time.Now())
		if !ok {
			seconds := int(retryAfter.Round(time.Second) / time.Second)
			if seconds < 1 {
				seconds = 1
			}
			w.Header().Set("Retry-After", fmt.Sprintf("%d", seconds))
			http.Error(w, "authentication rate limited", http.StatusTooManyRequests)
			return
		}
		defer release()
		// Never forward a caller-supplied identity. Node trusts this header only
		// over the helper's loopback connection.
		r.Header.Del(clientIPHeader)
		r.Header.Set(clientIPHeader, source)
		r = r.WithContext(context.WithValue(r.Context(), sourceContextKey{}, source))
		proxy.ServeHTTP(w, r)
	})
	httpServer := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
		ConnContext: func(ctx context.Context, conn net.Conn) context.Context {
			if source := funnelSource(conn); source != "" {
				return context.WithValue(ctx, sourceContextKey{}, source)
			}
			return ctx
		},
	}
	if err := httpServer.Serve(listener); err != nil && err != http.ErrServerClosed && ctx.Err() == nil {
		fail("Funnel server failed: " + err.Error())
	}
	emit(event{Phase: "stopped"})
}

// ensureFunnelAccess follows the same control-plane feature flow used by the
// official `tailscale funnel` CLI. It never asks for or stores a management API
// key: the logged-in node receives a Tailscale-hosted consent URL, and its
// capabilities update after an authorized tailnet administrator approves it.
func ensureFunnelAccess(ctx context.Context, srv *tsnet.Server, port uint16) error {
	status, err := srv.Up(ctx)
	if err != nil {
		return err
	}
	if status.Self == nil {
		return fmt.Errorf("Tailscale node status is unavailable")
	}
	if err := ipn.CheckFunnelAccess(port, status.Self); err == nil {
		return nil
	}

	localClient, err := srv.LocalClient()
	if err != nil {
		return err
	}
	info, err := localClient.QueryFeature(ctx, "funnel")
	if err != nil {
		return err
	}
	if !info.Complete {
		message := strings.TrimSpace(info.Text)
		if message == "" {
			message = "请在 Tailscale 官方页面授权 HTTPS 与 Funnel"
		}
		emit(event{Phase: "login_required", AuthURL: info.URL, Message: message})
		if info.URL == "" {
			return fmt.Errorf("%s", message)
		}
	}

	// Capability propagation is asynchronous. Keep the helper alive so the
	// settings page can be opened at any time, then continue automatically once
	// both HTTPS and Funnel permissions reach this embedded node.
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		statusCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		status, statusErr := localClient.StatusWithoutPeers(statusCtx)
		cancel()
		if statusErr == nil && status.Self != nil {
			if accessErr := ipn.CheckFunnelAccess(port, status.Self); accessErr == nil {
				return nil
			}
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func sanitizeHostname(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		}
	}
	result := strings.Trim(b.String(), "-")
	if result == "" || result == "dsh-phone" || result == "dsh-pocket" || result == "harnesspocket" {
		return "dsh-deeppilot"
	}
	if len(result) > 63 {
		return strings.TrimRight(result[:63], "-")
	}
	return result
}

func fail(message string) {
	emit(event{Phase: "error", Message: message})
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
