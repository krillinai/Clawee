package codex

import (
	"bytes"
	"encoding/json"
)

type FlexibleValue struct {
	raw       json.RawMessage
	value     any
	text      string
	jsonValue any
}

func (v *FlexibleValue) UnmarshalJSON(data []byte) error {
	v.raw = append(v.raw[:0], data...)
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&v.value); err != nil {
		return err
	}
	if text, ok := v.value.(string); ok {
		v.text = text
		var parsed any
		if err := json.Unmarshal([]byte(text), &parsed); err == nil {
			v.jsonValue = parsed
		}
		return nil
	}
	v.jsonValue = v.value
	if len(data) > 0 {
		v.text = string(data)
	}
	return nil
}

func (v FlexibleValue) Raw() json.RawMessage {
	return append(json.RawMessage(nil), v.raw...)
}

func (v FlexibleValue) Value() any {
	return v.value
}

func (v FlexibleValue) JSONValue() any {
	return v.jsonValue
}

func (v FlexibleValue) Text() string {
	return v.text
}

func (v FlexibleValue) Map() map[string]any {
	if typed, ok := v.jsonValue.(map[string]any); ok {
		return typed
	}
	if typed, ok := v.value.(map[string]any); ok {
		return typed
	}
	return nil
}

type HookPayload struct {
	HookEventName        string         `json:"hook_event_name"`
	SessionID            string         `json:"session_id"`
	TurnID               string         `json:"turn_id"`
	ToolUseID            string         `json:"tool_use_id"`
	ToolName             string         `json:"tool_name"`
	AgentID              string         `json:"agent_id"`
	AgentType            string         `json:"agent_type"`
	ParentThreadID       string         `json:"parent_thread_id"`
	ChildThreadID        string         `json:"child_thread_id"`
	CWD                  string         `json:"cwd"`
	CodexVersion         string         `json:"codex_version"`
	Model                string         `json:"model"`
	PermissionMode       string         `json:"permission_mode"`
	TranscriptPath       string         `json:"transcript_path"`
	AgentTranscriptPath  string         `json:"agent_transcript_path"`
	Prompt               string         `json:"prompt"`
	LastAssistantMessage string         `json:"last_assistant_message"`
	ToolInput            map[string]any `json:"tool_input"`
	ToolResponse         FlexibleValue  `json:"tool_response"`
	Raw                  map[string]any `json:"-"`
}
