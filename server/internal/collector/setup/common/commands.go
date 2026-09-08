package common

import (
	"context"
	"os/exec"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

type CommandRunner interface {
	Run(ctx context.Context, name string, args ...string) CommandResult
}

type CommandResult struct {
	ExitCode int
	Output   string
	Err      error
}

func (r CommandResult) OK() bool {
	return r.Err == nil && r.ExitCode == 0
}

type ExecCommandRunner struct{}

func (ExecCommandRunner) Run(ctx context.Context, name string, args ...string) CommandResult {
	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.CombinedOutput()
	code := 0
	if err != nil {
		code = 1
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		}
	}
	return CommandResult{ExitCode: code, Output: NormalizeCommandOutput(output), Err: err}
}

func NormalizeCommandOutput(output []byte) string {
	if utf8.Valid(output) {
		return strings.TrimSpace(string(output))
	}
	decoded, err := simplifiedchinese.GB18030.NewDecoder().Bytes(output)
	if err != nil {
		return strings.TrimSpace(string(output))
	}
	return strings.TrimSpace(string(decoded))
}
