package textutil

import (
	"testing"
	"unicode/utf8"
)

func TestTruncateRunesKeepsUnicodeCharactersIntact(t *testing.T) {
	got := TruncateRunes("企业智能体✅上线", 5, "...")
	if got != "企业智能体..." {
		t.Fatalf("TruncateRunes() = %q, want %q", got, "企业智能体...")
	}
	if !utf8.ValidString(got) {
		t.Fatalf("TruncateRunes() returned invalid UTF-8: %q", got)
	}
}

func TestTruncateRunesReturnsShortValueAndHandlesNonPositiveLimit(t *testing.T) {
	if got := TruncateRunes("短文本", 10, "..."); got != "短文本" {
		t.Fatalf("TruncateRunes() = %q, want unchanged value", got)
	}
	if got := TruncateRunes("短文本", 0, "..."); got != "" {
		t.Fatalf("TruncateRunes() = %q, want empty string", got)
	}
}

func TestTruncateUTF8BytesStaysWithinLimitAndKeepsRunesIntact(t *testing.T) {
	got := TruncateUTF8Bytes("ab中文cd", 7)
	if got != "ab中" {
		t.Fatalf("TruncateUTF8Bytes() = %q, want %q", got, "ab中")
	}
	if len(got) > 7 {
		t.Fatalf("TruncateUTF8Bytes() returned %d bytes, want at most 7", len(got))
	}
	if !utf8.ValidString(got) {
		t.Fatalf("TruncateUTF8Bytes() returned invalid UTF-8: %q", got)
	}
}

func TestTruncateUTF8BytesReturnsEmptyForNonPositiveLimit(t *testing.T) {
	if got := TruncateUTF8Bytes("中文", 0); got != "" {
		t.Fatalf("TruncateUTF8Bytes() = %q, want empty string", got)
	}
}

func TestTruncateUTF8BytesReturnsValueWithinLimit(t *testing.T) {
	if got := TruncateUTF8Bytes("短文本", 9); got != "短文本" {
		t.Fatalf("TruncateUTF8Bytes() = %q, want unchanged value", got)
	}
}
