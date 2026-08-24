package main

import "testing"

func TestSanitizeHostname(t *testing.T) {
	tests := map[string]string{
		"Harness Pocket": "harnesspocket",
		" --my-phone-- ": "my-phone",
		"dsh-phone":      "dsh-pocket",
		"中文":             "dsh-pocket",
	}
	for input, expected := range tests {
		if actual := sanitizeHostname(input); actual != expected {
			t.Fatalf("sanitizeHostname(%q) = %q, want %q", input, actual, expected)
		}
	}
}
