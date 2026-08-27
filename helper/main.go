// Package main implements the dsh-deeppilot embedded tunnel helper. It owns
// one tsnet node per invocation and exposes a tiny JSON-line protocol on
// stdout for the host process to consume.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
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
	if err := os.MkdirAll(filepath.Clean(*stateDirFlag), 0o700); err != nil {
		fail("cannot create state directory: " + err.Error())
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
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		http.Error(w, "DeepPilot bridge unavailable", http.StatusBadGateway)
		fmt.Fprintln(os.Stderr, "origin proxy error:", proxyErr)
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/phone" && r.URL.Path != "/phone/health" {
			http.NotFound(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	})
	httpServer := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
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
