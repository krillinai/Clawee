package windowsuser

import (
	"context"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/collector/setup/common"
)

type commandCall struct {
	name string
	args []string
}

type fakeCommandRunner struct {
	calls   []commandCall
	results []CommandResult
}

func (r *fakeCommandRunner) Run(ctx context.Context, name string, args ...string) CommandResult {
	r.calls = append(r.calls, commandCall{name: name, args: append([]string(nil), args...)})
	if len(r.results) == 0 {
		return CommandResult{}
	}
	result := r.results[0]
	r.results = r.results[1:]
	return result
}

func (r *fakeCommandRunner) JoinedCalls() string {
	var lines []string
	for _, call := range r.calls {
		lines = append(lines, call.name+" "+strings.Join(call.args, " "))
	}
	return strings.Join(lines, "\n")
}

func TestNormalizeCommandOutputDecodesGBKTaskErrors(t *testing.T) {
	raw := []byte{
		0xb4, 0xed, 0xce, 0xf3, 0x3a, 0x20, 0xcf, 0xb5,
		0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd,
		0xd6, 0xb8, 0xb6, 0xa8, 0xb5, 0xc4, 0xce, 0xc4,
		0xbc, 0xfe, 0xa1, 0xa3, 0x0d, 0x0d, 0x0a,
	}

	got := common.NormalizeCommandOutput(raw)

	if !strings.Contains(got, "错误: 系统找不到指定的文件。") {
		t.Fatalf("output = %q", got)
	}
}
