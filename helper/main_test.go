package main

import "testing"

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
