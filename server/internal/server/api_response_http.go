package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"unicode"

	"github.com/gin-gonic/gin"
)

type apiResponseWriter struct {
	gin.ResponseWriter
	status      int
	body        bytes.Buffer
	passthrough bool
}

func (w *apiResponseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

func (w *apiResponseWriter) WriteHeaderNow() {
	if w.status == 0 {
		w.status = http.StatusOK
	}
}

func (w *apiResponseWriter) Write(data []byte) (int, error) {
	w.WriteHeaderNow()
	if w.shouldPassThrough() {
		w.startPassThrough()
		return w.ResponseWriter.Write(data)
	}
	return w.body.Write(data)
}

func (w *apiResponseWriter) WriteString(data string) (int, error) {
	w.WriteHeaderNow()
	if w.shouldPassThrough() {
		w.startPassThrough()
		return w.ResponseWriter.WriteString(data)
	}
	return w.body.WriteString(data)
}

func (w *apiResponseWriter) Flush() {
	w.WriteHeaderNow()
	w.startPassThrough()
	w.ResponseWriter.Flush()
}

func (w *apiResponseWriter) Status() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

func (w *apiResponseWriter) Size() int     { return w.body.Len() }
func (w *apiResponseWriter) Written() bool { return w.status != 0 }

func (w *apiResponseWriter) shouldPassThrough() bool {
	contentType := w.Header().Get("Content-Type")
	return w.status < http.StatusBadRequest && contentType != "" && !strings.Contains(contentType, "application/json")
}

func (w *apiResponseWriter) startPassThrough() {
	if w.passthrough {
		return
	}
	w.passthrough = true
	w.ResponseWriter.WriteHeader(w.Status())
	if w.body.Len() > 0 {
		_, _ = w.ResponseWriter.Write(w.body.Bytes())
		w.body.Reset()
	}
}

func unifiedAPIResponse() gin.HandlerFunc {
	return func(c *gin.Context) {
		writer := &apiResponseWriter{ResponseWriter: c.Writer}
		c.Writer = writer
		c.Next()

		status := writer.Status()
		body := writer.body.Bytes()
		if writer.passthrough {
			return
		}
		if status == http.StatusNoContent || len(body) == 0 || !strings.Contains(c.Writer.Header().Get("Content-Type"), "application/json") {
			writeBufferedResponse(writer.ResponseWriter, status, body)
			return
		}

		var payload any
		if err := json.Unmarshal(body, &payload); err != nil {
			writeBufferedResponse(writer.ResponseWriter, status, body)
			return
		}
		normalized := normalizeAPIResponse(status, payload)
		encoded, err := json.Marshal(normalized)
		if err != nil {
			writeBufferedResponse(writer.ResponseWriter, status, body)
			return
		}
		writeBufferedResponse(writer.ResponseWriter, status, encoded)
	}
}

func writeBufferedResponse(writer gin.ResponseWriter, status int, body []byte) {
	writer.Header().Del("Content-Length")
	if len(body) > 0 {
		writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
	}
	writer.WriteHeader(status)
	if len(body) > 0 {
		_, _ = writer.Write(body)
	}
}

func normalizeAPIResponse(status int, payload any) any {
	if status >= http.StatusBadRequest {
		return normalizeAPIError(status, payload)
	}

	normalized := normalizeJSONValue(payload)
	if object, ok := normalized.(map[string]any); ok {
		if _, exists := object["data"]; exists {
			return object
		}
		if items, exists := object["items"]; exists {
			meta := map[string]any{"next_cursor": "", "has_next": false}
			if supplied, ok := object["meta"].(map[string]any); ok {
				for key, value := range supplied {
					meta[key] = value
				}
			}
			return map[string]any{"data": items, "meta": meta}
		}
	}
	if _, ok := normalized.([]any); ok {
		return map[string]any{"data": normalized, "meta": map[string]any{"next_cursor": "", "has_next": false}}
	}
	return map[string]any{"data": normalized}
}

func normalizeAPIError(status int, payload any) any {
	object, _ := normalizeJSONValue(payload).(map[string]any)
	code := httpErrorCode(status)
	message := http.StatusText(status)
	details := []any{}
	if object != nil {
		if value, ok := object["code"].(string); ok && strings.TrimSpace(value) != "" {
			code = value
		}
		switch value := object["error"].(type) {
		case string:
			if strings.TrimSpace(value) != "" {
				message = value
			}
		case map[string]any:
			if text, ok := value["code"].(string); ok && strings.TrimSpace(text) != "" {
				code = text
			}
			if text, ok := value["message"].(string); ok && strings.TrimSpace(text) != "" {
				message = text
			}
			if valueDetails, ok := value["details"].([]any); ok {
				details = valueDetails
			}
		}
		if value, ok := object["message"].(string); ok && strings.TrimSpace(value) != "" {
			message = value
		}
	}
	return map[string]any{"error": map[string]any{"code": code, "message": message, "details": details}}
}

func httpErrorCode(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "invalid_request"
	case http.StatusUnauthorized:
		return "unauthorized"
	case http.StatusForbidden:
		return "forbidden"
	case http.StatusNotFound:
		return "not_found"
	case http.StatusConflict:
		return "conflict"
	case http.StatusUnprocessableEntity:
		return "unprocessable_entity"
	case http.StatusTooManyRequests:
		return "rate_limited"
	default:
		return "internal_error"
	}
}

func normalizeJSONValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			normalizedKey := toSnakeCase(key)
			if key == normalizedKey {
				out[normalizedKey] = normalizeJSONField(normalizedKey, item)
			}
		}
		for key, item := range typed {
			normalizedKey := toSnakeCase(key)
			if _, exists := out[normalizedKey]; !exists {
				out[normalizedKey] = normalizeJSONField(normalizedKey, item)
			}
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = normalizeJSONValue(item)
		}
		return out
	default:
		return value
	}
}

func normalizeJSONField(key string, value any) any {
	switch key {
	case "annotations", "data_scope", "env", "input", "input_schema", "mcp_config", "request_body", "request_headers", "resolved_data_scope", "response", "response_body", "response_headers", "output_schema":
		return value
	default:
		return normalizeJSONValue(value)
	}
}

func toSnakeCase(value string) string {
	runes := []rune(value)
	var out strings.Builder
	for index, current := range runes {
		if unicode.IsUpper(current) && index > 0 {
			previous := runes[index-1]
			nextLower := index+1 < len(runes) && unicode.IsLower(runes[index+1])
			if unicode.IsLower(previous) || unicode.IsDigit(previous) || (unicode.IsUpper(previous) && nextLower) {
				out.WriteByte('_')
			}
		}
		out.WriteRune(unicode.ToLower(current))
	}
	return out.String()
}
