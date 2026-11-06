package feedback

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

func TestIncidentAgentWithoutEmployee(t *testing.T) {
	service, store := testService(t)
	in := incidentFixture()
	in.Reporter = &IncidentReporterIdentity{EnterpriseKey: strings.Repeat("a", 64), AgentID: "agent_1"}
	if _, _, err := service.PutIncident(context.Background(), in.ID, strings.Repeat("ab", 32), in, "127.0.0.1", ""); err != nil {
		t.Fatal(err)
	}
	stored, _ := store.Get(in.ID)
	if stored.Incident.Reporter.AgentID != "agent_1" || stored.Incident.Reporter.SubjectID != "" {
		t.Fatal("Agent 身份丢失或错误关联员工", stored.Incident.Reporter)
	}
	for _, reporter := range []IncidentReporterIdentity{
		{EnterpriseKey: in.Reporter.EnterpriseKey},
		{EnterpriseKey: in.Reporter.EnterpriseKey, AgentID: "agent_1", SubjectID: "user_1"},
		{EnterpriseKey: in.Reporter.EnterpriseKey, AgentID: "agent_1", DisplayName: "张三"},
	} {
		in.Reporter = &reporter
		if err := in.validate(); err == nil {
			t.Fatal("不完整的员工身份被接受", reporter)
		}
	}
}

func TestAutomaticIncidentRawLogs(t *testing.T) {
	service, store := testService(t)
	ctx := context.Background()
	in := incidentFixture()
	in.LogsExpected = new(bool)
	*in.LogsExpected = true
	in.Reporter = &IncidentReporterIdentity{EnterpriseKey: strings.Repeat("a", 64), SubjectID: "user_zhang", DisplayName: "张三", AgentID: "agent_1"}
	in.Diagnostics = &IncidentDiagnostics{ErrorMessage: "connection reset at /Users/zhang/app.ts:42", CauseCode: "ECONNRESET"}
	raw := strings.Repeat("ab", 32)
	if _, _, err := service.PutIncident(ctx, in.ID, raw, in, "127.0.0.1", ""); err != nil {
		t.Fatal(err)
	}
	data := []byte("{\"source\":\"desktop\",\"content\":\"TLS connection reset at /Users/zhang/app.ts:42\"}\n")
	upload := func(credential, digest string, body []byte) (bool, error) {
		return service.Upload(ctx, in.ID, "incident_raw_logs", credential, "application/x-ndjson", digest, int64(len(body)), bytes.NewReader(body), 1)
	}
	if _, err := upload(strings.Repeat("cd", 32), Hash(data), data); err == nil {
		t.Fatal("wrong credential accepted")
	}
	if _, err := upload(raw, strings.Repeat("0", 64), data); err == nil {
		t.Fatal("wrong digest accepted")
	}
	if _, err := service.Get(ctx, Actor{UserID: "admin"}, in.ID); err != nil {
		t.Fatal("logs failure hid summary", err)
	}
	if created, err := upload(raw, Hash(data), data); err != nil || !created {
		t.Fatal(created, err)
	}
	if created, err := upload(raw, Hash(data), data); err != nil || created {
		t.Fatal("retry not idempotent", created, err)
	}
	if _, err := upload(raw, Hash([]byte("changed\n")), []byte("changed\n")); err == nil {
		t.Fatal("overwrote first snapshot")
	}
	reader, artifact, err := service.Open(ctx, Actor{UserID: "admin"}, in.ID, "incident_raw_logs", true)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || !bytes.Equal(got, data) || artifact.RecordCount != 1 {
		t.Fatal(string(got), artifact, err)
	}
	for _, actor := range []Actor{{}, {UserID: "admin", AgentID: "agent_1"}, {UserID: "admin", ManualOnly: true}} {
		if _, _, err := service.Open(ctx, actor, in.ID, "incident_raw_logs", true); err == nil {
			t.Fatal("automatic logs escaped admin boundary", actor)
		}
		if _, err := service.Read(ctx, actor, in.ID, "logs", ReadInput{ArtifactID: "incident_raw_logs"}); err == nil {
			t.Fatal("automatic logs read escaped admin boundary", actor)
		}
	}
	stored, _ := store.Get(in.ID)
	items, _, listErr := service.List(ctx, Actor{UserID: "admin"}, Filter{Reporter: "张三"})
	encoded, _ := json.Marshal(items)
	if listErr != nil || len(items) != 1 || bytes.Contains(encoded, []byte("/Users/zhang")) || bytes.Contains(encoded, []byte("TLS connection")) {
		t.Fatal("list included diagnostics or raw logs", listErr)
	}
	if stored.ReservedBytes != MaxIncidentBytes+MaxIncidentLogBytes || stored.Version != 1 || stored.UploadState != "ready" {
		t.Fatal(stored)
	}
	changed := in
	changed.Reporter = &IncidentReporterIdentity{EnterpriseKey: in.Reporter.EnterpriseKey, SubjectID: "user_li", DisplayName: "李四"}
	changed.Revision++
	if _, _, err := service.PutIncident(ctx, in.ID, raw, changed, "127.0.0.1", ""); err == nil {
		t.Fatal("changed historical employee")
	}
}

func testIncidentReporterFilter(t *testing.T, store Store) {
	t.Helper()
	service := NewService(store, nil, func(context.Context, Actor, string) error { return nil }, 0)
	in := incidentFixture()
	in.Reporter = &IncidentReporterIdentity{EnterpriseKey: strings.Repeat("a", 64), SubjectID: "user_zhang", DisplayName: "张三"}
	if _, _, err := service.PutIncident(context.Background(), in.ID, strings.Repeat("ab", 32), in, "127.0.0.1", ""); err != nil {
		t.Fatal(err)
	}
	for _, filter := range []struct {
		query string
		count int
	}{{"张三", 1}, {"张", 1}, {"user_zhang", 1}, {"李四", 0}, {"' OR 1=1 --", 0}} {
		items, _, err := service.List(context.Background(), Actor{UserID: "admin"}, Filter{Reporter: filter.query})
		if err != nil || len(items) != filter.count {
			t.Fatal(filter, items, err)
		}
	}
}

func TestAutomaticIncidentReporterFilter(t *testing.T) {
	testIncidentReporterFilter(t, NewMemoryStore())
}

func TestModelResponseIncidentPreservesFirstCause(t *testing.T) {
	service, store := testService(t)
	ctx := context.Background()
	in := incidentFixture()
	in.Source, in.Layer, in.Stage, in.RunID = "daemon", "codex_model", "response", "run_model"
	in.ErrorCode, in.Message, in.FirstMessage = "responseStreamDisconnected", "responseStreamDisconnected HTTP 503", "responseStreamDisconnected HTTP 503"
	status := 503
	in.HTTPStatus = &status
	in.Diagnostics = &IncidentDiagnostics{ErrorMessage: "Reconnecting... 1/5", AdditionalDetails: "HTTP 503", RequestID: "req_first"}
	in.FirstDiagnostics = in.Diagnostics
	raw := strings.Repeat("ab", 32)
	if _, _, err := service.PutIncident(ctx, in.ID, raw, in, "127.0.0.1", ""); err != nil {
		t.Fatal(err)
	}
	in.Revision++
	in.OccurrenceCount++
	in.ErrorCode, in.Message, in.Outcome, in.TaskOutcome = "responseTooManyFailedAttempts", "responseTooManyFailedAttempts ECONNRESET", "failed", "failed"
	in.HTTPStatus = nil
	in.TransportCode = "ECONNRESET"
	in.Diagnostics = &IncidentDiagnostics{ErrorMessage: "retry limit exceeded", AdditionalDetails: "ECONNRESET", RequestID: "req_last"}
	if _, _, err := service.PutIncident(ctx, in.ID, raw, in, "127.0.0.1", ""); err != nil {
		t.Fatal(err)
	}
	stored, _ := store.Get(in.ID)
	if stored.Incident.FirstDiagnostics.RequestID != "req_first" || stored.Incident.Diagnostics.RequestID != "req_last" || stored.Incident.FirstMessage != "responseStreamDisconnected HTTP 503" || stored.Incident.ErrorCode != "responseTooManyFailedAttempts" {
		t.Fatal(stored.Incident)
	}
	items, _, err := service.List(ctx, Actor{UserID: "admin"}, Filter{})
	data, _ := json.Marshal(items)
	if err != nil || bytes.Contains(data, []byte("req_first")) || bytes.Contains(data, []byte("req_last")) {
		t.Fatal("list exposed technical details", err)
	}
	in.Revision++
	in.FirstDiagnostics = &IncidentDiagnostics{ErrorMessage: "changed first cause"}
	if _, _, err := service.PutIncident(ctx, in.ID, raw, in, "127.0.0.1", ""); err == nil {
		t.Fatal("first cause overwritten")
	}
}

func TestIncidentTechnicalDetailsValidation(t *testing.T) {
	for _, first := range []bool{false, true} {
		for _, details := range []string{strings.Repeat("x", 2049), "Bearer private-value"} {
			in := incidentFixture()
			diagnostics := &IncidentDiagnostics{AdditionalDetails: details}
			if first {
				in.FirstDiagnostics = diagnostics
			} else {
				in.Diagnostics = diagnostics
			}
			if in.validate() == nil {
				t.Fatal("unsafe technical details accepted")
			}
		}
	}
}

func TestModelIncidentFirstUploadAfterOfflineAggregation(t *testing.T) {
	service, store := testService(t)
	in := incidentFixture()
	in.Source, in.Layer, in.Stage, in.RunID = "daemon", "codex_model", "response", "run_offline"
	in.Revision, in.OccurrenceCount = 4, 3
	in.ErrorCode, in.Message, in.FirstMessage = "responseTooManyFailedAttempts", "responseTooManyFailedAttempts", "responseStreamDisconnected HTTP 503"
	in.FirstDiagnostics = &IncidentDiagnostics{AdditionalDetails: "HTTP 503", RequestID: "req_first"}
	in.Diagnostics = &IncidentDiagnostics{ErrorMessage: "retry limit exceeded"}
	in.Outcome, in.TaskOutcome = "failed", "failed"
	if _, created, err := service.PutIncident(context.Background(), in.ID, strings.Repeat("ab", 32), in, "127.0.0.1", ""); err != nil || !created {
		t.Fatalf("offline snapshot rejected: created=%v err=%v", created, err)
	}
	stored, err := store.Get(in.ID)
	if err != nil || stored.Incident.FirstDiagnostics.RequestID != "req_first" || stored.Incident.Outcome != "failed" {
		t.Fatal("offline evidence lost", err)
	}
}

func incidentFixture() AutomaticIncident {
	return AutomaticIncident{SchemaVersion: 1, PolicyVersion: 1, ID: "11111111-1111-4111-8111-111111111111", InstallationID: "22222222-2222-4222-8222-222222222222", SessionID: "33333333-3333-4333-8333-333333333333", Revision: 1, Source: "desktop", Layer: "desktop_bootstrap", Stage: "starting_daemon", ErrorCode: "RUNTIME_STARTUP_STALLED", FirstSeenAt: time.Now().UTC().Format(time.RFC3339Nano), LastSeenAt: time.Now().UTC().Format(time.RFC3339Nano), OccurrenceCount: 1, Outcome: "ongoing", Message: "RUNTIME_STARTUP_STALLED", FirstMessage: "RUNTIME_STARTUP_STALLED", Environment: IncidentEnvironment{AppVersion: "0.1.8"}}
}
func TestAutomaticIncidentIdempotencyAndManualState(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(store, nil, func(context.Context, Actor, string) error { return nil }, 0)
	in := incidentFixture()
	raw := strings.Repeat("ab", 32)
	out, created, err := service.PutIncident(ctx, in.ID, raw, in, "127.0.0.1", "")
	if err != nil || !created || out["accepted_revision"] != int64(1) {
		t.Fatal(out, created, err)
	}
	out, created, err = service.PutIncident(ctx, in.ID, raw, in, "127.0.0.1", "")
	if err != nil || created {
		t.Fatal(out, created, err)
	}
	conflict := in
	conflict.OccurrenceCount++
	_, _, err = service.PutIncident(ctx, in.ID, raw, conflict, "127.0.0.1", "")
	if status, _ := HTTPError(err); status != 409 {
		t.Fatal(err)
	}
	_, _, err = service.PutIncident(ctx, in.ID, strings.Repeat("cd", 32), in, "127.0.0.1", "")
	if status, _ := HTTPError(err); status != 403 {
		t.Fatal(err)
	}
	_, err = service.Operate(ctx, Actor{UserID: "admin"}, in.ID, "resolve", OperationInput{ExpectedVersion: 1, IdempotencyKey: "operation_001", ResolutionSummary: "已确认", Verification: "测试通过"})
	if err != nil {
		t.Fatal(err)
	}
	before, _ := store.Get(in.ID)
	in.Revision = 3
	in.Outcome = "recovered"
	in.OccurrenceCount = 3
	_, _, err = service.PutIncident(ctx, in.ID, raw, in, "127.0.0.1", "")
	if err != nil {
		t.Fatal(err)
	}
	older := in
	older.Revision = 2
	older.Outcome = "ongoing"
	out, _, err = service.PutIncident(ctx, in.ID, raw, older, "127.0.0.1", "")
	if err != nil || out["accepted_revision"] != int64(3) {
		t.Fatal(out, err)
	}
	after, _ := store.Get(in.ID)
	if after.Version != before.Version || after.ProcessingStatus != "resolved" || len(after.Events) != 1 || !after.ExpiresAt.Equal(before.ExpiresAt) || after.TrustedSource != "" || after.Incident.Outcome != "recovered" {
		t.Fatal(after)
	}
	if _, err = service.Get(ctx, Actor{}, in.ID); err == nil {
		t.Fatal("允许匿名读取")
	}
	if _, err = service.GetReady(ctx, Actor{UserID: "admin", AgentID: "agent_1"}, in.ID); err == nil {
		t.Fatal("MCP读到了自动异常")
	}
	if _, err = service.Operate(ctx, Actor{UserID: "admin", AgentID: "agent_1"}, in.ID, "reopen", OperationInput{ExpectedVersion: 2, IdempotencyKey: "operation_002", Reason: "不应允许"}); err == nil {
		t.Fatal("MCP处理了自动异常")
	}
}
func TestAutomaticIncidentValidationAndCapacity(t *testing.T) {
	for _, mutate := range []func(*AutomaticIncident){
		func(in *AutomaticIncident) { in.Message = "business body" },
		func(in *AutomaticIncident) { in.Environment.Model = "sk-private" },
		func(in *AutomaticIncident) { in.TransportCode = "/Users/private/file" },
		func(in *AutomaticIncident) { in.UpstreamRequestID = "https://user:pass@host?key=secret" },
		func(in *AutomaticIncident) { in.SchemaVersion = 2 },
		func(in *AutomaticIncident) { in.HTTPStatus = new(int) },
		func(in *AutomaticIncident) { in.Source = "web" },
	} {
		in := incidentFixture()
		mutate(&in)
		if in.validate() == nil {
			t.Fatalf("接受了无效字段：%+v", in)
		}
	}
	in := incidentFixture()
	service := NewService(NewMemoryStore(), nil, nil, MaxIncidentBytes-1)
	_, _, err := service.PutIncident(context.Background(), in.ID, strings.Repeat("ab", 32), in, "127.0.0.1", "")
	if status, _ := HTTPError(err); status != 429 {
		t.Fatal(err)
	}
}
func TestAutomaticIncidentRejectsCredentialFormats(t *testing.T) {
	for _, credential := range []string{
		"ghp_" + strings.Repeat("A", 36), "gho_" + strings.Repeat("B", 36), "github_pat_" + strings.Repeat("C", 60),
		"AKIA" + strings.Repeat("D", 16), "ASIA" + strings.Repeat("E", 16), "AIza" + strings.Repeat("F", 35),
		"xoxb-" + strings.Repeat("1", 24), "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl",
	} {
		for index, mutate := range []func(*AutomaticIncident){
			func(in *AutomaticIncident) { in.Stage = credential },
			func(in *AutomaticIncident) {
				in.ErrorCode, in.Message, in.FirstMessage = credential, credential, credential
			},
			func(in *AutomaticIncident) { in.ScopeID = credential },
			func(in *AutomaticIncident) { in.RunID = credential },
			func(in *AutomaticIncident) { in.ThreadID = credential },
			func(in *AutomaticIncident) {
				in.TransportCode = credential
				in.Message += " " + credential
				in.FirstMessage = in.Message
			},
			func(in *AutomaticIncident) { in.ExitSignal = credential },
			func(in *AutomaticIncident) { in.UpstreamRequestID = credential },
			func(in *AutomaticIncident) { in.Environment.AppVersion = credential },
			func(in *AutomaticIncident) { in.Environment.DaemonVersion = credential },
			func(in *AutomaticIncident) { in.Environment.RuntimeVersion = credential },
			func(in *AutomaticIncident) { in.Environment.ElectronVersion = credential },
			func(in *AutomaticIncident) { in.Environment.BuildSHA = credential },
			func(in *AutomaticIncident) { in.Environment.Platform = credential },
			func(in *AutomaticIncident) { in.Environment.Arch = credential },
			func(in *AutomaticIncident) { in.Environment.Model = credential },
			func(in *AutomaticIncident) { in.Environment.Protocol = credential },
			func(in *AutomaticIncident) { in.Environment.Transport = credential },
		} {
			in := incidentFixture()
			mutate(&in)
			if status, _ := HTTPError(in.validate()); status != 400 {
				t.Fatalf("credential format accepted in field %d", index)
			}
		}
	}
}

func TestAutomaticIncidentTimestampUpdates(t *testing.T) {
	for _, test := range []struct {
		name, previous, next string
		status               int
	}{
		{"fractional", "2026-10-15T10:00:00Z", "2026-10-15T10:00:00.001Z", 0},
		{"precision", "2026-10-15T10:00:00.1Z", "2026-10-15T10:00:00.100001Z", 0},
		{"offset", "2026-10-15T10:00:00Z", "2026-10-15T09:00:01-01:00", 0},
		{"equal", "2026-10-15T10:00:00Z", "2026-10-15T11:00:00+01:00", 0},
		{"older", "2026-10-15T10:00:00.001Z", "2026-10-15T10:00:00Z", 409},
		{"older_offset", "2026-10-15T10:00:00Z", "2026-10-15T11:00:00+02:00", 409},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := NewMemoryStore()
			service := NewService(store, nil, nil, 0)
			in := incidentFixture()
			in.FirstSeenAt, in.LastSeenAt = "2026-10-15T00:00:00Z", test.previous
			raw := strings.Repeat("ab", 32)
			if _, _, err := service.PutIncident(context.Background(), in.ID, raw, in, "127.0.0.1", ""); err != nil {
				t.Fatal(err)
			}
			in.Revision++
			in.LastSeenAt = test.next
			_, _, err := service.PutIncident(context.Background(), in.ID, raw, in, "127.0.0.1", "")
			status := 0
			if err != nil {
				status, _ = HTTPError(err)
			}
			if status != test.status {
				t.Fatalf("status=%d err=%v", status, err)
			}
			stored, _ := store.Get(in.ID)
			if test.status == 0 && stored.Incident.Revision != 2 || test.status != 0 && stored.Incident.Revision != 1 {
				t.Fatal("unexpected stored revision", stored.Incident.Revision)
			}
		})
	}
}

func TestAutomaticIncidentClassificationIsImmutable(t *testing.T) {
	status503, status504 := 503, 504
	status503Copy := 503
	for _, test := range []struct {
		name          string
		initial, next *int
		transport     string
		allowed       bool
	}{
		{name: "transport", transport: "ETIMEDOUT"},
		{name: "status_added", next: &status503},
		{name: "status_removed", initial: &status503},
		{name: "status_changed", initial: &status503, next: &status504},
		{name: "status_unchanged", initial: &status503, next: &status503Copy, allowed: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := NewMemoryStore()
			service := NewService(store, nil, nil, 0)
			in := incidentFixture()
			in.TransportCode = "ECONNRESET"
			in.HTTPStatus = test.initial
			in.Message += " " + in.TransportCode
			if in.HTTPStatus != nil {
				in.Message += fmt.Sprintf(" HTTP %d", *in.HTTPStatus)
			}
			in.FirstMessage = in.Message
			raw := strings.Repeat("ab", 32)
			if _, _, err := service.PutIncident(context.Background(), in.ID, raw, in, "127.0.0.1", ""); err != nil {
				t.Fatal(err)
			}
			in.Revision++
			in.HTTPStatus = test.next
			if test.transport != "" {
				in.TransportCode = test.transport
			}
			in.Message = in.ErrorCode + " " + in.TransportCode
			if in.HTTPStatus != nil {
				in.Message += fmt.Sprintf(" HTTP %d", *in.HTTPStatus)
			}
			in.FirstMessage = in.Message
			_, _, err := service.PutIncident(context.Background(), in.ID, raw, in, "127.0.0.1", "")
			if test.allowed && err != nil || !test.allowed && err == nil {
				t.Fatal("classification changed", err)
			}
			if err != nil {
				if status, _ := HTTPError(err); status != 409 {
					t.Fatal(err)
				}
			}
			stored, _ := store.Get(in.ID)
			expectedRevision := int64(1)
			if test.allowed {
				expectedRevision++
			}
			if stored.Incident.Revision != expectedRevision || stored.Incident.TransportCode != "ECONNRESET" {
				t.Fatal("rejected update changed stored facts")
			}
		})
	}
}

func TestAutomaticIncidentListPagination(t *testing.T) {
	testAutomaticIncidentPagination(t, NewMemoryStore())
}

func testAutomaticIncidentPagination(t *testing.T, store Store) {
	t.Helper()
	ctx := context.Background()
	service := NewService(store, nil, func(context.Context, Actor, string) error { return nil }, 0)
	now := time.Now().UTC().Truncate(time.Second)
	first := incidentFixture()
	first.FirstSeenAt = now.Add(-time.Minute).Format(time.RFC3339Nano)
	first.LastSeenAt = now.Add(123456789 * time.Nanosecond).Format(time.RFC3339Nano)
	second := first
	second.ID = "44444444-4444-4444-8444-444444444444"
	second.LastSeenAt = now.Add(123456111 * time.Nanosecond).Format(time.RFC3339Nano)
	third := first
	third.ID = "55555555-5555-4555-8555-555555555555"
	third.LastSeenAt = now.Add(100000000 * time.Nanosecond).Format(time.RFC3339Nano)
	for _, in := range []AutomaticIncident{first, second, third} {
		if _, _, err := service.PutIncident(ctx, in.ID, strings.Repeat("ab", 32), in, "127.0.0.1", ""); err != nil {
			t.Fatal(err)
		}
	}
	cursor := ""
	for index, id := range []string{second.ID, first.ID, third.ID} {
		items, next, err := service.List(ctx, Actor{UserID: "admin"}, Filter{Kind: "automatic_incident", Layer: "desktop_bootstrap", ErrorCode: "RUNTIME_STARTUP_STALLED", Cursor: cursor, Limit: 1})
		if err != nil || len(items) != 1 || items[0]["report_id"] != id {
			t.Fatalf("page %d: items=%v err=%v", index, items, err)
		}
		if index < 2 && next == "" || index == 2 && next != "" {
			t.Fatal("unexpected continuation", next)
		}
		cursor = next
	}
	last, _ := time.Parse(time.RFC3339Nano, second.LastSeenAt)
	for _, offset := range []int{8 * 60 * 60, -7 * 60 * 60} {
		cursor = last.Truncate(time.Microsecond).In(time.FixedZone("test", offset)).Format(time.RFC3339Nano) + "|" + second.ID
		items, _, err := service.List(ctx, Actor{UserID: "admin"}, Filter{Kind: "automatic_incident", Cursor: cursor, Limit: 1})
		if err != nil || len(items) != 1 || items[0]["report_id"] != first.ID {
			t.Fatalf("offset %d: items=%v err=%v", offset, items, err)
		}
	}
}

func TestUnavailableReportKinds(t *testing.T) {
	for _, kind := range []string{"", "manual", "automatic_incident"} {
		for _, state := range []string{"expired", "quarantine"} {
			t.Run(kind+"/"+state, func(t *testing.T) {
				now := time.Now().UTC()
				report := Report{Kind: kind, Description: "private facts", Incident: &AutomaticIncident{}, SecurityState: "normal", ExpiresAt: now.Add(time.Hour)}
				if state == "expired" {
					report.ExpiresAt = now.Add(-time.Hour)
				} else {
					report.SecurityState = state
				}
				out := publicReport(report)
				expected := kind
				if expected == "" {
					expected = "manual"
				}
				if out["kind"] != expected || out["incident"] != nil || out["description"] != nil {
					t.Fatal("unavailable report lost kind or exposed facts", out)
				}
			})
		}
	}
}
func TestAutomaticIncidentDailyLimitAndRetention(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(store, nil, nil, 0)
	now := time.Now().UTC()
	service.clock = func() time.Time { return now }
	for index := 0; index < 101; index++ {
		in := incidentFixture()
		in.ID = fmt.Sprintf("11111111-1111-4111-8111-%012d", index)
		_, _, err := service.PutIncident(ctx, in.ID, strings.Repeat("ab", 32), in, fmt.Sprintf("ip%d", index), "")
		if index < 100 && err != nil {
			t.Fatal(index, err)
		}
		if index == 100 {
			if status, code := HTTPError(err); status != 429 || code != "feedback_installation_rate_limited" {
				t.Fatal(err)
			}
		}
		now = now.Add(time.Minute)
	}
	now = now.Add(31 * 24 * time.Hour)
	if err := service.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	r, err := store.Get("11111111-1111-4111-8111-000000000000")
	if err != nil || r.Incident != nil || r.ReservedBytes != 0 {
		t.Fatal(r, err)
	}
	if publicReport(r)["kind"] != "automatic_incident" {
		t.Fatal("cleaned incident lost its kind")
	}
	data, _ := json.Marshal(r)
	if strings.Contains(string(data), "22222222-2222") {
		t.Fatal("过期元数据未清理")
	}
}
