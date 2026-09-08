package mcpgateway

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/krillinai/Clawee/server/internal/textutil"
)

const maxGateValueLength = 200

func ArgumentsHash(arguments JSONMap) (string, error) {
	body, err := json.Marshal(arguments)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func BuildGateSummary(capability Capability, arguments JSONMap) GateSummary {
	return GateSummary{
		System:      gateSystem(capability),
		Action:      firstNonEmpty(capability.Title, capability.ExposedName),
		Object:      gateObject(capability, arguments),
		Tool:        capability.ExposedName,
		RiskLevel:   capability.RiskLevel,
		Destructive: capability.Destructive,
		ReadOnly:    capability.ReadOnly,
		Parameters:  gateParameters(capability.InputSchema, arguments),
		Risks:       gateRisks(capability),
	}
}

func gateSystem(capability Capability) string {
	name := firstNonEmpty(capability.ExposedName, capability.UpstreamName)
	if name == "" {
		return ""
	}
	parts := strings.Split(name, ".")
	return parts[0]
}

func gateObject(capability Capability, arguments JSONMap) string {
	name := firstNonEmpty(capability.ExposedName, capability.UpstreamName)
	if name == "" {
		return ""
	}
	parts := strings.Split(name, ".")
	if len(parts) < 2 {
		return ""
	}
	resource := parts[len(parts)-2]

	idValue := gateObjectID(arguments)
	if idValue == "" {
		return resource
	}
	return resource + "/" + idValue
}

func gateObjectID(arguments JSONMap) string {
	if len(arguments) == 0 {
		return ""
	}
	keys := make([]string, 0, len(arguments))
	for key := range arguments {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		normalized := normalizeFieldName(key)
		if isSensitiveField(normalized) {
			continue
		}
		if normalized == "id" || strings.HasSuffix(normalized, "_id") || strings.HasSuffix(normalized, "_no") || strings.HasSuffix(normalized, "_code") {
			if val := arguments[key]; val != nil {
				s := fmt.Sprint(val)
				if strings.TrimSpace(s) != "" {
					return truncateString(s)
				}
			}
		}
	}
	for _, key := range keys {
		normalized := normalizeFieldName(key)
		if !isSensitiveField(normalized) {
			if s, ok := arguments[key].(string); ok && strings.TrimSpace(s) != "" {
				return truncateString(s)
			}
		}
	}
	return ""
}

func gateParameters(inputSchema JSONMap, arguments JSONMap) []GateParameter {
	if len(arguments) == 0 {
		return nil
	}
	properties := schemaProperties(inputSchema)
	keys := make([]string, 0, len(arguments))
	for key := range arguments {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	parameters := make([]GateParameter, 0, len(keys))
	for _, key := range keys {
		sensitive := isSensitiveField(key)
		parameters = append(parameters, GateParameter{
			Path:      key,
			Label:     schemaLabel(properties[key], key),
			Value:     formatGateValue(key, arguments[key], sensitive),
			Sensitive: sensitive,
		})
	}
	return parameters
}

func schemaProperties(inputSchema JSONMap) map[string]any {
	if inputSchema == nil {
		return nil
	}
	raw, ok := inputSchema["properties"]
	if !ok {
		return nil
	}
	switch properties := raw.(type) {
	case JSONMap:
		out := make(map[string]any, len(properties))
		for key, value := range properties {
			out[key] = value
		}
		return out
	case map[string]any:
		return properties
	default:
		return nil
	}
}

func schemaLabel(property any, key string) string {
	propertyMap, ok := property.(JSONMap)
	if !ok {
		if genericMap, genericOK := property.(map[string]any); genericOK {
			propertyMap = JSONMap(genericMap)
			ok = true
		}
	}
	if !ok {
		return key
	}
	title, ok := propertyMap["title"].(string)
	if !ok || strings.TrimSpace(title) == "" {
		return key
	}
	return title
}

func formatGateValue(key string, value any, sensitive bool) string {
	if sensitive {
		return maskSensitiveValue(key, value)
	}

	switch typed := value.(type) {
	case string:
		return truncateString(typed)
	default:
		body, err := json.Marshal(maskSensitiveJSONValue(typed))
		if err != nil {
			return truncateString(fmt.Sprint(typed))
		}
		return truncateString(string(body))
	}
}

func isSensitiveField(field string) bool {
	normalized := normalizeFieldName(field)
	return normalized == "phone" ||
		normalized == "email" ||
		strings.Contains(normalized, "api_key") ||
		strings.Contains(normalized, "apikey") ||
		strings.Contains(normalized, "authorization") ||
		strings.Contains(normalized, "cookie") ||
		strings.Contains(normalized, "credential") ||
		strings.Contains(normalized, "private_key") ||
		strings.Contains(normalized, "id_card") ||
		strings.Contains(normalized, "access_token") ||
		strings.Contains(normalized, "token") ||
		strings.Contains(normalized, "password") ||
		strings.Contains(normalized, "secret")
}

func normalizeFieldName(field string) string {
	normalized := strings.ToLower(field)
	normalized = strings.ReplaceAll(normalized, "-", "_")
	normalized = strings.ReplaceAll(normalized, " ", "_")
	return normalized
}

func maskSensitiveValue(key string, value any) string {
	raw := fmt.Sprint(value)
	normalized := strings.ToLower(key)
	normalized = strings.ReplaceAll(normalized, "-", "_")

	switch {
	case normalized == "phone":
		runes := []rune(raw)
		if len(runes) >= 7 {
			return string(runes[:3]) + "****" + string(runes[len(runes)-4:])
		}
	case normalized == "email":
		at := strings.Index(raw, "@")
		if at > 0 {
			local := []rune(raw[:at])
			if len(local) > 0 {
				return string(local[:1]) + "***" + raw[at:]
			}
		}
	}
	return "******"
}

func maskSensitiveJSONValue(value any) any {
	switch typed := value.(type) {
	case JSONMap:
		return maskSensitiveJSONMap(map[string]any(typed))
	case map[string]any:
		return maskSensitiveJSONMap(typed)
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = maskSensitiveJSONValue(item)
		}
		return out
	case []JSONMap:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = maskSensitiveJSONValue(item)
		}
		return out
	case []map[string]any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = maskSensitiveJSONValue(item)
		}
		return out
	default:
		return typed
	}
}

func maskSensitiveJSONMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if isSensitiveField(key) {
			out[key] = maskSensitiveValue(key, value)
			continue
		}
		out[key] = maskSensitiveJSONValue(value)
	}
	return out
}

func truncateString(value string) string {
	return textutil.TruncateRunes(value, maxGateValueLength, "...")
}

func gateRisks(capability Capability) []string {
	risks := make([]string, 0, 3)
	if capability.Destructive {
		risks = append(risks, "destructive operation may modify or delete data")
	}
	if !capability.ReadOnly {
		risks = append(risks, "tool is not read-only")
	}
	if strings.EqualFold(capability.RiskLevel, "high") || strings.EqualFold(capability.RiskLevel, "critical") {
		risks = append(risks, "risk level is "+capability.RiskLevel)
	}
	return risks
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
