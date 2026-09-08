package common

import (
	"fmt"
	"net"
	"net/http"
	"time"
)

type HealthWaiter interface {
	Wait(listenAddr string) error
}

type HealthChecker struct {
	HTTPClient *http.Client
	Timeout    time.Duration
	Interval   time.Duration
}

func (h HealthChecker) Wait(listenAddr string) error {
	timeout := h.Timeout
	if timeout == 0 {
		timeout = 20 * time.Second
	}
	interval := h.Interval
	if interval == 0 {
		interval = 500 * time.Millisecond
	}
	client := h.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 3 * time.Second}
	}
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		resp, err := client.Get("http://" + listenAddr + "/healthz")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return nil
			}
			lastErr = fmt.Errorf("status %d", resp.StatusCode)
		} else {
			lastErr = err
		}
		time.Sleep(interval)
	}
	if isPortOpen(listenAddr) {
		return fmt.Errorf("本地健康检查失败: 端口已被其他进程占用或采集器未响应 /healthz: %s", listenAddr)
	}
	return fmt.Errorf("本地健康检查失败: %w", lastErr)
}

func isPortOpen(listenAddr string) bool {
	conn, err := net.DialTimeout("tcp", listenAddr, 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
