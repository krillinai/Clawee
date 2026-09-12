package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClientDownloadsValidation(t *testing.T) {
	if err := (ClientDownloadsConfig{}).Validate(); err != nil {
		t.Fatal(err)
	}
	valid := ClientDownload{Platform: "macos", Arch: "arm64", Version: "0.1.7", URL: "https://downloads.example.com/Clawee.dmg", SHA256: strings.Repeat("a", 64), Signature: "signed_notarized"}
	for _, gateway := range []string{"", "https://gateway.example.com/", "http://127.0.0.1:1904"} {
		if err := (ClientDownloadsConfig{Gateway: gateway, Packages: []ClientDownload{valid}}).Validate(); err != nil {
			t.Fatal(err)
		}
	}
	for _, gateway := range []string{"https://user:secret@gateway.example.com", "https://gateway.example.com/api", "https://gateway.example.com?", "https://gateway.example.com#", "http://gateway.example.com", "javascript:alert(1)"} {
		if err := (ClientDownloadsConfig{Gateway: gateway}).Validate(); err == nil {
			t.Fatalf("accepted gateway %q", gateway)
		}
	}
	for _, mutate := range []func(*ClientDownload){
		func(p *ClientDownload) { p.URL = "http://downloads.example.com/a.exe" },
		func(p *ClientDownload) { p.URL = "https://user:secret@downloads.example.com/a.exe" },
		func(p *ClientDownload) { p.URL = "javascript:alert(1)" },
		func(p *ClientDownload) { p.SHA256 = "invalid" },
		func(p *ClientDownload) { p.Version = " " },
		func(p *ClientDownload) { p.Platform = "linux" },
		func(p *ClientDownload) { p.Signature = "signed" },
	} {
		item := valid
		mutate(&item)
		if err := (ClientDownloadsConfig{Packages: []ClientDownload{item}}).Validate(); err == nil {
			t.Fatalf("accepted invalid package %+v", item)
		}
	}
	if err := (ClientDownloadsConfig{Packages: []ClientDownload{valid, valid}}).Validate(); err == nil {
		t.Fatal("accepted duplicate platform")
	}
	mirror := StandardClientDownload{URL: valid.URL}
	if err := (ClientDownloadsConfig{Standard: mirror}).Validate(); err == nil {
		t.Fatal("accepted mirror without checksum")
	}
	mirror.Version, mirror.SHA256 = valid.Version, valid.SHA256
	if err := (ClientDownloadsConfig{Standard: mirror}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestLoadClientDownloads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	contents := "client_downloads:\n  gateway: https://gateway.example.com\n  packages:\n    - platform: windows\n      arch: x64\n      version: 0.1.7\n      url: https://downloads.example.com/Clawee.exe\n      sha256: " + strings.Repeat("a", 64) + "\n      signature: unsigned\n"
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClientDownloads.Gateway != "https://gateway.example.com" || len(cfg.ClientDownloads.Packages) != 1 || cfg.ClientDownloads.Packages[0].Signature != "unsigned" {
		t.Fatalf("unexpected config %+v", cfg.ClientDownloads)
	}
	if err := os.WriteFile(path, []byte("client_downloads:\n  gateway: https://example.com/api\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("invalid download config loaded")
	}
}
