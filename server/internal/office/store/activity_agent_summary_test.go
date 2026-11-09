package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/activity"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/office/state"
)

func TestAgentSummaryConversationOwnershipPaginationAndCoverage(t *testing.T) {
	db := openOfficeTestDB(t)
	ctx := context.Background()
	store := NewPostgresStore(db)
	start := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	end := start.Add(24 * time.Hour)
	for _, id := range []string{"employee-a", "employee-b"} {
		ensureOfficeTestAccount(t, ctx, db, id)
	}
	for _, item := range []struct{ source, employee string }{{"source-a", "employee-a"}, {"source-b", "employee-a"}, {"source-c", "employee-b"}} {
		if _, err := db.ExecContext(ctx, `INSERT INTO office_collector_tokens (collector_id, token_hash, user_id) VALUES ($1, $1, $2)`, item.source, item.employee); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertAgent(ctx, state.AgentState{CollectorID: item.source, AgentID: "shared", DeviceID: "device", AgentType: collectorapi.AgentTypeCodex,
			DisplayName: "测试 Agent", WorkspaceName: item.source, Status: collectorapi.StatusIdle, LastSeenAt: start}); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertSession(ctx, state.SessionState{CollectorID: item.source, AgentID: "shared", SessionID: "session", WorkspaceName: item.source + "/历史工作区", StartedAt: start, UpdatedAt: start, Status: collectorapi.StatusIdle}); err != nil {
			t.Fatal(err)
		}
	}
	for _, employeeID := range []string{"employee-a", "employee-b", ""} {
		if _, err := db.ExecContext(ctx, `INSERT INTO mcp_proxy_audit_records (audit_id, trace_id, agent_id, user_id, capability_type, decision, created_at, completed_at)
VALUES ($1, $1, 'shared', $2, 'tool', 'allowed', $3, $3)`, "audit-"+employeeID, employeeID, start.Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	addTurn := func(source, id, session, prompt, reply, subAgent string, at time.Time) {
		t.Helper()
		completed := at.Add(time.Second)
		if err := store.UpsertTurn(ctx, state.TurnState{CollectorID: source, AgentID: "shared", TurnID: id, SessionID: session, SubAgentID: subAgent,
			UserPrompt: prompt, LastAssistantMessage: reply, Status: collectorapi.StatusIdle, StartedAt: at, UpdatedAt: completed, CompletedAt: &completed}); err != nil {
			t.Fatal(err)
		}
	}
	addTurn("source-a", "same-turn", "session", "输入甲", "回复甲", "", start.Add(time.Minute))
	addTurn("source-b", "same-turn", "session", "输入乙", "回复乙", "", start.Add(time.Minute))
	addTurn("source-c", "private", "session", "其他员工输入", "其他员工回复", "", start.Add(time.Minute))
	addTurn("source-a", "follow-up", "session", "继续分析", "已继续分析", "", start.Add(2*time.Minute))
	addTurn("source-a", "missing", "session-2", "", "", "", start.Add(3*time.Minute))
	addTurn("source-a", "long", "session-2", strings.Repeat("中", activity.MaxConversationTextChars+10), "正常回复", "", start.Add(4*time.Minute))
	addTurn("source-a", "truncated", "session-2", "输入\n...[TRUNCATED]", "回复\n...[TRUNCATED]", "", start.Add(5*time.Minute))
	addTurn("source-a", "before", "session", "不在周期内", "", "", start.Add(-time.Minute))
	addTurn("source-a", "boundary", "session", "不在周期内", "", "", end)
	addTurn("source-a", "sub-agent", "session", "委派任务", "子 Agent 回复", "sub", start.Add(2*time.Minute))

	if _, err := store.AgentSummary(ctx, "shared", start, end, activity.AgentDetailOptions{}); !errors.Is(err, activity.ErrAmbiguousAgent) {
		t.Fatalf("must not merge different employees: %v", err)
	}
	if _, err := store.AgentSummary(ctx, "shared", start, end, activity.AgentDetailOptions{EmployeeID: "nonexistent"}); !errors.Is(err, activity.ErrAgentNotFound) {
		t.Fatalf("unknown owner = %v", err)
	}
	options := activity.AgentDetailOptions{EmployeeID: "employee-a", Limit: 2}
	summary, err := store.AgentSummary(ctx, "shared", start, end, options)
	if err != nil || summary.EmployeeID != "employee-a" || summary.EmployeeName != "employee-a" || summary.TurnCount != 7 || summary.MCPCallCount != 1 || summary.Content != nil {
		t.Fatalf("summary=%#v err=%v", summary, err)
	}
	statistics, err := store.Statistics(ctx, start, end)
	if err != nil {
		t.Fatal(err)
	}
	if len(statistics.Agents) != 3 || statistics.Agents[0].EmployeeID == "" || statistics.Agents[0].EmployeeName == "" {
		t.Fatalf("statistics must carry account ownership: %#v", statistics.Agents)
	}

	options.IncludeContent = true
	seen := map[string]activity.ConversationTurn{}
	for {
		summary, err = store.AgentSummary(ctx, "shared", start, end, options)
		if err != nil {
			t.Fatal(err)
		}
		content := summary.Content
		if content == nil || content.TotalTurns != 6 || content.ReturnedTurns != 2 || content.Offset != options.Offset || content.Scope != "reported_turns_with_last_assistant_message" {
			t.Fatalf("content=%#v", content)
		}
		for _, session := range content.Sessions {
			if session.SessionID == "session" && session.WorkspaceName != session.CollectorID+"/历史工作区" {
				t.Fatalf("must preserve session workspace: %#v", session)
			}
			for _, turn := range session.Turns {
				key := session.CollectorID + "/" + session.SessionID + "/" + turn.TurnID
				if _, exists := seen[key]; exists {
					t.Fatalf("duplicate turn across pages: %s", key)
				}
				seen[key] = turn
			}
		}
		if !content.HasMore {
			if content.NextOffset != nil {
				t.Fatalf("final page must not have next offset: %#v", content)
			}
			break
		}
		if content.NextOffset == nil || *content.NextOffset != options.Offset+content.ReturnedTurns {
			t.Fatalf("invalid next offset: %#v", content)
		}
		options.Offset = *content.NextOffset
	}
	if len(seen) != 6 || seen["source-a/session/same-turn"].LastAssistantMessage != "回复甲" || seen["source-b/session/same-turn"].LastAssistantMessage != "回复乙" {
		t.Fatalf("conversation turns were mixed or missing: %#v", seen)
	}
	missing := seen["source-a/session-2/missing"]
	long := seen["source-a/session-2/long"]
	truncated := seen["source-a/session-2/truncated"]
	if !missing.UserPromptMissing || !missing.LastAssistantMessageMissing || !long.UserPromptTruncated || len([]rune(long.UserPrompt)) != activity.MaxConversationTextChars || long.LastAssistantMessageTruncated || !truncated.UserPromptTruncated || !truncated.LastAssistantMessageTruncated {
		t.Fatal("missing and truncated content must be marked without corrupting UTF-8")
	}

	options.SessionID, options.Offset = "session-2", 0
	summary, err = store.AgentSummary(ctx, "shared", start, end, options)
	if err != nil || summary.Content.TotalTurns != 3 || len(summary.Content.Sessions) != 1 || summary.Content.Sessions[0].SessionID != "session-2" {
		t.Fatalf("session filter=%#v err=%v", summary.Content, err)
	}
	options.Offset = 100
	summary, err = store.AgentSummary(ctx, "shared", start, end, options)
	if err != nil || summary.Content.TotalTurns != 3 || summary.Content.ReturnedTurns != 0 || summary.Content.Sessions == nil || summary.Content.HasMore || summary.Content.NextOffset != nil {
		t.Fatalf("empty page=%#v err=%v", summary.Content, err)
	}
	options.EmployeeID, options.SessionID, options.Offset = "employee-b", "", 0
	summary, err = store.AgentSummary(ctx, "shared", start, end, options)
	if err != nil || summary.TurnCount != 1 || summary.Content.TotalTurns != 1 || summary.Content.Sessions[0].Turns[0].UserPrompt != "其他员工输入" {
		t.Fatalf("other employee=%#v err=%v", summary, err)
	}
}
