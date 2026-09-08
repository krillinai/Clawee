package scrub

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/krillinai/Clawee/server/internal/textutil"
)

const DefaultTextLimit = 160

func KeepMetadata(input map[string]any, allowedKeys []string) map[string]string {
	output := make(map[string]string)
	for _, key := range allowedKeys {
		value, ok := input[key]
		if !ok {
			continue
		}

		text, ok := metadataValueToString(value)
		if !ok {
			continue
		}
		if key == "cwd" || key == "workspace_path" {
			text = WorkspaceNameFromPath(text)
		}
		text = LimitText(text, DefaultTextLimit)
		if text == "" {
			continue
		}

		output[key] = text
	}
	return output
}

func LimitText(value string, maxLen int) string {
	text := strings.TrimSpace(value)
	if maxLen <= 0 {
		return text
	}
	return textutil.TruncateRunes(text, maxLen, "")
}

func WorkspaceNameFromPath(path string) string {
	text := strings.TrimSpace(path)
	if text == "" {
		return ""
	}

	base := filepath.Base(text)
	if base == "." || base == string(filepath.Separator) {
		return ""
	}
	return base
}

func metadataValueToString(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, true
	case int:
		return fmt.Sprint(typed), true
	case int64:
		return fmt.Sprint(typed), true
	case float64:
		return fmt.Sprint(typed), true
	case bool:
		return fmt.Sprint(typed), true
	default:
		return "", false
	}
}
