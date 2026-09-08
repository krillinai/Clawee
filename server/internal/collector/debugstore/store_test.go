package debugstore

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func TestStoreKeepsRecentChainsWithRawPayloadAndReportResult(t *testing.T) {
	store := New(Config{Capacity: 2, Now: fixedNow})

	chainID := store.RecordReceived(ReceivedInput{
		AgentType:  "codex",
		Path:       "/ingest/codex",
		RawPayload: []byte(`{"hook_event_name":"PreToolUse","tool_input":{"command":"printf secret"}}`),
	})
	store.RecordParsed(chainID, nil)
	store.RecordMapped(chainID, []collectorapi.CollectorEvent{{
		EventID:    "evt_1",
		EventType:  collectorapi.EventToolCallStarted,
		OccurredAt: fixedNow(),
		AgentID:    "agent_1",
		AgentType:  collectorapi.AgentTypeCodex,
	}})
	store.RecordChainReport(chainID, ChainReportInput{
		Kind:           "events",
		Path:           "/api/v1/collector/events",
		RawRequest:     []byte(`{"schema_version":"collector.v1","events":[{"event_id":"evt_1"}]}`),
		ResponseStatus: httpStatusAccepted,
	})

	state := store.State(10)
	if len(state.RecentChains) != 1 {
		t.Fatalf("chains len = %d, want 1", len(state.RecentChains))
	}
	chain := state.RecentChains[0]
	if chain.ID != chainID {
		t.Fatalf("chain id = %s", chain.ID)
	}
	if chain.RawPayload != `{"hook_event_name":"PreToolUse","tool_input":{"command":"printf secret"}}` {
		t.Fatalf("raw payload = %s", chain.RawPayload)
	}
	if chain.ReportStatus != ReportStatusSuccess {
		t.Fatalf("report status = %s", chain.ReportStatus)
	}
	if chain.ReportRequest != `{"schema_version":"collector.v1","events":[{"event_id":"evt_1"}]}` {
		t.Fatalf("report request = %s", chain.ReportRequest)
	}
	if chain.ReportResponseStatus != httpStatusAccepted {
		t.Fatalf("report response status = %d", chain.ReportResponseStatus)
	}
}

func TestStoreEvictsOldChainsWhenCapacityIsExceeded(t *testing.T) {
	store := New(Config{Capacity: 2, Now: fixedNow})

	firstID := store.RecordReceived(ReceivedInput{AgentType: "codex", Path: "/ingest/codex", RawPayload: []byte(`{"n":1}`)})
	secondID := store.RecordReceived(ReceivedInput{AgentType: "codex", Path: "/ingest/codex", RawPayload: []byte(`{"n":2}`)})
	thirdID := store.RecordReceived(ReceivedInput{AgentType: "codex", Path: "/ingest/codex", RawPayload: []byte(`{"n":3}`)})

	state := store.State(10)
	if len(state.RecentChains) != 2 {
		t.Fatalf("chains len = %d, want 2", len(state.RecentChains))
	}
	if state.RecentChains[0].ID != thirdID || state.RecentChains[1].ID != secondID {
		t.Fatalf("chain order = %#v, want newest first", []string{state.RecentChains[0].ID, state.RecentChains[1].ID})
	}
	if state.RecentChains[1].RawPayload != `{"n":2}` {
		t.Fatalf("raw payload = %s", state.RecentChains[1].RawPayload)
	}
	if earlier := store.Chain(firstID); earlier != nil {
		t.Fatalf("expected first chain to be evicted, got %#v", earlier)
	}
}

func TestStoreRecordsParseFailureAndHeartbeatStats(t *testing.T) {
	store := New(Config{Capacity: 50, Now: fixedNow})
	chainID := store.RecordReceived(ReceivedInput{AgentType: "codex", Path: "/ingest/codex", RawPayload: []byte(`{"hook_event_name":`)})
	store.RecordParsed(chainID, errInvalidJSON{})
	store.RecordReport(ReportInput{
		Kind:           "heartbeat",
		Path:           "/api/v1/collector/heartbeat",
		RawRequest:     []byte(`{"collector_token":"keep_raw","agents":[]}`),
		ResponseStatus: 401,
		Error:          "collector report /api/v1/collector/heartbeat returned status 401: unauthorized",
		Duration:       25 * time.Millisecond,
	})

	state := store.State(50)
	if state.Stats.ChainsParseFailed != 1 {
		t.Fatalf("parse failed = %d, want 1", state.Stats.ChainsParseFailed)
	}
	if state.RecentChains[0].ParseStatus != ParseStatusFailed {
		t.Fatalf("parse status = %s", state.RecentChains[0].ParseStatus)
	}
	if state.RecentChains[0].ParseError == "" {
		t.Fatal("expected parse error")
	}
	if state.RecentChains[0].RawPayload != `{"hook_event_name":` {
		t.Fatalf("raw payload = %s", state.RecentChains[0].RawPayload)
	}
	if len(state.RecentReports) != 0 {
		t.Fatalf("reports len = %d, want 0", len(state.RecentReports))
	}
	if state.Stats.HeartbeatFailed10m != 1 {
		t.Fatalf("heartbeat failed = %d, want 1", state.Stats.HeartbeatFailed10m)
	}
}

func TestStateLimitIsCappedByCapacityDefault(t *testing.T) {
	store := New(Config{Now: fixedNow})
	for i := 0; i < 55; i++ {
		body, err := json.Marshal(map[string]int{"n": i})
		if err != nil {
			t.Fatal(err)
		}
		store.RecordReceived(ReceivedInput{AgentType: "codex", Path: "/ingest/codex", RawPayload: body})
	}

	state := store.State(100)
	if state.Capacity != 50 {
		t.Fatalf("capacity = %d, want 50", state.Capacity)
	}
	if len(state.RecentChains) != 50 {
		t.Fatalf("chains len = %d, want 50", len(state.RecentChains))
	}
	if state.RecentChains[0].RawPayload != `{"n":54}` {
		t.Fatalf("newest payload = %s", state.RecentChains[0].RawPayload)
	}
}

func TestStoreRecordsEventReportsButNotHeartbeatReports(t *testing.T) {
	store := New(Config{Capacity: 50, Now: fixedNow})
	store.RecordReport(ReportInput{
		Kind:           "heartbeat",
		Path:           "/api/v1/collector/heartbeat",
		RawRequest:     []byte(`{"collector_id":"collector_1"}`),
		ResponseStatus: httpStatusAccepted,
	})
	store.RecordReport(ReportInput{
		Kind:           "events",
		Path:           "/api/v1/collector/events",
		RawRequest:     []byte(`{"events":[{"event_id":"evt_1"}]}`),
		ResponseStatus: httpStatusAccepted,
		Duration:       25 * time.Millisecond,
	})

	state := store.State(50)
	if len(state.RecentReports) != 1 {
		t.Fatalf("reports len = %d, want 1", len(state.RecentReports))
	}
	report := state.RecentReports[0]
	if report.Kind != "events" {
		t.Fatalf("report kind = %s, want events", report.Kind)
	}
	if report.RawRequest != `{"events":[{"event_id":"evt_1"}]}` {
		t.Fatalf("raw request = %s", report.RawRequest)
	}
	if report.DurationMS != 25 {
		t.Fatalf("duration = %d, want 25", report.DurationMS)
	}
	if state.Stats.ReportsTotal != 1 || state.Stats.ReportsSuccess != 1 {
		t.Fatalf("report stats = %#v", state.Stats)
	}
	if state.Stats.HeartbeatSuccess10m != 1 {
		t.Fatalf("heartbeat success = %d, want 1", state.Stats.HeartbeatSuccess10m)
	}
}

func TestHeartbeatStatsUseRecentTenMinuteWindow(t *testing.T) {
	now := time.Date(2026, 7, 3, 10, 0, 0, 0, time.UTC)
	store := New(Config{Capacity: 50, Now: func() time.Time { return now }})
	store.RecordReport(ReportInput{Kind: "heartbeat", ResponseStatus: httpStatusAccepted})

	now = now.Add(9 * time.Minute)
	store.RecordReport(ReportInput{Kind: "heartbeat", Error: "network error"})

	state := store.State(50)
	if state.Stats.HeartbeatSuccess10m != 1 {
		t.Fatalf("heartbeat success = %d, want 1", state.Stats.HeartbeatSuccess10m)
	}
	if state.Stats.HeartbeatFailed10m != 1 {
		t.Fatalf("heartbeat failed = %d, want 1", state.Stats.HeartbeatFailed10m)
	}

	now = now.Add(2 * time.Minute)
	state = store.State(50)
	if state.Stats.HeartbeatSuccess10m != 0 {
		t.Fatalf("heartbeat success after window = %d, want 0", state.Stats.HeartbeatSuccess10m)
	}
	if state.Stats.HeartbeatFailed10m != 1 {
		t.Fatalf("heartbeat failed after window = %d, want 1", state.Stats.HeartbeatFailed10m)
	}
}

func TestStoreTruncatesRawValuesLargerThanOneMB(t *testing.T) {
	store := New(Config{Capacity: 50, Now: fixedNow})
	largeRaw := []byte(strings.Repeat("x", MaxRawBytes+1))
	chainID := store.RecordReceived(ReceivedInput{
		AgentType:  "codex",
		Path:       "/ingest/codex",
		RawPayload: largeRaw,
	})
	store.RecordReport(ReportInput{
		ChainID:        chainID,
		Kind:           "events",
		Path:           "/api/v1/collector/events",
		RawRequest:     largeRaw,
		ResponseStatus: httpStatusAccepted,
	})

	state := store.State(50)
	chain := state.RecentChains[0]
	if len(chain.RawPayload) != MaxRawBytes {
		t.Fatalf("raw payload len = %d, want %d", len(chain.RawPayload), MaxRawBytes)
	}
	if !chain.RawPayloadTruncated {
		t.Fatal("expected raw payload truncated")
	}
	if len(chain.ReportRequest) != MaxRawBytes {
		t.Fatalf("report request len = %d, want %d", len(chain.ReportRequest), MaxRawBytes)
	}
	if !chain.ReportRequestTruncated {
		t.Fatal("expected report request truncated")
	}
	report := state.RecentReports[0]
	if len(report.RawRequest) != MaxRawBytes {
		t.Fatalf("raw request len = %d, want %d", len(report.RawRequest), MaxRawBytes)
	}
	if !report.RawRequestTruncated {
		t.Fatal("expected raw request truncated")
	}
}

func TestStoreTruncatesRawValuesAtUTF8Boundary(t *testing.T) {
	store := New(Config{Capacity: 50, Now: fixedNow})
	largeRaw := []byte(strings.Repeat("a", MaxRawBytes-1) + "中")
	chainID := store.RecordReceived(ReceivedInput{RawPayload: largeRaw})
	store.RecordChainReport(chainID, ChainReportInput{RawRequest: largeRaw})
	store.RecordReport(ReportInput{ChainID: chainID, RawRequest: largeRaw})

	state := store.State(50)
	chain := state.RecentChains[0]
	if !utf8.ValidString(chain.RawPayload) {
		t.Fatal("RawPayload is invalid UTF-8 at truncation boundary")
	}
	if len(chain.RawPayload) > MaxRawBytes {
		t.Fatalf("RawPayload has %d bytes, want at most %d", len(chain.RawPayload), MaxRawBytes)
	}
	if !utf8.ValidString(chain.ReportRequest) {
		t.Fatal("ReportRequest is invalid UTF-8 at truncation boundary")
	}
	if !utf8.ValidString(state.RecentReports[0].RawRequest) {
		t.Fatal("RawRequest is invalid UTF-8 at truncation boundary")
	}
}

type errInvalidJSON struct{}

func (errInvalidJSON) Error() string {
	return "invalid json"
}

func fixedNow() time.Time {
	return time.Date(2026, 7, 3, 10, 0, 0, 0, time.UTC)
}

const httpStatusAccepted = 202
