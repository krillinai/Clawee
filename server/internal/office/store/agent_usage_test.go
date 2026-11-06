package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/activity"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/state"
)

func TestAgentUsageScopesCollectorsAndTimeWithoutHistoryLimits(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	loc, _ := time.LoadLocation("Asia/Shanghai")
	start := time.Date(2026, 10, 29, 0, 0, 0, 0, loc)
	end := start.AddDate(0, 0, 1)
	r := activity.DateRange{Start: start, End: end, Timezone: "Asia/Shanghai", Granularity: "hour"}
	for _, id := range []string{"source-a", "source-b"} {
		ensureOfficeTestAccount(t, ctx, db, id)
		if _, err := db.ExecContext(ctx, `INSERT INTO office_collector_tokens (collector_id,token_hash,user_id) VALUES ($1,$1,$1)`, id); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertAgent(ctx, state.AgentState{CollectorID: id, AgentID: "shared", DeviceID: "device", AgentType: collectorapi.AgentTypeCodex, Status: collectorapi.StatusIdle, LastSeenAt: start}); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertSession(ctx, state.SessionState{CollectorID: id, AgentID: "shared", SessionID: "session", StartedAt: start, UpdatedAt: start, Status: collectorapi.StatusIdle}); err != nil {
			t.Fatal(err)
		}
	}
	addTurn := func(source, id string, at, done time.Time) {
		t.Helper()
		if err := store.UpsertTurn(ctx, state.TurnState{CollectorID: source, AgentID: "shared", TurnID: id, SessionID: "session", StartedAt: at, UpdatedAt: done, CompletedAt: &done, Status: collectorapi.StatusIdle}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 105; i++ {
		addTurn("source-a", fmt.Sprint(i), start.Add(time.Minute), start.Add(2*time.Minute))
	}
	addTurn("source-a", "earlier", start.Add(-time.Minute), start.Add(time.Minute))
	addTurn("source-a", "boundary", end, end)
	addTurn("source-b", "other", start, start.Add(time.Minute))
	if err := store.UpsertToolCall(ctx, state.ToolCallState{CollectorID: "source-a", AgentID: "shared", ToolCallID: "tool", SessionID: "session", ToolName: "search", ToolType: "mcp", Status: "completed", StartedAt: start}); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ source, id, evidence, invocation, run string }{
		{"source-a", "request", "explicit_request", "explicit", "run"},
		{"source-a", "read", "skill_file_read", "explicit", "run"},
		{"source-a", "resource", "skill_resource_run", "explicit", "run"},
		{"source-a", "implicit", "skill_file_read", "implicit", "run-2"},
		{"source-b", "other", "skill_file_read", "implicit", "run"},
		{"source-a", "outside", "skill_file_read", "implicit", "outside"},
	} {
		at := start
		if item.id == "outside" {
			at = end
		}
		_, err := store.ApplySourceEvent(ctx, state.SourceEventState{CollectorID: item.source, SourceEventID: item.id, SourceType: "clawee", SourceEventType: "skill_evidence", StandardEventType: collectorapi.EventSourceEventReceived, AgentID: "shared", TurnID: item.run, OccurredAt: at, ReceivedAt: at}, func(ctx context.Context, tx state.Store) error {
			return tx.InsertSkillEvidence(ctx, state.SkillEvidenceState{CollectorID: item.source, SourceEventID: item.id, AgentID: "shared", RunID: item.run, SkillID: "research", SkillName: "调研", SkillKey: "research", Source: "local", Evidence: item.evidence, Invocation: item.invocation, OccurredAt: at})
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO mcp_agents (agent_id,name,status,created_at,updated_at) VALUES ('mcp-a','Agent','active',$1,$1)`, start); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE office_agents SET mcp_agent_id='mcp-a' WHERE collector_id='source-a'`); err != nil {
		t.Fatal(err)
	}
	for _, a := range []struct {
		id, agent, user, decision string
		at                        time.Time
	}{
		{"allowed", "mcp-a", "source-a", "allowed", start},
		{"confirmed", "mcp-a", "source-a", "confirmation_completed", start},
		{"other-user", "mcp-a", "source-b", "allowed", start},
		{"other-agent", "mcp-b", "source-a", "allowed", start},
		{"denied", "mcp-a", "source-a", "no_matching_grant", start},
		{"outside", "mcp-a", "source-a", "allowed", end},
	} {
		if _, err := db.ExecContext(ctx, `INSERT INTO mcp_proxy_audit_records (audit_id,trace_id,agent_id,user_id,capability_type,upstream_server_id,decision,created_at,completed_at) VALUES ($1,$1,$2,$3,'tool','search',$4,$5,$5)`, a.id, a.agent, a.user, a.decision, a.at); err != nil {
			t.Fatal(err)
		}
	}
	result, err := store.AgentUsage(ctx, "source-a", "source-a", "shared", r)
	if err != nil {
		t.Fatal(err)
	}
	if result.SessionCount != 1 || result.TurnCount != 105 || result.CompletedTurns != 106 || result.ToolCallCount != 1 || len(result.Points) != 1 || result.Points[0].BucketStart.Unix() != start.Unix() {
		t.Fatalf("counts = %#v", result)
	}
	if len(result.SkillUsage) != 1 || result.SkillUsage[0].RequestedRuns != 1 || result.SkillUsage[0].ObservedRuns != 2 || result.SkillUsage[0].ImplicitRuns != 1 || result.SkillUsageTotals.ExplicitSkillRuns != 1 {
		t.Fatalf("Skill deduplication/scope = %#v", result)
	}
	if result.MCPStatus != "available" || len(result.MCPDistribution) != 1 || result.MCPDistribution[0].InvocationCount != 2 || result.MCPDistribution[0].Share != 1 {
		t.Fatalf("MCP attribution = %#v", result)
	}
	other, err := store.AgentUsage(ctx, "source-b", "source-b", "shared", r)
	if err != nil || other.TurnCount != 1 || other.MCPStatus != "unlinked" || len(other.MCPDistribution) != 0 {
		t.Fatalf("other collector = %#v, %v", other, err)
	}
	if _, err := store.AgentUsage(ctx, "missing", "missing", "shared", r); !errors.Is(err, activity.ErrAgentNotFound) {
		t.Fatalf("missing = %v", err)
	}
	if _, err := store.AgentUsage(ctx, "source-b", "source-a", "shared", r); !errors.Is(err, activity.ErrAgentNotFound) {
		t.Fatalf("cross-account lookup = %v", err)
	}
}
