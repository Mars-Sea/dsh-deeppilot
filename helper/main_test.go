package main

import (
	"net"
	"net/netip"
	"testing"
	"time"

	"tailscale.com/ipn"
)

type wrappedConn struct{ net.Conn }

func (c wrappedConn) NetConn() net.Conn { return c.Conn }

func TestSanitizeHostname(t *testing.T) {
	tests := map[string]string{
		"DeepPilot":      "deeppilot",
		" --my-phone-- ": "my-phone",
		"dsh-phone":      "dsh-deeppilot",
		"dsh-pocket":     "dsh-deeppilot",
		"Harness Pocket": "dsh-deeppilot",
		"中文":             "dsh-deeppilot",
	}
	for input, expected := range tests {
		if actual := sanitizeHostname(input); actual != expected {
			t.Fatalf("sanitizeHostname(%q) = %q, want %q", input, actual, expected)
		}
	}
}

func TestClientIP(t *testing.T) {
	if actual := clientIP("203.0.113.8:443"); actual != "203.0.113.8" {
		t.Fatalf("clientIP = %q", actual)
	}
	if actual := clientIP("[2001:db8::1]:443"); actual != "2001:db8::1" {
		t.Fatalf("IPv6 clientIP = %q", actual)
	}
}

func TestFunnelSourceUnwrapsIngressMetadata(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	conn := wrappedConn{Conn: &ipn.FunnelConn{
		Conn: left,
		Src:  netip.MustParseAddrPort("203.0.113.8:443"),
	}}
	if actual := funnelSource(conn); actual != "203.0.113.8" {
		t.Fatalf("funnelSource = %q", actual)
	}
}

func TestRequestGateLimitsActiveUpgradesAndFailures(t *testing.T) {
	gate := newRequestGate(8)
	now := time.Unix(1_000, 0)
	releases := make([]func(), 0, 4)
	for range 8 {
		release, _, ok := gate.admit("203.0.113.8", true, now)
		if !ok {
			t.Fatal("first eight active upgrades should be admitted")
		}
		releases = append(releases, release)
	}
	if _, _, ok := gate.admit("203.0.113.8", true, now); ok {
		t.Fatal("ninth active upgrade should be rejected")
	}
	releases[0]()
	if _, _, ok := gate.admit("203.0.113.8", true, now); !ok {
		t.Fatal("released slot should be reusable")
	}

	for range 5 {
		gate.recordFailure("198.51.100.4", now)
	}
	if _, _, ok := gate.admit("198.51.100.4", false, now); ok {
		t.Fatal("repeated failures should block the source")
	}
}

func TestRequestGateUsesConfiguredActiveLimit(t *testing.T) {
	gate := newRequestGate(3)
	now := time.Unix(2_000, 0)
	for range 3 {
		if _, _, ok := gate.admit("192.0.2.10", true, now); !ok {
			t.Fatal("configured active slot should be admitted")
		}
	}
	if _, _, ok := gate.admit("192.0.2.10", true, now); ok {
		t.Fatal("connection above configured active limit should be rejected")
	}
}
