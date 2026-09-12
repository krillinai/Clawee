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
	Put(context.Context, string, io.Reader, PutOptions) (ObjectMetadata, error)
	Open(context.Context, string) (io.ReadCloser, error)
	Delete(context.Context, string) error
	Probe(context.Context) error
}

type PutOptions struct {
	DeclaredSize int64
	MaxBytes     int64
	ContentType  string
	FileID       string
	ProfileID    string
	SHA256       string
}

type ObjectMetadata struct {
	SizeBytes int64
	SHA256    string
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

func (s *FileSystemStorage) Put(ctx context.Context, storageKey string, src io.Reader, opts PutOptions) (ObjectMetadata, error) {
	finalPath, err := s.resolve(storageKey)
	if err != nil {
		return ObjectMetadata{}, err
	}
	if opts.DeclaredSize < 0 || opts.MaxBytes < 0 || opts.DeclaredSize > opts.MaxBytes {
		if opts.DeclaredSize > opts.MaxBytes {
			return ObjectMetadata{}, ErrFileTooLarge
		}
		return ObjectMetadata{}, ErrContentLengthMismatch
	}
	tmp, err := os.CreateTemp(filepath.Join(s.root, ".tmp"), "upload-")
	if err != nil {
		return ObjectMetadata{}, ErrStorageUnavailable
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	hash := sha256.New()
	reader := &contextReader{ctx: ctx, reader: src}
	size, copyErr := io.Copy(io.MultiWriter(tmp, hash), io.LimitReader(reader, opts.MaxBytes+1))
	closeErr := tmp.Close()
	if closeErr != nil {
		return ObjectMetadata{}, ErrStorageUnavailable
	}
	if errors.Is(copyErr, io.ErrUnexpectedEOF) {
		return ObjectMetadata{}, ErrContentLengthMismatch
	}
	if copyErr != nil {
		return ObjectMetadata{}, ErrStorageUnavailable
	}
	if size > opts.MaxBytes {
		return ObjectMetadata{}, ErrFileTooLarge
	}
	if size != opts.DeclaredSize {
		return ObjectMetadata{}, ErrContentLengthMismatch
	}
	if err := s.rejectSymlinkComponents(filepath.Dir(finalPath)); err != nil {
		return ObjectMetadata{}, err
	}
	if err := os.MkdirAll(filepath.Dir(finalPath), 0o750); err != nil {
		return ObjectMetadata{}, ErrStorageUnavailable
	}
	if err := s.rejectSymlinkComponents(filepath.Dir(finalPath)); err != nil {
		return ObjectMetadata{}, err
	}
	if err := os.Rename(tmpName, finalPath); err != nil {
		return ObjectMetadata{}, ErrStorageUnavailable
	}
	return ObjectMetadata{SizeBytes: size, SHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

func (s *FileSystemStorage) Probe(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	probe, err := os.CreateTemp(filepath.Join(s.root, ".tmp"), "probe-")
	if err != nil {
		return ErrStorageUnavailable
	}
	name := probe.Name()
	if _, err := probe.Write([]byte("clawee-storage-probe")); err != nil {
		_ = probe.Close()
		_ = os.Remove(name)
		return ErrStorageUnavailable
	}
	if err := probe.Close(); err != nil {
		_ = os.Remove(name)
		return ErrStorageUnavailable
	}
	if err := os.Remove(name); err != nil {
		return ErrStorageUnavailable
	}
	return nil
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
