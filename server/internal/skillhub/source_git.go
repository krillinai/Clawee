package skillhub

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"go.uber.org/zap"
)

var commitSHAPattern = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)

const (
	maxGitCommandTimeout  = 300 * time.Second
	maxGitOutputBytes     = int64(64 * 1024)
	maxGitlinkPaths       = maxDiscoveredSkills
	maxGitlinkPathBytes   = 1 << 20
	maxGitIndexRecordSize = 16 << 10
)

type gitCommand struct {
	args []string
	env  []string
}

type gitCommandResult struct {
	stdout          string
	stderr          string
	stdoutTruncated bool
	stderrTruncated bool
}

type gitCommandRunner func(context.Context, gitCommand) (gitCommandResult, error)

// GitClient executes only the Git operations needed for a source workspace.
type GitClient struct {
	executable  string
	timeout     time.Duration
	outputLimit int64
	hooksPath   string
	homePath    string
	logger      *zap.Logger
	runner      gitCommandRunner
}

func NewGitClient(executable string, timeout time.Duration, outputLimit int64, logger *zap.Logger) *GitClient {
	if executable == "" {
		executable = "git"
	}
	if timeout <= 0 || timeout > maxGitCommandTimeout {
		timeout = maxGitCommandTimeout
	}
	if outputLimit <= 0 || outputLimit > maxGitOutputBytes {
		outputLimit = maxGitOutputBytes
	}
	client := &GitClient{executable: executable, timeout: timeout, outputLimit: outputLimit, logger: logger}
	statePath, err := os.MkdirTemp("", "skillhub-git-")
	if err == nil {
		_ = os.Mkdir(filepath.Join(statePath, "hooks"), 0o700)
		_ = os.Mkdir(filepath.Join(statePath, "home"), 0o700)
		client.hooksPath = filepath.Join(statePath, "hooks")
		client.homePath = filepath.Join(statePath, "home")
	}
	client.runner = func(ctx context.Context, command gitCommand) (gitCommandResult, error) {
		process := exec.CommandContext(ctx, client.executable, command.args...)
		process.Env = command.env
		stdout := &limitedGitOutput{limit: client.outputLimit}
		stderr := &limitedGitOutput{limit: client.outputLimit}
		operation := gitRemoteOperation(command.args)
		token := commandToken(command.env)
		progress := newGitProgressWriter(stderr, client.logger, operation, gitCommandSourceID(command.args), client.outputLimit, token)
		process.Stdout = stdout
		process.Stderr = progress
		startedAt := time.Now()
		client.logGitOperationStarted(operation, command.args)
		err := process.Run()
		progress.Flush()
		client.logGitOperationFinished(operation, command.args, time.Since(startedAt), progress.LastOutput(), err)
		return gitCommandResult{
			stdout: stdout.String(), stderr: stderr.String(),
			stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
		}, err
	}
	return client
}

func (c *GitClient) Clone(ctx context.Context, repositoryURL, branch, destination, token string) error {
	if err := c.validateBranch(ctx, branch); err != nil {
		return err
	}
	_, err := c.execute(ctx, []string{"clone", "--progress", "--depth=1", "--single-branch", "--no-tags", "--branch", branch, repositoryURL, destination}, token)
	return err
}

func (c *GitClient) OriginURL(ctx context.Context, repositoryRoot string) (string, error) {
	result, err := c.execute(ctx, []string{"-C", repositoryRoot, "remote", "get-url", "origin"}, "")
	if err != nil {
		return "", err
	}
	url := strings.TrimSpace(result.stdout)
	if url == "" {
		return "", errors.New("git origin URL is empty")
	}
	return url, nil
}

func (c *GitClient) Status(ctx context.Context, repositoryRoot string) error {
	result, err := c.execute(ctx, []string{"-C", repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"}, "")
	if err != nil {
		return err
	}
	if result.stdout != "" || result.stderr != "" {
		return errors.New("git repository workspace is dirty")
	}
	return nil
}

func (c *GitClient) Fetch(ctx context.Context, repositoryRoot, branch, token string) error {
	if err := c.validateBranch(ctx, branch); err != nil {
		return err
	}
	_, err := c.execute(ctx, []string{"-C", repositoryRoot, "fetch", "--progress", "--prune", "--depth=1", "origin", branch}, token)
	return err
}

func (c *GitClient) CheckoutDetached(ctx context.Context, repositoryRoot, commitSHA string) error {
	if !commitSHAPattern.MatchString(commitSHA) {
		return errors.New("git checkout target is not a full commit SHA")
	}
	_, err := c.execute(ctx, []string{"-C", repositoryRoot, "checkout", "--detach", strings.ToLower(commitSHA)}, "")
	return err
}

func (c *GitClient) ResolveFetchHead(ctx context.Context, repositoryRoot string) (string, error) {
	result, err := c.execute(ctx, []string{"-C", repositoryRoot, "rev-parse", "--verify", "FETCH_HEAD^{commit}"}, "")
	if err != nil {
		// git clone does not consistently leave FETCH_HEAD behind; its checked out
		// commit is the equivalent immutable initial source revision.
		result, err = c.execute(ctx, []string{"-C", repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}"}, "")
		if err != nil {
			return "", err
		}
	}
	sha := strings.TrimSpace(result.stdout)
	if !commitSHAPattern.MatchString(sha) {
		return "", errors.New("git FETCH_HEAD is not a full commit SHA")
	}
	return strings.ToLower(sha), nil
}

func (c *GitClient) ResolveHead(ctx context.Context, repositoryRoot string) (string, error) {
	result, err := c.execute(ctx, []string{"-C", repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}"}, "")
	if err != nil {
		return "", err
	}
	sha := strings.TrimSpace(result.stdout)
	if !commitSHAPattern.MatchString(sha) {
		return "", errors.New("git HEAD is not a full commit SHA")
	}
	return strings.ToLower(sha), nil
}

func (c *GitClient) ListGitlinks(ctx context.Context, repositoryRoot string) ([]string, error) {
	if c == nil || c.executable == "" || c.hooksPath == "" || c.homePath == "" {
		return nil, errors.New("git client is not configured")
	}
	commandContext, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	process := exec.CommandContext(commandContext, c.executable, "-C", repositoryRoot, "ls-files", "--stage", "-z")
	process.Env = c.environment("")
	stdout, err := process.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &limitedGitOutput{limit: c.outputLimit}
	process.Stderr = stderr
	if err := process.Start(); err != nil {
		return nil, err
	}
	paths, parseErr := collectGitlinkPaths(stdout)
	if parseErr != nil {
		_ = process.Process.Kill()
	}
	if waitErr := process.Wait(); waitErr != nil && parseErr == nil {
		return nil, fmt.Errorf("git command failed: %s: %w", c.errorSummary(gitCommandResult{stderr: stderr.String()}, ""), waitErr)
	}
	if parseErr != nil {
		return nil, parseErr
	}
	sort.Strings(paths)
	return paths, nil
}

func collectGitlinkPaths(output io.Reader) ([]string, error) {
	reader := bufio.NewReaderSize(output, maxGitIndexRecordSize)
	paths := make([]string, 0)
	pathBytes := 0
	for {
		record, err := reader.ReadSlice(0)
		if errors.Is(err, io.EOF) {
			return paths, nil
		}
		if err != nil {
			return nil, fmt.Errorf("read git index entry: %w", err)
		}
		metadata, path, found := bytes.Cut(record[:len(record)-1], []byte{'\t'})
		if !found || !bytes.HasPrefix(metadata, []byte("160000 ")) {
			continue
		}
		if len(paths) >= maxGitlinkPaths || len(path) > maxGitlinkPathBytes-pathBytes {
			return nil, errors.New("gitlink paths exceed limit")
		}
		paths = append(paths, string(path))
		pathBytes += len(path)
	}
}

func (c *GitClient) execute(ctx context.Context, args []string, token string) (gitCommandResult, error) {
	if c == nil || c.runner == nil || c.hooksPath == "" || c.homePath == "" {
		return gitCommandResult{}, errors.New("git client is not configured")
	}
	commandContext, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	result, err := c.runner(commandContext, gitCommand{args: append([]string(nil), args...), env: c.environment(token)})
	var truncated bool
	result.stdout, truncated = truncateGitOutput(result.stdout, c.outputLimit)
	result.stdoutTruncated = result.stdoutTruncated || truncated
	result.stderr, truncated = truncateGitOutput(result.stderr, c.outputLimit)
	result.stderrTruncated = result.stderrTruncated || truncated
	if err != nil {
		summary := c.errorSummary(result, token)
		if summary == "no output" {
			summary = redactGitOutput(err.Error(), token)
		}
		switch {
		case errors.Is(err, context.Canceled):
			return result, fmt.Errorf("git command failed: %s: %w", summary, context.Canceled)
		case errors.Is(err, context.DeadlineExceeded):
			return result, fmt.Errorf("git command failed: %s: %w", summary, context.DeadlineExceeded)
		default:
			return result, fmt.Errorf("git command failed: %s", summary)
		}
	}
	return result, nil
}

func (c *GitClient) validateBranch(ctx context.Context, branch string) error {
	if branch == "" || strings.HasPrefix(branch, "-") || strings.ContainsFunc(branch, unicode.IsControl) {
		return ErrInvalidRequest
	}
	if _, err := c.execute(ctx, []string{"check-ref-format", "--branch", branch}, ""); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return ErrInvalidRequest
	}
	return nil
}

func (c *GitClient) environment(token string) []string {
	base := make([]string, 0, len(os.Environ())+16)
	for _, item := range os.Environ() {
		key, _, found := strings.Cut(item, "=")
		if !found || key == "HOME" || key == "XDG_CONFIG_HOME" || strings.HasPrefix(key, "GIT_") {
			continue
		}
		base = append(base, item)
	}
	keys := []string{"core.hooksPath", "fetch.recurseSubmodules", "submodule.recurse"}
	values := []string{c.hooksPath, "false", "false"}
	if token != "" {
		keys = append(keys, "http.https://github.com/.extraHeader")
		values = append(values, "Authorization: Bearer "+token)
	}
	base = append(base,
		"GIT_TERMINAL_PROMPT=0",
		"GIT_LFS_SKIP_SMUDGE=1",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"HOME="+c.homePath,
		"XDG_CONFIG_HOME="+c.homePath,
		fmt.Sprintf("GIT_CONFIG_COUNT=%d", len(keys)),
	)
	for index := range keys {
		base = append(base, fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", index, keys[index]), fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", index, values[index]))
	}
	return base
}

func (c *GitClient) errorSummary(result gitCommandResult, token string) string {
	summary := strings.TrimSpace(result.stderr)
	if summary == "" {
		summary = strings.TrimSpace(result.stdout)
	}
	if summary == "" {
		summary = "no output"
	}
	if token != "" {
		summary = strings.ReplaceAll(summary, token, "[redacted]")
	}
	return summary
}

func (c *GitClient) logGitOperationStarted(operation string, args []string) {
	if operation == "" || c.logger == nil {
		return
	}
	c.logger.Info("github skill source git operation started", gitOperationFields(operation, args)...)
}

func (c *GitClient) logGitOperationFinished(operation string, args []string, duration time.Duration, lastOutput string, err error) {
	if operation == "" || c.logger == nil {
		return
	}
	fields := append(gitOperationFields(operation, args), zap.Duration("duration", duration))
	if err != nil {
		summary := strings.TrimSpace(lastOutput)
		if summary == "" {
			summary = err.Error()
		}
		fields = append(fields, zap.String("error", summary))
		c.logger.Error("github skill source git operation failed", fields...)
		return
	}
	c.logger.Info("github skill source git operation completed", fields...)
}

func gitRemoteOperation(args []string) string {
	if len(args) > 0 && args[0] == "clone" {
		return "clone"
	}
	if len(args) > 3 && args[0] == "-C" && args[2] == "fetch" {
		return "fetch"
	}
	return ""
}

func gitCommandSourceID(args []string) string {
	var repositoryRoot string
	switch gitRemoteOperation(args) {
	case "clone":
		if len(args) > 0 {
			repositoryRoot = args[len(args)-1]
		}
	case "fetch":
		if len(args) > 1 {
			repositoryRoot = args[1]
		}
	}
	sourceID := filepath.Base(filepath.Dir(repositoryRoot))
	if sourceIDPattern.MatchString(sourceID) {
		return sourceID
	}
	return ""
}

func gitOperationFields(operation string, args []string) []zap.Field {
	fields := []zap.Field{zap.String("operation", operation)}
	if sourceID := gitCommandSourceID(args); sourceID != "" {
		fields = append(fields, zap.String("source_id", sourceID))
	}
	if operation == "clone" && len(args) >= 2 {
		fields = append(fields, zap.String("repository_url", args[len(args)-2]))
	}
	for index, arg := range args {
		if arg == "--branch" && index+1 < len(args) {
			fields = append(fields, zap.String("branch", args[index+1]))
			break
		}
	}
	if operation == "fetch" && len(args) > 0 {
		fields = append(fields, zap.String("branch", args[len(args)-1]))
	}
	return fields
}

func commandToken(environment []string) string {
	for _, item := range environment {
		key, value, found := strings.Cut(item, "=")
		if found && strings.HasPrefix(key, "GIT_CONFIG_VALUE_") && strings.HasPrefix(value, "Authorization: Bearer ") {
			return strings.TrimPrefix(value, "Authorization: Bearer ")
		}
	}
	return ""
}

type gitProgressWriter struct {
	capture    *limitedGitOutput
	logger     *zap.Logger
	operation  string
	sourceID   string
	limit      int64
	token      string
	pending    []byte
	discarded  bool
	lastOutput string
}

func newGitProgressWriter(capture *limitedGitOutput, logger *zap.Logger, operation, sourceID string, limit int64, token string) *gitProgressWriter {
	return &gitProgressWriter{capture: capture, logger: logger, operation: operation, sourceID: sourceID, limit: limit, token: token}
}

func (w *gitProgressWriter) Write(data []byte) (int, error) {
	written, err := w.capture.Write(data)
	if w.logger == nil || w.operation == "" {
		return written, err
	}
	for _, value := range data {
		if value == '\r' || value == '\n' {
			w.flushLine()
			continue
		}
		if w.discarded {
			continue
		}
		if int64(len(w.pending)) >= w.limit {
			w.pending = nil
			w.discarded = true
			continue
		}
		w.pending = append(w.pending, value)
	}
	return written, err
}

func (w *gitProgressWriter) Flush() {
	if w.logger != nil && w.operation != "" {
		w.flushLine()
	}
}

func (w *gitProgressWriter) LastOutput() string {
	return w.lastOutput
}

func (w *gitProgressWriter) flushLine() {
	if w.discarded {
		w.log("[output line truncated]")
		w.discarded = false
		w.pending = nil
		return
	}
	line := strings.TrimSpace(string(w.pending))
	w.pending = nil
	if line != "" {
		w.log(redactGitOutput(line, w.token))
	}
}

func (w *gitProgressWriter) log(output string) {
	w.lastOutput = output
	fields := []zap.Field{zap.String("operation", w.operation), zap.String("output", output)}
	if w.sourceID != "" {
		fields = append(fields, zap.String("source_id", w.sourceID))
	}
	w.logger.Info("github skill source git progress", fields...)
}

func redactGitOutput(value, token string) string {
	if token != "" {
		value = strings.ReplaceAll(value, token, "[redacted]")
	}
	return strings.Map(func(value rune) rune {
		if unicode.IsControl(value) && value != '\t' && value != '\n' {
			return -1
		}
		return value
	}, value)
}

type limitedGitOutput struct {
	data      []byte
	limit     int64
	truncated bool
}

func (w *limitedGitOutput) Write(data []byte) (int, error) {
	written := len(data)
	remaining := w.limit - int64(len(w.data))
	if remaining > 0 {
		if int64(len(data)) > remaining {
			w.truncated = true
			data = data[:remaining]
		}
		w.data = append(w.data, data...)
	} else if len(data) > 0 {
		w.truncated = true
	}
	return written, nil
}

func (w *limitedGitOutput) String() string {
	return string(w.data)
}

func truncateGitOutput(value string, limit int64) (string, bool) {
	if limit < 0 || int64(len(value)) <= limit {
		return value, false
	}
	return value[:limit], true
}
