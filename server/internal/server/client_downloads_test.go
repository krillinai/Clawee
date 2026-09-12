package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/config"
	"github.com/krillinai/Clawee/server/internal/server"
)

func TestPublicClientDownloads(t *testing.T) {
	for _, configured := range []bool{false, true} {
		downloads := config.ClientDownloadsConfig{}
		if configured {
			downloads.Gateway = "https://gateway.example.com/"
			for _, pair := range [][2]string{{"macos", "arm64"}, {"macos", "x64"}, {"windows", "x64"}} {
				downloads.Packages = append(downloads.Packages, config.ClientDownload{Platform: pair[0], Arch: pair[1], URL: "https://downloads.example.com/client", Version: "0.1.7", SHA256: strings.Repeat("a", 64), Signature: "unsigned"})
			}
		}
		router := server.NewRouter(server.Options{ClientDownloads: downloads, BilibiliWebhookSecret: "private-sentinel"})
		request := httptest.NewRequest(http.MethodGet, "/api/v1/public/client-downloads", nil)
		request.Host = "attacker.example"
		request.Header.Set("X-Forwarded-Host", "attacker.example")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status %d: %s", recorder.Code, recorder.Body.String())
		}
		var response config.ClientDownloadsConfig
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if response.Standard.URL != config.StandardClientDownloadURL || response.Packages == nil {
			t.Fatalf("invalid fallback %+v", response)
		}
		if configured && (response.Gateway != "https://gateway.example.com" || len(response.Packages) != 3) {
			t.Fatalf("invalid packages %+v", response)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(recorder.Body.Bytes(), &fields); err != nil {
			t.Fatal(err)
		}
		if len(fields) != 3 || strings.Contains(recorder.Body.String(), "private-sentinel") || strings.Contains(recorder.Body.String(), "attacker.example") {
			t.Fatal("unexpected public fields")
		}
	}
}

func TestDownloadsStaticRouteIsAnonymous(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>downloads-app</html>"), 0600); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{StaticDir: dir})
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(method, "/downloads", nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s /downloads: %d", method, recorder.Code)
		}
	}
	for _, path := range []string{"/downloads/private", "/api/v1/public/unknown"} {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: %d", path, recorder.Code)
		}
	}
}
