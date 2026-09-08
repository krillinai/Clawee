package mcpgateway

import "testing"

func TestSessionKeySeparatesAgentUserTenantServerAndToken(t *testing.T) {
	base := NewSessionKey(SessionKeyInput{
		InboundSessionID: "in_1",
		AgentID:          "agent_a",
		ActorID:          "user_a",
		TenantID:         "tenant_a",
		UpstreamServerID: "crm-main",
		BearerToken:      "token_a",
	})
	same := NewSessionKey(SessionKeyInput{
		InboundSessionID: "in_1",
		AgentID:          "agent_a",
		ActorID:          "user_a",
		TenantID:         "tenant_a",
		UpstreamServerID: "crm-main",
		BearerToken:      "token_a",
	})
	otherToken := NewSessionKey(SessionKeyInput{
		InboundSessionID: "in_1",
		AgentID:          "agent_a",
		ActorID:          "user_a",
		TenantID:         "tenant_a",
		UpstreamServerID: "crm-main",
		BearerToken:      "token_b",
	})

	if base != same {
		t.Fatalf("same key mismatch: %q != %q", base, same)
	}
	if base == otherToken {
		t.Fatal("different delegated tokens produced the same session key")
	}
	if base.TokenHash == "token_a" {
		t.Fatal("session key must hash delegated token instead of storing plaintext")
	}
}

func TestHashTokenReturnsSHA256HexAndKeepsEmptyTokenEmpty(t *testing.T) {
	if got := HashToken(""); got != "" {
		t.Fatalf("empty token hash = %q, want empty", got)
	}
	got := HashToken("token_a")
	want := "e7e0ac4358145a17fe33582f906e237bab13f388fcbc564de60b757fb6371f6a"
	if got != want {
		t.Fatalf("token hash = %q, want %q", got, want)
	}
}
