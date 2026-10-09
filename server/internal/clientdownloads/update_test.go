package clientdownloads

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/settings"
)

func customerManifest() CustomerUpdateManifest {
	return CustomerUpdateManifest{Kind: "customer-desktop-update", GatewayURL: "https://customer.example.com", Version: "1.2.3", Notes: "更新说明\nversion: false", Packages: []CustomerUpdatePackage{{Platform: "macos", Arch: "arm64", URL: "https://cdn.example.com/customer/1.2.3/Clawee.zip", SHA512: base64.StdEncoding.EncodeToString(make([]byte, 64)), Size: 123}}}
}

func TestCustomerUpdateInvalidInputDoesNotPublish(t *testing.T) {
	cases := map[string]func(*CustomerUpdateManifest){
		"kind":               func(m *CustomerUpdateManifest) { m.Kind = "desktop" },
		"gateway mismatch":   func(m *CustomerUpdateManifest) { m.GatewayURL = "https://other.example.com" },
		"gateway HTTP":       func(m *CustomerUpdateManifest) { m.GatewayURL = "http://customer.example.com" },
		"gateway path":       func(m *CustomerUpdateManifest) { m.GatewayURL += "/api" },
		"gateway query":      func(m *CustomerUpdateManifest) { m.GatewayURL += "?" },
		"version prefix":     func(m *CustomerUpdateManifest) { m.Version = "v1.2.3" },
		"prerelease":         func(m *CustomerUpdateManifest) { m.Version = "1.2.3-beta.1" },
		"build metadata":     func(m *CustomerUpdateManifest) { m.Version = "1.2.3+build" },
		"leading zero":       func(m *CustomerUpdateManifest) { m.Version = "01.2.3" },
		"incomplete version": func(m *CustomerUpdateManifest) { m.Version = "1.2" },
		"unsafe major":       func(m *CustomerUpdateManifest) { m.Version = "9007199254740992.0.0" },
		"unsafe minor":       func(m *CustomerUpdateManifest) { m.Version = "1.9007199254740992.0" },
		"unsafe patch":       func(m *CustomerUpdateManifest) { m.Version = "1.2.9007199254740992" },
		"overflow version":   func(m *CustomerUpdateManifest) { m.Version = "99999999999999999999.0.0" },
		"empty packages":     func(m *CustomerUpdateManifest) { m.Packages = nil },
		"duplicate platform": func(m *CustomerUpdateManifest) { m.Packages = append(m.Packages, m.Packages[0]) },
		"linux":              func(m *CustomerUpdateManifest) { m.Packages[0].Platform = "linux" },
		"windows arm64": func(m *CustomerUpdateManifest) {
			m.Packages[0].Platform = "windows"
			m.Packages[0].URL = "https://cdn.example.com/a.exe"
		},
		"DMG":              func(m *CustomerUpdateManifest) { m.Packages[0].URL = "https://cdn.example.com/a.dmg" },
		"Windows ZIP":      func(m *CustomerUpdateManifest) { m.Packages[0].Platform = "windows"; m.Packages[0].Arch = "x64" },
		"HTTP package":     func(m *CustomerUpdateManifest) { m.Packages[0].URL = "http://cdn.example.com/a.zip" },
		"credentials":      func(m *CustomerUpdateManifest) { m.Packages[0].URL = "https://user:secret@cdn.example.com/a.zip" },
		"query":            func(m *CustomerUpdateManifest) { m.Packages[0].URL += "?token=secret" },
		"fragment":         func(m *CustomerUpdateManifest) { m.Packages[0].URL += "#secret" },
		"malformed SHA512": func(m *CustomerUpdateManifest) { m.Packages[0].SHA512 = strings.Repeat("x", 88) },
		"short digest": func(m *CustomerUpdateManifest) {
			m.Packages[0].SHA512 = base64.StdEncoding.EncodeToString(make([]byte, 32))
		},
		"digest newline": func(m *CustomerUpdateManifest) { m.Packages[0].SHA512 += "\n" },
		"zero size":      func(m *CustomerUpdateManifest) { m.Packages[0].Size = 0 },
		"negative size":  func(m *CustomerUpdateManifest) { m.Packages[0].Size = -1 },
		"unsafe JS size": func(m *CustomerUpdateManifest) { m.Packages[0].Size = 9007199254740992 },
		"long notes":     func(m *CustomerUpdateManifest) { m.Notes = strings.Repeat("a", 16385) },
		"long URL": func(m *CustomerUpdateManifest) {
			m.Packages[0].URL = "https://cdn.example.com/" + strings.Repeat("a", 2048) + ".zip"
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			service := NewService(settings.NewMemoryStore())
			manifest := customerManifest()
			mutate(&manifest)
			if _, err := service.PublishUpdate(context.Background(), manifest, "https://customer.example.com", "admin", 0); !errors.Is(err, ErrInvalidUpdate) {
				t.Fatalf("expected validation error, got %v", err)
			}
			current, err := service.GetUpdate(context.Background())
			if err != nil || current.Update != nil || current.Revision != 0 {
				t.Fatalf("invalid input published: %+v %v", current, err)
			}
		})
	}
}

func TestCustomerUpdateSafeVersionBoundary(t *testing.T) {
	for _, version := range []string{"0.0.0", "9007199254740991.0.0", "1.9007199254740991.0", "1.2.9007199254740991", "9007199254740991.9007199254740991.9007199254740991"} {
		t.Run(version, func(t *testing.T) {
			service := NewService(settings.NewMemoryStore())
			manifest := customerManifest()
			manifest.Version = version
			published, err := service.PublishUpdate(context.Background(), manifest, manifest.GatewayURL, "admin", 0)
			if err != nil || published.Update == nil || published.Update.Version != version {
				t.Fatalf("safe version rejected: %+v %v", published, err)
			}
		})
	}
}

func TestCustomerUpdateUnsafeVersionPreservesPublishedSnapshot(t *testing.T) {
	ctx := context.Background()
	service := NewService(settings.NewMemoryStore())
	manifest := customerManifest()
	if _, err := service.PublishUpdate(ctx, manifest, manifest.GatewayURL, "admin", 0); err != nil {
		t.Fatal(err)
	}
	manifest.Version = "9007199254740992.0.0"
	if _, err := service.PublishUpdate(ctx, manifest, manifest.GatewayURL, "admin", 1); !errors.Is(err, ErrInvalidUpdate) {
		t.Fatalf("unsafe version accepted: %v", err)
	}
	current, err := service.GetUpdate(ctx)
	if err != nil || current.Revision != 1 || current.Update == nil || current.Update.Version != "1.2.3" {
		t.Fatalf("published snapshot changed: %+v %v", current, err)
	}
	manifest.Version = "1.2.4"
	if _, err := service.PublishUpdate(ctx, manifest, manifest.GatewayURL, "admin", 1); err != nil {
		t.Fatalf("normal update blocked: %v", err)
	}
}

func TestCustomerUpdateCASAcrossServices(t *testing.T) {
	store := settings.NewMemoryStore()
	services := []*Service{NewService(store), NewService(store)}
	for _, revision := range []int64{0, 1} {
		var successes, conflicts atomic.Int32
		var workers sync.WaitGroup
		start := make(chan struct{})
		for index := 0; index < 20; index++ {
			workers.Add(1)
			go func(index int) {
				defer workers.Done()
				<-start
				manifest := customerManifest()
				if revision == 1 {
					manifest.Version = "1.2.4"
				}
				operator := "first-admin"
				if index%2 == 1 {
					operator = "second-admin"
				}
				_, err := services[index%2].PublishUpdate(context.Background(), manifest, manifest.GatewayURL, operator, revision)
				if err == nil {
					successes.Add(1)
				} else if errors.Is(err, ErrVersionConflict) {
					conflicts.Add(1)
				} else {
					t.Errorf("unexpected error: %v", err)
				}
			}(index)
		}
		close(start)
		workers.Wait()
		if successes.Load() != 1 || conflicts.Load() != 19 {
			t.Fatalf("revision %d: successes=%d conflicts=%d", revision, successes.Load(), conflicts.Load())
		}
	}
}

func TestCustomerUpdateSnapshotIsolationAndVersionOrder(t *testing.T) {
	store := settings.NewMemoryStore()
	var requests atomic.Int32
	service := NewServiceWithHTTPClient(store, &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { requests.Add(1); return nil, errors.New("must not fetch") })}, time.Minute)
	ctx := context.Background()
	manifest := customerManifest()
	release, err := service.PublishUpdate(ctx, manifest, manifest.GatewayURL, "operator", 0)
	if err != nil || release.Revision != 1 || release.Update.PublishedBy != "operator" || release.Update.PublishedAt.IsZero() {
		t.Fatalf("publish=%+v %v", release, err)
	}
	manifest.Packages[0].URL = "https://other.example.com/changed.zip"
	_, err = service.Update(ctx, Config{GatewayURL: "https://other.example.com", CatalogURL: "https://other.example.com/latest.json"}, "other", 0)
	if err != nil {
		t.Fatal(err)
	}
	current, err := NewService(store).GetUpdate(ctx)
	if err != nil || current.Update.GatewayURL != "https://customer.example.com" || current.Update.Packages[0].URL == manifest.Packages[0].URL {
		t.Fatalf("snapshot changed: %+v %v", current, err)
	}
	if _, ok := current.Update.Feed("macos", "x64", "latest-mac.yml"); ok {
		t.Fatal("unregistered platform has an update")
	}
	for _, version := range []string{"1.2.3", "1.2.2", "0.99.99"} {
		candidate := customerManifest()
		candidate.Version = version
		if _, err := service.PublishUpdate(ctx, candidate, "https://other.example.com", "operator", 1); !errors.Is(err, ErrInvalidUpdate) {
			t.Fatalf("accepted version %s: %v", version, err)
		}
	}
	candidate := customerManifest()
	candidate.GatewayURL = "https://other.example.com"
	candidate.Version = "1.2.4"
	if _, err := service.PublishUpdate(ctx, candidate, candidate.GatewayURL, "operator", 1); !errors.Is(err, ErrInvalidUpdate) {
		t.Fatalf("accepted channel switch: %v", err)
	}
	candidate = customerManifest()
	candidate.Version = "1.10.0"
	if _, err := service.PublishUpdate(ctx, candidate, "https://other.example.com", "operator", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := service.PublishUpdate(ctx, candidate, candidate.GatewayURL, "operator", -1); !errors.Is(err, ErrInvalidUpdate) {
		t.Fatalf("negative revision: %v", err)
	}
	if requests.Load() != 0 {
		t.Fatalf("update fetched %d URLs", requests.Load())
	}
	other, _ := NewService(settings.NewMemoryStore()).GetUpdate(ctx)
	if other.Update != nil || other.Revision != 0 {
		t.Fatalf("leaked customer snapshot: %+v", other)
	}
}
