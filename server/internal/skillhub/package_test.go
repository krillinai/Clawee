package skillhub

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
)

func TestValidatePackageAcceptsValidSkillPackage(t *testing.T) {
	data := buildTestZIP(t, []testZIPEntry{
		{name: "SKILL.md", body: "---\nname: code-review\ndescription: 企业代码审查规范\n---\n# Code Review\n"},
		{name: "scripts/", dir: true},
		{name: "scripts/check.sh", body: "#!/bin/sh\n"},
	})

	metadata, err := ValidatePackage(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("ValidatePackage() error = %v", err)
	}
	if metadata.Name != "code-review" || metadata.Description != "企业代码审查规范" {
		t.Fatalf("metadata = %#v", metadata)
	}
}

func TestValidatePackageAcceptsSingleWrapperDirectory(t *testing.T) {
	data := buildTestZIP(t, []testZIPEntry{
		{name: "implementation-review/", dir: true},
		{name: "implementation-review/SKILL.md", body: "---\nname: implementation-review\ndescription: 实现审查规范\n---\n"},
		{name: "implementation-review/agents/", dir: true},
		{name: "implementation-review/agents/reviewer.md", body: "review instructions"},
	})

	metadata, err := ValidatePackage(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("ValidatePackage() error = %v", err)
	}
	if metadata.Name != "implementation-review" || metadata.Description != "实现审查规范" {
		t.Fatalf("metadata = %#v", metadata)
	}
}

func TestValidatePackageRejectsInvalidArchives(t *testing.T) {
	tests := []struct {
		name       string
		entries    []testZIPEntry
		wantReason string
	}{
		{name: "nested wrapper", entries: []testZIPEntry{{name: "outer/wrapper/SKILL.md", body: validSkillMD("wrapped")}}, wantReason: "仅支持一层顶层包装目录"},
		{name: "entry outside wrapper", entries: []testZIPEntry{{name: "wrapper/SKILL.md", body: validSkillMD("wrapped")}, {name: "README.md", body: "readme"}}, wantReason: "不能包含该目录之外的条目"},
		{name: "path traversal", entries: []testZIPEntry{{name: "SKILL.md", body: validSkillMD("valid")}, {name: "../secret", body: "x"}}, wantReason: "包含不安全的上级目录路径"},
		{name: "backslash path", entries: []testZIPEntry{{name: "SKILL.md", body: validSkillMD("valid")}, {name: `scripts\run.sh`, body: "x"}}, wantReason: "路径必须使用正斜杠"},
		{name: "absolute path", entries: []testZIPEntry{{name: "SKILL.md", body: validSkillMD("valid")}, {name: "/etc/passwd", body: "x"}}, wantReason: "包含绝对路径"},
		{name: "windows drive path", entries: []testZIPEntry{{name: "SKILL.md", body: validSkillMD("valid")}, {name: "C:/temp/file", body: "x"}}, wantReason: "包含 Windows 盘符路径"},
		{name: "windows drive relative path", entries: []testZIPEntry{{name: "SKILL.md", body: validSkillMD("valid")}, {name: "C:temp/file", body: "x"}}, wantReason: "包含 Windows 盘符路径"},
		{name: "symlink", entries: []testZIPEntry{{name: "SKILL.md", body: validSkillMD("valid")}, {name: "link", body: "target", mode: os.ModeSymlink | 0o777}}, wantReason: "不支持符号链接或其他特殊文件"},
		{name: "duplicate frontmatter field", entries: []testZIPEntry{{name: "SKILL.md", body: "---\nname: first\nname: second\ndescription: desc\n---\n"}}, wantReason: "frontmatter 存在重复字段 name"},
		{name: "nested duplicate frontmatter field", entries: []testZIPEntry{{name: "SKILL.md", body: "---\nname: valid\ndescription: desc\nmetadata:\n  owner: first\n  owner: second\n---\n"}}, wantReason: "frontmatter 存在重复字段 owner"},
		{name: "invalid name", entries: []testZIPEntry{{name: "SKILL.md", body: "---\nname: Invalid_Name\ndescription: desc\n---\n"}}, wantReason: "name 仅允许小写字母、数字和连字符"},
		{name: "name with surrounding whitespace", entries: []testZIPEntry{{name: "SKILL.md", body: "---\nname: ' valid '\ndescription: desc\n---\n"}}, wantReason: "name 仅允许小写字母、数字和连字符"},
		{name: "non string description", entries: []testZIPEntry{{name: "SKILL.md", body: "---\nname: valid\ndescription: 123\n---\n"}}, wantReason: "description 必须是字符串"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data := buildTestZIP(t, tt.entries)
			_, err := ValidatePackage(bytes.NewReader(data), int64(len(data)))
			if !errors.Is(err, ErrPackageInvalid) {
				t.Fatalf("ValidatePackage() error = %v, want ErrPackageInvalid", err)
			}
			if !strings.Contains(err.Error(), tt.wantReason) {
				t.Fatalf("ValidatePackage() error = %q, want reason %q", err, tt.wantReason)
			}
		})
	}
}

func TestValidatePackageRejectsTooManyEntries(t *testing.T) {
	entries := make([]testZIPEntry, 0, MaxPackageEntries+1)
	entries = append(entries, testZIPEntry{name: "SKILL.md", body: validSkillMD("valid")})
	for i := 1; i <= MaxPackageEntries; i++ {
		entries = append(entries, testZIPEntry{name: "assets/file-" + testNumber(i), body: "x"})
	}
	data := buildTestZIP(t, entries)

	_, err := ValidatePackage(bytes.NewReader(data), int64(len(data)))
	if !errors.Is(err, ErrPackageInvalid) {
		t.Fatalf("ValidatePackage() error = %v, want ErrPackageInvalid", err)
	}
	if !strings.Contains(err.Error(), "ZIP 文件条目不能超过 2000 个") {
		t.Fatalf("ValidatePackage() error = %q", err)
	}
}

func TestNormalizePackageRemovesMacOSMetadata(t *testing.T) {
	data := buildTestZIP(t, []testZIPEntry{
		{name: "wrapper/", dir: true},
		{name: "wrapper/SKILL.md", body: validSkillMD("wrapped")},
		{name: "wrapper/.env", body: "BUSINESS_VALUE=1\n"},
		{name: "wrapper/scripts/", dir: true},
		{name: "wrapper/scripts/run.sh", body: "#!/bin/sh\n", mode: 0o755},
		{name: "__MACOSX/", dir: true},
		{name: "__MACOSX/wrapper/._SKILL.md", body: "metadata"},
		{name: "wrapper/.DS_Store", body: "metadata"},
		{name: "wrapper/scripts/._run.sh", body: "metadata"},
		{name: "wrapper/._cache/", dir: true},
		{name: "wrapper/._cache/content", body: "metadata"},
	})

	var normalized bytes.Buffer
	metadata, err := NormalizePackage(bytes.NewReader(data), int64(len(data)), &normalized)
	if err != nil {
		t.Fatalf("NormalizePackage() error = %v", err)
	}
	if metadata.Name != "wrapped" {
		t.Fatalf("metadata = %#v", metadata)
	}

	archive, err := zip.NewReader(bytes.NewReader(normalized.Bytes()), int64(normalized.Len()))
	if err != nil {
		t.Fatal(err)
	}
	wantNames := []string{"wrapper/", "wrapper/SKILL.md", "wrapper/.env", "wrapper/scripts/", "wrapper/scripts/run.sh"}
	if len(archive.File) != len(wantNames) {
		t.Fatalf("normalized entries = %d, want %d", len(archive.File), len(wantNames))
	}
	for i, file := range archive.File {
		if file.Name != wantNames[i] {
			t.Fatalf("normalized entry %d = %q, want %q", i, file.Name, wantNames[i])
		}
		if file.Name == "wrapper/scripts/run.sh" && file.Mode().Perm() != 0o755 {
			t.Fatalf("run.sh mode = %o, want 755", file.Mode().Perm())
		}
		if file.Name == "wrapper/.env" && string(readZIPFile(t, file)) != "BUSINESS_VALUE=1\n" {
			t.Fatalf(".env content was not preserved")
		}
	}
}

func TestNormalizePackageRejectsNonMetadataOutsideWrapper(t *testing.T) {
	tests := []struct {
		name       string
		entry      testZIPEntry
		wantReason string
	}{
		{name: "business file", entry: testZIPEntry{name: "README.md", body: "readme"}, wantReason: "不能包含该目录之外的条目"},
		{name: "other hidden file", entry: testZIPEntry{name: ".env", body: "secret"}, wantReason: "不能包含该目录之外的条目"},
		{name: "DS Store directory", entry: testZIPEntry{name: ".DS_Store/", dir: true}, wantReason: "不能包含该目录之外的条目"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data := buildTestZIP(t, []testZIPEntry{
				{name: "wrapper/SKILL.md", body: validSkillMD("wrapped")},
				tt.entry,
			})
			var normalized bytes.Buffer
			_, err := NormalizePackage(bytes.NewReader(data), int64(len(data)), &normalized)
			if !errors.Is(err, ErrPackageInvalid) || !strings.Contains(err.Error(), tt.wantReason) {
				t.Fatalf("NormalizePackage() error = %v, want reason %q", err, tt.wantReason)
			}
		})
	}
}

func TestNormalizePackageRejectsInvalidMetadataEntries(t *testing.T) {
	tests := []struct {
		name       string
		entries    []testZIPEntry
		wantReason string
	}{
		{
			name:       "path traversal",
			entries:    []testZIPEntry{{name: "__MACOSX/../outside", body: "metadata"}},
			wantReason: "包含不安全的上级目录路径",
		},
		{
			name:       "symlink",
			entries:    []testZIPEntry{{name: "__MACOSX/link", body: "target", mode: os.ModeSymlink | 0o777}},
			wantReason: "不支持符号链接或其他特殊文件",
		},
		{
			name: "duplicate normalized path",
			entries: []testZIPEntry{
				{name: "__MACOSX/data", body: "one"},
				{name: "__MACOSX/data/", dir: true},
			},
			wantReason: "存在重复路径",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			entries := append([]testZIPEntry{{name: "SKILL.md", body: validSkillMD("valid")}}, tt.entries...)
			data := buildTestZIP(t, entries)
			var normalized bytes.Buffer
			_, err := NormalizePackage(bytes.NewReader(data), int64(len(data)), &normalized)
			if !errors.Is(err, ErrPackageInvalid) || !strings.Contains(err.Error(), tt.wantReason) {
				t.Fatalf("NormalizePackage() error = %v, want reason %q", err, tt.wantReason)
			}
		})
	}
}

func TestNormalizePackageCountsMetadataEntries(t *testing.T) {
	entries := make([]testZIPEntry, 0, MaxPackageEntries+1)
	entries = append(entries, testZIPEntry{name: "SKILL.md", body: validSkillMD("valid")})
	for i := 0; i < MaxPackageEntries; i++ {
		entries = append(entries, testZIPEntry{name: "__MACOSX/file-" + testNumber(i), body: "x"})
	}
	data := buildTestZIP(t, entries)
	var normalized bytes.Buffer

	_, err := NormalizePackage(bytes.NewReader(data), int64(len(data)), &normalized)
	if !errors.Is(err, ErrPackageInvalid) || !strings.Contains(err.Error(), "ZIP 文件条目不能超过 2000 个") {
		t.Fatalf("NormalizePackage() error = %v", err)
	}
}

func TestNormalizePackageReadsMetadataFilesForCRC(t *testing.T) {
	const payload = "metadata-crc-payload"
	data := buildTestZIP(t, []testZIPEntry{
		{name: "SKILL.md", body: validSkillMD("valid")},
		{name: "__MACOSX/metadata", body: payload, store: true},
	})
	corrupted := append([]byte(nil), data...)
	index := bytes.Index(corrupted, []byte(payload))
	if index < 0 {
		t.Fatal("metadata payload not found in test ZIP")
	}
	corrupted[index] ^= 0xff

	var normalized bytes.Buffer
	_, err := NormalizePackage(bytes.NewReader(corrupted), int64(len(corrupted)), &normalized)
	if !errors.Is(err, ErrPackageInvalid) || !strings.Contains(err.Error(), "无法读取 ZIP 中的文件") {
		t.Fatalf("NormalizePackage() error = %v, want CRC read failure", err)
	}
}

type testZIPEntry struct {
	name  string
	body  string
	dir   bool
	mode  os.FileMode
	store bool
}

func buildTestZIP(t *testing.T, entries []testZIPEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Deflate}
		if entry.store {
			header.Method = zip.Store
		}
		if entry.dir {
			header.SetMode(0o755 | 0o040000)
		} else if entry.mode != 0 {
			header.SetMode(entry.mode)
		} else {
			header.SetMode(0o644)
		}
		part, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte(entry.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func readZIPFile(t *testing.T, file *zip.File) []byte {
	t.Helper()
	reader, err := file.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func validSkillMD(name string) string {
	return "---\nname: " + name + "\ndescription: test description\n---\n"
}

func testNumber(value int) string {
	const digits = "0123456789"
	if value == 0 {
		return "0"
	}
	var out [20]byte
	index := len(out)
	for value > 0 {
		index--
		out[index] = digits[value%10]
		value /= 10
	}
	return string(out[index:])
}
