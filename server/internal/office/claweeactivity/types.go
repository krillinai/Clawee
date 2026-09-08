package claweeactivity

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	SchemaVersion       = "clawee.activity.v1"
	MaxRequestBodyBytes = 1 << 20
	MaxBatchEvents      = 100
	MaxEventBytes       = 128 << 10
	MaxIDRunes          = 128
	MaxContentBytes     = 64 << 10
	DirectSourceType    = "clawee_direct"
	DirectDeviceID      = "clawee-direct"
	collectorSourceType = "clawee"
	truncationSuffix    = "\n...[TRUNCATED]"
)

var (
	ErrInvalidSchemaVersion = errors.New("invalid activity schema version")
	ErrInvalidActivityEvent = errors.New("invalid activity event")
	ErrActivityTooLarge     = errors.New("activity content is too large")
	ErrAgentForbidden       = errors.New("agent is forbidden")
	ErrCollectorSource      = errors.New("agent is assigned to a collector source")

	bearerPattern              = regexp.MustCompile(`(?i)bearer\s+[a-z0-9._~+/-]+=*`)
	secretPattern              = regexp.MustCompile(`(?i)(authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|token)\s*[:=]\s*[^\s,;]+`)
	standaloneOpenAIKeyPattern = regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{8,}\b`)
)

type EventsRequest struct {
	SchemaVersion string          `json:"schema_version"`
	ClientVersion string          `json:"client_version"`
	SentAt        time.Time       `json:"sent_at"`
	Events        []ActivityEvent `json:"events"`
}

type ActivityEvent struct {
	EventID           string          `json:"event_id"`
	RunID             string          `json:"run_id"`
	SessionID         string          `json:"session_id"`
	TurnID            string          `json:"turn_id"`
	Sequence          int64           `json:"sequence"`
	OccurredAt        time.Time       `json:"occurred_at"`
	EventType         string          `json:"event_type"`
	NormalizerVersion int             `json:"normalizer_version"`
	Payload           json.RawMessage `json:"payload"`
}

type AcceptedResponse struct {
	Accepted       bool      `json:"accepted"`
	ReceivedEvents int       `json:"received_events"`
	ServerTime     time.Time `json:"server_time"`
}

var eventPayloadFields = map[string]map[string]bool{
	"run_started":       {"prompt": true, "created_by": true, "workspace_name": true, "truncated": true},
	"status":            {"label": true, "threadId": true, "codexThreadId": true, "truncated": true},
	"reasoning_summary": {"text": true, "format": true, "delivery": true, "truncated": true},
	"assistant_message": {"text": true, "format": true, "delivery": true, "truncated": true},
	"tool_use":          {"toolCallId": true, "name": true, "input": true, "truncated": true},
	"tool_result":       {"toolCallId": true, "output": true, "response": true, "exitCode": true, "isError": true, "durationMs": true, "truncated": true},
	"file_change":       {"changes": true, "status": true, "truncated": true},
	"approval":          {"approval": true, "truncated": true},
	"diagnostic":        {"code": true, "severity": true, "message": true, "details": true, "truncated": true},
	"error":             {"code": true, "message": true, "details": true, "truncated": true},
	"done":              {"status": true, "terminationReason": true, "truncated": true},
}

func ValidateAndSanitize(req *EventsRequest) error {
	if req.SchemaVersion != SchemaVersion {
		return ErrInvalidSchemaVersion
	}
	if len(req.Events) == 0 || len(req.Events) > MaxBatchEvents {
		return ErrInvalidActivityEvent
	}
	for i := range req.Events {
		if err := validateAndSanitizeEvent(&req.Events[i]); err != nil {
			return err
		}
	}
	return nil
}

func validateAndSanitizeEvent(event *ActivityEvent) error {
	if !validID(event.EventID) || !validID(event.RunID) || !validID(event.SessionID) || !validID(event.TurnID) ||
		event.Sequence < 0 || event.OccurredAt.IsZero() || event.NormalizerVersion <= 0 {
		return ErrInvalidActivityEvent
	}
	fields, ok := eventPayloadFields[event.EventType]
	if !ok {
		return ErrInvalidActivityEvent
	}
	decoder := json.NewDecoder(bytes.NewReader(event.Payload))
	decoder.UseNumber()
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		return ErrInvalidActivityEvent
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ErrInvalidActivityEvent
	}
	sanitized := make(map[string]any, len(fields))
	for key, value := range payload {
		if fields[key] {
			sanitized[key] = sanitizeValue(key, value)
		}
	}
	if err := validatePayload(event.EventType, sanitized); err != nil {
		return err
	}
	encoded, err := json.Marshal(sanitized)
	if err != nil {
		return ErrInvalidActivityEvent
	}
	if len(encoded) > MaxEventBytes {
		return ErrActivityTooLarge
	}
	event.Payload = encoded
	serialized, err := json.Marshal(event)
	if err != nil {
		return ErrInvalidActivityEvent
	}
	if len(serialized) > MaxEventBytes {
		return ErrActivityTooLarge
	}
	return nil
}

func validatePayload(eventType string, payload map[string]any) error {
	requiredString := func(key string) bool {
		value, ok := payload[key].(string)
		return ok && strings.TrimSpace(value) != ""
	}
	switch eventType {
	case "run_started":
		if !requiredString("prompt") {
			return ErrInvalidActivityEvent
		}
	case "status":
		if !oneOf(payload["label"], "queued", "initializing", "running", "canceling", "finalizing") {
			return ErrInvalidActivityEvent
		}
	case "assistant_message", "reasoning_summary":
		if _, ok := payload["text"].(string); !ok {
			return ErrInvalidActivityEvent
		}
	case "tool_use":
		if !requiredString("toolCallId") || !requiredString("name") {
			return ErrInvalidActivityEvent
		}
	case "tool_result":
		if !requiredString("toolCallId") {
			return ErrInvalidActivityEvent
		}
	case "file_change":
		if _, ok := payload["changes"].([]any); !ok {
			return ErrInvalidActivityEvent
		}
	case "approval":
		if _, ok := payload["approval"].(map[string]any); !ok {
			return ErrInvalidActivityEvent
		}
	case "diagnostic", "error":
		if !requiredString("message") {
			return ErrInvalidActivityEvent
		}
	case "done":
		if !oneOf(payload["status"], "succeeded", "failed", "canceled") {
			return ErrInvalidActivityEvent
		}
	}
	if contentTooLarge(payload) {
		return ErrActivityTooLarge
	}
	return nil
}

func sanitizeValue(key string, value any) any {
	if isSecretKey(key) {
		return "[REDACTED]"
	}
	switch typed := value.(type) {
	case string:
		return redactText(typed)
	case map[string]any:
		clean := make(map[string]any, len(typed))
		for childKey, child := range typed {
			clean[childKey] = sanitizeValue(childKey, child)
		}
		return clean
	case []any:
		clean := make([]any, len(typed))
		for i, child := range typed {
			clean[i] = sanitizeValue("", child)
		}
		return clean
	default:
		return value
	}
}

func isSecretKey(key string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "-", "_"), " ", "_"))
	switch normalized {
	case "authorization", "cookie", "token", "secret", "password", "passwd", "api_key", "apikey", "credential", "access_token", "accesstoken", "refresh_token", "refreshtoken":
		return true
	default:
		return false
	}
}

func redactText(value string) string {
	value = bearerPattern.ReplaceAllString(value, "Bearer [REDACTED]")
	value = secretPattern.ReplaceAllStringFunc(value, func(match string) string {
		separator := strings.IndexAny(match, ":=")
		if separator < 0 {
			return "[REDACTED]"
		}
		return match[:separator+1] + "[REDACTED]"
	})
	return standaloneOpenAIKeyPattern.ReplaceAllString(value, "[REDACTED]")
}

func contentTooLarge(value any) bool {
	switch typed := value.(type) {
	case string:
		return len([]byte(typed)) > MaxContentBytes
	case map[string]any:
		for _, child := range typed {
			if contentTooLarge(child) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if contentTooLarge(child) {
				return true
			}
		}
	}
	return false
}

func validID(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && utf8.ValidString(value) && utf8.RuneCountInString(value) <= MaxIDRunes
}

func oneOf(value any, allowed ...string) bool {
	actual, ok := value.(string)
	if !ok {
		return false
	}
	for _, candidate := range allowed {
		if actual == candidate {
			return true
		}
	}
	return false
}

func decodePayload(event ActivityEvent) (map[string]any, error) {
	var payload map[string]any
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return nil, fmt.Errorf("decode %s payload: %w", event.EventType, err)
	}
	return payload, nil
}

func stringField(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return value
}

func boolField(payload map[string]any, key string) bool {
	value, _ := payload[key].(bool)
	return value
}

func int64Field(payload map[string]any, key string) int64 {
	value, _ := payload[key].(float64)
	return int64(value)
}
