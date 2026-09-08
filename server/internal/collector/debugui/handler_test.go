package debugui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/collector/debugstore"
)

func TestStateReturnsDebugStoreSnapshot(t *testing.T) {
	store := debugstore.New(debugstore.Config{
		Capacity:    50,
		Now:         func() time.Time { return time.Date(2026, 7, 3, 10, 0, 0, 0, time.UTC) },
		CollectorID: "collector_1",
		DeviceID:    "device_1",
		Version:     "0.1.0",
		OfficeURL:   "https://office.example",
	})
	chainID := store.RecordReceived(debugstore.ReceivedInput{
		AgentType:  "codex",
		Path:       "/ingest/codex",
		RawPayload: []byte(`{"hook_event_name":"PreToolUse"}`),
	})
	store.RecordParsed(chainID, nil)
	store.RecordReport(debugstore.ReportInput{
		Kind:           "events",
		Path:           "/api/v1/collector/events",
		RawRequest:     []byte(`{"collector_id":"collector_1","events":[]}`),
		ResponseStatus: http.StatusAccepted,
	})
	handler := New(store)
	req := httptest.NewRequest(http.MethodGet, "/debug/api/collector/state?limit=50", nil)
	resp := httptest.NewRecorder()

	handler.State(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.Code)
	}
	var state debugstore.State
	if err := json.NewDecoder(resp.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	if state.SchemaVersion != "collector_debug.v1" {
		t.Fatalf("schema = %s", state.SchemaVersion)
	}
	if state.Health.CollectorID != "collector_1" {
		t.Fatalf("collector id = %s", state.Health.CollectorID)
	}
	if len(state.RecentChains) != 1 {
		t.Fatalf("chains len = %d, want 1", len(state.RecentChains))
	}
	if state.RecentChains[0].RawPayload != `{"hook_event_name":"PreToolUse"}` {
		t.Fatalf("raw payload = %s", state.RecentChains[0].RawPayload)
	}
	if len(state.RecentReports) != 1 {
		t.Fatalf("reports len = %d, want 1", len(state.RecentReports))
	}
	if state.RecentReports[0].RawRequest != `{"collector_id":"collector_1","events":[]}` {
		t.Fatalf("raw request = %s", state.RecentReports[0].RawRequest)
	}
}

func TestHealthzRejectsNonGet(t *testing.T) {
	handler := New(debugstore.New(debugstore.Config{}))
	req := httptest.NewRequest(http.MethodPost, "/healthz", nil)
	resp := httptest.NewRecorder()

	handler.Healthz(resp, req)

	if resp.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", resp.Code)
	}
	if resp.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("allow = %s", resp.Header().Get("Allow"))
	}
}

func TestHealthzReturnsOnlyOK(t *testing.T) {
	store := debugstore.New(debugstore.Config{})
	store.RecordReceived(debugstore.ReceivedInput{
		AgentType:  "codex",
		Path:       "/ingest/codex",
		RawPayload: []byte(`{"secret":"raw"}`),
	})
	handler := New(store)
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	resp := httptest.NewRecorder()

	handler.Healthz(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.Code)
	}
	body := resp.Body.String()
	if body != "ok" {
		t.Fatalf("body = %q, want ok", body)
	}
}

func TestIndexIncludesDebugLinks(t *testing.T) {
	handler := New(debugstore.New(debugstore.Config{}))
	req := httptest.NewRequest(http.MethodGet, "/debug", nil)
	resp := httptest.NewRecorder()

	handler.Index(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.Code)
	}
	body := resp.Body.String()
	for _, want := range []string{
		"采集器调试入口",
		`href="/debug/collector"`,
		`href="/debug/api/collector/state?limit=50"`,
		`href="/healthz"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("index missing %q: %s", want, body)
		}
	}
}

func TestPageIncludesHeartbeatStatsAndKeepsZeroValuesVisible(t *testing.T) {
	handler := New(debugstore.New(debugstore.Config{}))
	req := httptest.NewRequest(http.MethodGet, "/debug/collector", nil)
	resp := httptest.NewRecorder()

	handler.Page(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.Code)
	}
	body := resp.Body.String()
	if !strings.Contains(body, "heartbeat_success_10m") || !strings.Contains(body, "heartbeat_failed_10m") {
		t.Fatalf("page missing heartbeat stats: %s", body)
	}
	if !strings.Contains(body, "String(value ?? \"\")") {
		t.Fatalf("page does not preserve zero metric values: %s", body)
	}
}

func TestPageMarksPositiveFailureStatValuesAsDanger(t *testing.T) {
	handler := New(debugstore.New(debugstore.Config{}))
	req := httptest.NewRequest(http.MethodGet, "/debug/collector", nil)
	resp := httptest.NewRecorder()

	handler.Page(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.Code)
	}
	body := resp.Body.String()
	if strings.Contains(body, ".metric-danger { background") || strings.Contains(body, "border-color: #f04438") {
		t.Fatalf("page should not render danger framing around metric cards: %s", body)
	}
	if !strings.Contains(body, ".metric .value.metric-danger") {
		t.Fatalf("page missing danger value styles: %s", body)
	}
	for _, want := range []string{
		`"chains_parse_failed"`,
		`"chains_report_failed"`,
		`"reports_failed"`,
		`"heartbeat_failed_10m"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("page missing danger metric key %s: %s", want, body)
		}
	}
	if !strings.Contains(body, `Number(value) > 0 ? "value metric-danger" : "value"`) {
		t.Fatalf("page does not apply danger styling only to positive stat values: %s", body)
	}
}

func TestPageRendersChainDetailsAsFullWidthSections(t *testing.T) {
	handler := New(debugstore.New(debugstore.Config{}))
	req := httptest.NewRequest(http.MethodGet, "/debug/collector", nil)
	resp := httptest.NewRecorder()

	handler.Page(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.Code)
	}
	body := resp.Body.String()
	for _, want := range []string{
		`class="chain-detail-row"`,
		`colspan="5"`,
		`原始 Hook Payload`,
		`映射后的事件`,
		`上报信息`,
		`chainDetailRow(chain)`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("page missing chain detail section %q: %s", want, body)
		}
	}
	if strings.Contains(body, `'<td><details><summary>查看</summary><pre>' + pretty(chain)`) {
		t.Fatalf("page still renders the whole chain JSON inside the table cell: %s", body)
	}
}
