package skillhub

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
)

const ContributionTimezone = "Asia/Shanghai"

var ErrContributionLimit = errors.New("contribution export exceeds 10000 rows")

type ContributionQuery struct {
	StartDate     string   `json:"start_date"`
	EndDate       string   `json:"end_date"`
	Report        string   `json:"report"`
	EmployeeID    string   `json:"employee_id,omitempty"`
	Status        string   `json:"status,omitempty"`
	MinTotalScore *float64 `json:"min_total_score,omitempty"`
	Page          int      `json:"page,omitempty"`
	PageSize      int      `json:"page_size,omitempty"`
}

type ContributionRecord struct {
	ID                     string             `json:"id"`
	EmployeeID             string             `json:"employee_id"`
	EmployeeName           string             `json:"employee_name"`
	SkillID                string             `json:"skill_id"`
	SkillName              string             `json:"skill_name"`
	VersionID              string             `json:"version_id"`
	Version                *string            `json:"version"`
	SpaceID                string             `json:"space_id"`
	Source                 string             `json:"source"`
	ApprovalID             *string            `json:"approval_id"`
	OccurredAt             time.Time          `json:"occurred_at"`
	Status                 *string            `json:"status"`
	ScoringStandardVersion *string            `json:"scoring_standard_version"`
	Scores                 *ScoreSummary      `json:"scores"`
	Approvers              []ApprovalDecision `json:"approvers"`
	EntityAvailable        bool               `json:"entity_available"`
	HistoryStatus          string             `json:"history_status"`
}

type ContributionEmployee struct {
	EmployeeID     string   `json:"employee_id"`
	EmployeeName   string   `json:"employee_name"`
	Uploads        int      `json:"uploads"`
	FirstApprovals int      `json:"first_approvals"`
	ScoredCount    int      `json:"scored_count"`
	AverageScore   *float64 `json:"average_score"`
}

type ContributionSummary struct {
	Uploads        int      `json:"uploads"`
	FirstApprovals int      `json:"first_approvals"`
	Contributors   int      `json:"contributors"`
	ScoredCount    int      `json:"scored_count"`
	AverageScore   *float64 `json:"average_score"`
}

type ContributionCoverage struct {
	FirstApprovalsFrom time.Time  `json:"first_approvals_from"`
	UploadsFrom        *time.Time `json:"uploads_from"`
	Notice             string     `json:"notice"`
}

type ContributionResponse struct {
	Query       ContributionQuery    `json:"query"`
	Timezone    string               `json:"timezone"`
	GeneratedAt time.Time            `json:"generated_at"`
	Coverage    ContributionCoverage `json:"coverage"`
	Summary     *ContributionSummary `json:"summary,omitempty"`
	Items       any                  `json:"items,omitempty"`
	Total       int                  `json:"total"`
}

type ContributionStore interface {
	ContributionData(context.Context, ContributionQuery) ([]ContributionRecord, []ContributionRecord, ContributionCoverage, error)
	ContributionDetail(context.Context, string, string) (ContributionRecord, ContributionCoverage, error)
}

func NormalizeContributionQuery(query ContributionQuery, summary bool) (ContributionQuery, error) {
	location, _ := time.LoadLocation(ContributionTimezone)
	now := time.Now().In(location)
	if query.StartDate == "" && query.EndDate == "" {
		query.StartDate = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, location).Format(time.DateOnly)
		query.EndDate = now.Format(time.DateOnly)
	}
	start, firstErr := time.ParseInLocation(time.DateOnly, query.StartDate, location)
	end, lastErr := time.ParseInLocation(time.DateOnly, query.EndDate, location)
	if firstErr != nil || lastErr != nil || end.Before(start) {
		return query, ErrInvalidRequest
	}
	if summary {
		if query.Report != "" || query.Status != "" || query.MinTotalScore != nil || query.Page != 0 || query.PageSize != 0 {
			return query, ErrInvalidRequest
		}
		return query, nil
	}
	if query.Report == "" {
		query.Report = "uploads"
	}
	if query.Report != "uploads" && query.Report != "first_approvals" && query.Report != "employees" {
		return query, ErrInvalidRequest
	}
	if query.Report == "employees" && (query.Status != "" || query.MinTotalScore != nil) {
		return query, ErrInvalidRequest
	}
	if query.Status != "" && query.Status != "pending" && query.Status != "approved" && query.Status != "rejected" {
		return query, ErrInvalidRequest
	}
	if query.MinTotalScore != nil && (math.IsNaN(*query.MinTotalScore) || math.IsInf(*query.MinTotalScore, 0) || *query.MinTotalScore < 0 || *query.MinTotalScore > 20) {
		return query, ErrInvalidRequest
	}
	if query.Page == 0 {
		query.Page = 1
	}
	if query.PageSize == 0 {
		query.PageSize = 50
	}
	if query.Page < 1 || query.Page > 1000000 || query.PageSize < 1 || query.PageSize > 100 {
		return query, ErrInvalidRequest
	}
	return query, nil
}

func contributionBounds(query ContributionQuery) (time.Time, time.Time) {
	location, _ := time.LoadLocation(ContributionTimezone)
	start, _ := time.ParseInLocation(time.DateOnly, query.StartDate, location)
	end, _ := time.ParseInLocation(time.DateOnly, query.EndDate, location)
	return start, end.AddDate(0, 0, 1)
}

func (s *Service) Contributions(ctx context.Context, query ContributionQuery, summary, export bool) (ContributionResponse, error) {
	if export && (query.Page != 0 || query.PageSize != 0) {
		return ContributionResponse{}, ErrInvalidRequest
	}
	query, err := NormalizeContributionQuery(query, summary)
	if err != nil {
		return ContributionResponse{}, err
	}
	store, ok := s.store.(ContributionStore)
	if !ok {
		return ContributionResponse{}, ErrInvalidRequest
	}
	uploads, approvals, coverage, err := store.ContributionData(ctx, query)
	if err != nil {
		return ContributionResponse{}, err
	}
	response := ContributionResponse{Query: query, Timezone: ContributionTimezone, GeneratedAt: s.clock().UTC(), Coverage: coverage}
	employees := map[string]*ContributionEmployee{}
	for _, row := range uploads {
		if employees[row.EmployeeID] == nil {
			employees[row.EmployeeID] = &ContributionEmployee{EmployeeID: row.EmployeeID, EmployeeName: row.EmployeeName}
		}
		employees[row.EmployeeID].Uploads++
	}
	var sum float64
	scored := 0
	for _, row := range approvals {
		if employees[row.EmployeeID] == nil {
			employees[row.EmployeeID] = &ContributionEmployee{EmployeeID: row.EmployeeID, EmployeeName: row.EmployeeName}
		}
		employee := employees[row.EmployeeID]
		employee.FirstApprovals++
		if row.Scores != nil {
			if employee.AverageScore == nil {
				employee.AverageScore = new(float64)
			}
			*employee.AverageScore += row.Scores.Total
			employee.ScoredCount++
			sum += row.Scores.Total
			scored++
		}
	}
	if summary {
		response.Summary = &ContributionSummary{Uploads: len(uploads), FirstApprovals: len(approvals), Contributors: len(employees), ScoredCount: scored}
		if scored > 0 {
			average := sum / float64(scored)
			response.Summary.AverageScore = &average
		}
		return response, nil
	}
	if query.Report == "employees" {
		items := []ContributionEmployee{}
		for _, employee := range employees {
			if employee.ScoredCount > 0 {
				*employee.AverageScore /= float64(employee.ScoredCount)
			}
			items = append(items, *employee)
		}
		sort.Slice(items, func(first, second int) bool { return items[first].EmployeeID < items[second].EmployeeID })
		response.Total = len(items)
		if export && len(items) > 10000 {
			return response, ErrContributionLimit
		}
		start, end := contributionPage(len(items), query, export)
		response.Items = items[start:end]
	} else {
		items := []ContributionRecord{}
		rows := uploads
		if query.Report == "first_approvals" {
			rows = approvals
		}
		for _, row := range rows {
			if query.Status != "" && (row.Status == nil || *row.Status != query.Status) {
				continue
			}
			if query.MinTotalScore != nil && (row.Scores == nil || row.Scores.Total < *query.MinTotalScore) {
				continue
			}
			items = append(items, row)
		}
		sort.Slice(items, func(first, second int) bool {
			if items[first].OccurredAt.Equal(items[second].OccurredAt) {
				return items[first].ID > items[second].ID
			}
			return items[first].OccurredAt.After(items[second].OccurredAt)
		})
		response.Total = len(items)
		if export && len(items) > 10000 {
			return response, ErrContributionLimit
		}
		start, end := contributionPage(len(items), query, export)
		response.Items = items[start:end]
	}
	return response, nil
}

func contributionPage(count int, query ContributionQuery, export bool) (int, int) {
	if export {
		return 0, count
	}
	start := min((query.Page-1)*query.PageSize, count)
	return start, min(start+query.PageSize, count)
}

func (s *Service) ContributionDetail(ctx context.Context, skillID, versionID string) (ContributionResponse, error) {
	if (skillID == "") == (versionID == "") {
		return ContributionResponse{}, ErrInvalidRequest
	}
	store, ok := s.store.(ContributionStore)
	if !ok {
		return ContributionResponse{}, ErrInvalidRequest
	}
	row, coverage, err := store.ContributionDetail(ctx, skillID, versionID)
	if err != nil {
		return ContributionResponse{}, err
	}
	return ContributionResponse{Timezone: ContributionTimezone, GeneratedAt: s.clock().UTC(), Coverage: coverage, Items: []ContributionRecord{row}, Total: 1}, nil
}

func ContributionCSV(response ContributionResponse) ([]byte, error) {
	buffer := bytes.NewBuffer([]byte{0xef, 0xbb, 0xbf})
	writer := csv.NewWriter(buffer)
	metadata := []string{"统计开始日", "统计结束日", "时区", "生成时间", "历史确认状态"}
	stamp := []string{response.Query.StartDate, response.Query.EndDate, response.Timezone, response.GeneratedAt.Format(time.RFC3339)}
	if response.Query.Report == "employees" {
		writer.Write(append([]string{"员工ID", "员工姓名", "上传数", "首次通过数", "有效评分条数", "平均分"}, metadata...))
		for _, row := range response.Items.([]ContributionEmployee) {
			writer.Write(append(append([]string{csvText(row.EmployeeID), csvText(row.EmployeeName), strconv.Itoa(row.Uploads), strconv.Itoa(row.FirstApprovals), strconv.Itoa(row.ScoredCount), csvNumber(row.AverageScore)}, stamp...), response.Coverage.Notice))
		}
	} else {
		writer.Write(append([]string{"员工ID", "员工姓名", "Skill ID", "Skill名称", "版本ID", "版本", "空间ID", "来源", "审核ID", "上传或首次通过时间", "审核状态", "场景价值", "结果有效性", "使用便利性", "复用价值", "总分", "审核意见", "实体可用"}, metadata...))
		for _, row := range response.Items.([]ContributionRecord) {
			scores := []string{"", "", "", "", ""}
			if row.Scores != nil {
				scores = []string{fmt.Sprintf("%.2f", row.Scores.ScenarioValue), fmt.Sprintf("%.2f", row.Scores.ResultEffectiveness), fmt.Sprintf("%.2f", row.Scores.EaseOfUse), fmt.Sprintf("%.2f", row.Scores.ReuseValue), fmt.Sprintf("%.2f", row.Scores.Total)}
			}
			comments := []string{}
			for _, approver := range row.Approvers {
				comments = append(comments, approver.Name+" ("+approver.UserID+"): "+approver.Comment)
			}
			fields := []string{csvText(row.EmployeeID), csvText(row.EmployeeName), csvText(row.SkillID), csvText(row.SkillName), csvText(row.VersionID), csvText(pointerString(row.Version)), csvText(row.SpaceID), csvText(row.Source), csvText(pointerString(row.ApprovalID)), row.OccurredAt.Format(time.RFC3339), pointerString(row.Status)}
			fields = append(fields, scores...)
			fields = append(fields, csvText(strings.Join(comments, "\n")), strconv.FormatBool(row.EntityAvailable))
			writer.Write(append(append(fields, stamp...), row.HistoryStatus))
		}
	}
	writer.Flush()
	return buffer.Bytes(), writer.Error()
}

func csvText(value string) string {
	trimmed := strings.TrimLeft(value, " \t\r\n")
	if trimmed != "" && strings.ContainsRune("=+-@", rune(trimmed[0])) || strings.HasPrefix(value, "\t") || strings.HasPrefix(value, "\r") || strings.HasPrefix(value, "\n") {
		return "'" + value
	}
	return value
}
func csvNumber(value *float64) string {
	if value == nil {
		return ""
	}
	return fmt.Sprintf("%.2f", *value)
}
func pointerString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func firstApprovalRecord(skill Skill, version Version, source, approvalID string, progress *LocalApproval, now time.Time) ContributionRecord {
	status := "approved"
	row := ContributionRecord{ID: skill.SkillID, EmployeeID: version.UploadedByUserID, EmployeeName: version.UploadedByName, SkillID: skill.SkillID, SkillName: skill.Name, VersionID: version.VersionID, Version: &version.Version, SpaceID: skill.SpaceID, Source: source, ApprovalID: &approvalID, OccurredAt: now, Status: &status, Approvers: []ApprovalDecision{}, EntityAvailable: true, HistoryStatus: "confirmed"}
	if progress != nil {
		row.Scores = progress.ScoreSummary
		row.Approvers = progress.Approvers
		row.ScoringStandardVersion = &progress.ScoringStandardVersion
	}
	return row
}
