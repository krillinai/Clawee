package skillhub

import (
	"strings"
	"sync"
	"time"
)

const (
	AIReviewAgentStateUnknown = "unknown"
	AIReviewAgentStateOnline  = "online"
	AIReviewAgentStateBlocked = "blocked"
	AIReviewAgentStateOffline = "offline"
	aiReviewAgentOnlineWindow = 90 * time.Second
)

type aiReviewAgentPresence struct {
	mu            sync.RWMutex
	lastSeenAt    time.Time
	lastErrorAt   time.Time
	lastErrorCode string
	lastError     string
}

// ObserveAIReviewAgentPoll records the result of the review worker's existing task poll.
// Only the configured review Agent is tracked; failed polls never count as online.
func (s *Service) ObserveAIReviewAgentPoll(agent string, success bool, errorCode, message string) {
	if s == nil || strings.TrimSpace(agent) == "" || agent != s.reviewAgentID {
		return
	}
	now := s.clock().UTC()
	s.aiReviewPresence.mu.Lock()
	defer s.aiReviewPresence.mu.Unlock()
	if success {
		s.aiReviewPresence.lastSeenAt = now
		s.aiReviewPresence.lastErrorAt = time.Time{}
		s.aiReviewPresence.lastErrorCode = ""
		s.aiReviewPresence.lastError = ""
		return
	}
	s.aiReviewPresence.lastErrorAt = now
	s.aiReviewPresence.lastErrorCode = strings.TrimSpace(errorCode)
	s.aiReviewPresence.lastError = strings.TrimSpace(message)
}

func (s *Service) CurrentAIReviewAgentPresence() *AIReviewAgentPresence {
	if s == nil || s.reviewAgentID == "" {
		return nil
	}
	now := s.clock().UTC()
	s.aiReviewPresence.mu.RLock()
	lastSeenAt, lastErrorAt := s.aiReviewPresence.lastSeenAt, s.aiReviewPresence.lastErrorAt
	lastErrorCode, lastError := s.aiReviewPresence.lastErrorCode, s.aiReviewPresence.lastError
	s.aiReviewPresence.mu.RUnlock()

	state := AIReviewAgentStateUnknown
	if !lastErrorAt.IsZero() && now.Sub(lastErrorAt) <= aiReviewAgentOnlineWindow && lastErrorAt.After(lastSeenAt) {
		state = AIReviewAgentStateBlocked
	} else if !lastSeenAt.IsZero() && now.Sub(lastSeenAt) <= aiReviewAgentOnlineWindow {
		state = AIReviewAgentStateOnline
	} else if !lastSeenAt.IsZero() {
		state = AIReviewAgentStateOffline
	}
	var seen *time.Time
	if !lastSeenAt.IsZero() {
		value := lastSeenAt
		seen = &value
	}
	return &AIReviewAgentPresence{AgentID: s.reviewAgentID, State: state, LastSeenAt: seen, LastErrorCode: lastErrorCode, LastError: lastError}
}

func (s *Service) attachAIReviewAgentPresence(detail *AdminDetail) {
	if s == nil || detail == nil {
		return
	}
	presence := s.CurrentAIReviewAgentPresence()
	for index := range detail.Versions {
		if detail.Versions[index].LocalApproval != nil && detail.Versions[index].LocalApproval.AIReview != nil {
			detail.Versions[index].LocalApproval.AIReview.AgentPresence = presence
		}
	}
}
