package claweeactivity

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestValidateAndSanitizeRedactsSecretsAndDropsUnknownFields(t *testing.T) {
	standaloneKey := "sk-" + "standalone-secret-value"
	req := validRequest(`{
		"toolCallId":"tool_1",
		"name":"crm__lookup",
		"input":{"arguments":{"apiKey":"secret-value","nested":{"authorization":"Bearer abc.def","accessToken":"access-secret","refreshToken":"refresh-secret"},"note":"` + standaloneKey + `"}},
		"raw":{"token":"must-not-survive"}
	}`)
	req.Events[0].EventType = "tool_use"

	if err := ValidateAndSanitize(&req); err != nil {
		t.Fatalf("ValidateAndSanitize() error = %v", err)
	}
	text := string(req.Events[0].Payload)
	for _, forbidden := range []string{"secret-value", "abc.def", "access-secret", "refresh-secret", standaloneKey, "must-not-survive", `"raw"`} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("sanitized payload contains %q: %s", forbidden, text)
		}
	}
	if !strings.Contains(text, "[REDACTED]") {
		t.Fatalf("sanitized payload = %s", text)
	}
}

func TestValidateAndSanitizeRejectsInvalidBatchBeforeMapping(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*EventsRequest)
		want   error
	}{
		{name: "schema", mutate: func(req *EventsRequest) { req.SchemaVersion = "other" }, want: ErrInvalidSchemaVersion},
		{name: "empty", mutate: func(req *EventsRequest) { req.Events = nil }, want: ErrInvalidActivityEvent},
		{name: "missing id", mutate: func(req *EventsRequest) { req.Events[0].EventID = "" }, want: ErrInvalidActivityEvent},
		{name: "unsupported", mutate: func(req *EventsRequest) { req.Events[0].EventType = "usage" }, want: ErrInvalidActivityEvent},
		{name: "large content", mutate: func(req *EventsRequest) {
			req.Events[0].Payload = json.RawMessage(`{"text":"` + strings.Repeat("x", MaxContentBytes+1) + `"}`)
		}, want: ErrActivityTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := validRequest(`{"text":"ok"}`)
			test.mutate(&req)
			if err := ValidateAndSanitize(&req); !errors.Is(err, test.want) {
				t.Fatalf("ValidateAndSanitize() error = %v, want %v", err, test.want)
			}
		})
	}
}

func validRequest(payload string) EventsRequest {
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	return EventsRequest{
		SchemaVersion: SchemaVersion,
		ClientVersion: "0.1.0",
		SentAt:        now,
		Events: []ActivityEvent{{
			EventID: "evt_1", RunID: "run_1", SessionID: "thread_1", TurnID: "run_1",
			Sequence: 1, OccurredAt: now, EventType: "assistant_message", NormalizerVersion: 1,
			Payload: json.RawMessage(payload),
		}},
	}
}
