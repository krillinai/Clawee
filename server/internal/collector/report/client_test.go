package report

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func TestPostEventsUsesAuthHeaderAndEndpoint(t *testing.T) {
	var gotAuth string
	var gotPath string
	var gotBody collectorapi.EventsRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(collectorapi.AcceptedResponse{
			Accepted:       true,
			ServerTime:     time.Date(2026, 6, 2, 10, 0, 1, 0, time.UTC),
			ReceivedEvents: 1,
		})
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:        server.URL,
		CollectorToken: "collector_token",
		HTTPClient:     server.Client(),
		Logger:         discardLogger(),
	})

	err := client.PostEvents(collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/v1/collector/events" {
		t.Fatalf("path = %s", gotPath)
	}
	if gotAuth != "Bearer collector_token" {
		t.Fatalf("auth = %s", gotAuth)
	}
	if gotBody.SchemaVersion != collectorapi.SchemaVersion {
		t.Fatalf("schema = %s", gotBody.SchemaVersion)
	}
}

func TestPostEventsObserverRecordsRawRequestAndResult(t *testing.T) {
	var records []ReportRecord
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(collectorapi.AcceptedResponse{Accepted: true})
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:        server.URL,
		CollectorToken: "collector_token",
		HTTPClient:     server.Client(),
		Logger:         discardLogger(),
		Observer: ObserverFunc(func(record ReportRecord) {
			records = append(records, record)
		}),
	})

	err := client.PostEventsWithChain("chain_1", collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC),
		Events: []collectorapi.CollectorEvent{{
			EventID: "evt_1",
			Metadata: map[string]string{
				"secret": "keep_raw",
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("records len = %d, want 1", len(records))
	}
	record := records[0]
	if record.ChainID != "chain_1" {
		t.Fatalf("chain id = %s", record.ChainID)
	}
	if record.Kind != "events" {
		t.Fatalf("kind = %s", record.Kind)
	}
	if record.Path != "/api/v1/collector/events" {
		t.Fatalf("path = %s", record.Path)
	}
	if !strings.Contains(string(record.RawRequest), `"secret":"keep_raw"`) {
		t.Fatalf("raw request = %s", record.RawRequest)
	}
	if record.ResponseStatus != http.StatusAccepted {
		t.Fatalf("status = %d", record.ResponseStatus)
	}
	if record.Error != "" {
		t.Fatalf("error = %s", record.Error)
	}
}

func TestPostHeartbeatReturnsStatusErrorForUnauthorized(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(collectorapi.ErrorResponse{
			Error: collectorapi.ErrorBody{
				Code:    "unauthorized",
				Message: "collector token is invalid",
			},
		})
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:        server.URL,
		CollectorToken: "bad_token",
		HTTPClient:     server.Client(),
		Logger:         discardLogger(),
	})

	err := client.PostHeartbeat(collectorapi.HeartbeatRequest{SchemaVersion: collectorapi.SchemaVersion})
	if err == nil {
		t.Fatal("expected error")
	}
	statusErr, ok := err.(*StatusError)
	if !ok {
		t.Fatalf("expected StatusError, got %T", err)
	}
	if statusErr.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", statusErr.StatusCode)
	}
	if statusErr.Code != "unauthorized" {
		t.Fatalf("code = %s", statusErr.Code)
	}
}

func TestPostHeartbeatSilentlyDoesNotLogRequestOrResponse(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(collectorapi.AcceptedResponse{Accepted: true})
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:        server.URL,
		CollectorToken: "collector_token",
		HTTPClient:     server.Client(),
		Logger:         logger,
	})

	if err := client.PostHeartbeatSilently(collectorapi.HeartbeatRequest{SchemaVersion: collectorapi.SchemaVersion}); err != nil {
		t.Fatal(err)
	}
	if logs.Len() != 0 {
		t.Fatalf("logs = %q, want empty", logs.String())
	}
}

func TestPostEventsRetriesRetryableStatuses(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(collectorapi.ErrorResponse{
				Error: collectorapi.ErrorBody{Code: "server_error", Message: "temporary failure"},
			})
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:        server.URL,
		CollectorToken: "collector_token",
		HTTPClient:     server.Client(),
		Logger:         discardLogger(),
	})

	err := client.PostEvents(collectorapi.EventsRequest{SchemaVersion: collectorapi.SchemaVersion})
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 3 {
		t.Fatalf("attempts = %d, want 3", attempts)
	}
}

func TestPostEventsDoesNotRetryUnauthorized(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(collectorapi.ErrorResponse{
			Error: collectorapi.ErrorBody{Code: "unauthorized", Message: "collector token is invalid"},
		})
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:        server.URL,
		CollectorToken: "bad_token",
		HTTPClient:     server.Client(),
		Logger:         discardLogger(),
	})

	err := client.PostEvents(collectorapi.EventsRequest{SchemaVersion: collectorapi.SchemaVersion})
	if err == nil {
		t.Fatal("expected error")
	}
	if attempts != 1 {
		t.Fatalf("attempts = %d, want 1", attempts)
	}
}

func TestRegisterCollectorPostsWithoutBearerToken(t *testing.T) {
	var gotAuth string
	var gotPath string
	var gotBody collectorapi.RegistrationRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(collectorapi.RegistrationResponse{
			CollectorID:    "collector_123",
			CollectorToken: "collector_token",
			DeviceID:       "device_123",
			PrivacyMode:    "summary_only",
		})
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client(), Logger: discardLogger()})
	resp, err := client.RegisterCollector(collectorapi.RegistrationRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		RegistrationCode: "ABCD-1234",
		AgentID:          "clawee_agent_1",
		OS:               "darwin",
		Arch:             "arm64",
		CollectorVersion: "0.1.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/v1/collector/register" {
		t.Fatalf("path = %s", gotPath)
	}
	if gotAuth != "" {
		t.Fatalf("auth = %q, want empty", gotAuth)
	}
	if gotBody.AgentID != "clawee_agent_1" {
		t.Fatalf("agent_id = %q", gotBody.AgentID)
	}
	if resp.CollectorToken != "collector_token" {
		t.Fatalf("resp = %#v", resp)
	}
}

func TestRegisterCollectorLogsRedactRegistrationCode(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(collectorapi.RegistrationResponse{
			CollectorID:    "collector_123",
			CollectorToken: "collector_token",
			DeviceID:       "device_123",
			PrivacyMode:    "summary_only",
		})
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client(), Logger: logger})
	_, err := client.RegisterCollector(collectorapi.RegistrationRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		RegistrationCode: "ABCD-1234",
		OS:               "darwin",
		Arch:             "arm64",
		CollectorVersion: "0.1.0",
	})
	if err != nil {
		t.Fatal(err)
	}

	got := logs.String()
	if !strings.Contains(got, "/api/v1/collector/register") {
		t.Fatalf("logs do not contain register endpoint: %s", got)
	}
	if !strings.Contains(got, "collector request") {
		t.Fatalf("logs do not contain request message: %s", got)
	}
	if strings.Contains(got, "ABCD-1234") {
		t.Fatalf("logs contain registration code: %s", got)
	}
}

func TestAuthenticatedRequestLogsRedactBearerTokenAndIncludeResponse(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(collectorapi.AcceptedResponse{
			Accepted:       true,
			ServerTime:     time.Date(2026, 6, 2, 10, 0, 1, 0, time.UTC),
			ReceivedEvents: 1,
		})
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:        server.URL,
		CollectorToken: "secret_token",
		HTTPClient:     server.Client(),
		Logger:         logger,
	})
	err := client.PostEvents(collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   "collector_1",
		DeviceID:      "device_1",
		SentAt:        time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}

	got := logs.String()
	if strings.Contains(got, "secret_token") {
		t.Fatalf("logs contain bearer token: %s", got)
	}
	if !strings.Contains(got, "status_code=202") {
		t.Fatalf("logs do not contain response status: %s", got)
	}
	if !strings.Contains(got, `\"accepted\":true`) {
		t.Fatalf("logs do not contain response body: %s", got)
	}
}

func TestResponseLogsRedactNonJSONBody(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("proxy echoed secret_token"))
	}))
	defer server.Close()

	client := NewClient(Config{
		BaseURL:        server.URL,
		CollectorToken: "secret_token",
		HTTPClient:     server.Client(),
		Logger:         logger,
	})
	err := client.PostEvents(collectorapi.EventsRequest{SchemaVersion: collectorapi.SchemaVersion})
	if err == nil {
		t.Fatal("expected error")
	}

	got := logs.String()
	if strings.Contains(got, "secret_token") || strings.Contains(got, "proxy echoed") {
		t.Fatalf("logs contain raw non-JSON body: %s", got)
	}
	if !strings.Contains(got, "<non-json body redacted>") {
		t.Fatalf("logs do not contain redacted placeholder: %s", got)
	}
}

func TestRegisterCollectorDoesNotRetryInvalidCode(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(collectorapi.ErrorResponse{
			Error: collectorapi.ErrorBody{Code: "invalid_registration_code", Message: "registration code is invalid"},
		})
	}))
	defer server.Close()

	client := NewClient(Config{BaseURL: server.URL, HTTPClient: server.Client(), Logger: discardLogger()})
	_, err := client.RegisterCollector(collectorapi.RegistrationRequest{SchemaVersion: collectorapi.SchemaVersion})
	if err == nil {
		t.Fatal("expected error")
	}
	if attempts != 1 {
		t.Fatalf("attempts = %d, want 1", attempts)
	}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
