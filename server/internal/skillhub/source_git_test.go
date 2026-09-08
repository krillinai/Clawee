package skillhub

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

const gitClientTestToken = "github_pat_test_token_123"

func TestGitClientKeepsTokenOutOfArgumentsAndUsesIsolatedEnvironment(t *testing.T) {
	t.Setenv("GIT_ASKPASS", "/tmp/credential-helper")
	t.Setenv("GIT_EXEC_PATH", "/tmp/git-exec")
	t.Setenv("GIT_TRACE", "/tmp/git-trace")
	client := NewGitClient("git", time.Second, 64*1024, nil)
	var commands []gitCommand
	client.runner = func(_ context.Context, command gitCommand) (gitCommandResult, error) {
		commands = append(commands, command)
		return gitCommandResult{}, nil
	}

	if err := client.Clone(context.Background(), "https://github.com/acme/skills.git", "main", "/fixed/repository", gitClientTestToken); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 2 {
		t.Fatalf("command count = %d, want 2", len(commands))
	}
	got := commands[1]
	if strings.Join(got.args, "\x00") != "clone\x00--progress\x00--depth=1\x00--single-branch\x00--no-tags\x00--branch\x00main\x00https://github.com/acme/skills.git\x00/fixed/repository" {
		t.Fatalf("git arguments = %#v", got.args)
	}
	if strings.Contains(strings.Join(got.args, "\x00"), gitClientTestToken) {
		t.Fatalf("git arguments contain token: %#v", got.args)
	}
	env := environmentMap(got.env)
	for key, want := range map[string]string{
		"GIT_TERMINAL_PROMPT": "0",
		"GIT_LFS_SKIP_SMUDGE": "1",
		"GIT_CONFIG_NOSYSTEM": "1",
		"GIT_CONFIG_GLOBAL":   "/dev/null",
	} {
		if env[key] != want {
			t.Fatalf("environment %s = %q, want %q", key, env[key], want)
		}
	}
	if env["GIT_CONFIG_VALUE_3"] != "Authorization: Bearer "+gitClientTestToken {
		t.Fatalf("authorization header = %q", env["GIT_CONFIG_VALUE_3"])
	}
	if env["GIT_CONFIG_KEY_3"] != "http.https://github.com/.extraHeader" || env["GIT_CONFIG_COUNT"] != "4" {
		t.Fatalf("git config environment is incomplete: %#v", env)
	}
	if env["GIT_CONFIG_KEY_0"] != "core.hooksPath" || env["GIT_CONFIG_KEY_1"] != "fetch.recurseSubmodules" || env["GIT_CONFIG_KEY_2"] != "submodule.recurse" {
		t.Fatalf("isolated git config = %#v", env)
	}
	for _, key := range []string{"GIT_ASKPASS", "GIT_EXEC_PATH", "GIT_TRACE"} {
		if _, ok := env[key]; ok {
			t.Fatalf("environment inherited unsafe %s", key)
		}
	}
}

func TestNewGitClientEnforcesFixedMaximums(t *testing.T) {
	client := NewGitClient("git", 10*time.Minute, 128*1024, nil)
	if client.timeout != 300*time.Second {
		t.Fatalf("timeout = %s, want 300s", client.timeout)
	}
	if client.outputLimit != 64*1024 {
		t.Fatalf("output limit = %d, want 65536", client.outputLimit)
	}
}

func TestGitClientValidatesBranchesThroughRestrictedRunner(t *testing.T) {
	client := NewGitClient("git", time.Second, 64*1024, nil)
	var commands [][]string
	client.runner = func(_ context.Context, command gitCommand) (gitCommandResult, error) {
		commands = append(commands, append([]string(nil), command.args...))
		return gitCommandResult{}, nil
	}

	if err := client.Clone(context.Background(), "https://github.com/acme/skills.git", "main", "/fixed/repository", ""); err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		{"check-ref-format", "--branch", "main"},
		{"clone", "--progress", "--depth=1", "--single-branch", "--no-tags", "--branch", "main", "https://github.com/acme/skills.git", "/fixed/repository"},
	}
	if len(commands) != len(want) {
		t.Fatalf("command count = %d, want %d: %#v", len(commands), len(want), commands)
	}
	for index := range want {
		if strings.Join(commands[index], "\x00") != strings.Join(want[index], "\x00") {
			t.Fatalf("command %d = %#v, want %#v", index, commands[index], want[index])
		}
	}
}

func TestGitClientTruncatesOutputAndRedactsTokenFromFailures(t *testing.T) {
	client := NewGitClient("git", time.Second, 64*1024, nil)
	client.runner = func(_ context.Context, _ gitCommand) (gitCommandResult, error) {
		return gitCommandResult{stderr: gitClientTestToken + strings.Repeat("x", 70*1024)}, errors.New("git exit")
	}

	err := client.Clone(context.Background(), "https://github.com/acme/skills.git", "main", "/tmp/repository", gitClientTestToken)
	if err == nil {
		t.Fatal("Clone() unexpectedly succeeded")
	}
	if strings.Contains(err.Error(), gitClientTestToken) {
		t.Fatalf("Clone() error leaked token: %q", err)
	}
	if len(err.Error()) > 65*1024 {
		t.Fatalf("Clone() error was not truncated: %d bytes", len(err.Error()))
	}
}

func TestGitClientLogsCloneProgressAndRedactedFailure(t *testing.T) {
	core, observed := observer.New(zap.InfoLevel)
	executable := filepath.Join(t.TempDir(), "git-test")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" = \"check-ref-format\" ]; then exit 0; fi\n" +
		"printf 'Receiving objects: 50%%\\r' >&2\n" +
		"printf 'fatal: failed " + gitClientTestToken + "\\n' >&2\n" +
		"exit 1\n"
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	client := NewGitClient(executable, time.Second, 64*1024, zap.New(core))
	destination := filepath.Join(t.TempDir(), "source_0123456789abcdef01234567", "repository")

	err := client.Clone(context.Background(), "https://github.com/acme/skills.git", "main", destination, gitClientTestToken)
	if err == nil {
		t.Fatal("Clone() error = nil")
	}
	var logged strings.Builder
	for _, entry := range observed.All() {
		fmt.Fprintf(&logged, "%s %#v\n", entry.Message, entry.ContextMap())
	}
	output := logged.String()
	for _, want := range []string{
		"github skill source git operation started",
		"github skill source git progress",
		"github skill source git operation failed",
		"Receiving objects: 50%",
		"fatal: failed [redacted]",
		"source_0123456789abcdef01234567",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("logs do not contain %q: %s", want, output)
		}
	}
	if strings.Contains(output, gitClientTestToken) {
		t.Fatalf("logs leaked token: %s", output)
	}
}

func TestGitClientCommandContextStopsSubprocess(t *testing.T) {
	client := NewGitClient("sleep", time.Second, 64*1024, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	_, err := client.execute(ctx, []string{"1"}, "")
	if err == nil {
		t.Fatal("execute() unexpectedly succeeded after context deadline")
	}
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("context error = %v, want deadline exceeded", ctx.Err())
	}
}

func TestGitClientUsesRestrictedCommands(t *testing.T) {
	client := NewGitClient("git", time.Second, 64*1024, nil)
	var commands [][]string
	client.runner = func(_ context.Context, command gitCommand) (gitCommandResult, error) {
		commands = append(commands, append([]string(nil), command.args...))
		args := strings.Join(command.args, "\x00")
		switch {
		case strings.Contains(args, "\x00remote\x00"):
			return gitCommandResult{stdout: "https://github.com/acme/skills.git\n"}, nil
		case strings.Contains(args, "\x00rev-parse\x00"):
			return gitCommandResult{stdout: strings.Repeat("a", 40) + "\n"}, nil
		case strings.Contains(args, "\x00ls-files\x00"):
			return gitCommandResult{stdout: "160000 deadbeef 0\tmodules/one\n"}, nil
		}
		if command.args[0] == "clone" {
			return gitCommandResult{}, nil
		}
		return gitCommandResult{}, nil
	}

	if err := client.Clone(context.Background(), "https://github.com/acme/skills.git", "main", "/fixed/repository", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := client.OriginURL(context.Background(), "/fixed/repository"); err != nil {
		t.Fatal(err)
	}
	if err := client.Status(context.Background(), "/fixed/repository"); err != nil {
		t.Fatal(err)
	}
	if err := client.Fetch(context.Background(), "/fixed/repository", "main", ""); err != nil {
		t.Fatal(err)
	}
	if err := client.CheckoutDetached(context.Background(), "/fixed/repository", strings.Repeat("a", 40)); err != nil {
		t.Fatal(err)
	}
	if _, err := client.ResolveFetchHead(context.Background(), "/fixed/repository"); err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		{"check-ref-format", "--branch", "main"},
		{"clone", "--progress", "--depth=1", "--single-branch", "--no-tags", "--branch", "main", "https://github.com/acme/skills.git", "/fixed/repository"},
		{"-C", "/fixed/repository", "remote", "get-url", "origin"},
		{"-C", "/fixed/repository", "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"},
		{"check-ref-format", "--branch", "main"},
		{"-C", "/fixed/repository", "fetch", "--progress", "--prune", "--depth=1", "origin", "main"},
		{"-C", "/fixed/repository", "checkout", "--detach", strings.Repeat("a", 40)},
		{"-C", "/fixed/repository", "rev-parse", "--verify", "FETCH_HEAD^{commit}"},
	}
	if len(commands) != len(want) {
		t.Fatalf("command count = %d, want %d", len(commands), len(want))
	}
	for i := range want {
		if strings.Join(commands[i], "\x00") != strings.Join(want[i], "\x00") {
			t.Fatalf("command %d = %#v, want %#v", i, commands[i], want[i])
		}
	}
}

func TestGitClientListGitlinksStreamsLargeOrdinaryIndex(t *testing.T) {
	repository := createGitIndex(t, 2000)
	indexOutput, err := exec.Command("git", "-C", repository, "ls-files", "--stage", "-z").Output()
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(indexOutput)) <= maxGitOutputBytes {
		t.Fatalf("git index output = %d bytes, want more than %d", len(indexOutput), maxGitOutputBytes)
	}

	gitlinks, err := NewGitClient("git", time.Minute, 64*1024, nil).ListGitlinks(context.Background(), repository)
	if err != nil {
		t.Fatalf("ListGitlinks() error = %v, want success for an index larger than 64 KiB", err)
	}
	if len(gitlinks) != 0 {
		t.Fatalf("ListGitlinks() = %#v, want no gitlinks", gitlinks)
	}
}

func TestGitClientListGitlinksRecognizesGitlinkEntries(t *testing.T) {
	repository := createGitIndex(t, 1)
	runGit(t, repository, "update-index", "--add", "--cacheinfo", "160000,"+strings.Repeat("a", 40)+",modules/one")

	gitlinks, err := NewGitClient("git", time.Minute, 64*1024, nil).ListGitlinks(context.Background(), repository)
	if err != nil {
		t.Fatal(err)
	}
	if len(gitlinks) != 1 || gitlinks[0] != "modules/one" {
		t.Fatalf("ListGitlinks() = %#v, want [modules/one]", gitlinks)
	}
}

func createGitIndex(t *testing.T, entries int) string {
	t.Helper()
	repository := t.TempDir()
	runGit(t, repository, "init")
	for index := 0; index < entries; index++ {
		filename := filepath.Join(repository, "files", fmt.Sprintf("%04d-%s.txt", index, strings.Repeat("a", 48)))
		if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	runGit(t, repository, "add", "files")
	return repository
}

func environmentMap(values []string) map[string]string {
	result := make(map[string]string, len(values))
	for _, value := range values {
		key, value, ok := strings.Cut(value, "=")
		if ok {
			result[key] = value
		}
	}
	return result
}
