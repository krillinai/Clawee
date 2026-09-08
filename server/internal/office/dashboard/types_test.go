package dashboard

import (
	"encoding/json"
	"testing"
	"time"
)

func TestBusinessCallFromMetadataNormalizesKnownFields(t *testing.T) {
	input := map[string]string{
		"business_system":   "ERP Gateway",
		"system_type":       "erp",
		"operation_label":   "采购订单查询",
		"risk_level":        "low",
		"external_event_id": "erp_evt_7f42",
		"external_source":   "claw-mcp",
	}

	call, ok := BusinessCallFromMetadata(input)
	if !ok {
		t.Fatal("BusinessCallFromMetadata returned ok=false")
	}
	if call.SystemType != "erp" {
		t.Fatalf("SystemType = %q", call.SystemType)
	}
	if call.SystemName != "ERP Gateway" {
		t.Fatalf("SystemName = %q", call.SystemName)
	}
	if call.OperationLabel != "采购订单查询" {
		t.Fatalf("OperationLabel = %q", call.OperationLabel)
	}
	if call.RiskLevel != "low" {
		t.Fatalf("RiskLevel = %q", call.RiskLevel)
	}
	if call.ExternalEventID != "erp_evt_7f42" {
		t.Fatalf("ExternalEventID = %q", call.ExternalEventID)
	}
	if call.ExternalSource != "claw-mcp" {
		t.Fatalf("ExternalSource = %q", call.ExternalSource)
	}
}

func TestBusinessCallFromMetadataAcceptsSystemNameAlias(t *testing.T) {
	call, ok := BusinessCallFromMetadata(map[string]string{
		"system_name":     "Salesforce",
		"operation_label": "客户查询",
	})
	if !ok {
		t.Fatal("BusinessCallFromMetadata returned ok=false")
	}
	if call.SystemName != "Salesforce" {
		t.Fatalf("SystemName = %q", call.SystemName)
	}
	if call.SystemType != "other" {
		t.Fatalf("SystemType = %q", call.SystemType)
	}
	if call.RiskLevel != "unknown" {
		t.Fatalf("RiskLevel = %q", call.RiskLevel)
	}
}

func TestBusinessCallFromMetadataRejectsEmptyMetadata(t *testing.T) {
	call, ok := BusinessCallFromMetadata(map[string]string{
		"tool_name": "apply_patch",
	})
	if ok {
		t.Fatalf("ok = true, call = %#v", call)
	}
}

func TestSSEEnvelopeUsesCollectorAndAgentID(t *testing.T) {
	env := RealtimeEnvelope{
		SchemaVersion: SchemaVersion,
		EventID:       "sse_1",
		EventType:     "agent.upserted",
		EmittedAt:     time.Date(2026, 6, 3, 10, 21, 36, 0, time.UTC),
		Cursor:        "1",
		Scope: RealtimeScope{
			CollectorID: "collector_1",
			AgentID:     "agent_same",
		},
		Data: json.RawMessage(`{"ok":true}`),
	}

	body, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(body) {
		t.Fatalf("invalid json: %s", string(body))
	}
	if env.Scope.CollectorID != "collector_1" || env.Scope.AgentID != "agent_same" {
		t.Fatalf("scope = %#v", env.Scope)
	}
}
