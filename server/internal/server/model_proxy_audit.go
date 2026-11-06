package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

const modelProxyAuditSnapshotLimit = 64 * 1024

func sanitizeModelProxyHeaders(headers http.Header) mcpgateway.JSONMap {
	if headers == nil {
		return nil
	}
	out := make(mcpgateway.JSONMap, len(headers))
	for key, values := range headers {
		if sensitiveModelProxyHeader(key) {
			out[key] = "[REDACTED]"
			continue
		}
		if len(values) == 1 {
			out[key] = values[0]
		} else {
			out[key] = append([]string(nil), values...)
		}
	}
	return out
}

func sanitizeModelProxyJSON(value any) any {
	switch current := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(current))
		for key, item := range current {
			if sensitiveModelProxyField(key) {
				out[key] = "[REDACTED]"
				continue
			}
			if encoded, ok := item.(string); ok && modelProxyMediaField(key) {
				out[key] = mediaModelProxySnapshot(encoded)
				continue
			}
			out[key] = sanitizeModelProxyJSON(item)
		}
		return out
	case []any:
		out := make([]any, len(current))
		for index, item := range current {
			out[index] = sanitizeModelProxyJSON(item)
		}
		return out
	case string:
		return sanitizeModelProxyString(current)
	default:
		return value
	}
}

func snapshotModelProxyBody(raw []byte) (mcpgateway.JSONMap, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return mcpgateway.JSONMap{
			"parse_error": true,
			"bytes":       len(raw),
			"sha256":      sha256Hex(raw),
		}, true
	}
	sanitized := sanitizeModelProxyJSON(value)
	encoded, err := json.Marshal(sanitized)
	if err != nil || len(encoded) > modelProxyAuditSnapshotLimit {
		return mcpgateway.JSONMap{
			"truncated": true,
			"bytes":     len(raw),
			"sha256":    sha256Hex(raw),
		}, true
	}
	if sanitized == nil {
		return nil, false
	}
	if object, ok := sanitized.(map[string]any); ok {
		return mcpgateway.JSONMap(object), false
	}
	return mcpgateway.JSONMap{"value": sanitized}, false
}

type modelProxyUsage struct {
	inputTokens         int64
	outputTokens        int64
	totalTokens         int64
	cacheReadTokens     int64
	cacheCreationTokens int64
	reasoningTokens     int64
	available           bool
	status              mcpgateway.ModelProxyUsageStatus
	source              mcpgateway.ModelProxyUsageSource
	responseModel       string
}

func extractModelProxyUsage(value any) (inputTokens, outputTokens, totalTokens, cacheReadTokens int64, available bool) {
	usage := extractModelProxyUsageDetailed(value)
	return usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cacheReadTokens, usage.available
}

func extractModelProxyUsageDetailed(value any) modelProxyUsage {
	var usage map[string]any
	findUsage(value, &usage)
	if usage == nil {
		return modelProxyUsage{status: mcpgateway.ModelProxyUsageUnavailable, source: mcpgateway.ModelProxyUsageSourceUnavailable}
	}
	inputTokens, inputFound := firstNumberPresent(usage, "input_tokens", "prompt_tokens")
	outputTokens, outputFound := firstNumberPresent(usage, "output_tokens", "completion_tokens")
	totalTokens, totalFound := firstNumberPresent(usage, "total_tokens")
	cacheReadTokens, _ := firstNumberPresent(usage, "cache_read_input_tokens", "cache_read_tokens", "cached_tokens")
	cacheCreationTokens, _ := firstNumberPresent(usage, "cache_creation_input_tokens", "cache_creation_tokens", "cache_write_tokens")
	reasoningTokens, _ := firstNumberPresent(usage, "reasoning_tokens")
	if cacheReadTokens == 0 || cacheCreationTokens == 0 {
		for _, key := range []string{"prompt_tokens_details", "input_tokens_details", "prompt_token_details"} {
			details, ok := usage[key].(map[string]any)
			if !ok {
				continue
			}
			if cacheReadTokens == 0 {
				cacheReadTokens, _ = firstNumberPresent(details, "cached_tokens", "cache_read_tokens", "cache_read_input_tokens")
			}
			if cacheCreationTokens == 0 {
				cacheCreationTokens, _ = firstNumberPresent(details, "cache_creation_tokens", "cache_creation_input_tokens", "cache_write_tokens")
			}
		}
	}
	for _, key := range []string{"completion_tokens_details", "output_tokens_details", "completion_token_details"} {
		details, ok := usage[key].(map[string]any)
		if !ok || reasoningTokens != 0 {
			continue
		}
		reasoningTokens, _ = firstNumberPresent(details, "reasoning_tokens")
	}
	if !totalFound && (inputFound || outputFound) {
		totalTokens = inputTokens + outputTokens
	}
	status := mcpgateway.ModelProxyUsagePartial
	if inputFound && outputFound {
		status = mcpgateway.ModelProxyUsageComplete
	}
	return modelProxyUsage{
		inputTokens: inputTokens, outputTokens: outputTokens, totalTokens: totalTokens,
		cacheReadTokens: cacheReadTokens, cacheCreationTokens: cacheCreationTokens,
		reasoningTokens: reasoningTokens, available: true, status: status,
		source: mcpgateway.ModelProxyUsageSourceUpstream, responseModel: responseModelFromValue(value),
	}
}

func extractModelProxyUsageBytes(raw []byte) (inputTokens, outputTokens, totalTokens, cacheReadTokens int64, available bool) {
	usage := extractModelProxyUsageBytesDetailed(raw)
	return usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cacheReadTokens, usage.available
}

func extractModelProxyUsageBytesDetailed(raw []byte) modelProxyUsage {
	if len(raw) == 0 {
		return modelProxyUsage{status: mcpgateway.ModelProxyUsageUnavailable, source: mcpgateway.ModelProxyUsageSourceUnavailable}
	}
	var value any
	if json.Unmarshal(raw, &value) == nil {
		return extractModelProxyUsageDetailed(value)
	}
	var result modelProxyUsage
	for _, line := range bytes.Split(raw, []byte("\n")) {
		if usage, ok := parseModelProxySSELine(line); ok && usage.available {
			result = usage
		}
	}
	if !result.available {
		return modelProxyUsage{status: mcpgateway.ModelProxyUsageUnavailable, source: mcpgateway.ModelProxyUsageSourceUnavailable}
	}
	return result
}

func parseModelProxySSELine(line []byte) (modelProxyUsage, bool) {
	line = bytes.TrimSpace(line)
	if !bytes.HasPrefix(line, []byte("data:")) {
		return modelProxyUsage{}, false
	}
	payload := bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
	if bytes.Equal(payload, []byte("[DONE]")) || len(payload) == 0 {
		return modelProxyUsage{}, false
	}
	var value any
	if json.Unmarshal(payload, &value) != nil {
		return modelProxyUsage{}, false
	}
	return extractModelProxyUsageDetailed(value), true
}

type modelProxyUsageAccumulator struct {
	pending []byte
	usage   modelProxyUsage
}

func (a *modelProxyUsageAccumulator) Consume(raw []byte) {
	a.pending = append(a.pending, raw...)
	for {
		index := bytes.IndexByte(a.pending, '\n')
		if index < 0 {
			return
		}
		line := a.pending[:index]
		a.pending = a.pending[index+1:]
		if usage, ok := parseModelProxySSELine(line); ok && usage.available {
			a.usage = usage
		}
	}
}

func (a *modelProxyUsageAccumulator) Finalize() modelProxyUsage {
	if len(a.pending) > 0 {
		if usage, ok := parseModelProxySSELine(a.pending); ok && usage.available {
			a.usage = usage
		}
	}
	return a.usage
}

func findUsage(value any, result *map[string]any) {
	if *result != nil {
		return
	}
	switch current := value.(type) {
	case map[string]any:
		for key, item := range current {
			if strings.EqualFold(key, "usage") {
				if usage, ok := item.(map[string]any); ok {
					*result = usage
					return
				}
			}
			findUsage(item, result)
		}
	case []any:
		for _, item := range current {
			findUsage(item, result)
		}
	}
}

func responseModelFromValue(value any) string {
	switch current := value.(type) {
	case map[string]any:
		if model, ok := current["model"].(string); ok && strings.TrimSpace(model) != "" {
			return strings.TrimSpace(model)
		}
		for _, item := range current {
			if model := responseModelFromValue(item); model != "" {
				return model
			}
		}
	case []any:
		for _, item := range current {
			if model := responseModelFromValue(item); model != "" {
				return model
			}
		}
	}
	return ""
}

func firstNumber(values map[string]any, keys ...string) int64 {
	value, _ := firstNumberPresent(values, keys...)
	return value
}

func firstNumberPresent(values map[string]any, keys ...string) (int64, bool) {
	for _, key := range keys {
		if value, ok := values[key]; ok {
			switch number := value.(type) {
			case float64:
				return int64(number), true
			case json.Number:
				parsed, _ := number.Int64()
				return parsed, true
			case int:
				return int64(number), true
			case int64:
				return number, true
			case string:
				parsed, _ := strconv.ParseInt(number, 10, 64)
				return parsed, true
			}
		}
	}
	return 0, false
}

func sensitiveModelProxyHeader(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key":
		return true
	default:
		return sensitiveModelProxyField(key)
	}
}

func sensitiveModelProxyField(key string) bool {
	key = strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(key), "-", "_"), " ", "_"))
	return strings.Contains(key, "api_key") || strings.Contains(key, "password") ||
		strings.Contains(key, "secret") || strings.Contains(key, "credential") ||
		key == "authorization" || key == "proxy_authorization" || key == "cookie" ||
		key == "set_cookie" || key == "access_token" || key == "refresh_token"
}

func modelProxyMediaField(key string) bool {
	key = strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(key), "-", "_"), " ", "_"))
	return key == "b64_json" || strings.Contains(key, "base64")
}

func sanitizeModelProxyString(value string) any {
	if strings.HasPrefix(strings.ToLower(value), "data:") {
		return mediaModelProxySnapshot(value)
	}
	return value
}

func mediaModelProxySnapshot(value string) mcpgateway.JSONMap {
	mediaType := "application/octet-stream"
	encoded := value
	if strings.HasPrefix(strings.ToLower(value), "data:") {
		parts := strings.SplitN(value, ",", 2)
		if len(parts) == 2 {
			metadata := strings.TrimPrefix(parts[0], "data:")
			if semicolon := strings.IndexByte(metadata, ';'); semicolon >= 0 {
				mediaType = metadata[:semicolon]
			} else if metadata != "" {
				mediaType = metadata
			}
			encoded = parts[1]
		}
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		decoded = []byte(encoded)
	}
	return mcpgateway.JSONMap{"media_type": mediaType, "bytes": len(decoded), "sha256": sha256Hex(decoded)}
}

func sha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}
