package sharedfiles

import (
	"fmt"
	"strings"
	"time"
)

const generatedSpaceNameLayout = "20060102150405"

func personalSpaceBaseName(ownerName string) string {
	ownerName = strings.TrimSpace(ownerName)
	if ownerName == "" {
		return "个人网盘"
	}
	return "个人网盘-" + ownerName
}

func generatedSpaceName(base string, createdAt time.Time, attempt int) string {
	base = strings.TrimSpace(base)
	if attempt == 0 {
		return truncateSpaceName(base)
	}
	suffix := "-" + createdAt.UTC().Format(generatedSpaceNameLayout)
	if attempt > 1 {
		suffix += fmt.Sprintf("-%d", attempt)
	}
	return truncateSpaceName(base, len([]rune(suffix))) + suffix
}

func truncateSpaceName(value string, suffixRunes ...int) string {
	max := 100
	if len(suffixRunes) > 0 {
		max -= suffixRunes[0]
	}
	if max < 1 {
		max = 1
	}
	runes := []rune(strings.TrimSpace(value))
	if len(runes) > max {
		runes = runes[:max]
	}
	return string(runes)
}
