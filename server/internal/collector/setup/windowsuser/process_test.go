package windowsuser

import (
	"context"
	"strings"
	"testing"
)

func TestProcessManagerWaitReleasedMatchesFormalRunnerPath(t *testing.T) {
	runner := &fakeCommandRunner{}
	manager := NewProcessManager(runner)

	err := manager.WaitReleased(context.Background(),
		`C:\Users\Mayn\.clawee-collector\bin\clawee-collector.exe`,
		`C:\Users\Mayn\.clawee-collector\bin\clawee-collector-runner.exe`,
	)
	if err != nil {
		t.Fatal(err)
	}
	joined := runner.JoinedCalls()
	for _, want := range []string{
		"powershell.exe",
		`C:\Users\Mayn\.clawee-collector\bin\clawee-collector-runner.exe`,
		`Stop-Process -Force`,
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("process release command missing %q:\n%s", want, joined)
		}
	}
	if strings.Contains(joined, "CLAWEE_COLLECTOR_BINARY_PATH") {
		t.Fatalf("process release command should not rely on unset environment variables:\n%s", joined)
	}
	if strings.Contains(joined, "CLAWEE_COLLECTOR_RUNNER_BINARY_PATH") {
		t.Fatalf("process release command should not rely on unset environment variables:\n%s", joined)
	}
}
