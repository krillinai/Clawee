package provider

import (
	"errors"
	"testing"
)

func TestProviderErrorDoesNotExposeCause(t *testing.T) {
	cause := errors.New("secret upstream response")
	err := &ProviderError{Code: ErrorUnauthorized, Cause: cause}
	if got := err.Error(); got != ErrorUnauthorized {
		t.Fatalf("Error() = %q, want %q", got, ErrorUnauthorized)
	}
	if !errors.Is(err, cause) {
		t.Fatal("ProviderError should unwrap its cause for server diagnostics")
	}
}

func TestSearchResultUsesNonNilEmptyChunks(t *testing.T) {
	result := EmptySearchResult()
	if result.Chunks == nil || len(result.Chunks) != 0 {
		t.Fatalf("chunks = %#v, want non-nil empty slice", result.Chunks)
	}
}
