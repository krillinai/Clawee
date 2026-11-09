package clientdownloads

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/settings"
)

func updateCatalogFixture(t *testing.T) (*Service, map[string]string) {
	t.Helper()
	digest := base64.StdEncoding.EncodeToString(make([]byte, 64))
	metadata := `{"version":"1.0.6","files":[{"url":"https://cdn.example.com/releases/v1.0.6/Clawee.zip","sha512":"` + digest + `","size":123}]}`
	checksum := sha256.Sum256([]byte(metadata))
	doc := catalogDocument{Product: "Clawee", Version: "1.0.6", Artifacts: []catalogArtifact{
		{Component: "desktop", Platform: "macos", Arch: "arm64", Format: "zip", DownloadURL: "https://cdn.example.com/releases/v1.0.6/Clawee.zip", Bytes: 123},
		{Component: "desktop", Platform: "macos", Arch: "arm64", Format: "yml", DownloadURL: "https://cdn.example.com/releases/v1.0.6/latest-arm64-mac.yml", SHA256: hex.EncodeToString(checksum[:])},
	}}
	doc.Desktop.MacosSigning = "developer-id-notarized"
	doc.Desktop.WindowsSigning = "unsigned"
	release, _ := json.Marshal(doc)
	responses := map[string]string{
		"/catalog/stable/versions.json":         `{"product":"Clawee","channel":"stable","versions":[{"version":"1.0.6","releaseUrl":"https://cdn.example.com/releases/v1.0.6/release.json"}]}`,
		"/releases/v1.0.6/release.json":         string(release),
		"/releases/v1.0.6/latest-arm64-mac.yml": metadata,
	}
	service := NewServiceWithHTTPClient(settings.NewMemoryStore(), &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		body, found := responses[request.URL.Path]
		if !found {
			return nil, errors.New("unexpected request: " + request.URL.String())
		}
		if request.Header.Get("Authorization") != "" {
			t.Error("credentials leaked to CDN")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}, time.Minute)
	if _, err := service.Update(context.Background(), Config{GatewayURL: "https://customer.example.com", CatalogURL: "https://cdn.example.com/catalog/stable/latest.json"}, "admin", 0); err != nil {
		t.Fatal(err)
	}
	return service, responses
}

func TestVersionPolicyEnableDisableAndReenableSameVersion(t *testing.T) {
	service, responses := updateCatalogFixture(t)
	ctx := context.Background()
	versions, err := service.UpdateVersions(ctx)
	if err != nil || len(versions) != 1 || versions[0].Version != "1.0.6" {
		t.Fatalf("versions=%+v %v", versions, err)
	}
	candidate, err := service.ResolveUpdateVersion(ctx, "1.0.6")
	if err != nil || len(candidate.Packages) != 1 || len(candidate.UnavailablePlatforms) != 2 {
		t.Fatalf("candidate=%+v %v", candidate, err)
	}
	first, err := service.PublishVersionPolicy(ctx, true, "1.0.6", "自动更新", "https://customer.example.com", "admin", 0)
	if err != nil || !first.Enabled || first.Revision != 1 {
		t.Fatalf("publish=%+v %v", first, err)
	}
	responses["/releases/v1.0.6/latest-arm64-mac.yml"] = "corrupted after approval"
	disabled, err := service.PublishVersionPolicy(ctx, false, "", "", "https://customer.example.com", "admin", 1)
	if err != nil || disabled.Enabled || disabled.Revision != 2 {
		t.Fatalf("disable=%+v %v", disabled, err)
	}
	public, err := service.PublicUpdate(ctx)
	if err != nil || public.Update != nil {
		t.Fatalf("disabled still public: %+v %v", public, err)
	}
	third, err := service.PublishVersionPolicy(ctx, true, "1.0.6", "重新启用", "https://customer.example.com", "admin", 2)
	if err != nil || !third.Enabled || third.Revision != 3 || third.Update.Packages[0] != first.Update.Packages[0] {
		t.Fatalf("reenable=%+v %v", third, err)
	}
	if _, err := service.PublishVersionPolicy(ctx, false, "", "", "https://customer.example.com", "admin", 2); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale revision accepted: %v", err)
	}
}

func TestVersionPolicyRejectsUnknownVersionAndTamperedMetadata(t *testing.T) {
	service, responses := updateCatalogFixture(t)
	ctx := context.Background()
	for _, version := range []string{"v1.0.6", "1.0.7", "1.0.6-beta.1"} {
		if _, err := service.ResolveUpdateVersion(ctx, version); !errors.Is(err, ErrInvalidUpdate) {
			t.Fatalf("accepted %s: %v", version, err)
		}
	}
	responses["/releases/v1.0.6/latest-arm64-mac.yml"] += "\n"
	if _, err := service.PublishVersionPolicy(ctx, true, "1.0.6", "", "https://customer.example.com", "admin", 0); !errors.Is(err, ErrInvalidUpdate) {
		t.Fatalf("tampered metadata accepted: %v", err)
	}
	current, _ := service.GetUpdate(ctx)
	if current.Update != nil {
		t.Fatal("invalid publication changed snapshot")
	}
	responses["/catalog/stable/versions.json"] = `{"product":"Clawee","channel":"stable","versions":[{"version":"1.0.6","releaseUrl":"https://other.example.com/releases/v1.0.6/release.json"}]}`
	if _, err := service.UpdateVersions(ctx); !errors.Is(err, ErrInvalidUpdate) {
		t.Fatalf("foreign release accepted: %v", err)
	}
}

func TestVersionPolicyAllowsUnsignedWindowsUpdate(t *testing.T) {
	service, responses := updateCatalogFixture(t)
	var document catalogDocument
	if err := json.Unmarshal([]byte(responses["/releases/v1.0.6/release.json"]), &document); err != nil {
		t.Fatal(err)
	}
	digest := base64.StdEncoding.EncodeToString(make([]byte, 64))
	metadata := `{"version":"1.0.6","files":[{"url":"https://cdn.example.com/releases/v1.0.6/Clawee.exe","sha512":"` + digest + `","size":123}]}`
	checksum := sha256.Sum256([]byte(metadata))
	document.Artifacts = append(document.Artifacts,
		catalogArtifact{Component: "desktop", Platform: "windows", Arch: "x64", Format: "exe", DownloadURL: "https://cdn.example.com/releases/v1.0.6/Clawee.exe", Bytes: 123},
		catalogArtifact{Component: "desktop", Platform: "windows", Arch: "x64", Format: "yml", DownloadURL: "https://cdn.example.com/releases/v1.0.6/latest.yml", SHA256: hex.EncodeToString(checksum[:])},
	)
	release, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	responses["/releases/v1.0.6/release.json"] = string(release)
	responses["/releases/v1.0.6/latest.yml"] = metadata
	ctx := context.Background()
	candidate, err := service.ResolveUpdateVersion(ctx, "1.0.6")
	if err != nil || len(candidate.Packages) != 2 || len(candidate.UnavailablePlatforms) != 1 || candidate.Packages[1].Platform != "windows" {
		t.Fatalf("candidate=%+v %v", candidate, err)
	}
	published, err := service.PublishVersionPolicy(ctx, true, "1.0.6", "Windows 更新", "https://customer.example.com", "admin", 0)
	if err != nil || !published.Enabled || len(published.Update.Packages) != 2 {
		t.Fatalf("publish=%+v %v", published, err)
	}
	responses["/releases/v1.0.6/latest.yml"] += "\n"
	if _, err := service.ResolveUpdateVersion(ctx, "1.0.6"); !errors.Is(err, ErrInvalidUpdate) {
		t.Fatalf("tampered Windows metadata accepted: %v", err)
	}
	document.Desktop.MacosSigning = "unsigned"
	release, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	responses["/releases/v1.0.6/release.json"] = string(release)
	responses["/releases/v1.0.6/latest.yml"] = metadata
	candidate, err = service.ResolveUpdateVersion(ctx, "1.0.6")
	if err != nil || len(candidate.Packages) != 1 || candidate.Packages[0].Platform != "windows" || len(candidate.UnavailablePlatforms) != 2 {
		t.Fatalf("unsigned macOS accepted: candidate=%+v %v", candidate, err)
	}
}
