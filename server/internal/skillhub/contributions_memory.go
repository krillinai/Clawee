package skillhub

import (
	"context"
	"encoding/json"
	"time"
)

func (s *MemoryStore) recordFirstApprovalLocked(skill Skill, version Version, source, approvalID string, progress *LocalApproval, now time.Time) {
	if _, exists := s.firstApprovals[skill.SkillID]; exists || skill.CreatedAt.Before(s.contributionStartedAt) || version.UploadedByUserID == "" {
		return
	}
	s.firstApprovals[skill.SkillID] = firstApprovalRecord(skill, version, source, approvalID, progress, now)
}

func (s *MemoryStore) contributionRowsLocked() ([]ContributionRecord, []ContributionRecord, ContributionCoverage) {
	coverage := ContributionCoverage{FirstApprovalsFrom: s.contributionStartedAt, Notice: "首次通过仅包含覆盖起点后创建的 Skill；旧 Skill 历史首次通过无法确认，上传仅包含已采集的成功上传事实。"}
	uploads := []ContributionRecord{}
	for _, fact := range s.contributionUploads {
		row := fact
		row.EntityAvailable = false
		row.Status, row.Scores, row.ApprovalID, row.ScoringStandardVersion = nil, nil, nil, nil
		row.Approvers = []ApprovalDecision{}
		row.HistoryStatus = "unknown"
		if skill, ok := s.skills[row.SkillID]; ok {
			row.SpaceID = skill.SpaceID
			if !skill.CreatedAt.Before(s.contributionStartedAt) {
				row.HistoryStatus = "covered"
			}
			for _, version := range s.versions[row.SkillID] {
				if version.VersionID != row.VersionID {
					continue
				}
				row.EntityAvailable, row.Status = true, &version.ApprovalStatus
				if external := s.latestApprovalLocked(version.VersionID); external != nil {
					row.ApprovalID = &external.ID
				}
				if progress := localProgress(s.currentLocalLocked(version, skill.SpaceID)); progress != nil {
					row.ApprovalID, row.ScoringStandardVersion = &progress.RequestID, &progress.ScoringStandardVersion
					row.Scores, row.Approvers = progress.ScoreSummary, progress.Approvers
				}
			}
		}
		if coverage.UploadsFrom == nil || row.OccurredAt.Before(*coverage.UploadsFrom) {
			stamp := row.OccurredAt
			coverage.UploadsFrom = &stamp
		}
		uploads = append(uploads, row)
	}
	approvals := []ContributionRecord{}
	for _, snapshot := range s.firstApprovals {
		row := snapshot
		row.EntityAvailable = false
		for _, version := range s.versions[row.SkillID] {
			if version.VersionID == row.VersionID {
				row.EntityAvailable = true
			}
		}
		approvals = append(approvals, row)
	}
	return uploads, approvals, coverage
}

func (s *MemoryStore) ContributionData(_ context.Context, query ContributionQuery) ([]ContributionRecord, []ContributionRecord, ContributionCoverage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	uploads, approvals, coverage := s.contributionRowsLocked()
	start, end := contributionBounds(query)
	filter := func(rows []ContributionRecord) []ContributionRecord {
		items := []ContributionRecord{}
		for _, row := range rows {
			if !row.OccurredAt.Before(start) && row.OccurredAt.Before(end) && (query.EmployeeID == "" || row.EmployeeID == query.EmployeeID) {
				items = append(items, row)
			}
		}
		return cloneContributionRows(items)
	}
	return filter(uploads), filter(approvals), coverage, nil
}

func (s *MemoryStore) ContributionDetail(_ context.Context, skillID, versionID string) (ContributionRecord, ContributionCoverage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	uploads, approvals, coverage := s.contributionRowsLocked()
	rows := uploads
	if skillID != "" {
		rows = approvals
	}
	for _, row := range rows {
		if skillID != "" && row.SkillID == skillID || versionID != "" && row.VersionID == versionID {
			return cloneContributionRows([]ContributionRecord{row})[0], coverage, nil
		}
	}
	return ContributionRecord{}, coverage, ErrNotFound
}

func cloneContributionRows(rows []ContributionRecord) []ContributionRecord {
	raw, _ := json.Marshal(rows)
	var copied []ContributionRecord
	json.Unmarshal(raw, &copied)
	return copied
}
