package runtime

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/krillinai/Clawee/server/internal/collector/debugstore"
	"github.com/krillinai/Clawee/server/internal/collector/debugui"
)

func TestLocalOnlyRoutesRejectNonLoopbackClients(t *testing.T) {
	mux := testServeMux()
	tests := []struct {
		name   string
		method string
		path   string
	}{
		{name: "codex ingest", method: http.MethodPost, path: "/ingest/codex"},
		{name: "debug index", method: http.MethodGet, path: "/debug"},
		{name: "debug page", method: http.MethodGet, path: "/debug/collector"},
		{name: "debug api", method: http.MethodGet, path: "/debug/api/collector/state"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, remoteAddr := range []string{"192.0.2.10:43000", "collector.example:43000", "malformed"} {
				req := httptest.NewRequest(tt.method, tt.path, nil)
				req.RemoteAddr = remoteAddr
				resp := httptest.NewRecorder()

				mux.ServeHTTP(resp, req)

				if resp.Code != http.StatusForbidden {
					t.Fatalf("RemoteAddr %q status = %d, want 403", remoteAddr, resp.Code)
				}
			}
		})
	}
}

func TestLocalOnlyRoutesAllowLoopbackClients(t *testing.T) {
	mux := testServeMux()
	tests := []struct {
		name   string
		method string
		path   string
	}{
		{name: "codex ingest", method: http.MethodPost, path: "/ingest/codex"},
		{name: "debug index", method: http.MethodGet, path: "/debug"},
		{name: "debug page", method: http.MethodGet, path: "/debug/collector"},
		{name: "debug api", method: http.MethodGet, path: "/debug/api/collector/state"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, remoteAddr := range []string{"127.0.0.1:43000", "[::1]:43000"} {
				req := httptest.NewRequest(tt.method, tt.path, nil)
				req.RemoteAddr = remoteAddr
				resp := httptest.NewRecorder()

				mux.ServeHTTP(resp, req)

				if resp.Code == http.StatusForbidden {
					t.Fatalf("RemoteAddr %q status = 403, want route response", remoteAddr)
				}
			}
		})
	}
}

func TestHealthzIsPublicAndReturnsOnlyOK(t *testing.T) {
	mux := testServeMux()
	for _, tt := range []struct {
		name       string
		method     string
		remoteAddr string
		wantStatus int
		wantBody   string
	}{
		{name: "loopback GET", method: http.MethodGet, remoteAddr: "127.0.0.1:43000", wantStatus: http.StatusOK, wantBody: "ok"},
		{name: "public GET", method: http.MethodGet, remoteAddr: "192.0.2.10:43000", wantStatus: http.StatusOK, wantBody: "ok"},
		{name: "public POST", method: http.MethodPost, remoteAddr: "192.0.2.10:43000", wantStatus: http.StatusMethodNotAllowed},
	} {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, "/healthz", nil)
			req.RemoteAddr = tt.remoteAddr
			resp := httptest.NewRecorder()

			mux.ServeHTTP(resp, req)

			if resp.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", resp.Code, tt.wantStatus)
			}
			if tt.wantBody != "" && resp.Body.String() != tt.wantBody {
				t.Fatalf("body = %q, want %q", resp.Body.String(), tt.wantBody)
			}
			if tt.wantStatus == http.StatusMethodNotAllowed && resp.Header().Get("Allow") != http.MethodGet {
				t.Fatalf("allow = %q, want %q", resp.Header().Get("Allow"), http.MethodGet)
			}
		})
	}
}

func TestA2ARoutesAreAbsent(t *testing.T) {
	mux := testServeMux()
	for _, path := range []string{"/.well-known/agent-card.json", "/a2a"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = "192.0.2.10:43000"
		resp := httptest.NewRecorder()

		mux.ServeHTTP(resp, req)

		if resp.Code != http.StatusNotFound {
			t.Fatalf("path %q status = %d, want 404", path, resp.Code)
		}
	}
}

func TestMCPRouteIsOnlyMountedWhenEnabled(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/mcp", nil)

	disabledResponse := httptest.NewRecorder()
	testServeMux().ServeHTTP(disabledResponse, request)
	if disabledResponse.Code != http.StatusNotFound {
		t.Fatalf("disabled /mcp status = %d, want 404", disabledResponse.Code)
	}

	enabledResponse := httptest.NewRecorder()
	enabledHandler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	testServeMuxWithMCP(enabledHandler).ServeHTTP(enabledResponse, request)
	if enabledResponse.Code != http.StatusUnauthorized {
		t.Fatalf("enabled /mcp status = %d, want handler status 401", enabledResponse.Code)
	}
}

func testServeMux() http.Handler {
	return testServeMuxWithMCP(nil)
}

func testServeMuxWithMCP(mcpHandler http.Handler) http.Handler {
	codexHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	})
	store := debugstore.New(debugstore.Config{})
	return newServeMux(codexHandler, debugui.New(store), mcpHandler)
}
