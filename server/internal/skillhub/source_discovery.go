package skillhub

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	maxSkillDiscoveryDepth = 12
	maxDiscoveredSkills    = 1000
)

type DiscoveredSkill struct {
	Path         string
	AbsolutePath string
}

type SkillDiscovery struct{}

func (d *SkillDiscovery) Discover(repositoryRoot, scanRoot string, excludes []string) ([]DiscoveredSkill, error) {
	root, err := filepath.Abs(repositoryRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve repository root: %w", err)
	}
	repository, err := openRepositoryRoot(root)
	if err != nil {
		return nil, fmt.Errorf("open repository root: %w", err)
	}
	defer repository.Close()
	scanPath, err := NormalizeRepositoryRelativePath(scanRoot, true)
	if err != nil {
		return nil, err
	}
	normalizedExcludes, err := NormalizeExcludePaths(excludes)
	if err != nil {
		return nil, err
	}
	if containsRepositoryPathSegment(scanPath, ".git") || excludedSkillPath(scanPath, normalizedExcludes) {
		return nil, errors.New("scan root is excluded")
	}
	start, startInfo, err := resolveRepositoryDirectory(repository, scanPath)
	if err != nil {
		return nil, fmt.Errorf("inspect scan root: %w", err)
	}

	var discovered []DiscoveredSkill
	var visit func(string, string, int, os.FileInfo) error
	visit = func(directory, relative string, depth int, expected os.FileInfo) error {
		if depth > maxSkillDiscoveryDepth {
			return fmt.Errorf("skill discovery exceeds maximum depth %d", maxSkillDiscoveryDepth)
		}
		entries, err := readVerifiedRepositoryDirectory(repository, directory, expected)
		if err != nil {
			return fmt.Errorf("read skill directory %q: %w", relative, err)
		}
		for _, entry := range entries {
			if entry.Name() != "SKILL.md" {
				continue
			}
			entryInfo, err := entry.Info()
			if err != nil {
				return err
			}
			if entryInfo.Mode().IsRegular() {
				discovered = append(discovered, DiscoveredSkill{Path: relative, AbsolutePath: filepath.Join(root, filepath.FromSlash(directory))})
				if len(discovered) > maxDiscoveredSkills {
					return fmt.Errorf("skill discovery exceeds maximum count %d", maxDiscoveredSkills)
				}
				return nil
			}
		}
		for _, entry := range entries {
			if entry.Name() == ".git" {
				continue
			}
			childRelative := entry.Name()
			if relative != "." {
				childRelative = relative + "/" + entry.Name()
			}
			if excludedSkillPath(childRelative, normalizedExcludes) {
				continue
			}
			child := filepath.Join(directory, entry.Name())
			entryInfo, err := entry.Info()
			if err != nil {
				return err
			}
			if entryInfo.IsDir() && entryInfo.Mode()&os.ModeSymlink == 0 {
				if err := visit(child, childRelative, depth+1, entryInfo); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := visit(start, scanPath, 0, startInfo); err != nil {
		return nil, err
	}
	sort.Slice(discovered, func(i, j int) bool { return discovered[i].Path < discovered[j].Path })
	return discovered, nil
}

func openRepositoryRoot(name string) (*os.Root, error) {
	info, err := os.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("repository root is not a directory")
	}
	root, err := os.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	openedInfo, err := root.Lstat(".")
	if err != nil || !os.SameFile(info, openedInfo) || !openedInfo.IsDir() {
		_ = root.Close()
		return nil, errors.New("repository root changed while opening")
	}
	return root, nil
}

func readVerifiedRepositoryDirectory(root *os.Root, name string, expected os.FileInfo) ([]os.DirEntry, error) {
	currentInfo, err := root.Lstat(name)
	if err != nil || !currentInfo.IsDir() || currentInfo.Mode()&os.ModeSymlink != 0 || !os.SameFile(expected, currentInfo) {
		return nil, errors.New("repository directory changed during traversal")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	openedInfo, err := file.Stat()
	if err != nil || !os.SameFile(expected, openedInfo) || !os.SameFile(currentInfo, openedInfo) || !openedInfo.IsDir() {
		_ = file.Close()
		return nil, errors.New("repository directory changed during traversal")
	}
	entries, readErr := file.ReadDir(-1)
	closeErr := file.Close()
	if readErr != nil {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return entries, nil
}

func resolveRepositoryDirectory(root *os.Root, relative string) (string, os.FileInfo, error) {
	current := "."
	info, err := root.Lstat(current)
	if err != nil {
		return "", nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", nil, errors.New("repository path is not a directory")
	}
	if relative == "." {
		return current, info, nil
	}
	for _, segment := range strings.Split(relative, "/") {
		current = filepath.Join(current, filepath.FromSlash(segment))
		info, err = root.Lstat(current)
		if err != nil {
			return "", nil, err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", nil, errors.New("repository path contains a non-directory or symbolic link")
		}
	}
	return current, info, nil
}

func containsRepositoryPathSegment(value, target string) bool {
	for _, segment := range strings.Split(value, "/") {
		if segment == target {
			return true
		}
	}
	return false
}

func excludedSkillPath(candidate string, excludes []string) bool {
	for _, excluded := range excludes {
		if candidate == excluded || strings.HasPrefix(candidate, excluded+"/") {
			return true
		}
	}
	return false
}
