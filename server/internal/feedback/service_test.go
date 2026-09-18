package feedback

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
	"io"
	"strings"
	"testing"
	"time"
)

func testService(t *testing.T) (*Service, *MemoryStore) {
	t.Helper()
	storage, e := sharedfiles.NewFileSystemStorage(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	store := NewMemoryStore()
	svc := NewService(store, storage, func(_ context.Context, a Actor, op string) error {
		if a.UserID != "admin" || (a.AgentID == "readonly" && op == "resolve") {
			return fail(403, "feedback_forbidden")
		}
		return nil
	}, 0)
	return svc, store
}
func inputFor(data []byte) CreateInput {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	m := Manifest{SchemaVersion: 1, SnapshotAt: now, ThreadID: "thread_test", RunIDs: []string{}, RuntimeThreadIDs: []string{}, Watermarks: []Watermark{}, Completeness: "partial", RedactionPolicyVersion: 1, Artifacts: []Artifact{{ID: "artifact_test", Kind: "conversation", Name: "conversation.ndjson", ContentType: "application/x-ndjson", Size: int64(len(data)), SHA256: Hash(data), RecordCount: 1, Source: "test", PartIndex: 1}}, MissingItems: []string{"desktop:unavailable"}, Warnings: []string{}}
	b, _ := json.Marshal(m)
	in := CreateInput{ClientID: "client_" + token(), RecoveryToken: token(), StatusToken: token(), Description: "测试问题", OccurredAt: now, Manifest: b, Environment: map[string]string{"app_version": "test"}}
	in.Consent.PolicyVersion = 1
	in.Consent.ConfirmedAt = now
	return in
}
func createTest(t *testing.T, s *Service, in CreateInput) map[string]any {
	t.Helper()
	p, created, e := s.Create(context.Background(), in, token(), "")
	if e != nil || !created {
		t.Fatalf("create: %v %v", created, e)
	}
	return p
}
func submitTest(t *testing.T, s *Service, in CreateInput, p map[string]any, data []byte) {
	t.Helper()
	id := p["report_id"].(string)
	raw := p["upload_token"].(string)
	var m Manifest
	_ = json.Unmarshal(in.Manifest, &m)
	_, e := s.Upload(context.Background(), id, m.Artifacts[0].ID, raw, m.Artifacts[0].ContentType, m.Artifacts[0].SHA256, m.Artifacts[0].Size, bytes.NewReader(data))
	if e != nil {
		t.Fatal(e)
	}
	mh, _ := CanonicalHash(in.Manifest)
	if _, e = s.Submit(context.Background(), id, raw, mh, true); e != nil {
		t.Fatal(e)
	}
}
func TestCredentialsIdempotencyAndConsent(t *testing.T) {
	s, store := testService(t)
	ctx := context.Background()
	data := []byte("{\"message\":\"业务正文\"}\n")
	in := inputFor(data)
	p := createTest(t, s, in)
	id := p["report_id"].(string)
	again, created, e := s.Create(ctx, in, "same", "")
	if e != nil || created || again["report_id"] != id {
		t.Fatal("creation retry is not idempotent", e)
	}
	if _, e = s.Status(ctx, id, in.RecoveryToken); e == nil {
		t.Fatal("recovery token reads status")
	}
	if _, e = s.Recover(ctx, id, in.StatusToken); e == nil {
		t.Fatal("status token recovers")
	}
	changed := in
	changed.Description = "不同正文"
	if _, _, e = s.Create(ctx, changed, "same", ""); e == nil {
		t.Fatal("immutable content changed")
	}
	if _, e = s.GetReady(ctx, Actor{UserID: "admin"}, id); e == nil {
		t.Fatal("MCP can read uploading")
	}
	_ = store.Update(ctx, func(tx Transaction) error {
		r, e := tx.Get(id)
		if e != nil {
			return e
		}
		if len(r.Consent) == 0 {
			t.Fatal("consent not stored")
		}
		return nil
	})
	submitTest(t, s, in, again, data)
	recovered, e := s.Recover(ctx, id, in.RecoveryToken)
	if e != nil || recovered["upload_token"] != nil {
		t.Fatal("ready report regained write credential", e)
	}
	status, e := s.Status(ctx, id, in.StatusToken)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(status)
	for _, field := range []string{"description", "manifest", "recovery", "storage", "environment"} {
		if strings.Contains(string(b), field) {
			t.Fatal("status leaks", field)
		}
	}
}
func TestListUnavailableDoesNotExposeQuarantineDescription(t *testing.T) {
	s, store := testService(t)
	ctx := context.Background()
	in := inputFor([]byte("{}\n"))
	in.Description = strings.Repeat("隔离正文", 300) + " password=secret_value_123"
	p := createTest(t, s, in)
	id := p["report_id"].(string)
	items, _, err := s.List(ctx, Actor{UserID: "admin"}, Filter{Status: "all"})
	if err != nil || len(items) != 0 {
		t.Fatal("default list should exclude unavailable reports", err)
	}
	items, _, err = s.List(ctx, Actor{UserID: "admin"}, Filter{Status: "all", IncludeUnavailable: true})
	if err != nil || len(items) != 1 {
		t.Fatal("unavailable list should include quarantine metadata", err)
	}
	for _, key := range []string{"description", "reproduction_steps", "manifest", "artifacts", "events"} {
		if _, exists := items[0][key]; exists {
			t.Fatal("quarantine list exposes body", key)
		}
	}
	if _, _, err = s.List(ctx, Actor{UserID: "unauthorized"}, Filter{IncludeUnavailable: true}); err == nil {
		t.Fatal("unavailable filter bypasses authorization")
	}
	if err = store.Update(ctx, func(tx Transaction) error {
		r, err := tx.Get(id)
		if err != nil {
			return err
		}
		r.ExpiresAt = time.Now().Add(-time.Hour)
		return tx.Save(r)
	}); err != nil {
		t.Fatal(err)
	}
	items, _, err = s.List(ctx, Actor{UserID: "admin"}, Filter{Status: "all", IncludeUnavailable: true})
	if err != nil || len(items) != 1 || items[0]["description"] != nil {
		t.Fatal("expired metadata unavailable or body exposed", err)
	}
}
func TestCompleteManifestRejectsKnownSourceTruncation(t *testing.T) {
	in := inputFor([]byte("{}\n"))
	var manifest Manifest
	_ = json.Unmarshal(in.Manifest, &manifest)
	manifest.Completeness = "complete"
	manifest.MissingItems = nil
	manifest.Artifacts = append(manifest.Artifacts,
		Artifact{ID: "artifact_environment", Kind: "environment", Source: "environment", PartIndex: 1, ContentType: "application/x-ndjson", Size: 3, SHA256: Hash([]byte("{}\n")), RecordCount: 1},
		Artifact{ID: "artifact_diagnostics", Kind: "diagnostics", Source: "diagnostics", PartIndex: 1, ContentType: "application/x-ndjson", Size: 3, SHA256: Hash([]byte("{}\n")), RecordCount: 1})
	manifest.Watermarks = []Watermark{{Source: "test", ExpectedCount: 1, ExportedCount: 1, SourceTruncated: true}}
	in.Manifest, _ = json.Marshal(manifest)
	if _, _, _, _, err := validate(in); err == nil {
		t.Fatal("known truncated source marked complete")
	}
	manifest.Completeness = "partial"
	manifest.MissingItems = []string{"test:source_truncated"}
	in.Manifest, _ = json.Marshal(manifest)
	if _, _, _, _, err := validate(in); err != nil {
		t.Fatal("explicit partial manifest rejected", err)
	}
}
func TestOperationsConflictAndRetry(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	data := []byte("{\"text\":\"ok\"}\n")
	in := inputFor(data)
	p := createTest(t, s, in)
	submitTest(t, s, in, p, data)
	id := p["report_id"].(string)
	op := OperationInput{ExpectedVersion: 1, IdempotencyKey: "operation_test", ResolutionSummary: "已定位", Verification: "单元测试通过", PublicResolutionSummary: "等待发布"}
	if _, e := s.Operate(ctx, Actor{UserID: "admin", AgentID: "readonly"}, id, "resolve", op); e == nil {
		t.Fatal("readonly resolve allowed")
	}
	first, e := s.Operate(ctx, Actor{UserID: "admin"}, id, "resolve", op)
	if e != nil {
		t.Fatal(e)
	}
	second, e := s.Operate(ctx, Actor{UserID: "admin"}, id, "resolve", op)
	if e != nil || first["version"] != second["version"] {
		t.Fatal("operation retry conflict", e)
	}
	op.IdempotencyKey = "operation_other"
	if _, e = s.Operate(ctx, Actor{UserID: "admin"}, id, "resolve", op); e == nil {
		t.Fatal("stale version accepted")
	}
	if _, e = s.Operate(ctx, Actor{UserID: "admin"}, id, "reopen", OperationInput{ExpectedVersion: 2, IdempotencyKey: "reopen_test", Reason: "复现仍失败"}); e != nil {
		t.Fatal(e)
	}
}
func TestQuarantineAndContinuation(t *testing.T) {
	ctx := context.Background()
	s, _ := testService(t)
	data := []byte("{\"text\":\"sk-testsecrethere\"}\n")
	in := inputFor(data)
	p := createTest(t, s, in)
	submitTest(t, s, in, p, data)
	if _, e := s.Read(ctx, Actor{UserID: "admin"}, p["report_id"].(string), "conversation", ReadInput{}); e == nil {
		t.Fatal("quarantine readable")
	}
	s, _ = testService(t)
	text := strings.Repeat("正文", 30000)
	data, _ = json.Marshal(map[string]string{"text": text})
	data = append(data, '\n')
	in = inputFor(data)
	p = createTest(t, s, in)
	submitTest(t, s, in, p, data)
	cursor := ""
	var result strings.Builder
	for n := 0; n < 30; n++ {
		page, e := s.Read(ctx, Actor{UserID: "admin"}, p["report_id"].(string), "conversation", ReadInput{Cursor: cursor, Limit: 1})
		if e != nil {
			t.Fatal(e)
		}
		for _, record := range page["records"].([]any) {
			result.WriteString(record.(map[string]any)["text"].(string))
		}
		cursor = page["next_cursor"].(string)
		if cursor == "" {
			break
		}
	}
	if result.String() != strings.TrimSuffix(string(data), "\n") {
		t.Fatal("long text silently truncated")
	}
}
func TestCleanupOldReportsAndReservations(t *testing.T) {
	s, store := testService(t)
	ctx := context.Background()
	now := time.Now().UTC()
	_ = store.Update(ctx, func(tx Transaction) error {
		for n := 0; n < 120; n++ {
			r := Report{ID: fmt.Sprintf("fb_%08d", n), ClientID: fmt.Sprintf("client_%08d", n), CreatedAt: now.Add(-time.Duration(n) * time.Hour), ExpiresAt: now.Add(time.Hour), UploadState: "uploading", SecurityState: "normal", ProcessingStatus: "open"}
			if n == 119 {
				r.ExpiresAt = now.Add(-time.Hour)
				r.Description = "private"
				r.PublicResolutionSummary = "private result"
				r.ReservedBytes = 100
			}
			if e := tx.Save(r); e != nil {
				return e
			}
		}
		return nil
	})
	if e := s.Cleanup(ctx); e != nil {
		t.Fatal(e)
	}
	_ = store.Update(ctx, func(tx Transaction) error {
		r, e := tx.Get("fb_00000119")
		if e != nil {
			return e
		}
		if r.UploadState != "expired" || r.Description != "" || r.PublicResolutionSummary != "" || r.ReservedBytes != 0 {
			t.Fatal("old feedback not scrubbed", r)
		}
		return nil
	})
}

type blockedReader struct {
	started chan struct{}
	unblock chan struct{}
	data    []byte
	done    bool
}

func (r *blockedReader) Read(p []byte) (int, error) {
	if r.done {
		return 0, io.EOF
	}
	r.done = true
	close(r.started)
	<-r.unblock
	return copy(p, r.data), nil
}
func TestSlowUploadDoesNotLockReads(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	data := []byte("{\"text\":\"ok\"}\n")
	in := inputFor(data)
	p := createTest(t, s, in)
	r := &blockedReader{started: make(chan struct{}), unblock: make(chan struct{}), data: data}
	done := make(chan error, 1)
	go func() {
		_, e := s.Upload(ctx, p["report_id"].(string), "artifact_test", p["upload_token"].(string), "application/x-ndjson", Hash(data), int64(len(data)), r)
		done <- e
	}()
	select {
	case <-r.started:
	case e := <-done:
		t.Fatalf("upload ended before reading: %v", e)
	case <-time.After(time.Second):
		t.Fatal("upload did not start")
	}
	progressDone := make(chan error, 1)
	go func() { _, e := s.Progress(ctx, p["report_id"].(string), in.RecoveryToken); progressDone <- e }()
	select {
	case e := <-progressDone:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Error("slow upload held transaction lock")
	}
	close(r.unblock)
	if e := <-done; e != nil {
		t.Fatal(e)
	}
}
func TestCanonicalVectorsAndMalformedManifest(t *testing.T) {
	a, e := CanonicalHash([]byte(`{"b":1e-7,"a":"测试","c":-0}`))
	if e != nil {
		t.Fatal(e)
	}
	b, e := CanonicalHash([]byte(`{"c":0,"a":"测试","b":0.0000001}`))
	if e != nil || a != b {
		t.Fatal("canonical hash mismatch")
	}
	if _, e = CanonicalHash([]byte(`{"a":1,"a":2}`)); e == nil {
		t.Fatal("duplicate key accepted")
	}
	in := inputFor([]byte("{}\n"))
	in.Manifest = []byte(`{"schema_version":2}`)
	if _, _, _, _, e = validate(in); e == nil {
		t.Fatal("unsupported schema accepted")
	}
}
func TestExpiredTombstonePreventsNewCreation(t *testing.T) {
	s, store := testService(t)
	ctx := context.Background()
	in := inputFor([]byte("{}\n"))
	p := createTest(t, s, in)
	s.clock = func() time.Time { return time.Now().Add(8 * 24 * time.Hour) }
	if e := s.Cleanup(ctx); e != nil {
		t.Fatal(e)
	}
	_, created, e := s.Create(ctx, in, "same", "")
	status, _ := HTTPError(e)
	if created || status != 410 {
		t.Fatalf("expired retry recreated report: %v %v", created, e)
	}
	_ = store.Update(ctx, func(tx Transaction) error {
		r, err := tx.Get(p["report_id"].(string))
		if err != nil {
			return err
		}
		if r.ClientID == in.ClientID {
			t.Error("client identity retained")
		}
		return nil
	})
}
func TestDeploymentQuotaAndRevocation(t *testing.T) {
	s, _ := testService(t)
	ctx := context.Background()
	c, raw, e := s.CreateDeploymentCredential(ctx, "source_test", time.Now().Add(time.Hour), 3)
	if e != nil {
		t.Fatal(e)
	}
	_, _, e = s.Create(ctx, inputFor([]byte("{}\n")), "ip", raw)
	if e != nil {
		t.Fatal(e)
	}
	_, _, e = s.Create(ctx, inputFor([]byte("{}\n")), "ip", raw)
	status, _ := HTTPError(e)
	if status != 429 {
		t.Fatal("source quota not enforced", e)
	}
	if e = s.RevokeDeploymentCredential(ctx, c.ID); e != nil {
		t.Fatal(e)
	}
	_, _, e = s.Create(ctx, inputFor([]byte("{}\n")), "ip", raw)
	status, _ = HTTPError(e)
	if status != 401 {
		t.Fatal("revoked deployment credential accepted", e)
	}
}
