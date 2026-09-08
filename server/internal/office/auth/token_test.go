package auth

import "testing"

func TestBearerToken(t *testing.T) {
	got, ok := BearerToken("Bearer collector_test_token")
	if !ok {
		t.Fatal("expected bearer token")
	}
	if got != "collector_test_token" {
		t.Fatalf("token = %q", got)
	}
}

func TestBearerTokenRejectsMalformedHeader(t *testing.T) {
	for _, header := range []string{"", "collector_test_token", "Basic abc", "Bearer ", "Bearer a b"} {
		if token, ok := BearerToken(header); ok {
			t.Fatalf("expected %q to be rejected, got token %q", header, token)
		}
	}
}

func TestHashAndCompareToken(t *testing.T) {
	hash := HashToken("collector_test_token")
	if hash == "" {
		t.Fatal("hash is empty")
	}
	if !CompareToken(hash, "collector_test_token") {
		t.Fatal("expected token to match hash")
	}
	if CompareToken(hash, "wrong_token") {
		t.Fatal("wrong token matched hash")
	}
}

func TestGenerateTokenUsesPrefixAndRandomHex(t *testing.T) {
	token, err := GenerateToken("collector_", 16)
	if err != nil {
		t.Fatal(err)
	}
	if len(token) != len("collector_")+32 {
		t.Fatalf("len(token) = %d, token = %q", len(token), token)
	}
	if token[:len("collector_")] != "collector_" {
		t.Fatalf("token prefix = %q", token)
	}

	other, err := GenerateToken("collector_", 16)
	if err != nil {
		t.Fatal(err)
	}
	if other == token {
		t.Fatalf("two generated tokens matched: %q", token)
	}
}

func TestGenerateTokenRejectsInvalidSize(t *testing.T) {
	if token, err := GenerateToken("collector_", 0); err == nil {
		t.Fatalf("expected error, got token %q", token)
	}
}
