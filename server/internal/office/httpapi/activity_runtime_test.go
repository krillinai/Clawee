package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/dashboard"
)

func TestRuntimeSnapshotExcludesConversationAndToolPayloads(t *testing.T) {
	now := time.Date(2026, 10, 28, 0, 0, 0, 0, time.UTC)
	reader := &fakeDashboardReader{office: dashboard.OfficeSnapshot{
		ServerTime: now, Summary: dashboard.OfficeSummary{TotalAgents: 1, OnlineAgents: 1, WorkingAgents: 1},
		Agents: []dashboard.AgentListItem{{CollectorID: "collector", AgentID: "agent", Status: "thinking", LastSeenAt: now,
			OwnerEmail: "private@example.com", CurrentTurn: &dashboard.TurnItem{Title: "分析本周数据", UserPrompt: "PRIVATE PROMPT", LastAssistantMessage: "PRIVATE ANSWER"}}},
		RecentFeed: []dashboard.ActivityFeedItem{{Text: "PRIVATE FEED"}},
	}}
	rec := httptest.NewRecorder()
	NewDashboardAPI(reader, nil, func() time.Time { return now }).RuntimeHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	for _, expected := range []string{`"scope":"organization"`, `"working_agents":1`, `"current_task":"分析本周数据"`} {
		if !strings.Contains(rec.Body.String(), expected) {
			t.Fatalf("missing %s in %s", expected, rec.Body.String())
		}
	}
	for _, private := range []string{"PRIVATE", "private@example.com", "current_turn", "user_prompt"} {
		if strings.Contains(rec.Body.String(), private) {
			t.Fatalf("unexpected private field %s", private)
		}
	}
}

func TestRuntimeSnapshotEmptyAgentsAreAnArray(t *testing.T) {
	rec := httptest.NewRecorder()
	NewDashboardAPI(&fakeDashboardReader{}, nil, nil).RuntimeHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"agents":[]`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRuntimeSnapshotCurrentTaskOnlyIncludesActiveTurns(t *testing.T) {
	now := time.Date(2026, 10, 28, 0, 0, 0, 0, time.UTC)
	completedAt := now.Add(-time.Minute)
	for _, test := range []struct {
		name        string
		agentStatus string
		turnStatus  string
		completedAt *time.Time
		wantTask    bool
	}{
		{name: "正在执行", agentStatus: "thinking", turnStatus: "thinking", wantTask: true},
		{name: "等待用户", agentStatus: "waiting_user", turnStatus: "waiting_user", wantTask: true},
		{name: "任务阻塞", agentStatus: "blocked", turnStatus: "blocked", wantTask: true},
		{name: "轮次已完成", agentStatus: "thinking", turnStatus: "thinking", completedAt: &completedAt},
		{name: "Agent 已空闲", agentStatus: "idle", turnStatus: "thinking"},
		{name: "Agent 已离线", agentStatus: "offline", turnStatus: "thinking"},
		{name: "轮次已空闲", agentStatus: "thinking", turnStatus: "idle"},
		{name: "轮次已离线", agentStatus: "thinking", turnStatus: "offline"},
	} {
		t.Run(test.name, func(t *testing.T) {
			reader := &fakeDashboardReader{office: dashboard.OfficeSnapshot{
				ServerTime: now,
				Agents: []dashboard.AgentListItem{{
					CollectorID: "collector", AgentID: "agent", Status: test.agentStatus, LastSeenAt: now,
					CurrentTurn: &dashboard.TurnItem{Title: "分析本周数据", Status: test.turnStatus, CompletedAt: test.completedAt},
				}},
			}}
			rec := httptest.NewRecorder()
			NewDashboardAPI(reader, nil, func() time.Time { return now }).RuntimeHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			var result struct {
				Agents []struct {
					CurrentTask *string `json:"current_task"`
				} `json:"agents"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if len(result.Agents) != 1 {
				t.Fatalf("agents=%d, want 1", len(result.Agents))
			}
			currentTask := result.Agents[0].CurrentTask
			if test.wantTask {
				if currentTask == nil || *currentTask != "分析本周数据" {
					t.Fatalf("missing active task: %s", rec.Body.String())
				}
			} else if currentTask != nil {
				t.Fatalf("inactive turn exposed as current task: %s", rec.Body.String())
			}
		})
	}
}
