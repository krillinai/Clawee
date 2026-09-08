package common

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	collectorconfig "github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func TestDiagnosticsWriterWritesReadableLogAndRedactsToken(t *testing.T) {
	writer, err := NewDiagnosticsWriter(t.TempDir(), func() time.Time {
		return time.Date(2026, 7, 6, 10, 11, 12, 0, time.Local)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()

	writer.Step("配置", "复用已有配置 collector_token=secret_token collector_id=collector_1")
	writer.Step("配置JSON", `{"collector_token":"json_secret","CollectorToken":"go_secret","collectorToken":"camel_secret"}`)
	writer.Step("配置结构体", "CollectorToken=struct_secret")
	writer.Step("计划任务", "已创建 ClaweeCollector")

	bodyBytes, err := os.ReadFile(writer.Path())
	if err != nil {
		t.Fatal(err)
	}
	body := string(bodyBytes)
	for _, leaked := range []string{"secret_token", "json_secret", "go_secret", "camel_secret", "struct_secret"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("diagnostics leaked token %q:\n%s", leaked, body)
		}
	}
	for _, leaked := range []string{"collector_token", "CollectorToken", "collectorToken"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("diagnostics leaked token field %q:\n%s", leaked, body)
		}
	}
	for _, want := range []string{"配置", "计划任务", "<redacted_token_field>", "<redacted>", "ClaweeCollector"} {
		if !strings.Contains(body, want) {
			t.Fatalf("diagnostics missing %q:\n%s", want, body)
		}
	}
}

func TestHealthCheckerPassesWhenHealthzReturnsOK(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	checker := HealthChecker{HTTPClient: server.Client(), Timeout: time.Second}
	if err := checker.Wait(strings.TrimPrefix(server.URL, "http://")); err != nil {
		t.Fatal(err)
	}
}

func TestHealthCheckerReturnsClearErrorWhenUnavailable(t *testing.T) {
	checker := HealthChecker{Timeout: 10 * time.Millisecond, Interval: time.Millisecond}
	err := checker.Wait("127.0.0.1:1")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "本地健康检查失败") {
		t.Fatalf("err = %v", err)
	}
}

func TestHealthCheckerReturnsClearPortOccupiedError(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	checker := HealthChecker{Timeout: 10 * time.Millisecond, Interval: time.Millisecond}
	err = checker.Wait(listener.Addr().String())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "端口已被其他进程占用") {
		t.Fatalf("err = %v", err)
	}
}

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

type fakeHeartbeatReporter struct {
	requests []collectorapi.HeartbeatRequest
	err      error
}

func (r *fakeHeartbeatReporter) PostHeartbeat(req collectorapi.HeartbeatRequest) error {
	r.requests = append(r.requests, req)
	return r.err
}
