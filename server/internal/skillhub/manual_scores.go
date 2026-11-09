package skillhub

import "strings"

const manualScoringStandard = "manual-v1"

func scoreValues(scores *ReviewScores) []*int {
	if scores == nil {
		return []*int{nil, nil, nil, nil}
	}
	return []*int{scores.ScenarioValue, scores.ResultEffectiveness, scores.EaseOfUse, scores.ReuseValue}
}

func validateReview(approve bool, comment string, input ReviewInput) error {
	if strings.TrimSpace(input.RequestID) == "" || len([]rune(comment)) > 2000 || !approve && strings.TrimSpace(comment) == "" {
		return ErrInvalidRequest
	}
	for _, value := range scoreValues(input.Scores) {
		if value == nil {
			if approve {
				return ErrInvalidRequest
			}
		} else if *value < 1 || *value > 5 {
			return ErrInvalidRequest
		}
	}
	return nil
}

func hasScores(scores *ReviewScores) bool {
	for _, value := range scoreValues(scores) {
		if value != nil {
			return true
		}
	}
	return false
}

func cloneScores(scores *ReviewScores) *ReviewScores {
	if !hasScores(scores) {
		return nil
	}
	values := scoreValues(scores)
	for index, value := range values {
		if value != nil {
			copied := *value
			values[index] = &copied
		}
	}
	return &ReviewScores{values[0], values[1], values[2], values[3]}
}

func summarizeScores(progress *LocalApproval) {
	progress.ScoreSummary = nil
	if progress.Status != "approved" || len(progress.Approvers) == 0 {
		return
	}
	var sums [4]int
	for _, person := range progress.Approvers {
		if person.Status != "approved" {
			return
		}
		for index, value := range scoreValues(person.Scores) {
			if value == nil || *value < 1 || *value > 5 {
				return
			}
			sums[index] += *value
		}
	}
	count := float64(len(progress.Approvers))
	progress.ScoreSummary = &ScoreSummary{float64(sums[0]) / count, float64(sums[1]) / count, float64(sums[2]) / count, float64(sums[3]) / count, float64(sums[0]+sums[1]+sums[2]+sums[3]) / count}
}
