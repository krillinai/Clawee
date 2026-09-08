package windowsuser

import (
	"testing"
	"time"

	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func TestConnectionCheckerPostsHeartbeatWithCurrentConfig(t *testing.T) {
	reporter := &fakeHeartbeatReporter{}
	checker := ConnectionChecker{
		Reporter: reporter,
		Now:      func() time.Time { return time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC) },
	}

	err := checker.Check(collectorconfig.Config{
		CollectorID: "collector_1",
		DeviceID:    "device_1",
		PrivacyMode: "summary_only",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(reporter.requests) != 1 {
		t.Fatalf("requests = %d", len(reporter.requests))
	}
	got := reporter.requests[0]
	if got.CollectorID != "collector_1" || got.DeviceID != "device_1" {
		t.Fatalf("heartbeat = %#v", got)
	}
	if len(got.Agents) != 1 || got.Agents[0].DisplayName != "" {
		t.Fatalf("agents = %#v", got.Agents)
	}
}

type fakeRegistrar struct {
	calls    int
	request  collectorapi.RegistrationRequest
	response collectorapi.RegistrationResponse
	err      error
}

func (r *fakeRegistrar) RegisterCollector(req collectorapi.RegistrationRequest) (collectorapi.RegistrationResponse, error) {
	r.calls++
	r.request = req
	if r.err != nil {
		return collectorapi.RegistrationResponse{}, r.err
	}
	return r.response, nil
}

type fakeHeartbeatReporter struct {
	requests []collectorapi.HeartbeatRequest
	err      error
}

func (r *fakeHeartbeatReporter) PostHeartbeat(req collectorapi.HeartbeatRequest) error {
	r.requests = append(r.requests, req)
	return r.err
}
