package skillhub

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const repositoryWorkspaceTestSourceID = "source_0123456789abcdef01234567"

func TestPrepareRepositoryRootCreatesWritableAbsoluteDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "nested", "repositories")
	absolute, err := PrepareRepositoryRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(absolute) {
		t.Fatalf("repository root = %q, want absolute path", absolute)
	}
	if info, err := os.Stat(absolute); err != nil || !info.IsDir() {
		t.Fatalf("repository root stat = %#v, %v", info, err)
	}
}

func TestRepositoryWorkspaceRejectsNonGeneratedSourceID(t *testing.T) {
	workspace := NewRepositoryWorkspace(t.TempDir(), NewGitClient("git", time.Minute, 64*1024, nil))
	if _, err := workspace.WorkspacePath("../../outside"); err == nil {
		t.Fatal("WorkspacePath() accepted non-generated source id")
	}
}

func TestRepositoryWorkspaceEnforcesTotalUpdateTimeout(t *testing.T) {
	root, err := PrepareRepositoryRoot(filepath.Join(t.TempDir(), "repositories"))
	if err != nil {
		t.Fatal(err)
	}
	client := NewGitClient("git", time.Hour, 128*1024, nil)
	client.runner = func(ctx context.Context, command gitCommand) (gitCommandResult, error) {
		if len(command.args) > 0 && command.args[0] == "check-ref-format" {
			return gitCommandResult{}, nil
		}
		<-ctx.Done()
		return gitCommandResult{}, ctx.Err()
	}
	workspace := NewRepositoryWorkspace(root, client)
	if workspace.timeout != 300*time.Second {
		t.Fatalf("workspace timeout = %s, want 300s", workspace.timeout)
	}
	workspace.timeout = 20 * time.Millisecond
	workspace.repositoryURL = func(_, _ string) string { return "file:///unused.git" }

	_, err = workspace.Update(context.Background(), testGitHubSource(), "")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Update() error = %v, want deadline exceeded", err)
	}
}

func TestRepositoryWorkspaceClonesAndUpdatesFixedDirectory(t *testing.T) {
	remote, remoteURL, initialSHA := createGitRemote(t)
	workspace := testRepositoryWorkspace(t, remoteURL)
	source := testGitHubSource()

	got, err := workspace.Update(context.Background(), source, "")
	if err != nil {
		t.Fatal(err)
	}
	if got != initialSHA {
		t.Fatalf("first Update() = %q, want %q", got, initialSHA)
	}
	path, err := workspace.WorkspacePath(source.SourceID)
	if err != nil {
		t.Fatal(err)
	}
	if count := runGit(t, path, "rev-list", "--count", "HEAD"); count != "1" {
		t.Fatalf("shallow clone commit count = %q, want 1", count)
	}
	if err := runGitError(path, "symbolic-ref", "-q", "HEAD"); err == nil {
		t.Fatal("HEAD remains attached after initial clone")
	}

	updatedSHA := forceUpdateRemote(t, remote, "second\n")
	got, err = workspace.Update(context.Background(), source, "")
	if err != nil {
		t.Fatal(err)
	}
	if got != updatedSHA || runGit(t, path, "rev-parse", "HEAD") != updatedSHA {
		t.Fatalf("second Update() = %q, HEAD = %q, want %q", got, runGit(t, path, "rev-parse", "HEAD"), updatedSHA)
	}
	if err := runGitError(path, "symbolic-ref", "-q", "HEAD"); err == nil {
		t.Fatal("HEAD remains attached after update")
	}
}

func TestRepositoryWorkspaceRejectsDirtyRepositoryWithoutRepair(t *testing.T) {
	tests := []struct {
		name  string
		setup func(t *testing.T, path string)
	}{
		{name: "tracked", setup: func(t *testing.T, path string) { writeFile(t, filepath.Join(path, "SKILL.md"), "changed\n") }},
		{name: "untracked", setup: func(t *testing.T, path string) { writeFile(t, filepath.Join(path, "new.txt"), "new\n") }},
		{name: "ignored", setup: func(t *testing.T, path string) {
			writeFile(t, filepath.Join(path, ".git", "info", "exclude"), "ignored.txt\n")
			writeFile(t, filepath.Join(path, "ignored.txt"), "ignored\n")
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, remoteURL, _ := createGitRemote(t)
			workspace := testRepositoryWorkspace(t, remoteURL)
			source := testGitHubSource()
			if _, err := workspace.Update(context.Background(), source, ""); err != nil {
				t.Fatal(err)
			}
			path, _ := workspace.WorkspacePath(source.SourceID)
			tt.setup(t, path)
			if _, err := workspace.Update(context.Background(), source, ""); err == nil {
				t.Fatal("Update() accepted dirty workspace")
			}
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("workspace was removed: %v", err)
			}
		})
	}
}

func TestRepositoryWorkspaceUsesExistingRepositoryWithoutFetch(t *testing.T) {
	_, remoteURL, wantSHA := createGitRemote(t)
	workspace := testRepositoryWorkspace(t, remoteURL)
	source := testGitHubSource()
	path, err := workspace.WorkspacePath(source.SourceID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	runGit(t, "", "clone", "--depth=1", "--branch", "main", remoteURL, path)
	originalRunner := workspace.git.runner
	workspace.git.runner = func(ctx context.Context, command gitCommand) (gitCommandResult, error) {
		for _, arg := range command.args {
			if arg == "clone" || arg == "fetch" {
				return gitCommandResult{}, errors.New("remote operation must not run")
			}
		}
		return originalRunner(ctx, command)
	}

	gotSHA, err := workspace.UseExisting(context.Background(), source)
	if err != nil || gotSHA != wantSHA {
		t.Fatalf("UseExisting() = %q, %v, want %q", gotSHA, err, wantSHA)
	}
}

func TestRepositoryWorkspaceRejectsInvalidLocalRepository(t *testing.T) {
	_, remoteURL, _ := createGitRemote(t)
	workspace := testRepositoryWorkspace(t, remoteURL)
	source := testGitHubSource()
	path, _ := workspace.WorkspacePath(source.SourceID)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	runGit(t, "", "clone", "--depth=1", "--branch", "main", remoteURL, path)
	writeFile(t, filepath.Join(path, "local.txt"), "dirty")

	if _, err := workspace.UseExisting(context.Background(), source); err == nil || !strings.Contains(err.Error(), "dirty") {
		t.Fatalf("UseExisting() error = %v, want dirty workspace error", err)
	}
}

func TestRepositoryWorkspaceRejectsInvalidExistingDirectoryWithoutRecreating(t *testing.T) {
	tests := []struct {
		name  string
		setup func(t *testing.T, path string)
	}{
		{name: "origin tampered", setup: func(t *testing.T, path string) {
			runGit(t, path, "remote", "set-url", "origin", "https://github.com/other/repository.git")
		}},
		{name: "git missing", setup: func(t *testing.T, path string) {
			if err := os.RemoveAll(filepath.Join(path, ".git")); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "partial directory", setup: func(t *testing.T, path string) {
			if err := os.RemoveAll(filepath.Join(path, ".git")); err != nil {
				t.Fatal(err)
			}
			writeFile(t, filepath.Join(path, "partial"), "x")
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, remoteURL, _ := createGitRemote(t)
			workspace := testRepositoryWorkspace(t, remoteURL)
			source := testGitHubSource()
			if _, err := workspace.Update(context.Background(), source, ""); err != nil {
				t.Fatal(err)
			}
			path, _ := workspace.WorkspacePath(source.SourceID)
			tt.setup(t, path)
			if _, err := workspace.Update(context.Background(), source, ""); err == nil {
				t.Fatal("Update() accepted invalid workspace")
			}
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("workspace was recreated or removed: %v", err)
			}
		})
	}
}

func testRepositoryWorkspace(t *testing.T, remoteURL string) *RepositoryWorkspace {
	t.Helper()
	root, err := PrepareRepositoryRoot(filepath.Join(t.TempDir(), "repositories"))
	if err != nil {
		t.Fatal(err)
	}
	workspace := NewRepositoryWorkspace(root, NewGitClient("git", time.Minute, 64*1024, nil))
	workspace.repositoryURL = func(_, _ string) string { return remoteURL }
	return workspace
}

func testGitHubSource() GitHubSource {
	return GitHubSource{SourceID: repositoryWorkspaceTestSourceID, Provider: GitHubSourceProvider, RepositoryOwner: "acme", RepositoryName: "skills", Branch: "main"}
}

func createGitRemote(t *testing.T) (string, string, string) {
	t.Helper()
	remote := filepath.Join(t.TempDir(), "remote.git")
	runGit(t, "", "init", "--bare", "--initial-branch=main", remote)
	work := filepath.Join(t.TempDir(), "work")
	runGit(t, "", "init", "--initial-branch=main", work)
	runGit(t, work, "config", "user.email", "test@example.com")
	runGit(t, work, "config", "user.name", "Test")
	writeFile(t, filepath.Join(work, "SKILL.md"), "first\n")
	runGit(t, work, "add", "SKILL.md")
	runGit(t, work, "commit", "-m", "first")
	runGit(t, work, "remote", "add", "origin", remote)
	runGit(t, work, "push", "origin", "main")
	return work, "file://" + remote, runGit(t, work, "rev-parse", "HEAD")
}

func forceUpdateRemote(t *testing.T, work, contents string) string {
	t.Helper()
	runGit(t, work, "checkout", "--orphan", "rewritten")
	runGit(t, work, "rm", "-rf", ".")
	writeFile(t, filepath.Join(work, "SKILL.md"), contents)
	runGit(t, work, "add", "SKILL.md")
	runGit(t, work, "commit", "-m", "rewritten")
	runGit(t, work, "push", "--force", "origin", "HEAD:main")
	return runGit(t, work, "rev-parse", "HEAD")
}

func runGit(t *testing.T, directory string, args ...string) string {
	t.Helper()
	result, err := runGitOutput(directory, args...)
	if err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(result)
}

func runGitError(directory string, args ...string) error {
	_, err := runGitOutput(directory, args...)
	return err
}

func runGitOutput(directory string, args ...string) (string, error) {
	if directory != "" {
		args = append([]string{"-C", directory}, args...)
	}
	client := NewGitClient("git", time.Minute, 64*1024, nil)
	result, err := client.execute(context.Background(), args, "")
	return result.stdout, err
}

func writeFile(t *testing.T, name, contents string) {
	t.Helper()
	if err := os.WriteFile(name, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRepositoryWorkspaceRejectsOversizedWorkspace(t *testing.T) {
	_, remoteURL, _ := createGitRemote(t)
	workspace := testRepositoryWorkspace(t, remoteURL)
	workspace.maxBytes = 1
	if _, err := workspace.Update(context.Background(), testGitHubSource(), ""); !errors.Is(err, ErrRepositoryWorkspaceTooLarge) {
		t.Fatalf("Update() error = %v, want workspace size error", err)
	}
}
