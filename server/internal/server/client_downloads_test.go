package server_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/clientdownloads"
	"github.com/krillinai/Clawee/server/internal/settings"
	"github.com/krillinai/Clawee/server/internal/server"
)

const catalogJSON = `{"schemaVersion":1,"product":"Clawee","version":"0.2.0","artifacts":[{"component":"desktop","platform":"macos","arch":"arm64","format":"dmg","downloadUrl":"https://cdn.example.com/a.dmg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"desktop":{"macosSigning":"developer-id-notarized","windowsSigning":"unsigned"}}`

func TestPublicClientDownloadsUsesCatalog(t *testing.T) {
	service := clientDownloadsService(catalogJSON)
	router := server.NewRouter(server.Options{ClientDownloadsService: service})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/public/client-downloads", nil)
	request.Host = "gateway.example.com"
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "https://cdn.example.com/a.dmg") || strings.Contains(recorder.Body.String(), "standard") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestClientDownloadsAdminRequiresPermissionAndUpdates(t *testing.T) {
	service := clientDownloadsService(catalogJSON)
	router := newTestRouter(t, server.Options{ClientDownloadsService: service})
	get := doRequest(t, router, http.MethodGet, "/api/v1/admin/client-downloads", nil, "", nil, http.StatusOK)
	if !strings.Contains(get.Body.String(), clientdownloads.DefaultCatalogURL) { t.Fatalf("default config=%s", get.Body.String()) }
	body := bytes.NewBufferString(`{"gateway_url":"https://gateway.example.com","catalog_url":"https://cdn.example.com/latest.json","version":0}`)
	doRequest(t, router, http.MethodPut, "/api/v1/admin/client-downloads", body, "application/json", nil, http.StatusOK)
}

func TestClientDownloadsWithoutServiceIsUnavailable(t *testing.T) {
	router := server.NewRouter(server.Options{})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/public/client-downloads", nil))
	if recorder.Code != http.StatusServiceUnavailable { t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String()) }
}

func clientDownloadsService(body string) *clientdownloads.Service {
	client := &http.Client{Transport: catalogRoundTripper{body: body}}
	service := clientdownloads.NewServiceWithHTTPClient(settings.NewMemoryStore(), client, time.Minute)
	_, _ = service.Update(context.Background(), clientdownloads.Config{GatewayURL: "https://gateway.example.com", CatalogURL: clientdownloads.DefaultCatalogURL}, "test", 0)
	return service
}

type catalogRoundTripper struct{ body string }
func (t catalogRoundTripper) RoundTrip(*http.Request) (*http.Response, error) { return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(t.body)), Header: make(http.Header)}, nil }
