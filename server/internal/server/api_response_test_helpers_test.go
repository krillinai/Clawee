package server_test

import (
	"encoding/json"
	"strings"
	"testing"
)

func unwrapAPIDataMap(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var envelope map[string]any
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode API response: %v", err)
	}
	if data, ok := envelope["data"].(map[string]any); ok {
		return data
	}
	return envelope
}

func unwrapAPIListMaps(t *testing.T, body []byte) []map[string]any {
	t.Helper()
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode API list response: %v", err)
	}
	raw := envelope["data"]
	if len(raw) == 0 {
		raw = envelope["items"]
	}
	var items []map[string]any
	if err := json.Unmarshal(raw, &items); err != nil {
		t.Fatalf("decode API list data: %v", err)
	}
	return items
}

func decodeAPIResource[T any](t *testing.T, body []byte) T {
	t.Helper()
	return decodeSnakeCaseFields[T](t, unwrapAPIRawData(t, body))
}

func decodeAPIJSONResource[T any](t *testing.T, body []byte) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(unwrapAPIRawData(t, body), &out); err != nil {
		t.Fatalf("decode API JSON data: %v", err)
	}
	return out
}

func decodeAPIResources[T any](t *testing.T, body []byte) []T {
	t.Helper()
	return decodeSnakeCaseFields[[]T](t, unwrapAPIRawData(t, body))
}

func unwrapAPIRawData(t *testing.T, body []byte) json.RawMessage {
	t.Helper()
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode API response: %v", err)
	}
	if raw := envelope["data"]; len(raw) > 0 {
		return raw
	}
	return body
}

func decodeSnakeCaseFields[T any](t *testing.T, raw json.RawMessage) T {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("decode API data: %v", err)
	}
	converted, err := json.Marshal(exportedJSONFieldNames(value))
	if err != nil {
		t.Fatalf("encode converted API data: %v", err)
	}
	var out T
	if err := json.Unmarshal(converted, &out); err != nil {
		t.Fatalf("decode converted API data: %v", err)
	}
	return out
}

func exportedJSONFieldNames(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			parts := strings.Split(key, "_")
			for index := range parts {
				if parts[index] != "" {
					parts[index] = strings.ToUpper(parts[index][:1]) + parts[index][1:]
				}
			}
			out[strings.Join(parts, "")] = exportedJSONFieldNames(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = exportedJSONFieldNames(item)
		}
		return out
	default:
		return value
	}
}
