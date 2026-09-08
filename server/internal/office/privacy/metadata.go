package privacy

import "strings"

func SafeMetadata(input map[string]string) map[string]string {
	out := make(map[string]string)
	for key, value := range input {
		if IsSensitiveMetadataKey(key) {
			continue
		}
		out[key] = value
	}
	return out
}

func IsSensitiveMetadataKey(key string) bool {
	lower := strings.ToLower(key)
	for _, sensitive := range []string{
		"prompt",
		"response",
		"output",
		"token",
		"cookie",
		"secret",
		"password",
		"diff",
		"content",
	} {
		if strings.Contains(lower, sensitive) {
			return true
		}
	}
	return false
}
