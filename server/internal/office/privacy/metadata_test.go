package privacy

import "testing"

func TestSafeMetadataDropsSensitiveKeys(t *testing.T) {
	got := SafeMetadata(map[string]string{
		"tool_name":      "shell",
		"command_output": "secret output",
		"prompt":         "raw prompt",
		"api_token":      "token",
		"summary":        "safe summary",
	})
	if got["tool_name"] != "shell" {
		t.Fatalf("tool_name = %q", got["tool_name"])
	}
	if got["summary"] != "safe summary" {
		t.Fatalf("summary = %q", got["summary"])
	}
	for _, key := range []string{"command_output", "prompt", "api_token"} {
		if _, exists := got[key]; exists {
			t.Fatalf("sensitive key %q was retained: %#v", key, got)
		}
	}
}
