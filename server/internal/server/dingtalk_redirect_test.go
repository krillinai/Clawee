package server

import "testing"

func TestDingTalkRedirectAllowlist(t *testing.T) {
	for _, test := range []struct {
		value string
		want  string
	}{
		{value: "", want: "/admin"},
		{value: "/app/agents", want: "/app/agents"},
		{value: "/admin/accounts", want: "/admin/accounts"},
		{value: "//evil.example", want: "/app"},
		{value: "/app/../../evil", want: "/app"},
		{value: "/app\\evil", want: "/app"},
		{value: "/app?next=//evil.example", want: "/app"},
	} {
		if got := normalizeOAuthRedirect(test.value); got != test.want {
			t.Fatalf("normalize redirect %q = %q, want %q", test.value, got, test.want)
		}
	}
}
