package skillhub

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

const (
	maxRepositoryWorkspaceBytes int64 = 2 * 1024 * 1024 * 1024
	maxRepositoryUpdateTimeout        = 300 * time.Second
)

var (
	sourceIDPattern                = regexp.MustCompile(`^source_(?:[0-9a-f]{24}|[0-9]+)$`)
	ErrRepositoryWorkspaceTooLarge = errors.New("repository workspace exceeds size limit")
)

type repositoryCloneError struct {
	cause error
}

func (e *repositoryCloneError) Error() string {
	return "repository clone failed: " + e.cause.Error()
}

func (e *repositoryCloneError) Unwrap() error {
	return e.cause
}

func PrepareRepositoryRoot(root string) (string, error) {
	return PreparePackageRoot(root)
}

// RepositoryWorkspace owns the fixed on-disk checkout for one GitHub source.
type RepositoryWorkspace struct {
	root          string
	git           *GitClient
	repositoryURL func(string, string) string
	maxBytes      int64
	timeout       time.Duration
}

func NewRepositoryWorkspace(root string, git *GitClient) *RepositoryWorkspace {
	return &RepositoryWorkspace{
		root: root, git: git, repositoryURL: CanonicalGitHubURL,
		maxBytes: maxRepositoryWorkspaceBytes, timeout: maxRepositoryUpdateTimeout,
	}
}

func (w *RepositoryWorkspace) WorkspacePath(sourceID string) (string, error) {
	if w == nil || !sourceIDPattern.MatchString(sourceID) {
		return "", ErrInvalidRequest
	}
	return filepath.Join(w.root, sourceID, "repository"), nil
}

func (w *RepositoryWorkspace) Update(ctx context.Context, source GitHubSource, token string) (string, error) {
	if w == nil || w.git == nil || w.repositoryURL == nil {
		return "", errors.New("repository workspace is not configured")
	}
	if err := ValidateGitHubRepositoryPart(source.RepositoryOwner); err != nil {
		return "", err
	}
	if err := ValidateGitHubRepositoryPart(source.RepositoryName); err != nil {
		return "", err
	}
	timeout := w.timeout
	if timeout <= 0 || timeout > maxRepositoryUpdateTimeout {
		timeout = maxRepositoryUpdateTimeout
	}
	updateContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	path, err := w.WorkspacePath(source.SourceID)
	if err != nil {
		return "", err
	}
	repositoryURL := w.repositoryURL(source.RepositoryOwner, source.RepositoryName)
	if repositoryURL == "" {
		return "", errors.New("repository URL is empty")
	}

	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := w.prepareWorkspaceParent(source.SourceID); err != nil {
			return "", err
		}
		if err := w.git.Clone(updateContext, repositoryURL, source.Branch, path, token); err != nil {
			return "", &repositoryCloneError{cause: err}
		}
		if err := w.checkSize(updateContext, path); err != nil {
			return "", err
		}
		sha, err := w.git.ResolveFetchHead(updateContext, path)
		if err != nil {
			return "", err
		}
		if err := w.git.CheckoutDetached(updateContext, path, sha); err != nil {
			return "", err
		}
		return sha, nil
	}
	if err := w.validateExisting(updateContext, path, repositoryURL, info, err); err != nil {
		return "", err
	}
	if err := w.git.Fetch(updateContext, path, source.Branch, token); err != nil {
		return "", err
	}
	if err := w.checkSize(updateContext, path); err != nil {
		return "", err
	}
	sha, err := w.git.ResolveFetchHead(updateContext, path)
	if err != nil {
		return "", err
	}
	if err := w.git.CheckoutDetached(updateContext, path, sha); err != nil {
		return "", err
	}
	if err := w.checkSize(updateContext, path); err != nil {
		return "", err
	}
	return sha, nil
}

func (w *RepositoryWorkspace) UseExisting(ctx context.Context, source GitHubSource) (string, error) {
	if w == nil || w.git == nil || w.repositoryURL == nil {
		return "", errors.New("repository workspace is not configured")
	}
	if err := ValidateGitHubRepositoryPart(source.RepositoryOwner); err != nil {
		return "", err
	}
	if err := ValidateGitHubRepositoryPart(source.RepositoryName); err != nil {
		return "", err
	}
	timeout := w.timeout
	if timeout <= 0 || timeout > maxRepositoryUpdateTimeout {
		timeout = maxRepositoryUpdateTimeout
	}
	localContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	path, err := w.WorkspacePath(source.SourceID)
	if err != nil {
		return "", err
	}
	repositoryURL := w.repositoryURL(source.RepositoryOwner, source.RepositoryName)
	if repositoryURL == "" {
		return "", errors.New("repository URL is empty")
	}
	info, inspectErr := os.Lstat(path)
	if err := w.validateExisting(localContext, path, repositoryURL, info, inspectErr); err != nil {
		return "", err
	}
	if err := w.checkSize(localContext, path); err != nil {
		return "", err
	}
	return w.git.ResolveHead(localContext, path)
}

func (w *RepositoryWorkspace) validateExisting(ctx context.Context, path, repositoryURL string, info os.FileInfo, inspectErr error) error {
	if inspectErr != nil {
		return fmt.Errorf("inspect repository workspace: %w", inspectErr)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("repository workspace is not a directory")
	}
	if err := requireDirectory(filepath.Join(path, ".git")); err != nil {
		return fmt.Errorf("repository workspace git metadata is invalid: %w", err)
	}
	originURL, err := w.git.OriginURL(ctx, path)
	if err != nil {
		return err
	}
	if originURL != repositoryURL {
		return errors.New("repository workspace origin does not match source")
	}
	return w.git.Status(ctx, path)
}

func (w *RepositoryWorkspace) prepareWorkspaceParent(sourceID string) error {
	parent := filepath.Join(w.root, sourceID)
	info, err := os.Lstat(parent)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.Mkdir(parent, 0o750); err != nil {
			return fmt.Errorf("create repository workspace parent: %w", err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect repository workspace parent: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("repository workspace parent is not a directory")
	}
	return nil
}

func (w *RepositoryWorkspace) checkSize(ctx context.Context, root string) error {
	var total int64
	err := filepath.WalkDir(root, func(_ string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			total += info.Size()
			if total > w.maxBytes {
				return ErrRepositoryWorkspaceTooLarge
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("measure repository workspace: %w", err)
	}
	return nil
}

func requireDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("not a directory")
	}
	return nil
}
