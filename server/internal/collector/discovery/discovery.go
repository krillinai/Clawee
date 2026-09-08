package discovery

import (
	"os"
	"runtime"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

type DeviceSummary struct {
	DeviceName       string
	Hostname         string
	OS               string
	Arch             string
	CollectorVersion string
}

func DeviceInfo(collectorVersion string) DeviceSummary {
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown"
	}
	return DeviceSummary{
		DeviceName:       hostname,
		Hostname:         hostname,
		OS:               runtime.GOOS,
		Arch:             runtime.GOARCH,
		CollectorVersion: collectorVersion,
	}
}

func DiscoverAgents(workspaceName string) []collectorapi.RegistrationAgent {
	return []collectorapi.RegistrationAgent{{
		AgentType:     collectorapi.AgentTypeCodex,
		WorkspaceName: workspaceName,
		Metadata: map[string]string{
			"source": "local_discovery",
		},
	}}
}
