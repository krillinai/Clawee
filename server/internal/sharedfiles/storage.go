package sharedfiles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Storage interface {
	Put(context.Context, string, io.Reader, int64) (int64, string, error)
	Open(context.Context, string) (io.ReadCloser, error)
	Delete(context.Context, string) error
}

type FileSystemStorage struct {
	root string
}

func NewFileSystemStorage(root string) (*FileSystemStorage, error) {
	abs, err := filepath.Abs(strings.TrimSpace(root))
	if err != nil || strings.TrimSpace(root) == "" {
		return nil, ErrStorageUnavailable
	}
	if err := os.MkdirAll(filepath.Join(abs, ".tmp"), 0o750); err != nil {
		return nil, ErrStorageUnavailable
	}
	probe, err := os.CreateTemp(filepath.Join(abs, ".tmp"), "probe-")
	if err != nil {
		return nil, ErrStorageUnavailable
	}
	probeName := probe.Name()
	if closeErr := probe.Close(); closeErr != nil {
		_ = os.Remove(probeName)
		return nil, ErrStorageUnavailable
	}
	if err := os.Remove(probeName); err != nil {
		return nil, ErrStorageUnavailable
	}
	return &FileSystemStorage{root: abs}, nil
}

func (s *FileSystemStorage) Root() string { return s.root }

func (s *FileSystemStorage) Put(ctx context.Context, storageKey string, src io.Reader, maxBytes int64) (int64, string, error) {
	finalPath, err := s.resolve(storageKey)
	if err != nil {
		return 0, "", err
	}
	tmp, err := os.CreateTemp(filepath.Join(s.root, ".tmp"), "upload-")
	if err != nil {
		return 0, "", ErrStorageUnavailable
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	hash := sha256.New()
	reader := &contextReader{ctx: ctx, reader: src}
	size, copyErr := io.Copy(io.MultiWriter(tmp, hash), io.LimitReader(reader, maxBytes+1))
	closeErr := tmp.Close()
	if closeErr != nil {
		return 0, "", ErrStorageUnavailable
	}
	if errors.Is(copyErr, io.ErrUnexpectedEOF) {
		return 0, "", ErrContentLengthMismatch
	}
	if copyErr != nil {
		return 0, "", ErrStorageUnavailable
	}
	if size > maxBytes {
		return 0, "", ErrFileTooLarge
	}
	if err := s.rejectSymlinkComponents(filepath.Dir(finalPath)); err != nil {
		return 0, "", err
	}
	if err := os.MkdirAll(filepath.Dir(finalPath), 0o750); err != nil {
		return 0, "", ErrStorageUnavailable
	}
	if err := s.rejectSymlinkComponents(filepath.Dir(finalPath)); err != nil {
		return 0, "", err
	}
	if err := os.Rename(tmpName, finalPath); err != nil {
		return 0, "", ErrStorageUnavailable
	}
	return size, hex.EncodeToString(hash.Sum(nil)), nil
}

func (s *FileSystemStorage) Open(ctx context.Context, storageKey string) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path, err := s.resolve(storageKey)
	if err != nil {
		return nil, err
	}
	if err := s.rejectSymlinkComponents(path); err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, ErrStorageUnavailable
	}
	return file, nil
}

func (s *FileSystemStorage) Delete(ctx context.Context, storageKey string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	path, err := s.resolve(storageKey)
	if err != nil {
		return err
	}
	if err := s.rejectSymlinkComponents(path); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return ErrStorageUnavailable
	}
	return nil
}

func (s *FileSystemStorage) CleanStaleTemp(now time.Time) error {
	entries, err := os.ReadDir(filepath.Join(s.root, ".tmp"))
	if err != nil {
		return ErrStorageUnavailable
	}
	cutoff := now.Add(-24 * time.Hour)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.ModTime().Before(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(s.root, ".tmp", entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			return ErrStorageUnavailable
		}
	}
	return nil
}

func (s *FileSystemStorage) resolve(storageKey string) (string, error) {
	parts := strings.Split(storageKey, "/")
	if len(parts) != 3 || !strings.HasPrefix(parts[0], "space_") || !strings.HasPrefix(parts[1], "file_") || !strings.HasPrefix(parts[2], "blob_") {
		return "", ErrStorageUnavailable
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\\x00") {
			return "", ErrStorageUnavailable
		}
	}
	path := filepath.Join(append([]string{s.root}, parts...)...)
	rel, err := filepath.Rel(s.root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", ErrStorageUnavailable
	}
	return path, nil
}

func (s *FileSystemStorage) rejectSymlinkComponents(target string) error {
	rel, err := filepath.Rel(s.root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return ErrStorageUnavailable
	}
	current := s.root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "" || part == "." {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return ErrStorageUnavailable
		}
	}
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}
