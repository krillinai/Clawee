package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/feedback"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
)

func TestFeedbackIncidentLogsHTTP(t *testing.T) {
	storage, err := sharedfiles.NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store := feedback.NewMemoryStore()
	service := feedback.NewService(store, storage, func(context.Context, feedback.Actor, string) error { return nil }, 0)
	router := NewRouter(Options{FeedbackService: service})
	id := "11111111-1111-4111-8111-111111111111"
	now := time.Now().UTC().Format(time.RFC3339Nano)
	expected := true
	in := feedback.AutomaticIncident{SchemaVersion: 1, PolicyVersion: 1, ID: id, InstallationID: id, SessionID: id, Revision: 1, Source: "desktop", Layer: "desktop_bootstrap", Stage: "failed", ErrorCode: "DAEMON_START_FAILED", FirstSeenAt: now, LastSeenAt: now, OccurrenceCount: 1, Outcome: "failed", Message: "DAEMON_START_FAILED", FirstMessage: "DAEMON_START_FAILED", LogsExpected: &expected}
	raw := strings.Repeat("ab", 32)
	if _, _, err = service.PutIncident(context.Background(), id, raw, in, "127.0.0.1", ""); err != nil {
		t.Fatal(err)
	}
	data := []byte("{\"source\":\"desktop-main.log\",\"content\":\"ECONNRESET\"}\n")
	for _, test := range []struct {
		credential string
		data       []byte
		status     int
	}{{strings.Repeat("cd", 32), data, 403}, {raw, []byte(strings.Repeat("x", feedback.MaxIncidentLogBytes+1)), 413}, {raw, data, 201}, {raw, data, 200}} {
		req := httptest.NewRequest(http.MethodPut, "/api/v1/feedback/incidents/"+id+"/logs", bytes.NewReader(test.data))
		req.Header.Set("Authorization", "Bearer "+test.credential)
		req.Header.Set("Content-Type", "application/x-ndjson")
		req.Header.Set("X-Content-SHA256", feedback.Hash(test.data))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		if out.Code != test.status {
			t.Fatal(out.Code, out.Body.String())
		}
	}
	report, _ := store.Get(id)
	if len(report.Artifacts) != 1 || report.Artifacts[0].RecordCount != 1 || report.Artifacts[0].UploadState != "received" {
		t.Fatal(report.Artifacts)
	}
}

func TestFeedbackModelIncidentOfflineSnapshotHTTP(t *testing.T) {
	store := feedback.NewMemoryStore()
	service := feedback.NewService(store, nil, nil, 0)
	router := NewRouter(Options{FeedbackService: service})
	id := "11111111-1111-4111-8111-111111111111"
	now := time.Now().UTC().Format(time.RFC3339Nano)
	in := feedback.AutomaticIncident{SchemaVersion: 1, PolicyVersion: 1, ID: id, InstallationID: id, SessionID: id,
		Revision: 4, Source: "daemon", Layer: "codex_model", Stage: "response", RunID: "run_offline",
		ErrorCode: "responseTooManyFailedAttempts", FirstSeenAt: now, LastSeenAt: now, OccurrenceCount: 3,
		Outcome: "failed", TaskOutcome: "failed", Message: "responseTooManyFailedAttempts", FirstMessage: "responseStreamDisconnected HTTP 503",
		FirstDiagnostics: &feedback.IncidentDiagnostics{AdditionalDetails: "HTTP 503", RequestID: "req_first"},
		Diagnostics:      &feedback.IncidentDiagnostics{ErrorMessage: "retry limit exceeded", RequestID: "req_last"}}
	for _, expected := range []int{201, 200} {
		body, err := json.Marshal(in)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPut, "/api/v1/feedback/incidents/"+id, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+strings.Repeat("ab", 32))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		if out.Code != expected {
			t.Fatal(out.Code, out.Body.String())
		}
	}
	report, err := store.Get(id)
	if err != nil || report.Incident.FirstDiagnostics.RequestID != "req_first" || report.Incident.Diagnostics.RequestID != "req_last" || report.Incident.Outcome != "failed" {
		t.Fatal("offline evidence lost", err)
	}
}

func TestFeedbackIncidentHTTPBeforeLogin(t *testing.T) {
	service := feedback.NewService(feedback.NewMemoryStore(), nil, func(context.Context, feedback.Actor, string) error { return nil }, 0)
	router := NewRouter(Options{FeedbackService: service})
	id := "11111111-1111-4111-8111-111111111111"
	now := time.Now().UTC().Format(time.RFC3339Nano)
	in := map[string]any{"schema_version": 1, "policy_version": 1, "incident_id": id, "installation_id": "22222222-2222-4222-8222-222222222222", "app_session_id": "33333333-3333-4333-8333-333333333333", "revision": 1, "source": "desktop", "layer": "desktop_bootstrap", "stage": "starting_daemon", "error_code": "DAEMON_START_FAILED", "first_seen_at": now, "last_seen_at": now, "occurrence_count": 1, "outcome": "failed", "message": "DAEMON_START_FAILED", "first_message": "DAEMON_START_FAILED", "environment": map[string]string{"app_version": "0.1.8"}}
	request := func(body []byte, method, path, credential string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+credential)
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out
	}
	path := "/api/v1/feedback/incidents/" + id
	credential := strings.Repeat("ab", 32)
	body, _ := json.Marshal(in)
	for _, expected := range []int{201, 200} {
		out := request(body, http.MethodPut, path, credential)
		if out.Code != expected {
			t.Fatal(out.Code, out.Body.String())
		}
	}
	if out := request(body, http.MethodGet, path, credential); out.Code == 200 {
		t.Fatal("写入凭证不能读取异常")
	}
	if out := request(body, http.MethodPut, path, strings.Repeat("cd", 32)); out.Code != 403 {
		t.Fatal(out.Code, out.Body.String())
	}
	in["processing_status"] = "resolved"
	body, _ = json.Marshal(in)
	if out := request(body, http.MethodPut, path, credential); out.Code != 400 {
		t.Fatal(out.Code, out.Body.String())
	}
	delete(in, "processing_status")
	in["environment"].(map[string]string)["api_key"] = "sk-private"
	body, _ = json.Marshal(in)
	if out := request(body, http.MethodPut, path, credential); out.Code != 400 {
		t.Fatal(out.Code, out.Body.String())
	}
	if out := request([]byte(strings.Repeat(" ", feedback.MaxIncidentBytes+1)), http.MethodPut, path, credential); out.Code != 413 {
		t.Fatal(out.Code, out.Body.String())
	}
}

func TestFeedbackPolicyBeforeLogin(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		opts := Options{}
		if enabled {
			opts.FeedbackService = feedback.NewService(feedback.NewMemoryStore(), nil, nil, 0)
		}
		router := NewRouter(opts)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/feedback/policy", nil))
		var envelope struct {
			Data struct {
				Enabled   bool      `json:"enabled"`
				Version   int       `json:"policy_version"`
				ExpiresAt time.Time `json:"expires_at"`
			} `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if response.Code != 200 || envelope.Data.Enabled != enabled || envelope.Data.Version != 1 || !envelope.Data.ExpiresAt.After(time.Now()) || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(response.Code, response.Body.String())
		}
	}
}

func TestFeedbackIncidentHTTPRejectsCredentialFormats(t *testing.T) {
	store := feedback.NewMemoryStore()
	service := feedback.NewService(store, nil, nil, 0)
	router := NewRouter(Options{FeedbackService: service})
	id := "11111111-1111-4111-8111-111111111111"
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, credential := range []string{
		"ghp_" + strings.Repeat("A", 36), "gho_" + strings.Repeat("B", 36), "github_pat_" + strings.Repeat("C", 60),
		"AKIA" + strings.Repeat("D", 16), "ASIA" + strings.Repeat("E", 16), "AIza" + strings.Repeat("F", 35),
		"xoxb-" + strings.Repeat("1", 24), "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl",
	} {
		for _, field := range []string{"upstream_request_id", "model", "transport_code"} {
			in := feedback.AutomaticIncident{SchemaVersion: 1, PolicyVersion: 1, ID: id, InstallationID: id, SessionID: id, Revision: 1, Source: "desktop", Layer: "desktop_bootstrap", Stage: "starting_daemon", ErrorCode: "DAEMON_START_FAILED", FirstSeenAt: now, LastSeenAt: now, OccurrenceCount: 1, Outcome: "failed", Message: "DAEMON_START_FAILED", FirstMessage: "DAEMON_START_FAILED"}
			switch field {
			case "upstream_request_id":
				in.UpstreamRequestID = credential
			case "model":
				in.Environment.Model = credential
			case "transport_code":
				in.TransportCode = credential
				in.Message += " " + credential
				in.FirstMessage = in.Message
			}
			body, err := json.Marshal(in)
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(http.MethodPut, "/api/v1/feedback/incidents/"+id, bytes.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+strings.Repeat("ab", 32))
			req.Header.Set("Content-Type", "application/json")
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			if out.Code != 400 || strings.Contains(out.Body.String(), credential) {
				t.Fatalf("credential in %s: status=%d", field, out.Code)
			}
			if _, err := store.Get(id); err != feedback.ErrNotFound {
				t.Fatal("credential-bearing incident was stored")
			}
		}
	}
}
