package clientdownloads

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type UpdateVersion struct {
	Version     string `json:"version"`
	PublishedAt string `json:"published_at"`
	ReleaseURL  string `json:"-"`
}

type UpdateCandidate struct {
	Version              string                  `json:"version"`
	Packages             []CustomerUpdatePackage `json:"packages"`
	UnavailablePlatforms []string                `json:"unavailable_platforms"`
}

func (s *Service) readUpdateMetadata(ctx context.Context, address string) ([]byte, error) {
	if !validCatalogURL(address) {
		return nil, invalidUpdate("发布资料必须使用 HTTPS 地址")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Cache-Control", "no-cache")
	client := *s.client
	client.CheckRedirect = func(request *http.Request, previous []*http.Request) error {
		if len(previous) >= 5 || !validCatalogURL(request.URL.String()) || request.URL.Host != previous[0].URL.Host {
			return errors.New("发布资料重定向无效")
		}
		return nil
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, invalidUpdate("无法读取发布资料，请检查版本目录")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, invalidUpdate(fmt.Sprintf("发布资料不可用（HTTP %d）", response.StatusCode))
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxCatalogBytes+1))
	if err != nil || int64(len(body)) > maxCatalogBytes {
		return nil, invalidUpdate("发布资料超出大小限制或读取失败")
	}
	return body, nil
}

func (s *Service) UpdateVersions(ctx context.Context) ([]UpdateVersion, error) {
	configuration, err := s.Get(ctx)
	if err != nil {
		return nil, err
	}
	catalog, err := url.Parse(configuration.CatalogURL)
	if err != nil || !validCatalogURL(configuration.CatalogURL) {
		return nil, invalidUpdate("版本目录地址无效")
	}
	body, err := s.readUpdateMetadata(ctx, catalog.ResolveReference(&url.URL{Path: "versions.json"}).String())
	if err != nil {
		return nil, err
	}
	var document struct {
		Product  string `json:"product"`
		Channel  string `json:"channel"`
		Versions []struct {
			Version     string `json:"version"`
			PublishedAt string `json:"publishedAt"`
			ReleaseURL  string `json:"releaseUrl"`
		} `json:"versions"`
	}
	if err := json.Unmarshal(body, &document); err != nil || document.Product != "Clawee" || document.Channel != "stable" {
		return nil, invalidUpdate("稳定版本目录无效")
	}
	versions := make([]UpdateVersion, 0, len(document.Versions))
	seen := map[string]bool{}
	for _, item := range document.Versions {
		release, err := url.Parse(item.ReleaseURL)
		if !validStableVersion(item.Version) || seen[item.Version] || err != nil || !validCatalogURL(item.ReleaseURL) || release.Host != catalog.Host || !strings.HasSuffix(release.Path, "/v"+item.Version+"/release.json") {
			return nil, invalidUpdate("版本目录包含无效或重复的版本")
		}
		seen[item.Version] = true
		versions = append(versions, UpdateVersion{Version: item.Version, PublishedAt: item.PublishedAt, ReleaseURL: item.ReleaseURL})
	}
	sort.Slice(versions, func(first, second int) bool {
		return stableVersionGreater(versions[first].Version, versions[second].Version)
	})
	return versions, nil
}

func (s *Service) ResolveUpdateVersion(ctx context.Context, version string) (UpdateCandidate, error) {
	if !validStableVersion(version) {
		return UpdateCandidate{}, invalidUpdate("请选择有效的稳定版本")
	}
	versions, err := s.UpdateVersions(ctx)
	if err != nil {
		return UpdateCandidate{}, err
	}
	address := ""
	for _, item := range versions {
		if item.Version == version {
			address = item.ReleaseURL
			break
		}
	}
	if address == "" {
		return UpdateCandidate{}, invalidUpdate("目标版本未在稳定版本目录中发布")
	}
	body, err := s.readUpdateMetadata(ctx, address)
	if err != nil {
		return UpdateCandidate{}, err
	}
	var document catalogDocument
	if err := json.Unmarshal(body, &document); err != nil || document.Product != "Clawee" || document.Version != version {
		return UpdateCandidate{}, invalidUpdate("发布资料与目标版本不一致")
	}
	root, _ := url.Parse(address)
	root.Path = strings.TrimSuffix(root.Path, "release.json")
	insideRelease := func(address string) bool {
		parsed, err := url.Parse(address)
		return err == nil && validCatalogURL(address) && parsed.Host == root.Host && strings.HasPrefix(parsed.Path, root.Path) && !strings.Contains(parsed.Path, "/../")
	}
	candidate := UpdateCandidate{Version: version, Packages: []CustomerUpdatePackage{}, UnavailablePlatforms: []string{}}
	for _, target := range []struct{ platform, arch, format string }{{"macos", "arm64", "zip"}, {"macos", "x64", "zip"}, {"windows", "x64", "exe"}} {
		label := target.platform + "/" + target.arch
		if target.platform == "macos" && document.Desktop.MacosSigning != "developer-id-notarized" {
			candidate.UnavailablePlatforms = append(candidate.UnavailablePlatforms, label+"：缺少正式签名，不能自动安装")
			continue
		}
		var artifact, metadata *catalogArtifact
		for index := range document.Artifacts {
			item := &document.Artifacts[index]
			if item.Component != "desktop" || item.Platform != target.platform || item.Arch != target.arch {
				continue
			}
			if item.Format == target.format {
				if artifact != nil {
					return UpdateCandidate{}, invalidUpdate("更新包重复：" + label)
				}
				artifact = item
			}
			if item.Format == "yml" {
				if metadata != nil {
					return UpdateCandidate{}, invalidUpdate("更新元数据重复：" + label)
				}
				metadata = item
			}
		}
		if artifact == nil || metadata == nil {
			candidate.UnavailablePlatforms = append(candidate.UnavailablePlatforms, label+"：缺少更新包或更新元数据")
			continue
		}
		if !insideRelease(artifact.DownloadURL) || !insideRelease(metadata.DownloadURL) || !sha256Pattern.MatchString(metadata.SHA256) {
			return UpdateCandidate{}, invalidUpdate("更新包必须来自目标版本的不可变目录")
		}
		metadataBody, err := s.readUpdateMetadata(ctx, metadata.DownloadURL)
		if err != nil {
			return UpdateCandidate{}, err
		}
		digest := sha256.Sum256(metadataBody)
		if !strings.EqualFold(hex.EncodeToString(digest[:]), metadata.SHA256) {
			return UpdateCandidate{}, invalidUpdate("更新元数据 SHA256 校验失败")
		}
		var feed struct {
			Version string `yaml:"version"`
			Files   []struct {
				URL    string `yaml:"url"`
				SHA512 string `yaml:"sha512"`
				Size   int64  `yaml:"size"`
			} `yaml:"files"`
		}
		if err := yaml.Unmarshal(metadataBody, &feed); err != nil || feed.Version != version {
			return UpdateCandidate{}, invalidUpdate("更新元数据版本无效")
		}
		var pkg *CustomerUpdatePackage
		for _, file := range feed.Files {
			if file.URL != artifact.DownloadURL {
				continue
			}
			if pkg != nil || file.Size != artifact.Bytes {
				return UpdateCandidate{}, invalidUpdate("更新元数据与产物不一致")
			}
			pkg = &CustomerUpdatePackage{Platform: target.platform, Arch: target.arch, URL: file.URL, SHA512: file.SHA512, Size: file.Size}
		}
		if pkg == nil {
			return UpdateCandidate{}, invalidUpdate("更新元数据未引用目标更新包")
		}
		candidate.Packages = append(candidate.Packages, *pkg)
	}
	if len(candidate.Packages) > 0 {
		manifest := CustomerUpdateManifest{Kind: "customer-desktop-update", GatewayURL: "https://validation.invalid", Version: version, Packages: candidate.Packages}
		if err := validateCustomerUpdate(manifest, manifest.GatewayURL); err != nil {
			return UpdateCandidate{}, err
		}
	}
	return candidate, nil
}

func (s *Service) PublishVersionPolicy(ctx context.Context, enabled bool, version, notes, gateway, operator string, expectedRevision int64) (AdminUpdateResponse, error) {
	if expectedRevision < 0 || expectedRevision > 9007199254740990 {
		return AdminUpdateResponse{}, invalidUpdate("expected_revision 无效")
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
	var manifest CustomerUpdateManifest
	if current.Update != nil {
		manifest = current.Update.CustomerUpdateManifest
	}
	if enabled {
		if current.Update == nil || manifest.Version != version {
			candidate, err := s.ResolveUpdateVersion(ctx, version)
			if err != nil {
				return AdminUpdateResponse{}, err
			}
			if len(candidate.Packages) == 0 {
				return AdminUpdateResponse{}, invalidUpdate("目标版本没有可安全自动安装的平台包")
			}
			manifest = CustomerUpdateManifest{Kind: "customer-desktop-update", Version: version, Packages: candidate.Packages}
		}
		manifest.GatewayURL = gateway
		manifest.Notes = notes
		if err := validateCustomerUpdate(manifest, gateway); err != nil {
			return AdminUpdateResponse{}, err
		}
	} else if current.Update == nil {
		return AdminUpdateResponse{}, invalidUpdate("尚未发布客户更新")
	}
	manifest.Disabled = !enabled
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
	return AdminUpdateResponse{Update: &AdminCustomerUpdateRelease{CustomerUpdateRelease: CustomerUpdateRelease{CustomerUpdateManifest: manifest, Revision: record.Version, PublishedAt: record.UpdatedAt}, PublishedBy: record.UpdatedBy}, Revision: record.Version, Enabled: !manifest.Disabled}, nil
}
