package clientdownloads

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/krillinai/Clawee/server/internal/settings"
	"github.com/krillinai/Clawee/server/internal/textutil"
)

const (
	Namespace               = "client_downloads"
	Key                     = "default"
	DefaultCatalogURL       = "https://cdn.krillinai.com/clawee/catalog/stable/latest.json"
	maxCatalogBytes   int64 = 2 << 20
)

var ErrVersionConflict = settings.ErrVersionConflict

var sha256Pattern = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

type Config struct {
	GatewayURL string `json:"gateway_url"`
	CatalogURL string `json:"catalog_url"`
}
type StoredConfig struct {
	Config
	Version   int64     `json:"version"`
	UpdatedBy string    `json:"updated_by"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
type Artifact struct {
	Platform    string `json:"platform"`
	Arch        string `json:"arch"`
	Version     string `json:"version"`
	DownloadURL string `json:"download_url"`
	SHA256      string `json:"sha256"`
	Signature   string `json:"signature"`
}
type PublicResponse struct {
	GatewayURL     string     `json:"gateway_url"`
	CatalogURL     string     `json:"catalog_url,omitempty"`
	Version        string     `json:"version,omitempty"`
	Packages       []Artifact `json:"packages"`
	ManifestStatus string     `json:"manifest_status"`
}

type Service struct {
	store     settings.SettingsStore
	client    *http.Client
	ttl       time.Duration
	mu        sync.Mutex
	cachedAt  time.Time
	cachedURL string
	cached    PublicResponse
}

func NewService(store settings.SettingsStore) *Service {
	return NewServiceWithHTTPClient(store, &http.Client{Timeout: 5 * time.Second}, 30*time.Second)
}

func NewServiceWithHTTPClient(store settings.SettingsStore, client *http.Client, ttl time.Duration) *Service {
	if store == nil {
		store = settings.NewMemoryStore()
	}
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &Service{store: store, client: client, ttl: ttl}
}
func (s *Service) Get(ctx context.Context) (StoredConfig, error) {
	record, err := s.store.Get(ctx, Namespace, Key)
	if err != nil {
		return StoredConfig{}, err
	}
	if len(record.Value) == 0 {
		return StoredConfig{Config: Config{CatalogURL: DefaultCatalogURL}}, nil
	}
	var cfg Config
	if err := json.Unmarshal(record.Value, &cfg); err != nil {
		return StoredConfig{}, err
	}
	if cfg.CatalogURL == "" {
		cfg.CatalogURL = DefaultCatalogURL
	}
	return StoredConfig{Config: cfg, Version: record.Version, UpdatedBy: record.UpdatedBy, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}, nil
}
func (s *Service) Update(ctx context.Context, cfg Config, updatedBy string, expectedVersion int64) (StoredConfig, error) {
	cfg.GatewayURL = textutil.TrimInput(cfg.GatewayURL)
	cfg.CatalogURL = textutil.TrimInput(cfg.CatalogURL)
	if err := Validate(cfg); err != nil {
		return StoredConfig{}, err
	}
	if expectedVersion > 0 {
		current, err := s.store.Get(ctx, Namespace, Key)
		if err != nil {
			return StoredConfig{}, err
		}
		if current.Version != expectedVersion {
			return StoredConfig{}, ErrVersionConflict
		}
	}
	value, _ := json.Marshal(cfg)
	record, err := s.store.Put(ctx, Namespace, Key, value, strings.TrimSpace(updatedBy), expectedVersion, time.Now().UTC())
	if err != nil {
		return StoredConfig{}, err
	}
	return StoredConfig{Config: cfg, Version: record.Version, UpdatedBy: record.UpdatedBy, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}, nil
}
func Validate(cfg Config) error {
	if !validGatewayURL(cfg.GatewayURL) {
		return errors.New("gateway_url must be a valid HTTP or HTTPS origin")
	}
	if !validCatalogURL(cfg.CatalogURL) {
		return errors.New("catalog_url must be a valid HTTPS URL without user info, fragment, or query")
	}
	return nil
}
func validGatewayURL(value string) bool {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u.Hostname() == "" || u.User != nil || u.Opaque != "" || u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	return u.Scheme == "https" || u.Scheme == "http"
}
func validCatalogURL(value string) bool {
	u, err := url.Parse(strings.TrimSpace(value))
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.Opaque == "" && u.Fragment == "" && u.RawQuery == "" && !u.ForceQuery
}

func (s *Service) Public(ctx context.Context, gatewayURL string) (PublicResponse, error) {
	cfg, err := s.Get(ctx)
	if err != nil {
		return PublicResponse{}, err
	}
	gateway := strings.TrimRight(strings.TrimSpace(cfg.GatewayURL), "/")
	if gateway == "" {
		gateway = strings.TrimRight(gatewayURL, "/")
	}
	catalog := cfg.CatalogURL
	s.mu.Lock()
	if time.Since(s.cachedAt) < s.ttl && s.cachedURL == catalog {
		out := s.cached
		s.mu.Unlock()
		out.GatewayURL = gateway
		return out, nil
	}
	s.mu.Unlock()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, catalog, nil)
	if err != nil {
		return PublicResponse{}, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return PublicResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return PublicResponse{}, fmt.Errorf("catalog returned status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxCatalogBytes+1))
	if err != nil || int64(len(body)) > maxCatalogBytes {
		return PublicResponse{}, errors.New("catalog response is too large")
	}
	var doc catalogDocument
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(&doc); err != nil {
		return PublicResponse{}, err
	}
	if dec.Decode(&struct{}{}) != io.EOF {
		return PublicResponse{}, errors.New("invalid catalog JSON")
	}
	packages, version, err := parseCatalog(doc)
	if err != nil {
		return PublicResponse{}, err
	}
	out := PublicResponse{GatewayURL: gateway, CatalogURL: catalog, Version: version, Packages: packages, ManifestStatus: "ok"}
	s.mu.Lock()
	s.cachedAt = time.Now()
	s.cachedURL = catalog
	s.cached = out
	s.mu.Unlock()
	return out, nil
}

type catalogDocument struct {
	Product   string            `json:"product"`
	Kind      string            `json:"kind"`
	Version   string            `json:"version"`
	Artifacts []catalogArtifact `json:"artifacts"`
	Files     []catalogFile     `json:"files"`
	Desktop   struct {
		MacosSigning   string `json:"macosSigning"`
		WindowsSigning string `json:"windowsSigning"`
	} `json:"desktop"`
}
type catalogFile struct {
	Name        string `json:"name"`
	DownloadURL string `json:"downloadUrl"`
	SHA256      string `json:"sha256"`
}
type catalogArtifact struct {
	Component   string `json:"component"`
	Platform    string `json:"platform"`
	Arch        string `json:"arch"`
	Format      string `json:"format"`
	DownloadURL string `json:"downloadUrl"`
	SHA256      string `json:"sha256"`
}

func parseCatalog(doc catalogDocument) ([]Artifact, string, error) {
	if doc.Product != "Clawee" || strings.TrimSpace(doc.Version) == "" {
		return nil, "", errors.New("invalid catalog")
	}
	if doc.Kind == "customer-desktop-delivery" {
		return parseCustomerDesktopDelivery(doc)
	}
	if len(doc.Artifacts) == 0 {
		return nil, "", errors.New("invalid catalog")
	}
	if doc.Desktop.MacosSigning != "" && doc.Desktop.MacosSigning != "unsigned" && doc.Desktop.MacosSigning != "developer-id-notarized" {
		return nil, "", errors.New("invalid macOS signing status")
	}
	if doc.Desktop.WindowsSigning != "" && doc.Desktop.WindowsSigning != "unsigned" && doc.Desktop.WindowsSigning != "signed" && doc.Desktop.WindowsSigning != "authenticode-signed" {
		return nil, "", errors.New("invalid Windows signing status")
	}
	out := make([]Artifact, 0, 3)
	seen := map[string]bool{}
	for _, a := range doc.Artifacts {
		if a.Component != "desktop" {
			continue
		}
		if a.Platform != "macos" && a.Platform != "windows" {
			return nil, "", errors.New("unsupported desktop platform")
		}
		if (a.Platform == "macos" && a.Arch != "arm64" && a.Arch != "x64") || (a.Platform == "windows" && a.Arch != "x64") {
			return nil, "", errors.New("unsupported desktop architecture")
		}
		if (a.Platform == "macos" && a.Format != "dmg") || (a.Platform == "windows" && a.Format != "exe") {
			continue
		}
		key := a.Platform + "/" + a.Arch
		if seen[key] || !validCatalogURL(a.DownloadURL) || strings.TrimSpace(a.SHA256) == "" || !sha256Pattern.MatchString(a.SHA256) {
			return nil, "", errors.New("invalid desktop artifact")
		}
		seen[key] = true
		signature := "unsigned"
		if a.Platform == "macos" && doc.Desktop.MacosSigning != "" {
			signature = "signed_notarized"
		}
		if a.Platform == "windows" && doc.Desktop.WindowsSigning != "" && doc.Desktop.WindowsSigning != "unsigned" {
			signature = "signed"
		}
		out = append(out, Artifact{Platform: a.Platform, Arch: a.Arch, Version: doc.Version, DownloadURL: a.DownloadURL, SHA256: a.SHA256, Signature: signature})
	}
	if len(out) == 0 {
		return nil, "", errors.New("catalog has no desktop packages")
	}
	return out, doc.Version, nil
}

func parseCustomerDesktopDelivery(doc catalogDocument) ([]Artifact, string, error) {
	out := make([]Artifact, 0, 3)
	seen := map[string]bool{}
	for _, file := range doc.Files {
		parts := strings.Split(strings.Trim(file.Name, "/"), "/")
		if len(parts) != 3 || (parts[0] != "macos" && parts[0] != "windows") {
			continue
		}
		platform, arch := parts[0], parts[1]
		ext := strings.ToLower(parts[2])
		if platform == "macos" {
			if (arch != "arm64" && arch != "x64") || !strings.HasSuffix(ext, ".dmg") {
				continue
			}
		} else if arch != "x64" || !strings.HasSuffix(ext, ".exe") {
			continue
		}
		key := platform + "/" + arch
		if seen[key] || !validCatalogURL(file.DownloadURL) || !sha256Pattern.MatchString(file.SHA256) {
			return nil, "", errors.New("invalid desktop artifact")
		}
		seen[key] = true
		out = append(out, Artifact{Platform: platform, Arch: arch, Version: doc.Version, DownloadURL: file.DownloadURL, SHA256: file.SHA256, Signature: "unsigned"})
	}
	if len(out) == 0 {
		return nil, "", errors.New("catalog has no desktop packages")
	}
	return out, doc.Version, nil
}
