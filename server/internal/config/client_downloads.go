package config

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
)

const StandardClientDownloadURL = "https://github.com/krillinai/Clawee/releases/latest"

type ClientDownloadsConfig struct {
	Gateway  string                 `mapstructure:"gateway" json:"gateway"`
	Standard StandardClientDownload `mapstructure:"standard" json:"standard"`
	Packages []ClientDownload       `mapstructure:"packages" json:"packages"`
}

type StandardClientDownload struct {
	URL     string `mapstructure:"url" json:"url"`
	Version string `mapstructure:"version" json:"version,omitempty"`
	SHA256  string `mapstructure:"sha256" json:"sha256,omitempty"`
}

type ClientDownload struct {
	Platform  string `mapstructure:"platform" json:"platform"`
	Arch      string `mapstructure:"arch" json:"arch"`
	Version   string `mapstructure:"version" json:"version"`
	URL       string `mapstructure:"url" json:"url"`
	SHA256    string `mapstructure:"sha256" json:"sha256"`
	Signature string `mapstructure:"signature" json:"signature"`
}

var clientDownloadSHA256 = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

func (cfg ClientDownloadsConfig) Validate() error {
	if cfg.Gateway != "" {
		u, err := url.Parse(cfg.Gateway)
		if err != nil || u.Hostname() == "" || u.User != nil || u.Opaque != "" ||
			(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || strings.Contains(cfg.Gateway, "#") {
			return fmt.Errorf("client_downloads.gateway 必须是 Gateway origin")
		}
		ip := net.ParseIP(u.Hostname())
		loopback := u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
		if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
			return fmt.Errorf("client_downloads.gateway 必须使用 HTTPS（本机回环地址除外）")
		}
	}
	if cfg.Standard.URL != "" && cfg.Standard.URL != StandardClientDownloadURL {
		if !validClientDownloadURL(cfg.Standard.URL) || strings.TrimSpace(cfg.Standard.Version) == "" || !clientDownloadSHA256.MatchString(cfg.Standard.SHA256) {
			return fmt.Errorf("client_downloads.standard 镜像必须填写 HTTPS URL、版本和 SHA256")
		}
	}
	seen := map[string]bool{}
	for _, item := range cfg.Packages {
		key := item.Platform + "/" + item.Arch
		if seen[key] || (key != "macos/arm64" && key != "macos/x64" && key != "windows/x64") {
			return fmt.Errorf("client_downloads.packages 平台不支持或重复")
		}
		seen[key] = true
		if !validClientDownloadURL(item.URL) || strings.TrimSpace(item.Version) == "" || !clientDownloadSHA256.MatchString(item.SHA256) {
			return fmt.Errorf("client_downloads.packages 必须填写 HTTPS URL、版本和 SHA256")
		}
		if item.Signature != "unsigned" && !(item.Platform == "macos" && item.Signature == "signed_notarized") && !(item.Platform == "windows" && item.Signature == "signed") {
			return fmt.Errorf("client_downloads.packages 签名状态无效")
		}
	}
	return nil
}

func validClientDownloadURL(value string) bool {
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil &&
		u.Opaque == "" && !strings.Contains(value, "#")
}
