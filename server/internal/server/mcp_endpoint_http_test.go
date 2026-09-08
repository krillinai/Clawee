package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMCPHandlerDisablesResponseBufferingAndCaching(t *testing.T) {
	handler := newMCPHandler(Options{}, "", "/mcp")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/mcp", nil))

	if got := recorder.Header().Get("Cache-Control"); got != "no-cache, no-transform" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := recorder.Header().Get("X-Accel-Buffering"); got != "no" {
		t.Fatalf("X-Accel-Buffering = %q", got)
	}
}
