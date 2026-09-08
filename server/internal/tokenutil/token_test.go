package tokenutil

import (
	"regexp"
	"testing"
)

func TestGenerate32(t *testing.T) {
	pattern := regexp.MustCompile(`^(agt|col)_[A-Za-z0-9_-]{28}$`)
	seen := map[string]bool{}
	for _, prefix := range []string{"agt_", "col_"} {
		for range 32 {
			token, err := Generate32(prefix)
			if err != nil {
				t.Fatal(err)
			}
			if len(token) != 32 || !pattern.MatchString(token) {
				t.Fatalf("Generate32(%q) = %q", prefix, token)
			}
			if seen[token] {
				t.Fatalf("duplicate token generated: %q", token)
			}
			seen[token] = true
		}
	}
}

func TestGenerate32RejectsUnknownPrefix(t *testing.T) {
	if _, err := Generate32("reg_"); err == nil {
		t.Fatal("Generate32 accepted unsupported prefix")
	}
}
