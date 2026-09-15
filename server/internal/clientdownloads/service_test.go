package clientdownloads

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/settings"
)

func TestValidateURLs(t *testing.T) {
	valid := Config{GatewayURL: "https://gateway.example.com", CatalogURL: DefaultCatalogURL}
	if err := Validate(valid); err != nil {
		t.Fatal(err)
	}
	for _, cfg := range []Config{
		{GatewayURL: "https://gateway.example.com/api", CatalogURL: valid.CatalogURL},
		{GatewayURL: "http://gateway.example.com", CatalogURL: valid.CatalogURL},
		{GatewayURL: valid.GatewayURL, CatalogURL: "https://user:secret@example.com/latest.json"},
		{GatewayURL: valid.GatewayURL, CatalogURL: "https://example.com/latest.json?x=1"},
	} {
		if err := Validate(cfg); err == nil {
			t.Fatalf("expected invalid config: %#v", cfg)
		}
	}
}

func TestPublicParsesDesktopArtifactsAndCaches(t *testing.T) {
	body := `{"schemaVersion":1,"product":"Clawee","version":"0.2.0","artifacts":[` +
		`{"component":"desktop","platform":"macos","arch":"arm64","format":"dmg","downloadUrl":"https://cdn.example.com/a.dmg","sha256":"` + strings.Repeat("a", 64) + `"},` +
		`{"component":"desktop","platform":"macos","arch":"x64","format":"dmg","downloadUrl":"https://cdn.example.com/b.dmg","sha256":"` + strings.Repeat("b", 64) + `"},` +
		`{"component":"desktop","platform":"windows","arch":"x64","format":"exe","downloadUrl":"https://cdn.example.com/c.exe","sha256":"` + strings.Repeat("c", 64) + `"}],"desktop":{"macosSigning":"developer-id-notarized","windowsSigning":"unsigned"}}`
	var calls int
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	service := NewServiceWithHTTPClient(settings.NewMemoryStore(), client, time.Minute)
	if _, err := service.Update(context.Background(), Config{GatewayURL: "https://gateway.example.com", CatalogURL: DefaultCatalogURL}, "admin", 0); err != nil {
		t.Fatal(err)
	}
	result, err := service.Public(context.Background(), "https://fallback.example.com")
	if err != nil || len(result.Packages) != 3 {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	if result.Packages[0].Signature != "signed_notarized" || result.Packages[2].Signature != "unsigned" {
		t.Fatalf("signatures=%#v", result.Packages)
	}
	if _, err := service.Public(context.Background(), "https://fallback.example.com"); err != nil || calls != 1 {
		t.Fatalf("cache calls=%d err=%v", calls, err)
	}
}

func TestPublicParsesCustomerDesktopDeliveryFiles(t *testing.T) {
	body := `{"schemaVersion":1,"product":"Clawee","kind":"customer-desktop-delivery","version":"0.1.7","files":[` +
		`{"name":"macos/arm64/Clawee-0.1.7-arm64.dmg","downloadUrl":"https://cdn.example.com/a.dmg","sha256":"` + strings.Repeat("a", 64) + `"},` +
		`{"name":"macos/x64/Clawee-0.1.7.dmg","downloadUrl":"https://cdn.example.com/b.dmg","sha256":"` + strings.Repeat("b", 64) + `"},` +
		`{"name":"windows/x64/Clawee-Setup-0.1.7.exe","downloadUrl":"https://cdn.example.com/c.exe","sha256":"` + strings.Repeat("c", 64) + `"},` +
		`{"name":"customer-delivery.json","downloadUrl":"https://cdn.example.com/meta.json","sha256":"` + strings.Repeat("d", 64) + `"}]}`
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	service := NewServiceWithHTTPClient(settings.NewMemoryStore(), client, time.Minute)
	if _, err := service.Update(context.Background(), Config{GatewayURL: "https://gateway.example.com", CatalogURL: DefaultCatalogURL}, "admin", 0); err != nil {
		t.Fatal(err)
	}
	result, err := service.Public(context.Background(), "")
	if err != nil || len(result.Packages) != 3 {
		t.Fatalf("result=%#v err=%v", result, err)
	}
}

func TestPublicRejectsInvalidJSON(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}")), Header: make(http.Header)}, nil
	})}
	service := NewServiceWithHTTPClient(settings.NewMemoryStore(), client, time.Minute)
	if _, err := service.Update(context.Background(), Config{GatewayURL: "https://gateway.example.com", CatalogURL: DefaultCatalogURL}, "admin", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Public(context.Background(), ""); err == nil {
		t.Fatal("expected invalid catalog error")
	}
}

func TestParseCatalogRejectsUnknownDesktopPlatformAndSigning(t *testing.T) {
	base := catalogDocument{Product: "Clawee", Version: "0.2.0", Artifacts: []catalogArtifact{{Component: "desktop", Platform: "linux", Arch: "x64", Format: "dmg", DownloadURL: "https://cdn.example.com/a", SHA256: strings.Repeat("a", 64)}}}
	if _, _, err := parseCatalog(base); err == nil {
		t.Fatal("expected unknown platform error")
	}
	base = catalogDocument{Product: "Clawee", Version: "0.2.0", Artifacts: []catalogArtifact{{Component: "desktop", Platform: "macos", Arch: "arm64", Format: "dmg", DownloadURL: "https://cdn.example.com/a", SHA256: strings.Repeat("a", 64)}}}
	base.Desktop.MacosSigning = "unverified"
	if _, _, err := parseCatalog(base); err == nil {
		t.Fatal("expected unknown signing error")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
