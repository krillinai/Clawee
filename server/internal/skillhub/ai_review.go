package skillhub

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrAIReviewRequired = errors.New("skill AI review required")
var ErrAIReviewFailed = errors.New("skill AI review failed")

const AIReviewFailure = "AI 审核未完成，请重试或明确转人工审核"
const AIReviewTimeout = "AI 审核超时，请重试或明确转人工审核"
const AIReviewMaterialsFailure = "审核材料无法安全读取或超过限制，请转人工审核"
const AIReviewReportFailure = "AI 审核报告无效，请重试或明确转人工审核"

type AIReviewConfig struct {
	Enabled bool   `json:"enabled"`
	AgentID string `json:"agent_id"`
}

type AIReviewFinding struct {
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Path     string `json:"path,omitempty"`
}

type AIReviewReport struct {
	Conclusion      string            `json:"conclusion"`
	Summary         string            `json:"summary"`
	Findings        []AIReviewFinding `json:"findings"`
	SuggestedScores *ReviewScores     `json:"suggested_scores,omitempty"`
}

type AIReviewAttempt struct {
	AttemptID     string          `json:"attempt_id"`
	AgentID       string          `json:"agent_id"`
	Status        string          `json:"status"`
	Report        *AIReviewReport `json:"report,omitempty"`
	Error         string          `json:"error,omitempty"`
	CreatedAt     time.Time       `json:"created_at"`
	UpdatedAt     time.Time       `json:"updated_at"`
	StartedAt     *time.Time      `json:"started_at,omitempty"`
	ManualBy      string          `json:"manual_by,omitempty"`
	ManualAt      *time.Time      `json:"manual_at,omitempty"`
	ManualComment string          `json:"manual_comment,omitempty"`
}

type AIReview struct {
	AIReviewAttempt
	Attempts []AIReviewAttempt `json:"attempts,omitempty"`
}

type AIReviewTask struct {
	RequestID     string             `json:"request_id"`
	AttemptID     string             `json:"attempt_id"`
	SkillID       string             `json:"skill_id"`
	VersionID     string             `json:"version_id"`
	PackageSHA256 string             `json:"package_sha256"`
	Materials     *AIReviewMaterials `json:"materials,omitempty"`
}

type AIReviewMaterials struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Files       []AIReviewMaterialFile `json:"files"`
}

type AIReviewMaterialFile struct {
	Path          string  `json:"path"`
	Content       *string `json:"content,omitempty"`
	OmittedReason string  `json:"omitted_reason,omitempty"`
}

type AIReviewResultInput struct {
	AttemptID     string          `json:"attempt_id"`
	PackageSHA256 string          `json:"package_sha256"`
	Report        json.RawMessage `json:"report,omitempty"`
	Error         *string         `json:"error,omitempty"`
}

type AIReviewIdentityLookup func(context.Context, string, string) error

type aiReviewState struct {
	Skill   Skill
	Version Version
	Request localRequest
}

type aiReviewStore interface {
	GetAIReviewConfig(context.Context, string) (AIReviewConfig, error)
	SetAIReviewConfig(context.Context, string, AIReviewConfig, string, time.Time) (AIReviewConfig, error)
	listAIReviewRequests(context.Context, string) ([]string, error)
	withAIReview(context.Context, string, string, bool, time.Time, func(*aiReviewState) error) error
}

func newAIAttempt(agent string, now time.Time) AIReviewAttempt {
	return AIReviewAttempt{AttemptID: newID("ai_attempt"), AgentID: agent, Status: "pending", CreatedAt: now.UTC(), UpdatedAt: now.UTC()}
}

func expireAIAttempts(attempts []AIReviewAttempt, now time.Time) {
	if len(attempts) == 0 {
		return
	}
	current := &attempts[len(attempts)-1]
	if current.Status == "running" && current.StartedAt != nil && !now.Before(current.StartedAt.Add(15*time.Minute)) {
		current.Status, current.Error, current.UpdatedAt = "failed", AIReviewTimeout, now.UTC()
	}
}

func aiProgress(attempts []AIReviewAttempt, now time.Time) *AIReview {
	expireAIAttempts(attempts, now)
	if len(attempts) == 0 {
		return nil
	}
	data, _ := json.Marshal(attempts)
	var copied []AIReviewAttempt
	_ = json.Unmarshal(data, &copied)
	return &AIReview{AIReviewAttempt: copied[len(copied)-1], Attempts: copied}
}

func aiAllowsHuman(attempts []AIReviewAttempt, now time.Time) bool {
	expireAIAttempts(attempts, now)
	return len(attempts) == 0 || attempts[len(attempts)-1].Status == "completed" || attempts[len(attempts)-1].Status == "manual"
}

func (s *Service) SetAIReviewIdentityLookup(lookup AIReviewIdentityLookup) {
	if store, ok := s.store.(*MemoryStore); ok {
		store.mu.Lock()
		defer store.mu.Unlock()
		store.aiIdentityLookup = lookup
	}
}

func (s *Service) GetAIReviewConfig(ctx context.Context, space string) (AIReviewConfig, error) {
	store, ok := s.store.(aiReviewStore)
	if !ok {
		return AIReviewConfig{}, ErrInvalidRequest
	}
	return store.GetAIReviewConfig(ctx, space)
}

func (s *Service) SetAIReviewConfig(ctx context.Context, space string, config AIReviewConfig, user string) (AIReviewConfig, error) {
	store, ok := s.store.(aiReviewStore)
	if !ok || user == "" || config.Enabled && (config.AgentID == "" || len(config.AgentID) > 256 || config.AgentID != strings.TrimSpace(config.AgentID)) || !config.Enabled && config.AgentID != "" {
		return AIReviewConfig{}, ErrInvalidRequest
	}
	return store.SetAIReviewConfig(ctx, space, config, user, s.clock().UTC())
}

func aiTask(state *aiReviewState) AIReviewTask {
	current := state.Request.AIAttempts[len(state.Request.AIAttempts)-1]
	return AIReviewTask{RequestID: state.Request.ID, AttemptID: current.AttemptID, SkillID: state.Skill.SkillID, VersionID: state.Version.VersionID, PackageSHA256: state.Request.Digest}
}

func (s *Service) ListAIReviewTasks(ctx context.Context, user, agent string) ([]AIReviewTask, error) {
	tasks := []AIReviewTask{}
	if agent == "" {
		return tasks, nil
	}
	store, ok := s.store.(aiReviewStore)
	if !ok {
		return nil, ErrInvalidRequest
	}
	ids, err := store.listAIReviewRequests(ctx, agent)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		err := store.withAIReview(ctx, id, user, false, s.clock().UTC(), func(state *aiReviewState) error {
			current := state.Request.AIAttempts[len(state.Request.AIAttempts)-1]
			if current.AgentID != agent || current.Status != "pending" {
				return ErrConflict
			}
			if err := s.checkAIPackageDigest(state.Version); err != nil {
				return err
			}
			tasks = append(tasks, aiTask(state))
			return nil
		})
		if err != nil && !errors.Is(err, ErrConflict) && !errors.Is(err, ErrReviewForbidden) && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
	}
	return tasks, nil
}

func (s *Service) ClaimAIReview(ctx context.Context, request, attempt, user, agent string) (AIReviewTask, error) {
	var task AIReviewTask
	store, ok := s.store.(aiReviewStore)
	if !ok || agent == "" || attempt == "" {
		return task, ErrInvalidRequest
	}
	now := s.clock().UTC()
	err := store.withAIReview(ctx, request, user, false, now, func(state *aiReviewState) error {
		current := &state.Request.AIAttempts[len(state.Request.AIAttempts)-1]
		if current.AgentID != agent || current.AttemptID != attempt || current.Status != "pending" {
			return ErrConflict
		}
		materials, err := s.aiMaterials(state.Version)
		if err != nil {
			if errors.Is(err, ErrConflict) {
				return ErrConflict
			}
			current.Status, current.Error, current.UpdatedAt = "failed", AIReviewMaterialsFailure, now
			return ErrAIReviewFailed
		}
		current.Status, current.StartedAt, current.UpdatedAt = "running", &now, now
		task = aiTask(state)
		task.Materials = materials
		return nil
	})
	return task, err
}

func (s *Service) SubmitAIReviewResult(ctx context.Context, request, user, agent string, input AIReviewResultInput) (*AIReview, error) {
	var result *AIReview
	store, ok := s.store.(aiReviewStore)
	if !ok || agent == "" || input.AttemptID == "" || input.PackageSHA256 == "" || (len(input.Report) == 0) == (input.Error == nil) {
		return nil, ErrInvalidRequest
	}
	now := s.clock().UTC()
	err := store.withAIReview(ctx, request, user, false, now, func(state *aiReviewState) error {
		current := &state.Request.AIAttempts[len(state.Request.AIAttempts)-1]
		if current.AgentID != agent || current.AttemptID != input.AttemptID || current.Status != "running" || state.Request.Digest != input.PackageSHA256 {
			return ErrConflict
		}
		materials, err := s.aiMaterials(state.Version)
		if err != nil {
			if errors.Is(err, ErrConflict) {
				return err
			}
			current.Status, current.Error, current.UpdatedAt = "failed", AIReviewMaterialsFailure, now
			result = aiProgress(state.Request.AIAttempts, now)
			return nil
		}
		current.Status, current.Error, current.UpdatedAt = "failed", AIReviewFailure, now
		if input.Error == nil {
			report, err := validateAIReport(input.Report, materials)
			if err != nil {
				current.Error = AIReviewReportFailure
			} else {
				current.Status, current.Error, current.Report = "completed", "", report
			}
		}
		result = aiProgress(state.Request.AIAttempts, now)
		return nil
	})
	return result, err
}

func (s *Service) ManageAIReview(ctx context.Context, request, attempt, user, comment string, manual bool) (*AIReview, error) {
	store, ok := s.store.(aiReviewStore)
	comment = strings.TrimSpace(comment)
	if !ok || attempt == "" || manual && (comment == "" || len(comment) > 4096) {
		return nil, ErrInvalidRequest
	}
	var result *AIReview
	now := s.clock().UTC()
	err := store.withAIReview(ctx, request, user, true, now, func(state *aiReviewState) error {
		current := &state.Request.AIAttempts[len(state.Request.AIAttempts)-1]
		if current.AttemptID != attempt || current.Status == "completed" || current.Status == "manual" {
			return ErrConflict
		}
		if err := s.checkAIPackageDigest(state.Version); err != nil {
			return err
		}
		if manual {
			current.Status, current.UpdatedAt, current.ManualBy, current.ManualAt, current.ManualComment = "manual", now, user, &now, comment
		} else {
			if current.Status == "pending" || current.Status == "running" {
				current.Status, current.Error, current.UpdatedAt = "failed", AIReviewFailure, now
			}
			next := newAIAttempt(current.AgentID, now)
			if !next.CreatedAt.After(current.CreatedAt) {
				next.CreatedAt = current.CreatedAt.Add(time.Microsecond)
			}
			state.Request.AIAttempts = append(state.Request.AIAttempts, next)
		}
		result = aiProgress(state.Request.AIAttempts, now)
		return nil
	})
	return result, err
}

func (s *Service) checkAIPackageDigest(version Version) error {
	file, _, err := s.openVersionFile(version)
	if err != nil {
		return ErrConflict
	}
	defer file.Close()
	return s.checkAIOpenFile(version, file)
}

func (s *Service) checkAIOpenFile(version Version, file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return ErrConflict
	}
	stored, err := os.Lstat(filepath.Join(s.packageRoot, version.PackagePath))
	if err != nil || !stored.Mode().IsRegular() || !os.SameFile(info, stored) {
		return ErrConflict
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, io.NewSectionReader(file, 0, info.Size())); err != nil {
		return ErrConflict
	}
	if fmt.Sprintf("%x", digest.Sum(nil)) != version.PackageSHA256 {
		return ErrConflict
	}
	return nil
}

func (s *Service) checkAIHumanDigest(ctx context.Context, skill, versionID string) error {
	detail, err := s.store.GetAdmin(ctx, skill)
	if err != nil {
		return err
	}
	for _, version := range detail.Versions {
		if version.VersionID == versionID && version.LocalApproval != nil && version.LocalApproval.AIReview != nil {
			return s.checkAIPackageDigest(version)
		}
	}
	return nil
}

func (s *Service) aiMaterials(version Version) (*AIReviewMaterials, error) {
	if err := s.checkAIPackageDigest(version); err != nil {
		return nil, err
	}
	file, archive, entries, err := s.openVersionArchive(version)
	if err != nil {
		return nil, ErrAIReviewFailed
	}
	defer file.Close()
	if err := s.checkAIOpenFile(version, file); err != nil {
		return nil, err
	}
	materials := &AIReviewMaterials{Name: version.SkillName, Description: version.Description, Files: []AIReviewMaterialFile{}}
	total := len(materials.Name) + len(materials.Description)
	if total > 512*1024 {
		return nil, ErrAIReviewFailed
	}
	for index, entry := range entries {
		if entry.logicalPath == "" {
			continue
		}
		if !safeAIPath(entry.logicalPath) {
			return nil, ErrAIReviewFailed
		}
		reader, err := archive.File[index].Open()
		if err != nil {
			return nil, ErrAIReviewFailed
		}
		content, text, readErr := readAIText(reader)
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil {
			return nil, ErrAIReviewFailed
		}
		item := AIReviewMaterialFile{Path: entry.logicalPath}
		if !text {
			item.OmittedReason = "二进制或非文本材料，未读取内容"
		} else {
			if total+len(content) > 512*1024 {
				return nil, ErrAIReviewFailed
			}
			total += len(content)
			item.Content = &content
		}
		materials.Files = append(materials.Files, item)
	}
	sort.Slice(materials.Files, func(left, right int) bool { return materials.Files[left].Path < materials.Files[right].Path })
	if err := s.checkAIOpenFile(version, file); err != nil {
		return nil, err
	}
	return materials, nil
}

func readAIText(reader io.Reader) (string, bool, error) {
	buffer := bufio.NewReader(reader)
	var content strings.Builder
	for {
		value, size, err := buffer.ReadRune()
		if errors.Is(err, io.EOF) {
			return content.String(), true, nil
		}
		if err != nil {
			return "", false, err
		}
		if value == utf8.RuneError && size == 1 || value < 0x20 && value != '\t' && value != '\n' && value != '\r' || value >= 0x7f && value <= 0x9f {
			return "", false, nil
		}
		if content.Len()+size > 128*1024 {
			return "", false, ErrAIReviewFailed
		}
		content.WriteRune(value)
	}
}

func safeAIPath(value string) bool {
	clean, err := validateEntryName(value)
	return err == nil && clean == value && !strings.ContainsRune(value, 0)
}

func validateAIReport(data []byte, materials *AIReviewMaterials) (*AIReviewReport, error) {
	if len(data) > 128*1024 {
		return nil, ErrInvalidRequest
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var report AIReviewReport
	if err := decoder.Decode(&report); err != nil {
		return nil, ErrInvalidRequest
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, ErrInvalidRequest
	}
	if report.Conclusion != "recommend_approve" && report.Conclusion != "recommend_reject" && report.Conclusion != "needs_attention" || strings.TrimSpace(report.Summary) == "" || len(report.Summary) > 8192 || report.Findings == nil || len(report.Findings) > 100 {
		return nil, ErrInvalidRequest
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, ErrInvalidRequest
	}
	if value, exists := fields["suggested_scores"]; exists && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return nil, ErrInvalidRequest
	}
	var findings []map[string]json.RawMessage
	if err := json.Unmarshal(fields["findings"], &findings); err != nil {
		return nil, ErrInvalidRequest
	}
	for _, finding := range findings {
		if value, exists := finding["path"]; exists {
			var evidencePath string
			if err := json.Unmarshal(value, &evidencePath); err != nil || !safeAIPath(evidencePath) {
				return nil, ErrInvalidRequest
			}
		}
	}
	paths := map[string]bool{}
	for _, file := range materials.Files {
		paths[file.Path] = true
	}
	for _, finding := range report.Findings {
		if finding.Severity != "info" && finding.Severity != "warning" && finding.Severity != "error" || strings.TrimSpace(finding.Message) == "" || len(finding.Message) > 4096 || finding.Path != "" && (!safeAIPath(finding.Path) || !paths[finding.Path]) {
			return nil, ErrInvalidRequest
		}
	}
	if report.SuggestedScores != nil {
		for _, score := range []*int{report.SuggestedScores.ScenarioValue, report.SuggestedScores.ResultEffectiveness, report.SuggestedScores.EaseOfUse, report.SuggestedScores.ReuseValue} {
			if score == nil || *score < 1 || *score > 5 {
				return nil, ErrInvalidRequest
			}
		}
	}
	return &report, nil
}
