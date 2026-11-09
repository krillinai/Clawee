package skillhub

import (
	"testing"
	"time"
)

func TestAIReviewAgentPresence(t *testing.T) {
	now := time.Date(2026, 10, 30, 8, 0, 0, 0, time.UTC)
	service := NewService(Config{ReviewAgentID: "agent-review", Store: NewMemoryStore(), Clock: func() time.Time { return now }})
	if got := service.CurrentAIReviewAgentPresence(); got.State != AIReviewAgentStateUnknown {
		t.Fatalf("initial state = %q, want unknown", got.State)
	}
	service.ObserveAIReviewAgentPoll("agent-review", false, "skill_read_forbidden", "审核 Agent 缺少技能查看权限")
	if got := service.CurrentAIReviewAgentPresence(); got.State != AIReviewAgentStateBlocked || got.LastErrorCode != "skill_read_forbidden" {
		t.Fatalf("blocked presence = %#v", got)
	}
	service.ObserveAIReviewAgentPoll("agent-review", true, "", "")
	if got := service.CurrentAIReviewAgentPresence(); got.State != AIReviewAgentStateOnline || got.LastError != "" {
		t.Fatalf("online presence = %#v", got)
	}
	now = now.Add(91 * time.Second)
	if got := service.CurrentAIReviewAgentPresence(); got.State != AIReviewAgentStateOffline {
		t.Fatalf("stale presence = %#v", got)
	}
}
