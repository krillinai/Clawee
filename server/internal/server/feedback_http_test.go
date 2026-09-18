package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/krillinai/Clawee/server/internal/feedback"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
	"go.uber.org/zap"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFeedbackDisabledAndFailClosed(t *testing.T) {
	router := NewRouter(Options{})
	for _, path := range []string{"/api/v1/feedback/reports", "/mcp/feedback"} {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != 404 {
			t.Fatalf("%s status %d", path, w.Code)
		}
	}
	storage, e := sharedfiles.NewFileSystemStorage(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	svc := feedback.NewService(feedback.NewMemoryStore(), storage, func(context.Context, feedback.Actor, string) error { return nil }, 0)
	router = NewRouter(Options{FeedbackService: svc})
	for _, path := range []string{"/api/v1/admin/feedback/reports", "/mcp/feedback"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != 503 {
			t.Fatalf("%s should fail closed, got %d", path, w.Code)
		}
	}
}
func feedbackTestInput(data []byte) feedback.CreateInput {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	manifest, _ := json.Marshal(feedback.Manifest{SchemaVersion: 1, SnapshotAt: now, ThreadID: "thread_test", Completeness: "partial", RedactionPolicyVersion: 1, MissingItems: []string{"desktop:unavailable"}, Artifacts: []feedback.Artifact{{ID: "artifact_test", Kind: "conversation", Name: "conversation.ndjson", ContentType: "application/x-ndjson", Size: int64(len(data)), SHA256: feedback.Hash(data), RecordCount: 1, Source: "test", PartIndex: 1}}})
	in := feedback.CreateInput{ClientID: "client_test0001", RecoveryToken: strings.Repeat("a", 43), StatusToken: strings.Repeat("b", 43), Description: "排障问题", OccurredAt: now, Manifest: manifest}
	in.Consent.PolicyVersion = 1
	in.Consent.ConfirmedAt = now
	return in
}

type deadlineTestWriter struct{ http.ResponseWriter }

func (w deadlineTestWriter) SetReadDeadline(at time.Time) error {
	if !at.IsZero() {
		at = time.Now().Add(50 * time.Millisecond)
	}
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(at)
}
func (w deadlineTestWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func TestFeedbackUploadDeadlineInterruptsStalledBodyThroughLogWriter(t *testing.T) {
	for _, received := range []bool{false, true} {
		t.Run(fmt.Sprintf("received=%v", received), func(t *testing.T) { testStalledFeedbackUpload(t, received) })
	}
}
func testStalledFeedbackUpload(t *testing.T, received bool) {
	storage, _ := sharedfiles.NewFileSystemStorage(t.TempDir())
	svc := feedback.NewService(feedback.NewMemoryStore(), storage, nil, 0)
	in := feedbackTestInput([]byte("{}\n"))
	p, _, e := svc.Create(context.Background(), in, "test", "")
	if e != nil {
		t.Fatal(e)
	}
	if received {
		_, e = svc.Upload(context.Background(), p["report_id"].(string), "artifact_test", p["upload_token"].(string), "application/x-ndjson", feedback.Hash([]byte("{}\n")), 3, bytes.NewReader([]byte("{}\n")))
		if e != nil {
			t.Fatal(e)
		}
	}
	router := NewRouter(Options{FeedbackService: svc, Logger: zap.NewNop()})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { router.ServeHTTP(deadlineTestWriter{w}, r) }))
	defer server.Close()
	conn, e := net.Dial("tcp", server.Listener.Addr().String())
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, e = fmt.Fprintf(conn, "PUT /api/v1/feedback/reports/%s/artifacts/artifact_test HTTP/1.1\r\nHost: local\r\nContent-Type: application/x-ndjson\r\nContent-Length: 3\r\nX-Content-SHA256: %s\r\nAuthorization: Bearer %s\r\n\r\n{", p["report_id"], feedback.Hash([]byte("{}\n")), p["upload_token"])
	if e != nil {
		t.Fatal(e)
	}
	response, e := http.ReadResponse(bufio.NewReader(conn), nil)
	if e != nil {
		t.Fatal("body deadline did not terminate upload", e)
	}
	defer response.Body.Close()
	expected := 503
	if received {
		expected = 200
	}
	if response.StatusCode != expected {
		t.Fatalf("stalled upload status %d", response.StatusCode)
	}
}
func TestAnonymousFeedbackHTTPUploadSubmitAndReceipt(t *testing.T) {
	storage, _ := sharedfiles.NewFileSystemStorage(t.TempDir())
	svc := feedback.NewService(feedback.NewMemoryStore(), storage, nil, 0)
	router := NewRouter(Options{FeedbackService: svc})
	data := []byte("{}\n")
	in := feedbackTestInput(data)
	raw, _ := json.Marshal(in)
	request := func(method, path string, body []byte, token, mime string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("Content-Type", mime)
		if method == "PUT" {
			req.Header.Set("X-Content-SHA256", feedback.Hash(data))
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	created := request("POST", "/api/v1/feedback/reports", raw, "", "application/json")
	if created.Code != 201 {
		t.Fatalf("create status=%d", created.Code)
	}
	var envelope struct{ Data map[string]any }
	_ = json.Unmarshal(created.Body.Bytes(), &envelope)
	p := envelope.Data
	id := p["report_id"].(string)
	upload := p["upload_token"].(string)
	if w := request("PUT", "/api/v1/feedback/reports/"+id+"/artifacts/artifact_test", data, upload, "application/x-ndjson"); w.Code != 201 {
		t.Fatalf("upload status=%d", w.Code)
	}
	mh, _ := feedback.CanonicalHash(in.Manifest)
	submit, _ := json.Marshal(map[string]any{"manifest_sha256": mh, "accept_partial": true})
	if w := request("POST", "/api/v1/feedback/reports/"+id+"/submit", submit, upload, "application/json"); w.Code != 200 {
		t.Fatalf("submit status=%d", w.Code)
	}
	if w := request("GET", "/api/v1/feedback/reports/"+id+"/status", nil, in.StatusToken, ""); w.Code != 200 || strings.Contains(w.Body.String(), "排障问题") {
		t.Fatal("receipt missing or leaks body")
	}
	if w := request("GET", "/api/v1/feedback/reports/"+id+"/status", nil, upload, ""); w.Code != 401 {
		t.Fatal("upload token read status")
	}
}
func TestFeedbackRejectsDuplicateJSONKeysWithoutSecretEcho(t *testing.T) {
	storage, _ := sharedfiles.NewFileSystemStorage(t.TempDir())
	svc := feedback.NewService(feedback.NewMemoryStore(), storage, nil, 0)
	router := NewRouter(Options{FeedbackService: svc})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/feedback/reports", strings.NewReader(`{"description":"private-value","description":"other"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 400 || strings.Contains(w.Body.String(), "private-value") {
		t.Fatalf("invalid JSON: %d %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("response can be cached")
	}
}
func TestFeedbackClientIPRequiresExplicitTrustedProxy(t *testing.T) {
	r := httptest.NewRequest("POST", "/", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "198.51.100.7, 10.0.0.2")
	if ip := feedbackClientIP(r, nil); ip != "10.0.0.1" {
		t.Fatal("untrusted forwarded header used", ip)
	}
	if ip := feedbackClientIP(r, []string{"10.0.0.0/8"}); ip != "198.51.100.7" {
		t.Fatal("trusted proxy not resolved", ip)
	}
	r.Header.Set("X-Forwarded-For", "203.0.113.99, 198.51.100.7")
	if ip := feedbackClientIP(r, []string{"10.0.0.0/8"}); ip != "198.51.100.7" {
		t.Fatal("spoofed prefix trusted", ip)
	}
}
