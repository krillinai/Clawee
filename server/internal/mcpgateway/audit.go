package mcpgateway

import (
	"encoding/json"
	"strings"
)

func SanitizeHeaders(headers JSONMap) JSONMap {
	if headers == nil {
		return nil
	}
	out := JSONMap{}
	for key, value := range headers {
		if isSensitiveHeader(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = cloneJSONValue(value)
	}
	return out
}

func isSensitiveHeader(key string) bool {
	return strings.EqualFold(key, "authorization") ||
		strings.EqualFold(key, "cookie") ||
		strings.EqualFold(key, "set-cookie")
}

func structuredContentToJSONMap(value any) JSONMap {
	if value == nil {
		return nil
	}
	if m, ok := value.(JSONMap); ok {
		return cloneJSONMap(m)
	}
	if m, ok := value.(map[string]any); ok {
		return cloneJSONMap(JSONMap(m))
	}
	return JSONMap{"value": cloneJSONValue(value)}
}

func toolResponseBody(structuredContent any, content any) JSONMap {
	body := structuredContentToJSONMap(structuredContent)
	if body != nil {
		return body
	}
	if content == nil {
		return nil
	}
	raw, err := json.Marshal(content)
	if err != nil {
		return JSONMap{"content": cloneJSONValue(content)}
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return JSONMap{"content": cloneJSONValue(content)}
	}
	return JSONMap{"content": cloneJSONValue(decoded)}
}
