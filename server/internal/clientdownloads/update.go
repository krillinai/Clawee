package clientdownloads

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const UpdateKey = "customer_update"

var ErrInvalidUpdate = errors.New("客户更新清单无效")
var stableVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var initialUpdateMu sync.Mutex

type CustomerUpdatePackage struct {
	Platform string `json:"platform"`
	Arch     string `json:"arch"`
	URL      string `json:"url"`
	SHA512   string `json:"sha512"`
	Size     int64  `json:"size"`
}

type CustomerUpdateManifest struct {
	Kind       string                  `json:"kind"`
	GatewayURL string                  `json:"gateway_url"`
	Version    string                  `json:"version"`
	Notes      string                  `json:"notes"`
	Packages   []CustomerUpdatePackage `json:"packages"`
}

type CustomerUpdateRelease struct {
	CustomerUpdateManifest
	Revision    int64     `json:"revision"`
	PublishedAt time.Time `json:"published_at"`
}

type AdminCustomerUpdateRelease struct {
	CustomerUpdateRelease
	PublishedBy string `json:"published_by"`
}

type AdminUpdateResponse struct {
	Update   *AdminCustomerUpdateRelease `json:"update"`
	Revision int64                       `json:"revision"`
}

type PublicUpdateResponse struct {
	Update *CustomerUpdateRelease `json:"update"`
}

type UpdateFeed struct {
	Version      string           `json:"version"`
	ReleaseNotes string           `json:"releaseNotes"`
	Files        []UpdateFeedFile `json:"files"`
}

type UpdateFeedFile struct {
	URL    string `json:"url"`
	SHA512 string `json:"sha512"`
	Size   int64  `json:"size"`
}

func (s *Service) GetUpdate(ctx context.Context) (AdminUpdateResponse, error) {
	record, err := s.store.Get(ctx, Namespace, UpdateKey)
	if err != nil {
		return AdminUpdateResponse{}, err
	}
	if len(record.Value) == 0 {
		return AdminUpdateResponse{}, nil
	}
	var manifest CustomerUpdateManifest
	if err := json.Unmarshal(record.Value, &manifest); err != nil {
		return AdminUpdateResponse{}, err
	}
	return AdminUpdateResponse{Update: &AdminCustomerUpdateRelease{CustomerUpdateRelease: CustomerUpdateRelease{CustomerUpdateManifest: manifest, Revision: record.Version, PublishedAt: record.UpdatedAt}, PublishedBy: record.UpdatedBy}, Revision: record.Version}, nil
}

func (s *Service) PublicUpdate(ctx context.Context) (PublicUpdateResponse, error) {
	current, err := s.GetUpdate(ctx)
	if err != nil || current.Update == nil {
		return PublicUpdateResponse{}, err
	}
	return PublicUpdateResponse{Update: &current.Update.CustomerUpdateRelease}, nil
}

func (s *Service) PublishUpdate(ctx context.Context, manifest CustomerUpdateManifest, gatewayURL, operator string, expectedRevision int64) (AdminUpdateResponse, error) {
	if expectedRevision < 0 || expectedRevision > 9007199254740990 {
		return AdminUpdateResponse{}, invalidUpdate("expected_revision 必须为非负安全整数")
	}
	if expectedRevision == 0 {
		initialUpdateMu.Lock()
		defer initialUpdateMu.Unlock()
	}
	current, err := s.GetUpdate(ctx)
	if err != nil {
		return AdminUpdateResponse{}, err
	}
	if current.Revision != expectedRevision {
		return AdminUpdateResponse{}, ErrVersionConflict
	}
	if current.Update != nil {
		gatewayURL = current.Update.GatewayURL
	}
	if err := validateCustomerUpdate(manifest, gatewayURL); err != nil {
		return AdminUpdateResponse{}, err
	}
	if current.Update != nil && !stableVersionGreater(manifest.Version, current.Update.Version) {
		return AdminUpdateResponse{}, invalidUpdate("版本必须严格高于已发布版本")
	}
	manifest.GatewayURL, _ = updateOrigin(manifest.GatewayURL)
	value, err := json.Marshal(manifest)
	if err != nil {
		return AdminUpdateResponse{}, err
	}
	storeVersion := expectedRevision
	if storeVersion == 0 {
		storeVersion = -1
	}
	record, err := s.store.Put(ctx, Namespace, UpdateKey, value, strings.TrimSpace(operator), storeVersion, time.Now().UTC())
	if err != nil {
		return AdminUpdateResponse{}, err
	}
	return AdminUpdateResponse{Update: &AdminCustomerUpdateRelease{CustomerUpdateRelease: CustomerUpdateRelease{CustomerUpdateManifest: manifest, Revision: record.Version, PublishedAt: record.UpdatedAt}, PublishedBy: record.UpdatedBy}, Revision: record.Version}, nil
}

func (release *CustomerUpdateRelease) Feed(platform, arch, filename string) (UpdateFeed, bool) {
	validName := platform == "windows" && arch == "x64" && filename == "latest.yml" || platform == "macos" && (arch == "arm64" || arch == "x64") && (filename == "latest-mac.yml" || arch == "arm64" && filename == "latest-arm64-mac.yml")
	if !validName {
		return UpdateFeed{}, false
	}
	for _, pkg := range release.Packages {
		if pkg.Platform == platform && pkg.Arch == arch {
			return UpdateFeed{Version: release.Version, ReleaseNotes: release.Notes, Files: []UpdateFeedFile{{URL: pkg.URL, SHA512: pkg.SHA512, Size: pkg.Size}}}, true
		}
	}
	return UpdateFeed{}, false
}

func validateCustomerUpdate(manifest CustomerUpdateManifest, gatewayURL string) error {
	if manifest.Kind != "customer-desktop-update" {
		return invalidUpdate("kind 必须为 customer-desktop-update")
	}
	actual, valid := updateOrigin(manifest.GatewayURL)
	expected, configured := updateOrigin(gatewayURL)
	if !valid || !configured || actual != expected {
		return invalidUpdate("清单 Gateway 与固定更新渠道不匹配，渠道必须为 HTTPS origin")
	}
	if !validStableVersion(manifest.Version) {
		return invalidUpdate("version 必须为严格稳定语义版本，不允许前缀、预发布、构建标记或前导零，各分量不得超过 9007199254740991")
	}
	if len(manifest.Notes) > 16384 {
		return invalidUpdate("更新说明不能超过 16384 字节")
	}
	if len(manifest.Packages) < 1 || len(manifest.Packages) > 3 {
		return invalidUpdate("packages 必须包含 1 至 3 个平台包")
	}
	seen := make(map[string]bool)
	for _, pkg := range manifest.Packages {
		pair := pkg.Platform + "/" + pkg.Arch
		if pair != "macos/arm64" && pair != "macos/x64" && pair != "windows/x64" || seen[pair] {
			return invalidUpdate("平台架构不受支持或重复")
		}
		seen[pair] = true
		parsed, err := url.Parse(pkg.URL)
		if err != nil || len(pkg.URL) > 2048 || strings.ContainsAny(pkg.URL, "?#\\") || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
			return invalidUpdate("包地址必须为无凭据、查询或片段的 HTTPS URL，最多 2048 字节")
		}
		extension := strings.ToLower(path.Ext(parsed.Path))
		if pkg.Platform == "macos" && extension != ".zip" || pkg.Platform == "windows" && extension != ".exe" {
			return invalidUpdate("macOS 更新包必须为 ZIP，Windows 更新包必须为 NSIS EXE")
		}
		digest, err := base64.StdEncoding.Strict().DecodeString(pkg.SHA512)
		if err != nil || len(digest) != 64 || base64.StdEncoding.EncodeToString(digest) != pkg.SHA512 {
			return invalidUpdate("sha512 必须为 64 字节摘要的标准 Base64 编码")
		}
		if pkg.Size <= 0 || pkg.Size > 9007199254740991 {
			return invalidUpdate("size 必须为正安全整数")
		}
	}
	return nil
}

func updateOrigin(value string) (string, bool) {
	parsed, err := url.Parse(value)
	if err != nil || len(value) > 2048 || strings.ContainsAny(value, "?#\\") || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Opaque != "" || parsed.Path != "" && parsed.Path != "/" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return "", false
	}
	return "https://" + strings.TrimSuffix(strings.ToLower(parsed.Host), ":443"), true
}

func validStableVersion(version string) bool {
	if len(version) > 64 || !stableVersionPattern.MatchString(version) {
		return false
	}
	for _, component := range strings.Split(version, ".") {
		if _, err := strconv.ParseUint(component, 10, 53); err != nil {
			return false
		}
	}
	return true
}

func stableVersionGreater(candidate, current string) bool {
	if !stableVersionPattern.MatchString(current) {
		return false
	}
	candidateParts, currentParts := strings.Split(candidate, "."), strings.Split(current, ".")
	for index := range candidateParts {
		if len(candidateParts[index]) != len(currentParts[index]) {
			return len(candidateParts[index]) > len(currentParts[index])
		}
		if candidateParts[index] != currentParts[index] {
			return candidateParts[index] > currentParts[index]
		}
	}
	return false
}

func invalidUpdate(message string) error {
	return fmt.Errorf("%w：%s", ErrInvalidUpdate, message)
}
