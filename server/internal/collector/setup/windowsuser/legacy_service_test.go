package windowsuser

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestLegacyServiceCleanupContinuesWhenServiceMissing(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{{ExitCode: 1060, Output: "The specified service does not exist", Err: errors.New("exit status 1060")}},
	}
	manager := NewLegacyServiceManager(runner)

	status, err := manager.Cleanup(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.Exists {
		t.Fatalf("status = %#v", status)
	}
}

func TestLegacyServiceCleanupStopsAndDeletesExistingService(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{
			{ExitCode: 0, Output: "SERVICE_NAME: ClaweeCollector"},
			{ExitCode: 0, Output: "STOP_PENDING"},
			{ExitCode: 0, Output: "DeleteService SUCCESS"},
		},
	}
	manager := NewLegacyServiceManager(runner)

	status, err := manager.Cleanup(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !status.Exists || !status.Cleaned {
		t.Fatalf("status = %#v", status)
	}
	joined := runner.JoinedCalls()
	for _, want := range []string{"sc.exe query ClaweeCollector", "sc.exe stop ClaweeCollector", "sc.exe delete ClaweeCollector"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("calls missing %q:\n%s", want, joined)
		}
	}
}

func TestLegacyServiceCleanupFailsWithAdminGuidance(t *testing.T) {
	runner := &fakeCommandRunner{
		results: []CommandResult{
			{ExitCode: 0, Output: "SERVICE_NAME: ClaweeCollector"},
			{ExitCode: 5, Output: "Access is denied.", Err: errors.New("exit status 5")},
		},
	}
	manager := NewLegacyServiceManager(runner)

	status, err := manager.Cleanup(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if !status.Exists || status.Cleaned {
		t.Fatalf("status = %#v", status)
	}
	for _, want := range []string{"Access is denied.", "sc.exe stop ClaweeCollector", "sc.exe delete ClaweeCollector"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error missing %q:\n%s", want, err.Error())
		}
	}
}
