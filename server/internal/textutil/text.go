package textutil

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

func isInputBoundary(r rune) bool {
	return unicode.IsSpace(r) || r == '\u200b' || r == '\u200c' || r == '\u200d' || r == '\u2060' || r == '\ufeff'
}

func TrimInput(value string) string {
	return strings.TrimFunc(value, isInputBoundary)
}

func CleanInputIdentifier(value string) string {
	return TrimInput(strings.Map(func(r rune) rune {
		if r == '\u200b' || r == '\u200c' || r == '\u200d' || r == '\u2060' || r == '\ufeff' {
			return -1
		}
		return r
	}, value))
}

func TruncateRunes(value string, maxRunes int, suffix string) string {
	if maxRunes <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes]) + suffix
}

func TruncateUTF8Bytes(value string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(value) <= maxBytes {
		return value
	}
	for maxBytes > 0 && !utf8.RuneStart(value[maxBytes]) {
		maxBytes--
	}
	return value[:maxBytes]
}
