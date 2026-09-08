package skillhub

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSourcePackageBuilderBuildDeterministicAndNormalizable(t *testing.T) {
	repository := t.TempDir()
	skillRoot := filepath.Join(repository, "skills", "example")
	writeDiscoveryFile(t, skillRoot, "SKILL.md", validSkillMD("example"))
	writeDiscoveryFile(t, skillRoot, "scripts/run.sh", "#!/bin/sh\necho ok\n")
	writeDiscoveryFile(t, skillRoot, "scripts.txt", "sibling\n")
	if err := os.Chmod(filepath.Join(skillRoot, "scripts", "run.sh"), 0o755); err != nil {
		t.Fatal(err)
	}

	builder := &SourcePackageBuilder{}
	var first bytes.Buffer
	metadata, err := builder.Build(repository, DiscoveredSkill{Path: "skills/example", AbsolutePath: skillRoot}, nil, &first)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	var second bytes.Buffer
	secondMetadata, err := builder.Build(repository, DiscoveredSkill{Path: "skills/example", AbsolutePath: skillRoot}, nil, &second)
	if err != nil {
		t.Fatalf("Build() second error = %v", err)
	}
	if metadata != secondMetadata || !bytes.Equal(first.Bytes(), second.Bytes()) {
		t.Fatalf("Build() is not deterministic: %#v %#v", metadata, secondMetadata)
	}
	if metadata.Size != int64(first.Len()) || metadata.ContentSHA256 == "" {
		t.Fatalf("metadata = %#v", metadata)
	}
	archive, err := zip.NewReader(bytes.NewReader(first.Bytes()), int64(first.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := zipNames(archive), []string{"SKILL.md", "scripts/", "scripts.txt", "scripts/run.sh"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ZIP names = %v, want %v", got, want)
	}
	var normalized bytes.Buffer
	if _, err := NormalizePackage(bytes.NewReader(first.Bytes()), int64(first.Len()), &normalized); err != nil {
		t.Fatalf("NormalizePackage() error = %v", err)
	}

	writeDiscoveryFile(t, skillRoot, "scripts/run.sh", "#!/bin/sh\necho changed\n")
	var changed bytes.Buffer
	changedMetadata, err := builder.Build(repository, DiscoveredSkill{Path: "skills/example", AbsolutePath: skillRoot}, nil, &changed)
	if err != nil {
		t.Fatal(err)
	}
	if changedMetadata.ContentSHA256 == metadata.ContentSHA256 {
		t.Fatal("content change did not change ContentSHA256")
	}
	if err := os.Chmod(filepath.Join(skillRoot, "scripts", "run.sh"), 0o644); err != nil {
		t.Fatal(err)
	}
	var modeChanged bytes.Buffer
	modeMetadata, err := builder.Build(repository, DiscoveredSkill{Path: "skills/example", AbsolutePath: skillRoot}, nil, &modeChanged)
	if err != nil {
		t.Fatal(err)
	}
	if modeMetadata.ContentSHA256 == changedMetadata.ContentSHA256 {
		t.Fatal("permission change did not change ContentSHA256")
	}
	if err := os.Rename(filepath.Join(skillRoot, "scripts", "run.sh"), filepath.Join(skillRoot, "scripts", "renamed.sh")); err != nil {
		t.Fatal(err)
	}
	var pathChanged bytes.Buffer
	pathMetadata, err := builder.Build(repository, DiscoveredSkill{Path: "skills/example", AbsolutePath: skillRoot}, nil, &pathChanged)
	if err != nil {
		t.Fatal(err)
	}
	if pathMetadata.ContentSHA256 == modeMetadata.ContentSHA256 {
		t.Fatal("path change did not change ContentSHA256")
	}
}

func TestSourcePackageBuilderRejectsIntermediateSymlink(t *testing.T) {
	repository := t.TempDir()
	outside := t.TempDir()
	writeDiscoveryFile(t, outside, "skill/SKILL.md", validSkillMD("outside"))
	if err := os.Symlink(outside, filepath.Join(repository, "link")); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer

	if _, err := (&SourcePackageBuilder{}).Build(repository, DiscoveredSkill{Path: "link/skill", AbsolutePath: filepath.Join(repository, "link", "skill")}, nil, &output); err == nil {
		t.Fatal("Build() followed an intermediate symlink outside the repository")
	}
}

func TestSourcePackageBuilderBuildRejectsUnsafeEntries(t *testing.T) {
	tests := []struct {
		name    string
		prepare func(t *testing.T, root string) []string
	}{
		{name: "symbolic link", prepare: func(t *testing.T, root string) []string {
			if err := os.Symlink("SKILL.md", filepath.Join(root, "link")); err != nil {
				t.Fatal(err)
			}
			return nil
		}},
		{name: "gitlink", prepare: func(_ *testing.T, _ string) []string { return []string{"skills/example/submodule"} }},
		{name: "special file", prepare: func(t *testing.T, root string) []string {
			listener, err := net.Listen("unix", filepath.Join(root, "socket"))
			if err != nil {
				t.Skipf("unix socket unavailable: %v", err)
			}
			t.Cleanup(func() { _ = listener.Close() })
			return nil
		}},
		{name: "lfs pointer", prepare: func(t *testing.T, root string) []string {
			writeDiscoveryFile(t, root, "asset.bin", "version https://git-lfs.github.com/spec/v1\noid sha256:abc\n")
			return nil
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repository := t.TempDir()
			skillRoot := filepath.Join(repository, "skills", "example")
			writeDiscoveryFile(t, skillRoot, "SKILL.md", validSkillMD("example"))
			gitlinks := tt.prepare(t, skillRoot)
			var output bytes.Buffer
			_, err := (&SourcePackageBuilder{}).Build(repository, DiscoveredSkill{Path: "skills/example", AbsolutePath: skillRoot}, gitlinks, &output)
			if err == nil || errors.Is(err, ErrPackageTooLarge) {
				t.Fatalf("Build() error = %v, want unsafe entry failure", err)
			}
		})
	}
}

func TestSourcePackageBuilderRejectsUnmaterializedGitlinkForRootSkill(t *testing.T) {
	repository := t.TempDir()
	writeDiscoveryFile(t, repository, "SKILL.md", validSkillMD("root"))
	var output bytes.Buffer

	if _, err := (&SourcePackageBuilder{}).Build(repository, DiscoveredSkill{Path: ".", AbsolutePath: repository}, []string{"modules/one"}, &output); !errors.Is(err, errSourcePackageInvalid) {
		t.Fatalf("Build() error = %v, want errSourcePackageInvalid", err)
	}
}

func TestSourcePackageBuilderStopsTraversalWhenEntriesExceedLimit(t *testing.T) {
	repository := t.TempDir()
	skillRoot := filepath.Join(repository, "skills", "example")
	writeDiscoveryFile(t, skillRoot, "SKILL.md", validSkillMD("example"))
	for index := 0; index < MaxPackageEntries; index++ {
		writeDiscoveryFile(t, skillRoot, fmt.Sprintf("files/%04d.txt", index), "x")
	}
	if err := os.Mkdir(filepath.Join(skillRoot, "z-after-limit"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("missing", filepath.Join(skillRoot, "z-after-limit", "unsafe-link")); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer

	_, err := (&SourcePackageBuilder{}).Build(repository, DiscoveredSkill{Path: "skills/example", AbsolutePath: skillRoot}, nil, &output)
	if err == nil || !strings.Contains(err.Error(), "entries exceed") {
		t.Fatalf("Build() error = %v, want entry limit failure before z-after-limit traversal", err)
	}
	if output.Len() != 0 {
		t.Fatalf("Build() wrote %d bytes before rejecting entry count", output.Len())
	}
}

func TestSourcePackageBuilderCapsCandidateArchiveSize(t *testing.T) {
	repository := t.TempDir()
	skillRoot := filepath.Join(repository, "skills", "example")
	writeDiscoveryFile(t, skillRoot, "SKILL.md", validSkillMD("example"))
	asset, err := os.Create(filepath.Join(skillRoot, "asset.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.CopyN(asset, rand.Reader, MaxPackageSize+(1<<20)); err != nil {
		_ = asset.Close()
		t.Fatal(err)
	}
	if err := asset.Close(); err != nil {
		t.Fatal(err)
	}
	output := &sourceCountingWriter{writer: io.Discard}

	_, err = (&SourcePackageBuilder{}).Build(repository, DiscoveredSkill{Path: "skills/example", AbsolutePath: skillRoot}, nil, output)
	if !errors.Is(err, ErrPackageTooLarge) {
		t.Fatalf("Build() error = %v, want ErrPackageTooLarge", err)
	}
	if output.size > MaxPackageSize {
		t.Fatalf("Build() wrote %d bytes, limit %d", output.size, MaxPackageSize)
	}
}

func zipNames(archive *zip.Reader) []string {
	names := make([]string, len(archive.File))
	for i, file := range archive.File {
		names[i] = file.Name
	}
	return names
}
