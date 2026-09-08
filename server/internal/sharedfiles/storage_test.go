package sharedfiles

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFileSystemStorageStreamsAndRejectsTraversal(t *testing.T) {
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := "space_one/file_one/blob_one"
	size, digest, err := storage.Put(ctx, key, strings.NewReader("hello"), 5)
	if err != nil || size != 5 || digest != "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" {
		t.Fatalf("Put() = %d, %q, %v", size, digest, err)
	}
	reader, err := storage.Open(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	contents, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || string(contents) != "hello" {
		t.Fatalf("Open() = %q, %v", contents, err)
	}
	for _, invalid := range []string{"../outside", "space_one/file_one/../../outside", "/space_one/file_one/blob_one", "space_one/file_one/not-a-blob"} {
		if _, _, err := storage.Put(ctx, invalid, strings.NewReader("x"), 1); !errors.Is(err, ErrStorageUnavailable) {
			t.Fatalf("Put(%q) error = %v, want storage unavailable", invalid, err)
		}
	}
}

func TestFileSystemStorageEnforcesHardLimitAndCleansStaleTemp(t *testing.T) {
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := storage.Put(context.Background(), "space_one/file_one/blob_large", strings.NewReader("12345"), 4); !errors.Is(err, ErrFileTooLarge) {
		t.Fatalf("Put() error = %v, want file too large", err)
	}
	stale := filepath.Join(storage.Root(), ".tmp", "stale")
	fresh := filepath.Join(storage.Root(), ".tmp", "fresh")
	if err := os.WriteFile(stale, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fresh, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := os.Chtimes(stale, now.Add(-25*time.Hour), now.Add(-25*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := storage.CleanStaleTemp(now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale temp still exists: %v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("fresh temp removed: %v", err)
	}
}

func TestFileSystemStorageRejectsSymlinkComponents(t *testing.T) {
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(outside, "file_one"), 0o750); err != nil {
		t.Fatal(err)
	}
	outsideFile := filepath.Join(outside, "file_one", "blob_one")
	if err := os.WriteFile(outsideFile, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(storage.Root(), "space_one")); err != nil {
		t.Skipf("当前平台无法创建符号链接: %v", err)
	}
	ctx := context.Background()
	key := "space_one/file_one/blob_one"
	if _, _, err := storage.Put(ctx, key, strings.NewReader("changed"), 7); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("Put() error = %v, want storage unavailable", err)
	}
	if _, err := storage.Open(ctx, key); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("Open() error = %v, want storage unavailable", err)
	}
	if err := storage.Delete(ctx, key); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("Delete() error = %v, want storage unavailable", err)
	}
	contents, err := os.ReadFile(outsideFile)
	if err != nil || string(contents) != "outside" {
		t.Fatalf("outside file = %q, %v", contents, err)
	}
}

func TestFileSystemStoragePreservesUnexpectedEOF(t *testing.T) {
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	reader := io.MultiReader(strings.NewReader("short"), unexpectedEOFReader{})
	if _, _, err := storage.Put(context.Background(), "space_one/file_one/blob_one", reader, 10); !errors.Is(err, ErrContentLengthMismatch) {
		t.Fatalf("Put() error = %v, want content length mismatch", err)
	}
}

type unexpectedEOFReader struct{}

func (unexpectedEOFReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
