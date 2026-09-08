package skillhub

import (
	"archive/zip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

var versionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

type Config struct {
	Store       Store
	SpaceStore  SpaceStore
	PackageRoot string
	Clock       func() time.Time
}

type Service struct {
	store       Store
	spaces      SpaceStore
	packageRoot string
	clock       func() time.Time
}

func NewService(cfg Config) *Service {
	clock := cfg.Clock
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC() }
	}
	spaces := cfg.SpaceStore
	if spaces == nil {
		spaces, _ = cfg.Store.(SpaceStore)
	}
	return &Service{store: cfg.Store, spaces: spaces, packageRoot: cfg.PackageRoot, clock: clock}
}

func PreparePackageRoot(root string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", errors.New("skillhub package root is required")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve skillhub package root: %w", err)
	}
	if err := os.MkdirAll(absolute, 0o750); err != nil {
		return "", fmt.Errorf("create skillhub package root: %w", err)
	}
	directory, err := os.Open(absolute)
	if err != nil {
		return "", fmt.Errorf("skillhub package root is not readable: %w", err)
	}
	_, readErr := directory.Readdirnames(1)
	closeErr := directory.Close()
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return "", fmt.Errorf("skillhub package root is not readable: %w", readErr)
	}
	if closeErr != nil {
		return "", closeErr
	}
	probe, err := os.CreateTemp(absolute, ".write-test-*")
	if err != nil {
		return "", fmt.Errorf("skillhub package root is not writable: %w", err)
	}
	probeName := probe.Name()
	if err := probe.Close(); err != nil {
		_ = os.Remove(probeName)
		return "", err
	}
	if err := os.Remove(probeName); err != nil {
		return "", err
	}
	return absolute, nil
}

func (s *Service) UploadVersion(ctx context.Context, input UploadVersionInput) (MutationResult, error) {
	return s.CreateVersionFromPackage(ctx, CreateVersionInput{
		SpaceID: input.SpaceID, Version: input.Version, Changelog: input.Changelog, Package: input.Package,
		CreatedBy: input.CreatedBy, Publish: true, Resolution: VersionResolutionByName,
		UploadedByUserID: input.UploadedByUserID, UploadedByAgentID: input.UploadedByAgentID,
	})
}

func (s *Service) CreateVersionFromPackage(ctx context.Context, input CreateVersionInput) (MutationResult, error) {
	input.CreatedBy = strings.TrimSpace(input.CreatedBy)
	input.SpaceID = strings.TrimSpace(input.SpaceID)
	if input.SpaceID == "" {
		input.SpaceID = DefaultSpaceID
	}
	input.TargetSkillID = strings.TrimSpace(input.TargetSkillID)
	if s == nil || s.store == nil || s.packageRoot == "" || input.Package == nil || input.CreatedBy == "" ||
		!versionPattern.MatchString(input.Version) || len([]rune(input.Changelog)) > MaxChangelogRunes ||
		(input.Resolution != VersionResolutionByName && input.Resolution != VersionResolutionCreateOnly && input.Resolution != VersionResolutionTarget) ||
		(input.Resolution == VersionResolutionTarget && input.TargetSkillID == "") || !validVersionSourceEvidence(input.Source) {
		return MutationResult{}, ErrInvalidRequest
	}

	temporary, err := os.CreateTemp(s.packageRoot, ".upload-*.zip")
	if err != nil {
		return MutationResult{}, err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	written, copyErr := io.Copy(temporary, io.LimitReader(input.Package, MaxPackageSize+1))
	if closeErr := temporary.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return MutationResult{}, copyErr
	}
	if written <= 0 {
		return MutationResult{}, packageInvalid("上传文件为空")
	}
	if written > MaxPackageSize {
		return MutationResult{}, ErrPackageTooLarge
	}

	file, err := os.Open(temporaryPath)
	if err != nil {
		return MutationResult{}, err
	}
	normalized, err := os.CreateTemp(s.packageRoot, ".normalized-*.zip")
	if err != nil {
		_ = file.Close()
		return MutationResult{}, err
	}
	normalizedPath := normalized.Name()
	defer os.Remove(normalizedPath)
	metadata, normalizeErr := NormalizePackage(file, written, normalized)
	closeErr := file.Close()
	normalizedCloseErr := normalized.Close()
	if normalizeErr != nil {
		return MutationResult{}, normalizeErr
	}
	if closeErr != nil {
		return MutationResult{}, closeErr
	}
	if normalizedCloseErr != nil {
		return MutationResult{}, normalizedCloseErr
	}
	normalizedInfo, err := os.Stat(normalizedPath)
	if err != nil {
		return MutationResult{}, err
	}
	if normalizedInfo.Size() <= 0 {
		return MutationResult{}, packageInvalid("规范 ZIP 压缩包为空")
	}
	if normalizedInfo.Size() > MaxPackageSize {
		return MutationResult{}, ErrPackageTooLarge
	}
	normalizedFile, err := os.Open(normalizedPath)
	if err != nil {
		return MutationResult{}, err
	}
	hash := sha256.New()
	_, hashErr := io.Copy(hash, normalizedFile)
	hashCloseErr := normalizedFile.Close()
	if hashErr != nil {
		return MutationResult{}, hashErr
	}
	if hashCloseErr != nil {
		return MutationResult{}, hashCloseErr
	}

	now := s.clock().UTC()
	versionID := newID("skillver")
	skill := Skill{SkillID: newID("skill"), SpaceID: input.SpaceID, Name: metadata.Name, Description: metadata.Description, CreatedBy: input.CreatedBy, CreatedAt: now, UpdatedAt: now}
	version := Version{
		VersionID: versionID, Version: input.Version, Description: metadata.Description,
		Changelog: input.Changelog, PackagePath: versionID + ".zip", PackageSHA256: hex.EncodeToString(hash.Sum(nil)), Source: input.Source, CreatedAt: now,
		UploadedByUserID: strings.TrimSpace(input.UploadedByUserID), UploadedByAgentID: strings.TrimSpace(input.UploadedByAgentID),
	}
	finalPath := filepath.Join(s.packageRoot, version.PackagePath)
	if err := os.Rename(normalizedPath, finalPath); err != nil {
		return MutationResult{}, err
	}
	storedSkill, storedVersion, err := s.store.CreateVersion(ctx, skill, version, CreateVersionOptions{
		Publish: input.Publish, Resolution: input.Resolution, TargetSkillID: input.TargetSkillID,
	})
	if err != nil {
		_ = os.Remove(finalPath)
		return MutationResult{}, err
	}
	return MutationResult{Skill: storedSkill, Version: storedVersion}, nil
}

func validVersionSourceEvidence(source *VersionSourceEvidence) bool {
	if source == nil {
		return true
	}
	if strings.TrimSpace(source.SourceID) == "" || strings.TrimSpace(source.RepositoryOwner) == "" ||
		strings.TrimSpace(source.RepositoryName) == "" || strings.TrimSpace(source.Path) == "" ||
		len(source.CommitSHA) != 40 || len(source.ContentSHA256) != 64 {
		return false
	}
	if _, err := hex.DecodeString(source.CommitSHA); err != nil {
		return false
	}
	_, err := hex.DecodeString(source.ContentSHA256)
	return err == nil
}

func (s *Service) ListAdmin(ctx context.Context) ([]Skill, error) {
	return s.store.ListAdmin(ctx)
}

func (s *Service) GetAdmin(ctx context.Context, skillID string) (AdminDetail, error) {
	if strings.TrimSpace(skillID) == "" {
		return AdminDetail{}, ErrNotFound
	}
	return s.store.GetAdmin(ctx, skillID)
}

func (s *Service) ListPublished(ctx context.Context) ([]PublishedItem, error) {
	return s.store.ListPublished(ctx)
}

func (s *Service) GetPublished(ctx context.Context, skillID string) (PublishedDetail, error) {
	return s.store.GetPublished(ctx, strings.TrimSpace(skillID))
}

func (s *Service) OpenCurrentPackageForUser(ctx context.Context, userID, skillID, expectedVersionID string) (PackageDownload, error) {
	if s == nil || s.spaces == nil || s.spaces.CheckSkillAccess(ctx, userID, skillID, SpaceActionRead) != nil {
		return PackageDownload{}, ErrNotFound
	}
	return s.OpenCurrentPackageForVersion(ctx, skillID, expectedVersionID)
}

func (s *Service) SetCurrentVersion(ctx context.Context, skillID, versionID string) (MutationResult, error) {
	if strings.TrimSpace(skillID) == "" || strings.TrimSpace(versionID) == "" {
		return MutationResult{}, ErrInvalidRequest
	}
	skill, version, err := s.store.SetCurrentVersion(ctx, skillID, versionID, s.clock().UTC())
	if err != nil {
		return MutationResult{}, err
	}
	return MutationResult{Skill: skill, Version: version}, nil
}

func (s *Service) ClearCurrentVersion(ctx context.Context, skillID string) (*Version, error) {
	if strings.TrimSpace(skillID) == "" {
		return nil, ErrNotFound
	}
	return s.store.ClearCurrentVersion(ctx, skillID, s.clock().UTC())
}

func (s *Service) OpenCurrentPackage(ctx context.Context, skillID string) (PackageDownload, error) {
	return s.OpenCurrentPackageForVersion(ctx, skillID, "")
}

func (s *Service) OpenCurrentPackageForVersion(ctx context.Context, skillID, expectedVersionID string) (PackageDownload, error) {
	detail, err := s.GetPublished(ctx, skillID)
	if err != nil {
		return PackageDownload{}, err
	}
	if expectedVersionID = strings.TrimSpace(expectedVersionID); expectedVersionID != "" && detail.VersionID != expectedVersionID {
		return PackageDownload{}, ErrVersionChanged
	}
	expectedPath := detail.VersionID + ".zip"
	if detail.PackagePath != expectedPath || filepath.Base(detail.PackagePath) != detail.PackagePath {
		return PackageDownload{}, errors.New("invalid stored skill package path")
	}
	file, err := os.Open(filepath.Join(s.packageRoot, detail.PackagePath))
	if errors.Is(err, os.ErrNotExist) {
		return PackageDownload{}, err
	}
	if err != nil {
		return PackageDownload{}, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return PackageDownload{}, err
	}
	return PackageDownload{
		Filename: detail.Name + "-" + detail.Version + ".zip", Size: info.Size(), Reader: file, Detail: detail,
	}, nil
}

func (s *Service) ListVersionFiles(ctx context.Context, skillID, versionID string) ([]PackageFile, error) {
	_, version, err := s.adminVersion(ctx, skillID, versionID)
	if err != nil {
		return nil, err
	}
	return s.listVersionFiles(version)
}

func (s *Service) ListPublishedVersionFiles(ctx context.Context, skillID, versionID string) ([]PackageFile, error) {
	version, err := s.publishedVersion(ctx, skillID, versionID)
	if err != nil {
		return nil, err
	}
	return s.listVersionFiles(version)
}

func (s *Service) ListPublishedVersionFilesForUser(ctx context.Context, userID, skillID, versionID string) ([]PackageFile, error) {
	if s == nil || s.spaces == nil || s.spaces.CheckSkillAccess(ctx, userID, skillID, SpaceActionRead) != nil {
		return nil, ErrNotFound
	}
	return s.ListPublishedVersionFiles(ctx, skillID, versionID)
}

func (s *Service) listVersionFiles(version Version) ([]PackageFile, error) {
	file, archive, entries, err := s.openVersionArchive(version)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	files := make([]PackageFile, 0, len(archive.File))
	for i, item := range archive.File {
		if item.FileInfo().IsDir() {
			continue
		}
		files = append(files, PackageFile{Path: entries[i].logicalPath, Size: int64(item.UncompressedSize64)})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

func (s *Service) ReadVersionFile(ctx context.Context, skillID, versionID, requestedPath string) (PackageFileContent, error) {
	cleaned, err := validateEntryName(requestedPath)
	if err != nil || cleaned != requestedPath {
		return PackageFileContent{}, ErrInvalidRequest
	}
	_, version, err := s.adminVersion(ctx, skillID, versionID)
	if err != nil {
		return PackageFileContent{}, err
	}
	return s.readVersionFile(version, requestedPath)
}

func (s *Service) ReadPublishedVersionFile(ctx context.Context, skillID, versionID, requestedPath string) (PackageFileContent, error) {
	cleaned, err := validateEntryName(requestedPath)
	if err != nil || cleaned != requestedPath {
		return PackageFileContent{}, ErrInvalidRequest
	}
	version, err := s.publishedVersion(ctx, skillID, versionID)
	if err != nil {
		return PackageFileContent{}, err
	}
	return s.readVersionFile(version, requestedPath)
}

func (s *Service) ReadPublishedVersionFileForUser(ctx context.Context, userID, skillID, versionID, requestedPath string) (PackageFileContent, error) {
	if s == nil || s.spaces == nil || s.spaces.CheckSkillAccess(ctx, userID, skillID, SpaceActionRead) != nil {
		return PackageFileContent{}, ErrNotFound
	}
	return s.ReadPublishedVersionFile(ctx, skillID, versionID, requestedPath)
}

func (s *Service) readVersionFile(version Version, requestedPath string) (PackageFileContent, error) {
	file, archive, entries, err := s.openVersionArchive(version)
	if err != nil {
		return PackageFileContent{}, err
	}
	defer file.Close()

	for i, item := range archive.File {
		if item.FileInfo().IsDir() || entries[i].logicalPath != requestedPath {
			continue
		}
		limit := MaxFilePreviewSize
		if requestedPath == "SKILL.md" {
			limit = MaxSkillMDSize
		}
		if item.UncompressedSize64 > uint64(limit) {
			return PackageFileContent{}, ErrFileNotPreviewable
		}
		reader, err := item.Open()
		if err != nil {
			return PackageFileContent{}, storedPackageInvalidf("无法读取 ZIP 中的文件 %q", item.Name)
		}
		content, readErr := io.ReadAll(io.LimitReader(reader, limit+1))
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil {
			return PackageFileContent{}, storedPackageInvalidf("无法读取 ZIP 中的文件 %q", item.Name)
		}
		if int64(len(content)) > limit || !isPreviewableText(content) {
			return PackageFileContent{}, ErrFileNotPreviewable
		}
		return PackageFileContent{Path: requestedPath, Size: int64(len(content)), Content: string(content)}, nil
	}
	return PackageFileContent{}, ErrNotFound
}

func (s *Service) publishedVersion(ctx context.Context, skillID, expectedVersionID string) (Version, error) {
	if strings.TrimSpace(expectedVersionID) == "" {
		return Version{}, ErrInvalidRequest
	}
	detail, err := s.GetPublished(ctx, skillID)
	if err != nil {
		return Version{}, err
	}
	if detail.VersionID != strings.TrimSpace(expectedVersionID) {
		return Version{}, ErrVersionChanged
	}
	return Version{
		VersionID:   detail.VersionID,
		SkillID:     detail.SkillID,
		Version:     detail.Version,
		PackagePath: detail.PackagePath,
	}, nil
}

func (s *Service) OpenVersionPackage(ctx context.Context, skillID, versionID string) (PackageDownload, error) {
	skill, version, err := s.adminVersion(ctx, skillID, versionID)
	if err != nil {
		return PackageDownload{}, err
	}
	file, info, err := s.openVersionFile(version)
	if err != nil {
		return PackageDownload{}, err
	}
	return PackageDownload{
		Filename: skill.Name + "-" + version.Version + ".zip",
		Size:     info.Size(),
		Reader:   file,
		Detail: PublishedDetail{PublishedItem: PublishedItem{
			SkillID: skill.SkillID, Name: skill.Name, Description: version.Description,
			VersionID: version.VersionID, Version: version.Version, PackageSHA256: version.PackageSHA256,
			UpdatedAt: skill.UpdatedAt,
		}, Changelog: version.Changelog, PackagePath: version.PackagePath},
	}, nil
}

func (s *Service) adminVersion(ctx context.Context, skillID, versionID string) (Skill, Version, error) {
	skillID = strings.TrimSpace(skillID)
	versionID = strings.TrimSpace(versionID)
	if skillID == "" || versionID == "" {
		return Skill{}, Version{}, ErrNotFound
	}
	detail, err := s.store.GetAdmin(ctx, skillID)
	if err != nil {
		return Skill{}, Version{}, err
	}
	for _, version := range detail.Versions {
		if version.VersionID == versionID {
			return detail.Skill, version, nil
		}
	}
	return Skill{}, Version{}, ErrNotFound
}

type packageArchiveEntry struct {
	logicalPath string
}

func (s *Service) openVersionArchive(version Version) (*os.File, *zip.Reader, []packageArchiveEntry, error) {
	file, info, err := s.openVersionFile(version)
	if err != nil {
		return nil, nil, nil, err
	}
	archive, err := zip.NewReader(file, info.Size())
	if err != nil {
		file.Close()
		return nil, nil, nil, storedPackageInvalidf("文件不是有效的 ZIP 压缩包")
	}
	if len(archive.File) == 0 || len(archive.File) > MaxPackageEntries {
		file.Close()
		return nil, nil, nil, storedPackageInvalidf("ZIP 文件条目数量不合法")
	}
	names := make([]string, len(archive.File))
	seen := make(map[string]struct{}, len(archive.File))
	for i, item := range archive.File {
		name, err := validateEntryName(item.Name)
		if err != nil {
			file.Close()
			return nil, nil, nil, storedPackageInvalidf("ZIP 文件路径不合法")
		}
		if _, exists := seen[name]; exists {
			file.Close()
			return nil, nil, nil, storedPackageInvalidf("ZIP 中存在重复路径 %q", name)
		}
		seen[name] = struct{}{}
		names[i] = name
	}
	skillMDPath, err := locateSkillMD(names)
	if err != nil {
		file.Close()
		return nil, nil, nil, storedPackageInvalidf("ZIP 中的 SKILL.md 位置不合法")
	}
	wrapper := path.Dir(skillMDPath)
	if wrapper == "." {
		wrapper = ""
	}
	entries := make([]packageArchiveEntry, len(archive.File))
	var total int64
	for i, item := range archive.File {
		mode := item.Mode()
		if item.FileInfo().IsDir() {
			if mode&^(mode.Perm()|mode.Type()) != 0 {
				file.Close()
				return nil, nil, nil, storedPackageInvalidf("目录条目 %q 的类型或权限不合法", names[i])
			}
			continue
		}
		if !mode.IsRegular() {
			file.Close()
			return nil, nil, nil, storedPackageInvalidf("文件 %q 不支持符号链接或其他特殊文件", names[i])
		}
		if item.UncompressedSize64 > uint64(MaxUncompressedSize-total) {
			file.Close()
			return nil, nil, nil, storedPackageInvalidf("ZIP 解压后大小超过限制")
		}
		total += int64(item.UncompressedSize64)
		logicalPath := names[i]
		if wrapper != "" {
			logicalPath = strings.TrimPrefix(logicalPath, wrapper+"/")
		}
		entries[i] = packageArchiveEntry{logicalPath: logicalPath}
	}
	return file, archive, entries, nil
}

func (s *Service) openVersionFile(version Version) (*os.File, os.FileInfo, error) {
	expectedPath := version.VersionID + ".zip"
	if version.PackagePath != expectedPath || filepath.Base(version.PackagePath) != version.PackagePath {
		return nil, nil, storedPackageInvalidf("存储路径不合法")
	}
	file, err := os.Open(filepath.Join(s.packageRoot, version.PackagePath))
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	if info.Size() <= 0 {
		file.Close()
		return nil, nil, storedPackageInvalidf("ZIP 压缩包为空")
	}
	if info.Size() > MaxPackageSize {
		file.Close()
		return nil, nil, storedPackageInvalidf("ZIP 压缩包大小超过限制")
	}
	return file, info, nil
}

func isPreviewableText(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	for _, value := range string(data) {
		if value < 0x20 && value != '\t' && value != '\n' && value != '\r' {
			return false
		}
		if value >= 0x7f && value <= 0x9f {
			return false
		}
	}
	return true
}

func storedPackageInvalidf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrStoredPackageInvalid, fmt.Sprintf(format, args...))
}

func newID(prefix string) string {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return prefix + "_" + hex.EncodeToString(raw[:])
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
