package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestModelUpstreamContentText(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "string", raw: `"hello"`, want: "hello"},
		{name: "content parts", raw: `[{"type":"text","text":"hello "},{"type":"text","text":"world"}]`, want: "hello world"},
		{name: "empty", raw: `null`, want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := modelUpstreamContentText(json.RawMessage(tt.raw)); got != tt.want {
				t.Fatalf("modelUpstreamContentText(%s) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}

func TestParseModelUpstreamResponsesStreamRequiresTextAndCompletion(t *testing.T) {
	stream := strings.NewReader("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n" +
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\" world\"}\n\n" +
		"data: {\"type\":\"response.completed\"}\n\n" +
		"data: [DONE]\n\n")
	reply, err := parseModelUpstreamResponsesStream(stream)
	if err != nil || reply != "hello world" {
		t.Fatalf("reply=%q err=%v", reply, err)
	}

	for _, raw := range []string{
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
		"data: {\"type\":\"response.failed\"}\n\n",
	} {
		if _, err := parseModelUpstreamResponsesStream(strings.NewReader(raw)); err == nil {
			t.Fatalf("stream %q unexpectedly succeeded", raw)
		}
	}
}
