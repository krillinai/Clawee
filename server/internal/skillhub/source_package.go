package skillhub

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const lfsPointerPrefix = "version https://git-lfs.github.com/spec/v1"

var errSourcePackageInvalid = errors.New("invalid source package")

type SourcePackageMetadata struct {
	ContentSHA256 string
	Size          int64
}

type SourcePackageBuilder struct{}

func (b *SourcePackageBuilder) Build(repositoryRoot string, skill DiscoveredSkill, gitlinks []string, output io.Writer) (SourcePackageMetadata, error) {
	if output == nil {
		return SourcePackageMetadata{}, errors.New("source package output is required")
	}
	repository, err := filepath.Abs(repositoryRoot)
	if err != nil {
		return SourcePackageMetadata{}, fmt.Errorf("resolve repository root: %w", err)
	}
	root, err := filepath.Abs(skill.AbsolutePath)
	if err != nil {
		return SourcePackageMetadata{}, fmt.Errorf("resolve skill root: %w", err)
	}
	relativeRoot, err := filepath.Rel(repository, root)
	if err != nil || relativeRoot == ".." || strings.HasPrefix(relativeRoot, ".."+string(filepath.Separator)) {
		return SourcePackageMetadata{}, errors.New("skill root is outside repository")
	}
	skillPath, err := NormalizeRepositoryRelativePath(skill.Path, true)
	if err != nil || skillPath != filepath.ToSlash(relativeRoot) {
		return SourcePackageMetadata{}, errors.New("skill path does not match skill root")
	}
	repositoryFS, err := openRepositoryRoot(repository)
	if err != nil {
		return SourcePackageMetadata{}, fmt.Errorf("open repository root: %w", err)
	}
	defer repositoryFS.Close()
	repositoryRelativeRoot := filepath.ToSlash(relativeRoot)
	root, rootInfo, err := resolveRepositoryDirectory(repositoryFS, repositoryRelativeRoot)
	if err != nil {
		return SourcePackageMetadata{}, fmt.Errorf("inspect skill root: %w", err)
	}
	for _, gitlink := range gitlinks {
		normalized := filepath.ToSlash(filepath.Clean(gitlink))
		if repositoryRelativeRoot == "." || normalized == repositoryRelativeRoot || strings.HasPrefix(normalized, repositoryRelativeRoot+"/") {
			return SourcePackageMetadata{}, sourcePackageInvalidf("source package contains gitlink %q", normalized)
		}
	}

	entries, err := collectSourcePackageEntries(repositoryFS, root, "", rootInfo)
	if err != nil {
		return SourcePackageMetadata{}, err
	}
	var uncompressedSize int64
	for _, entry := range entries {
		if entry.info.IsDir() {
			continue
		}
		if entry.info.Size() > MaxUncompressedSize-uncompressedSize {
			return SourcePackageMetadata{}, ErrPackageTooLarge
		}
		uncompressedSize += entry.info.Size()
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].relative < entries[j].relative })
	counted := &sourceCountingWriter{writer: output, limit: MaxPackageSize}
	archive := zip.NewWriter(counted)
	hash := sha256.New()
	for _, entry := range entries {
		if entry.info.IsDir() {
			if err := writeSourceHashFrame(hash, entry.relative, entry.info.Mode().Perm(), 0, nil); err != nil {
				_ = archive.Close()
				return SourcePackageMetadata{}, err
			}
			header := &zip.FileHeader{Name: entry.relative + "/", Method: zip.Store, Modified: time.Unix(0, 0).UTC()}
			header.SetMode(entry.info.Mode())
			if _, err := archive.CreateHeader(header); err != nil {
				_ = archive.Close()
				return SourcePackageMetadata{}, err
			}
			continue
		}
		if err := b.addFile(repositoryFS, entry.repositoryPath, entry.relative, entry.info, archive, hash); err != nil {
			_ = archive.Close()
			return SourcePackageMetadata{}, err
		}
	}
	if err := archive.Close(); err != nil {
		return SourcePackageMetadata{}, fmt.Errorf("close source package: %w", err)
	}
	return SourcePackageMetadata{ContentSHA256: fmt.Sprintf("%x", hash.Sum(nil)), Size: counted.size}, nil
}

type sourcePackageEntry struct {
	repositoryPath string
	relative       string
	info           os.FileInfo
}

func collectSourcePackageEntries(root *os.Root, directory, relative string, expected os.FileInfo) ([]sourcePackageEntry, error) {
	result := make([]sourcePackageEntry, 0)
	if err := collectSourcePackageEntriesInto(root, directory, relative, expected, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func collectSourcePackageEntriesInto(root *os.Root, directory, relative string, expected os.FileInfo, result *[]sourcePackageEntry) error {
	entries, err := readVerifiedRepositoryDirectory(root, directory, expected)
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if entry.Name() == ".git" {
			continue
		}
		entryPath := filepath.Join(directory, entry.Name())
		entryRelative := entry.Name()
		if relative != "" {
			entryRelative = relative + "/" + entry.Name()
		}
		if len(*result) >= MaxPackageEntries {
			return sourcePackageInvalidf("source package entries exceed %d", MaxPackageEntries)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
			return sourcePackageInvalidf("source package contains unsupported file %q", entryRelative)
		}
		*result = append(*result, sourcePackageEntry{repositoryPath: entryPath, relative: entryRelative, info: info})
		if info.IsDir() {
			if err := collectSourcePackageEntriesInto(root, entryPath, entryRelative, info, result); err != nil {
				return err
			}
		}
	}
	return nil
}

func (b *SourcePackageBuilder) addFile(root *os.Root, filename, relative string, info os.FileInfo, archive *zip.Writer, hash io.Writer) error {
	currentInfo, err := root.Lstat(filename)
	if err != nil || currentInfo.Mode()&os.ModeSymlink != 0 || !currentInfo.Mode().IsRegular() || !os.SameFile(info, currentInfo) {
		return errors.New("source package entry changed during build")
	}
	file, err := root.Open(filename)
	if err != nil {
		return err
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil || !os.SameFile(info, openedInfo) || !os.SameFile(currentInfo, openedInfo) || !openedInfo.Mode().IsRegular() {
		return errors.New("source package entry changed during build")
	}
	prefix := make([]byte, len(lfsPointerPrefix))
	n, err := io.ReadFull(file, prefix)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return err
	}
	if string(prefix[:n]) == lfsPointerPrefix {
		return sourcePackageInvalidf("source package contains Git LFS pointer %q", relative)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := writeSourceHashFrame(hash, relative, info.Mode().Perm(), uint64(info.Size()), nil); err != nil {
		return err
	}
	header := &zip.FileHeader{Name: relative, Method: zip.Deflate, Modified: time.Unix(0, 0).UTC()}
	header.SetMode(info.Mode())
	entry, err := archive.CreateHeader(header)
	if err != nil {
		return err
	}
	if _, err := io.Copy(io.MultiWriter(entry, hash), file); err != nil {
		return err
	}
	return nil
}

func sourcePackageInvalidf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errSourcePackageInvalid, fmt.Sprintf(format, args...))
}

func writeSourceHashFrame(output io.Writer, path string, mode os.FileMode, contentSize uint64, content []byte) error {
	pathBytes := []byte(path)
	var buffer [8]byte
	binary.BigEndian.PutUint64(buffer[:], uint64(len(pathBytes)))
	if _, err := output.Write(buffer[:]); err != nil {
		return err
	}
	if _, err := output.Write(pathBytes); err != nil {
		return err
	}
	var permissions [4]byte
	binary.BigEndian.PutUint32(permissions[:], uint32(mode.Perm()))
	if _, err := output.Write(permissions[:]); err != nil {
		return err
	}
	binary.BigEndian.PutUint64(buffer[:], contentSize)
	if _, err := output.Write(buffer[:]); err != nil {
		return err
	}
	if len(content) > 0 {
		_, err := output.Write(content)
		return err
	}
	return nil
}

type sourceCountingWriter struct {
	writer io.Writer
	size   int64
	limit  int64
}

func (w *sourceCountingWriter) Write(data []byte) (int, error) {
	overflow := false
	if w.limit > 0 {
		remaining := w.limit - w.size
		if remaining <= 0 {
			return 0, ErrPackageTooLarge
		}
		if int64(len(data)) > remaining {
			data = data[:remaining]
			overflow = true
		}
	}
	n, err := w.writer.Write(data)
	w.size += int64(n)
	if err == nil && n != len(data) {
		return n, io.ErrShortWrite
	}
	if err == nil && overflow {
		return n, ErrPackageTooLarge
	}
	return n, err
}
