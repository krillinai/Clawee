package skillhub

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestServiceUploadVersionStoresImmutablePackage(t *testing.T) {
	root := t.TempDir()
	store := NewMemoryStore()
	now := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)
	service := NewService(Config{Store: store, PackageRoot: root, Clock: func() time.Time { return now }})
	data := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("code-review")}})

	result, err := service.UploadVersion(context.Background(), UploadVersionInput{
		Version: "1.2.0", Changelog: "修复安装说明", Package: bytes.NewReader(data), CreatedBy: "usr_admin",
	})
	if err != nil {
		t.Fatalf("UploadVersion() error = %v", err)
	}
	if result.Skill.Name != "code-review" || result.Skill.CreatedBy != "usr_admin" || result.Skill.CurrentVersionID == nil || *result.Skill.CurrentVersionID != result.Version.VersionID {
		t.Fatalf("skill = %#v", result.Skill)
	}
	if result.Version.Version != "1.2.0" || len(result.Version.PackageSHA256) != 64 {
		t.Fatalf("version = %#v", result.Version)
	}
	path := filepath.Join(root, result.Version.PackagePath)
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read package: %v", err)
	}
	storedSHA256 := sha256.Sum256(stored)
	if result.Version.PackageSHA256 != hex.EncodeToString(storedSHA256[:]) {
		t.Fatalf("package_sha256 = %q, want stored package digest", result.Version.PackageSHA256)
	}

	_, err = service.UploadVersion(context.Background(), UploadVersionInput{
		Version: "1.2.0", Package: bytes.NewReader(data), CreatedBy: "usr_admin",
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate upload error = %v, want ErrConflict", err)
	}
	files, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("package files = %d, want 1 after compensation", len(files))
	}
	published, err := service.GetPublished(context.Background(), result.Skill.SkillID)
	if err != nil || published.VersionID != result.Version.VersionID {
		t.Fatalf("GetPublished() = %#v, %v", published, err)
	}
	items, err := service.ListAdmin(context.Background())
	if err != nil || len(items) != 1 || items[0].SkillID != result.Skill.SkillID {
		t.Fatalf("ListAdmin() = %#v, %v", items, err)
	}
	detail, err := service.GetAdmin(context.Background(), result.Skill.SkillID)
	if err != nil || len(detail.Versions) != 1 {
		t.Fatalf("GetAdmin() = %#v, %v", detail, err)
	}
	if _, err := service.GetAdmin(context.Background(), "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetAdmin(missing) error = %v", err)
	}
}

func TestServiceUploadVersionStoresNormalizedPackage(t *testing.T) {
	root := t.TempDir()
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: root})
	uploaded := buildTestZIP(t, []testZIPEntry{
		{name: "wrapper/SKILL.md", body: validSkillMD("normalized")},
		{name: "wrapper/scripts/run.sh", body: "#!/bin/sh\n", mode: 0o755},
		{name: "__MACOSX/wrapper/._SKILL.md", body: "metadata"},
		{name: "wrapper/.DS_Store", body: "metadata"},
		{name: "wrapper/scripts/._run.sh", body: "metadata"},
	})

	result, err := service.UploadVersion(context.Background(), UploadVersionInput{
		Version: "1.0", Package: bytes.NewReader(uploaded), CreatedBy: "admin",
	})
	if err != nil {
		t.Fatalf("UploadVersion() error = %v", err)
	}
	stored, err := os.ReadFile(filepath.Join(root, result.Version.PackagePath))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(stored, uploaded) {
		t.Fatal("stored package must be the normalized ZIP, not the original upload")
	}
	storedSHA256 := sha256.Sum256(stored)
	if result.Version.PackageSHA256 != hex.EncodeToString(storedSHA256[:]) {
		t.Fatalf("package_sha256 = %q, want %x", result.Version.PackageSHA256, storedSHA256)
	}

	archive, err := zip.NewReader(bytes.NewReader(stored), int64(len(stored)))
	if err != nil {
		t.Fatal(err)
	}
	wantNames := []string{"wrapper/SKILL.md", "wrapper/scripts/run.sh"}
	if len(archive.File) != len(wantNames) {
		t.Fatalf("stored entries = %d, want %d", len(archive.File), len(wantNames))
	}
	for i, file := range archive.File {
		if file.Name != wantNames[i] {
			t.Fatalf("stored entry %d = %q, want %q", i, file.Name, wantNames[i])
		}
	}
	if archive.File[1].Mode().Perm() != 0o755 {
		t.Fatalf("stored run.sh mode = %o, want 755", archive.File[1].Mode().Perm())
	}

	download, err := service.OpenCurrentPackage(context.Background(), result.Skill.SkillID)
	if err != nil {
		t.Fatal(err)
	}
	defer download.Reader.Close()
	downloaded, err := io.ReadAll(download.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(downloaded, stored) {
		t.Fatal("downloaded package differs from stored normalized package")
	}
}

func TestServiceUploadVersionPublishesLatestUploadAndConflictPreservesCurrent(t *testing.T) {
	root := t.TempDir()
	store := NewMemoryStore()
	now := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)
	service := NewService(Config{Store: store, PackageRoot: root, Clock: func() time.Time { return now }})
	firstData := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: "---\nname: code-review\ndescription: first\n---\n# First\n"}})
	first, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "2.0", Package: bytes.NewReader(firstData), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Hour)
	secondData := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: "---\nname: code-review\ndescription: second\n---\n# Second\n"}})
	second, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "1.0", Package: bytes.NewReader(secondData), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	if second.Skill.SkillID != first.Skill.SkillID || second.Skill.CurrentVersionID == nil || *second.Skill.CurrentVersionID != second.Version.VersionID {
		t.Fatalf("second upload result = %#v", second)
	}
	published, err := service.GetPublished(context.Background(), first.Skill.SkillID)
	if err != nil || published.VersionID != second.Version.VersionID || published.Description != "second" {
		t.Fatalf("published = %#v, %v", published, err)
	}

	_, err = service.UploadVersion(context.Background(), UploadVersionInput{Version: "1.0", Package: bytes.NewReader(secondData), CreatedBy: "admin"})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate upload error = %v", err)
	}
	afterConflict, err := service.GetPublished(context.Background(), first.Skill.SkillID)
	if err != nil || afterConflict.VersionID != second.Version.VersionID {
		t.Fatalf("published after conflict = %#v, %v", afterConflict, err)
	}
}

func TestServiceCreateVersionFromPackageCreatesUnpublishedVersionWithSource(t *testing.T) {
	root := t.TempDir()
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: root})
	source := &VersionSourceEvidence{
		SourceID: "source-1", RepositoryOwner: "acme", RepositoryName: "skills",
		Path: "skills/code-review", CommitSHA: "0123456789012345678901234567890123456789",
		ContentSHA256: strings.Repeat("a", 64),
	}

	created, err := service.CreateVersionFromPackage(context.Background(), CreateVersionInput{
		Version:    "git-0123456789012345678901234567890123456789",
		Package:    bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("code-review")}})),
		CreatedBy:  "平台管理员",
		Publish:    false,
		Resolution: VersionResolutionCreateOnly,
		Source:     source,
	})
	if err != nil {
		t.Fatalf("CreateVersionFromPackage() error = %v", err)
	}
	if created.Skill.CurrentVersionID != nil {
		t.Fatalf("current version = %v, want nil", created.Skill.CurrentVersionID)
	}
	if created.Version.Source == nil || *created.Version.Source != *source {
		t.Fatalf("source = %#v, want %#v", created.Version.Source, source)
	}
	if _, err := service.GetPublished(context.Background(), created.Skill.SkillID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetPublished() error = %v, want ErrNotFound", err)
	}
	detail, err := service.GetAdmin(context.Background(), created.Skill.SkillID)
	if err != nil || len(detail.Versions) != 1 || detail.Versions[0].Source == nil || *detail.Versions[0].Source != *source {
		t.Fatalf("GetAdmin() = %#v, %v", detail, err)
	}
}

func TestServiceCreateVersionFromPackageRejectsIncompleteSourceBeforePackageWrite(t *testing.T) {
	validCommitSHA := strings.Repeat("a", 40)
	validContentSHA256 := strings.Repeat("b", 64)
	tests := []struct {
		name   string
		source VersionSourceEvidence
	}{
		{name: "empty source id", source: VersionSourceEvidence{RepositoryOwner: "acme", RepositoryName: "skills", Path: "skills/code-review", CommitSHA: validCommitSHA, ContentSHA256: validContentSHA256}},
		{name: "empty repository owner", source: VersionSourceEvidence{SourceID: "source-1", RepositoryName: "skills", Path: "skills/code-review", CommitSHA: validCommitSHA, ContentSHA256: validContentSHA256}},
		{name: "empty repository name", source: VersionSourceEvidence{SourceID: "source-1", RepositoryOwner: "acme", Path: "skills/code-review", CommitSHA: validCommitSHA, ContentSHA256: validContentSHA256}},
		{name: "empty path", source: VersionSourceEvidence{SourceID: "source-1", RepositoryOwner: "acme", RepositoryName: "skills", CommitSHA: validCommitSHA, ContentSHA256: validContentSHA256}},
		{name: "empty commit sha", source: VersionSourceEvidence{SourceID: "source-1", RepositoryOwner: "acme", RepositoryName: "skills", Path: "skills/code-review", ContentSHA256: validContentSHA256}},
		{name: "short commit sha", source: VersionSourceEvidence{SourceID: "source-1", RepositoryOwner: "acme", RepositoryName: "skills", Path: "skills/code-review", CommitSHA: strings.Repeat("a", 39), ContentSHA256: validContentSHA256}},
		{name: "non hex commit sha", source: VersionSourceEvidence{SourceID: "source-1", RepositoryOwner: "acme", RepositoryName: "skills", Path: "skills/code-review", CommitSHA: strings.Repeat("g", 40), ContentSHA256: validContentSHA256}},
		{name: "empty content sha256", source: VersionSourceEvidence{SourceID: "source-1", RepositoryOwner: "acme", RepositoryName: "skills", Path: "skills/code-review", CommitSHA: validCommitSHA}},
		{name: "short content sha256", source: VersionSourceEvidence{SourceID: "source-1", RepositoryOwner: "acme", RepositoryName: "skills", Path: "skills/code-review", CommitSHA: validCommitSHA, ContentSHA256: strings.Repeat("b", 63)}},
		{name: "non hex content sha256", source: VersionSourceEvidence{SourceID: "source-1", RepositoryOwner: "acme", RepositoryName: "skills", Path: "skills/code-review", CommitSHA: validCommitSHA, ContentSHA256: strings.Repeat("g", 64)}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := NewMemoryStore()
			missingRoot := filepath.Join(t.TempDir(), "missing")
			service := NewService(Config{Store: store, PackageRoot: missingRoot})
			_, err := service.CreateVersionFromPackage(context.Background(), CreateVersionInput{
				Version:   "git-0123456789012345678901234567890123456789",
				Package:   bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("code-review")}})),
				CreatedBy: "平台管理员", Resolution: VersionResolutionCreateOnly, Source: &tt.source,
			})
			if !errors.Is(err, ErrInvalidRequest) {
				t.Errorf("CreateVersionFromPackage() error = %v, want ErrInvalidRequest", err)
			}
			if _, err := os.Stat(missingRoot); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("package root stat error = %v, want os.ErrNotExist", err)
			}
			items, err := store.ListAdmin(context.Background())
			if err != nil || len(items) != 0 {
				t.Errorf("ListAdmin() = %#v, %v; want no store mutation", items, err)
			}
		})
	}
}

func TestServiceCreateVersionFromPackageTargetPreservesOrPublishesCurrent(t *testing.T) {
	root := t.TempDir()
	store := NewMemoryStore()
	service := NewService(Config{Store: store, PackageRoot: root})
	initial, err := service.UploadVersion(context.Background(), UploadVersionInput{
		Version: "1.0", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("code-review")}})), CreatedBy: "admin",
	})
	if err != nil {
		t.Fatal(err)
	}

	unpublished, err := service.CreateVersionFromPackage(context.Background(), CreateVersionInput{
		Version:   "git-1111111111111111111111111111111111111111",
		Package:   bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("code-review")}})),
		CreatedBy: "平台管理员", Publish: false, Resolution: VersionResolutionTarget, TargetSkillID: initial.Skill.SkillID,
		Source: &VersionSourceEvidence{SourceID: "source-1", RepositoryOwner: "acme", RepositoryName: "skills", Path: "skills/code-review", CommitSHA: strings.Repeat("1", 40), ContentSHA256: strings.Repeat("b", 64)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if unpublished.Skill.SkillID != initial.Skill.SkillID || unpublished.Skill.CurrentVersionID == nil || *unpublished.Skill.CurrentVersionID != initial.Version.VersionID {
		t.Fatalf("unpublished result = %#v", unpublished)
	}

	published, err := service.CreateVersionFromPackage(context.Background(), CreateVersionInput{
		Version:   "git-2222222222222222222222222222222222222222",
		Package:   bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("code-review")}})),
		CreatedBy: "平台管理员", Publish: true, Resolution: VersionResolutionTarget, TargetSkillID: initial.Skill.SkillID,
		Source: &VersionSourceEvidence{SourceID: "source-1", RepositoryOwner: "acme", RepositoryName: "skills", Path: "skills/code-review", CommitSHA: strings.Repeat("2", 40), ContentSHA256: strings.Repeat("c", 64)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if published.Skill.CurrentVersionID == nil || *published.Skill.CurrentVersionID != published.Version.VersionID {
		t.Fatalf("published result = %#v", published)
	}
	current, err := service.GetPublished(context.Background(), initial.Skill.SkillID)
	if err != nil || current.VersionID != published.Version.VersionID {
		t.Fatalf("GetPublished() = %#v, %v", current, err)
	}
}

func TestServiceCreateVersionFromPackageCreateOnlyRejectsExistingName(t *testing.T) {
	root := t.TempDir()
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: root})
	data := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("code-review")}})
	if _, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "1", Package: bytes.NewReader(data), CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	_, err := service.CreateVersionFromPackage(context.Background(), CreateVersionInput{
		Version: "git-0123456789012345678901234567890123456789", Package: bytes.NewReader(data), CreatedBy: "平台管理员",
		Resolution: VersionResolutionCreateOnly,
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("CreateVersionFromPackage() error = %v, want ErrConflict", err)
	}
	files, readErr := os.ReadDir(root)
	if readErr != nil || len(files) != 1 {
		t.Fatalf("package files = %d, %v; want 1 after compensation", len(files), readErr)
	}
}

func TestServiceCreateVersionFromPackageTargetRequiresExistingMatchingSkill(t *testing.T) {
	root := t.TempDir()
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: root})
	one, err := service.UploadVersion(context.Background(), UploadVersionInput{
		Version: "1", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("one")}})), CreatedBy: "admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	two, err := service.UploadVersion(context.Background(), UploadVersionInput{
		Version: "1", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("two")}})), CreatedBy: "admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	data := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("one")}})
	input := CreateVersionInput{Version: "2", Package: bytes.NewReader(data), CreatedBy: "admin", Resolution: VersionResolutionTarget, TargetSkillID: two.Skill.SkillID}
	if _, err := service.CreateVersionFromPackage(context.Background(), input); !errors.Is(err, ErrConflict) {
		t.Fatalf("mismatched target error = %v, want ErrConflict", err)
	}
	input.Package = bytes.NewReader(data)
	input.TargetSkillID = "missing"
	if _, err := service.CreateVersionFromPackage(context.Background(), input); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing target error = %v, want ErrNotFound", err)
	}
	detail, err := service.GetAdmin(context.Background(), one.Skill.SkillID)
	if err != nil || len(detail.Versions) != 1 {
		t.Fatalf("target skill changed: %#v, %v", detail, err)
	}
}

func TestServicePublishesClearsAndDownloadsCurrentVersion(t *testing.T) {
	root := t.TempDir()
	store := NewMemoryStore()
	service := NewService(Config{Store: store, PackageRoot: root})
	data := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("code-review")}})
	created, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "1.0", Package: bytes.NewReader(data), CreatedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}

	if created.Skill.CurrentVersionID == nil || *created.Skill.CurrentVersionID != created.Version.VersionID {
		t.Fatalf("created skill = %#v", created.Skill)
	}
	items, err := service.ListPublished(context.Background())
	if err != nil || len(items) != 1 || items[0].VersionID != created.Version.VersionID {
		t.Fatalf("ListPublished() = %#v, %v", items, err)
	}

	download, err := service.OpenCurrentPackage(context.Background(), created.Skill.SkillID)
	if err != nil {
		t.Fatalf("OpenCurrentPackage() error = %v", err)
	}
	defer download.Reader.Close()
	got, err := io.ReadAll(download.Reader)
	if err != nil {
		t.Fatalf("read download: %v", err)
	}
	downloadSHA256 := sha256.Sum256(got)
	if created.Version.PackageSHA256 != hex.EncodeToString(downloadSHA256[:]) {
		t.Fatalf("download SHA-256 = %x, want %s", downloadSHA256, created.Version.PackageSHA256)
	}
	if download.Filename != "code-review-1.0.zip" {
		t.Fatalf("filename = %q", download.Filename)
	}

	cleared, err := service.ClearCurrentVersion(context.Background(), created.Skill.SkillID)
	if err != nil {
		t.Fatalf("ClearCurrentVersion() error = %v", err)
	}
	if cleared == nil || cleared.VersionID != created.Version.VersionID || cleared.PackageSHA256 != created.Version.PackageSHA256 {
		t.Fatalf("cleared version = %#v", cleared)
	}
	cleared, err = service.ClearCurrentVersion(context.Background(), created.Skill.SkillID)
	if err != nil {
		t.Fatalf("idempotent clear error = %v", err)
	}
	if cleared != nil {
		t.Fatalf("idempotent clear version = %#v, want nil", cleared)
	}
	if _, err := service.OpenCurrentPackage(context.Background(), created.Skill.SkillID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("download after clear error = %v, want ErrNotFound", err)
	}
}

func TestServiceListsReadsAndDownloadsVersionPackage(t *testing.T) {
	root := t.TempDir()
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: root})
	data := buildTestZIP(t, []testZIPEntry{
		{name: "wrapper/SKILL.md", body: "---\nname: code-review\ndescription: desc\n---\n# Overview\n"},
		{name: "wrapper/docs/guide.md", body: "guide"},
		{name: "wrapper/docs/read me.txt", body: "spaced path"},
		{name: "wrapper/assets/logo.bin", body: string([]byte{0, 1, 2})},
		{name: "wrapper/assets/control.bin", body: string([]byte{1, 2, 3})},
	})
	created, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "1.0", Package: bytes.NewReader(data), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}

	files, err := service.ListVersionFiles(context.Background(), created.Skill.SkillID, created.Version.VersionID)
	if err != nil {
		t.Fatalf("ListVersionFiles() error = %v", err)
	}
	if len(files) != 5 || files[0].Path != "SKILL.md" || files[1].Path != "assets/control.bin" || files[2].Path != "assets/logo.bin" || files[3].Path != "docs/guide.md" || files[4].Path != "docs/read me.txt" {
		t.Fatalf("files = %#v", files)
	}
	preview, err := service.ReadVersionFile(context.Background(), created.Skill.SkillID, created.Version.VersionID, "SKILL.md")
	if err != nil || preview.Path != "SKILL.md" || !strings.Contains(preview.Content, "# Overview") {
		t.Fatalf("preview = %#v, %v", preview, err)
	}
	if _, err := service.ReadVersionFile(context.Background(), created.Skill.SkillID, created.Version.VersionID, "assets/logo.bin"); !errors.Is(err, ErrFileNotPreviewable) {
		t.Fatalf("binary preview error = %v", err)
	}
	if _, err := service.ReadVersionFile(context.Background(), created.Skill.SkillID, created.Version.VersionID, "assets/control.bin"); !errors.Is(err, ErrFileNotPreviewable) {
		t.Fatalf("control character preview error = %v", err)
	}
	spacedPreview, err := service.ReadVersionFile(context.Background(), created.Skill.SkillID, created.Version.VersionID, "docs/read me.txt")
	if err != nil || spacedPreview.Content != "spaced path" {
		t.Fatalf("spaced path preview = %#v, %v", spacedPreview, err)
	}

	download, err := service.OpenVersionPackage(context.Background(), created.Skill.SkillID, created.Version.VersionID)
	if err != nil {
		t.Fatalf("OpenVersionPackage() error = %v", err)
	}
	defer download.Reader.Close()
	got, err := io.ReadAll(download.Reader)
	if err != nil {
		t.Fatal(err)
	}
	downloadSHA256 := sha256.Sum256(got)
	if created.Version.PackageSHA256 != hex.EncodeToString(downloadSHA256[:]) || download.Filename != "code-review-1.0.zip" {
		t.Fatalf("download = %#v sha256=%x", download, downloadSHA256)
	}
}

func TestServicePublishedVersionFilesOnlyAllowCurrentVersion(t *testing.T) {
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: t.TempDir()})
	firstData := buildTestZIP(t, []testZIPEntry{
		{name: "SKILL.md", body: validSkillMD("first")},
		{name: "docs/guide.md", body: "first guide"},
	})
	first, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "1", Package: bytes.NewReader(firstData), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	secondData := buildTestZIP(t, []testZIPEntry{
		{name: "SKILL.md", body: validSkillMD("second")},
		{name: "private.md", body: "unpublished history"},
	})
	second, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "2", Package: bytes.NewReader(secondData), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(context.Background(), first.Skill.SkillID, first.Version.VersionID); err != nil {
		t.Fatal(err)
	}

	files, err := service.ListPublishedVersionFiles(context.Background(), first.Skill.SkillID, first.Version.VersionID)
	if err != nil {
		t.Fatalf("ListPublishedVersionFiles() error = %v", err)
	}
	if len(files) != 2 || files[0].Path != "SKILL.md" || files[1].Path != "docs/guide.md" {
		t.Fatalf("published files = %#v", files)
	}
	preview, err := service.ReadPublishedVersionFile(context.Background(), first.Skill.SkillID, first.Version.VersionID, "docs/guide.md")
	if err != nil || preview.Content != "first guide" {
		t.Fatalf("published preview = %#v, %v", preview, err)
	}
	if _, err := service.ListPublishedVersionFiles(context.Background(), first.Skill.SkillID, second.Version.VersionID); !errors.Is(err, ErrVersionChanged) {
		t.Fatalf("historical published files error = %v, want ErrVersionChanged", err)
	}
	if _, err := service.ReadPublishedVersionFile(context.Background(), first.Skill.SkillID, second.Version.VersionID, "private.md"); !errors.Is(err, ErrVersionChanged) {
		t.Fatalf("historical published preview error = %v, want ErrVersionChanged", err)
	}
}

func TestServiceRejectsInvalidVersionFileAccess(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(Config{Store: store, PackageRoot: t.TempDir()})
	firstData := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("first")}})
	first, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "1", Package: bytes.NewReader(firstData), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	secondData := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("second")}})
	second, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "1", Package: bytes.NewReader(secondData), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ListVersionFiles(context.Background(), first.Skill.SkillID, second.Version.VersionID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign version list error = %v", err)
	}
	if _, err := service.OpenVersionPackage(context.Background(), first.Skill.SkillID, second.Version.VersionID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign version package error = %v", err)
	}
	if _, err := service.ListVersionFiles(context.Background(), "", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty version identifiers error = %v", err)
	}
	for _, invalidPath := range []string{"", "../SKILL.md", "/SKILL.md", `docs\\guide.md`} {
		if _, err := service.ReadVersionFile(context.Background(), first.Skill.SkillID, first.Version.VersionID, invalidPath); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("ReadVersionFile(%q) error = %v", invalidPath, err)
		}
	}
	if _, err := service.ReadVersionFile(context.Background(), first.Skill.SkillID, first.Version.VersionID, "missing.md"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing file error = %v", err)
	}

	largeData := buildTestZIP(t, []testZIPEntry{
		{name: "SKILL.md", body: validSkillMD("large")},
		{name: "large.txt", body: strings.Repeat("x", int(MaxFilePreviewSize+1))},
	})
	large, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "2", Package: bytes.NewReader(largeData), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReadVersionFile(context.Background(), large.Skill.SkillID, large.Version.VersionID, "large.txt"); !errors.Is(err, ErrFileNotPreviewable) {
		t.Fatalf("large preview error = %v", err)
	}
}

func TestServiceRejectsCorruptedStoredVersionArchive(t *testing.T) {
	store := NewMemoryStore()
	root := t.TempDir()
	service := NewService(Config{Store: store, PackageRoot: root})
	data := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("valid")}})
	created, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "1", Package: bytes.NewReader(data), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, created.Version.PackagePath)
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	part, err := writer.Create("../outside.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("bad"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ListVersionFiles(context.Background(), created.Skill.SkillID, created.Version.VersionID); !errors.Is(err, ErrStoredPackageInvalid) {
		t.Fatalf("corrupted archive error = %v, want ErrStoredPackageInvalid", err)
	}
}

func TestServiceValidatesUploadFields(t *testing.T) {
	service := NewService(Config{Store: NewMemoryStore(), PackageRoot: t.TempDir()})
	data := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("valid")}})
	tests := []UploadVersionInput{
		{Version: "", Package: bytes.NewReader(data), CreatedBy: "admin"},
		{Version: " invalid", Package: bytes.NewReader(data), CreatedBy: "admin"},
		{Version: "1", Changelog: string(make([]rune, MaxChangelogRunes+1)), Package: bytes.NewReader(data), CreatedBy: "admin"},
		{Version: "1", Package: nil, CreatedBy: "admin"},
	}
	for _, input := range tests {
		if _, err := service.UploadVersion(context.Background(), input); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("UploadVersion(%#v) error = %v, want ErrInvalidRequest", input, err)
		}
	}
	if _, err := service.SetCurrentVersion(context.Background(), "", ""); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("SetCurrentVersion empty error = %v", err)
	}
	if _, err := service.ClearCurrentVersion(context.Background(), ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ClearCurrentVersion empty error = %v", err)
	}
	if _, err := service.GetAdmin(context.Background(), ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetAdmin empty error = %v", err)
	}
}

func TestServiceRejectsUnexpectedStoredPackagePath(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(Config{Store: store, PackageRoot: t.TempDir()})
	data := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("valid")}})
	created, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "1", Package: bytes.NewReader(data), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetCurrentVersion(context.Background(), created.Skill.SkillID, created.Version.VersionID); err != nil {
		t.Fatal(err)
	}
	store.versions[created.Skill.SkillID][0].PackagePath = "../outside.zip"
	if _, err := service.OpenCurrentPackage(context.Background(), created.Skill.SkillID); err == nil {
		t.Fatal("unexpected stored package path should fail")
	}
}

func TestPreparePackageRootCreatesWritableAbsoluteDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "nested", "packages")
	absolute, err := PreparePackageRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(absolute) {
		t.Fatalf("package root = %q, want absolute path", absolute)
	}
	if info, err := os.Stat(absolute); err != nil || !info.IsDir() {
		t.Fatalf("package root stat = %#v, %v", info, err)
	}
	if _, err := PreparePackageRoot(""); err == nil {
		t.Fatal("empty package root should fail")
	}
	filePath := filepath.Join(t.TempDir(), "package-root-file")
	if err := os.WriteFile(filePath, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := PreparePackageRoot(filepath.Join(filePath, "packages")); err == nil {
		t.Fatal("package root below a file should fail")
	}
}

func TestMemoryStoreAdminListUsesNewestUpdateFirst(t *testing.T) {
	store := NewMemoryStore()
	firstTime := time.Date(2026, 7, 27, 8, 0, 0, 0, time.UTC)
	secondTime := firstTime.Add(time.Hour)
	_, _, err := store.CreateVersion(context.Background(),
		Skill{SkillID: "skill-old", Name: "old", CreatedBy: "admin", CreatedAt: firstTime, UpdatedAt: firstTime},
		Version{VersionID: "version-old", Version: "1", Description: "old", CreatedAt: firstTime},
		CreateVersionOptions{Publish: true, Resolution: VersionResolutionByName},
	)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = store.CreateVersion(context.Background(),
		Skill{SkillID: "skill-new", Name: "new", CreatedBy: "admin", CreatedAt: secondTime, UpdatedAt: secondTime},
		Version{VersionID: "version-new", Version: "1", Description: "new", CreatedAt: secondTime},
		CreateVersionOptions{Publish: true, Resolution: VersionResolutionByName},
	)
	if err != nil {
		t.Fatal(err)
	}
	items, err := store.ListAdmin(context.Background())
	if err != nil || len(items) != 2 || items[0].SkillID != "skill-new" {
		t.Fatalf("ListAdmin() = %#v, %v", items, err)
	}
	detail, err := store.GetAdmin(context.Background(), "skill-old")
	if err != nil || detail.Skill.Description != "old" || len(detail.Versions) != 1 {
		t.Fatalf("GetAdmin() = %#v, %v", detail, err)
	}
}

func TestServiceMovesSkillsToSpaceAtomically(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(Config{Store: store, PackageRoot: t.TempDir()})
	target, err := service.CreateSpace(context.Background(), "产品技能", "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.UploadVersion(context.Background(), UploadVersionInput{Version: "1", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("first")}})), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.UploadVersion(context.Background(), UploadVersionInput{SpaceID: target.SpaceID, Version: "1", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("second")}})), CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}

	result, err := service.MoveSkillsToSpace(context.Background(), []string{" " + first.Skill.SkillID + " ", second.Skill.SkillID, first.Skill.SkillID}, target.SpaceID)
	if err != nil || result.MovedCount != 1 || result.UnchangedCount != 1 {
		t.Fatalf("MoveSkillsToSpace() = %#v, %v", result, err)
	}
	detail, err := service.GetAdmin(context.Background(), first.Skill.SkillID)
	if err != nil || detail.Skill.SpaceID != target.SpaceID || detail.Skill.CurrentVersionID == nil {
		t.Fatalf("moved skill = %#v, %v", detail, err)
	}

	if _, err := service.MoveSkillsToSpace(context.Background(), []string{first.Skill.SkillID, "missing"}, DefaultSpaceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("atomic move error = %v, want ErrNotFound", err)
	}
	detail, _ = service.GetAdmin(context.Background(), first.Skill.SkillID)
	if detail.Skill.SpaceID != target.SpaceID {
		t.Fatalf("skill moved after failed batch: %#v", detail.Skill)
	}
	if _, err := service.MoveSkillsToSpace(context.Background(), []string{first.Skill.SkillID}, "skillspace-missing"); !errors.Is(err, ErrSpaceNotFound) {
		t.Fatalf("missing target space error = %v, want ErrSpaceNotFound", err)
	}
	detail, _ = service.GetAdmin(context.Background(), first.Skill.SkillID)
	if detail.Skill.SpaceID != target.SpaceID {
		t.Fatalf("skill moved to missing space: %#v", detail.Skill)
	}
}

func TestMemoryStoreDistinguishesMissingAndForeignVersions(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)
	_, _, err := store.CreateVersion(context.Background(),
		Skill{SkillID: "skill-one", Name: "one", CreatedBy: "admin", CreatedAt: now, UpdatedAt: now},
		Version{VersionID: "version-one", Version: "1", Description: "one", CreatedAt: now},
		CreateVersionOptions{Publish: true, Resolution: VersionResolutionByName},
	)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = store.CreateVersion(context.Background(),
		Skill{SkillID: "skill-two", Name: "two", CreatedBy: "admin", CreatedAt: now, UpdatedAt: now},
		Version{VersionID: "version-two", Version: "1", Description: "two", CreatedAt: now},
		CreateVersionOptions{Publish: true, Resolution: VersionResolutionByName},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.SetCurrentVersion(context.Background(), "skill-one", "missing", now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing version error = %v", err)
	}
	if _, _, err := store.SetCurrentVersion(context.Background(), "skill-one", "version-two", now); !errors.Is(err, ErrConflict) {
		t.Fatalf("foreign version error = %v", err)
	}
}
