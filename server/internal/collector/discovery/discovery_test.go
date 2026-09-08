package discovery

import (
	"runtime"
	"testing"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func TestDeviceInfoUsesRuntimeAndHostname(t *testing.T) {
	info := DeviceInfo("0.1.0")
	if info.OS != runtime.GOOS {
		t.Fatalf("OS = %q, want %q", info.OS, runtime.GOOS)
	}
	if info.Arch != runtime.GOARCH {
		t.Fatalf("Arch = %q, want %q", info.Arch, runtime.GOARCH)
	}
	if info.CollectorVersion != "0.1.0" {
		t.Fatalf("CollectorVersion = %q", info.CollectorVersion)
	}
	if info.Hostname == "" {
		t.Fatal("Hostname is empty")
	}
}

func TestDiscoverAgentsReturnsCodexSummary(t *testing.T) {
	agents := DiscoverAgents("claw-mcp")
	if len(agents) != 1 {
		t.Fatalf("len(agents) = %d", len(agents))
	}
	if agents[0].AgentType != collectorapi.AgentTypeCodex {
		t.Fatalf("AgentType = %q", agents[0].AgentType)
	}
	if agents[0].DisplayName != "" {
		t.Fatalf("DisplayName = %q, want empty", agents[0].DisplayName)
	}
	if agents[0].Metadata["source"] != "local_discovery" {
		t.Fatalf("Metadata = %#v", agents[0].Metadata)
	}
}
