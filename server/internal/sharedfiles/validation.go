package sharedfiles

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"unicode/utf8"
)

type cursorPayload struct {
	UpdatedAt string `json:"updated_at,omitempty"`
	ID        string `json:"id"`
	Name      string `json:"name,omitempty"`
}

func NormalizeLogicalPath(value string, allowTrailingSlash bool) (string, error) {
	if value == "" || strings.HasPrefix(value, "/") || strings.Contains(value, "\\") || strings.ContainsRune(value, 0) {
		return "", ErrInvalidLogicalPath
	}
	if len([]byte(value)) > 512 || (!allowTrailingSlash && strings.HasSuffix(value, "/")) {
		return "", ErrInvalidLogicalPath
	}
	trimmed := value
	if allowTrailingSlash {
		trimmed = strings.TrimSuffix(trimmed, "/")
	}
	if trimmed == "" {
		return "", ErrInvalidLogicalPath
	}
	for _, segment := range strings.Split(trimmed, "/") {
		if segment == "" || segment == "." || segment == ".." || len([]byte(segment)) > 255 || !utf8.ValidString(segment) {
			return "", ErrInvalidLogicalPath
		}
	}
	return value, nil
}

func normalizeLimit(limit int) (int, error) {
	if limit == 0 {
		return DefaultLimit, nil
	}
	if limit < 1 || limit > MaxLimit {
		return 0, ErrInvalidRequest
	}
	return limit, nil
}

func normalizeQuery(query string) (string, error) {
	query = strings.TrimSpace(query)
	if utf8.RuneCountInString(query) > 200 {
		return "", ErrInvalidRequest
	}
	return query, nil
}

func encodeCursor(cursor Cursor) string {
	payload := cursorPayload{ID: cursor.ID, Name: cursor.Name}
	if !cursor.UpdatedAt.IsZero() {
		payload.UpdatedAt = cursor.UpdatedAt.UTC().Format("2006-01-02T15:04:05.999999999Z07:00")
	}
	raw, _ := json.Marshal(payload)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeCursor(value string, kind string) (Cursor, error) {
	if value == "" {
		return Cursor{}, nil
	}
	if len(value) > 2048 {
		return Cursor{}, ErrInvalidCursor
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return Cursor{}, ErrInvalidCursor
	}
	var payload cursorPayload
	if err := json.Unmarshal(raw, &payload); err != nil || payload.ID == "" {
		return Cursor{}, ErrInvalidCursor
	}
	cursor := Cursor{ID: payload.ID, Name: payload.Name}
	switch kind {
	case "time":
		if payload.UpdatedAt == "" {
			return Cursor{}, ErrInvalidCursor
		}
		if err := cursor.UpdatedAt.UnmarshalText([]byte(payload.UpdatedAt)); err != nil {
			return Cursor{}, ErrInvalidCursor
		}
	case "name":
		if payload.Name == "" {
			return Cursor{}, ErrInvalidCursor
		}
	default:
		return Cursor{}, ErrInvalidCursor
	}
	return cursor, nil
}

func normalizeSpaceInput(name, description string) (string, string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 100 || utf8.RuneCountInString(description) > 500 {
		return "", "", ErrInvalidRequest
	}
	return name, description, nil
}
