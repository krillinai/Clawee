package windowsuser

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

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
