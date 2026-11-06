package approvals

import (
	"sort"
	"strings"
	"time"
)

type Filter struct {
	View, Status, Channel                    string
	InitiatedBy, SpaceID, TemplateID, Search string
	From, Until                              *time.Time
	BeforeTime                               time.Time
	BeforeKind, BeforeID                     string
}

type Record struct {
	WorkflowStage        string    `json:"workflow_stage,omitempty"`
	CanRetryAI           bool      `json:"can_retry_ai"`
	CanSubmitReview      bool      `json:"can_submit_review"`
	Kind                 string    `json:"kind"`
	ID                   string    `json:"id"`
	Type                 string    `json:"type"`
	Title                string    `json:"title"`
	Channel              string    `json:"channel"`
	Status               string    `json:"status"`
	BusinessStatus       string    `json:"business_status"`
	InitiatedBy          string    `json:"initiated_by"`
	InitiatedName        string    `json:"initiated_name"`
	CreatedAt            time.Time `json:"created_at"`
	SpaceID              string    `json:"space_id,omitempty"`
	SpaceName            string    `json:"space_name,omitempty"`
	SkillID              string    `json:"skill_id,omitempty"`
	VersionID            string    `json:"version_id,omitempty"`
	Version              string    `json:"version,omitempty"`
	TemplateID           string    `json:"template_id,omitempty"`
	TaskID               string    `json:"task_id,omitempty"`
	CurrentNode          string    `json:"current_node,omitempty"`
	CurrentApprovers     []string  `json:"current_approvers"`
	CurrentApproverNames []string  `json:"current_approver_names"`
	ProgressCompleted    int       `json:"progress_completed"`
	ProgressTotal        int       `json:"progress_total"`
	CanProcess           bool      `json:"can_process"`
	MaterialsAvailable   bool      `json:"materials_available"`
	ContentDigest        string    `json:"content_digest,omitempty"`
}

type Summary struct {
	Total    int `json:"total"`
	Pending  int `json:"pending"`
	Running  int `json:"running"`
	Abnormal int `json:"abnormal"`
}

func (s *Summary) Add(other Summary) {
	s.Total += other.Total
	s.Pending += other.Pending
	s.Running += other.Running
	s.Abnormal += other.Abnormal
}

func (s *Summary) Count(item Record) {
	s.Total++
	switch item.Status {
	case "pending":
		s.Pending++
	case "running":
		s.Running++
	case "error":
		s.Abnormal++
	}
}

func (f Filter) Matches(item Record) bool {
	active := item.Status == "pending" || item.Status == "running"
	if (f.View == "active" && !active) || (f.View == "error" && item.Status != "error") || (f.View == "closed" && (active || item.Status == "error")) {
		return false
	}
	if f.Status != "" && f.Status != "all" && f.Status != item.Status || f.Channel != "" && f.Channel != "all" && f.Channel != item.Channel {
		return false
	}
	if f.InitiatedBy != "" && item.InitiatedBy != f.InitiatedBy || f.SpaceID != "" && item.SpaceID != f.SpaceID || f.TemplateID != "" && item.TemplateID != f.TemplateID {
		return false
	}
	if f.From != nil && item.CreatedAt.Before(*f.From) || f.Until != nil && !item.CreatedAt.Before(*f.Until) {
		return false
	}
	return strings.Contains(strings.ToLower(strings.Join([]string{item.Title, item.ID, item.Version, item.CurrentNode, item.InitiatedName, item.InitiatedBy}, " ")), strings.ToLower(f.Search))
}

func (f Filter) Before(item Record) bool {
	return f.BeforeTime.IsZero() || item.CreatedAt.Before(f.BeforeTime) || item.CreatedAt.Equal(f.BeforeTime) && (item.Kind < f.BeforeKind || item.Kind == f.BeforeKind && item.ID < f.BeforeID)
}

func Sort(items []Record) {
	sort.Slice(items, func(left, right int) bool {
		if !items[left].CreatedAt.Equal(items[right].CreatedAt) {
			return items[left].CreatedAt.After(items[right].CreatedAt)
		}
		if items[left].Kind != items[right].Kind {
			return items[left].Kind > items[right].Kind
		}
		return items[left].ID > items[right].ID
	})
}

const FilterSQL = ` WHERE ($2='all' OR ($2='active' AND status IN ('pending','running')) OR ($2='error' AND status='error') OR ($2='closed' AND status NOT IN ('pending','running','error')))
AND ($3='all' OR status=$3) AND ($4='all' OR channel=$4)
AND ($5='' OR initiated_by=$5) AND ($6='' OR space_id=$6) AND ($7='' OR template_id=$7)
AND ($8='' OR strpos(lower(title||' '||id||' '||version||' '||current_node||' '||initiated_name||' '||initiated_by),lower($8))>0)
AND ($9::timestamptz IS NULL OR created_at>=$9) AND ($10::timestamptz IS NULL OR created_at<$10)`

const PageSQL = ` AND (created_at,kind COLLATE "C",id COLLATE "C")<($11,$12::text COLLATE "C",$13::text COLLATE "C") ORDER BY created_at DESC,kind COLLATE "C" DESC,id COLLATE "C" DESC LIMIT $14`

const Columns = `kind,id,type,title,channel,status,business_status,initiated_by,initiated_name,created_at,space_id,space_name,skill_id,version_id,version,template_id,task_id,current_node,current_approvers,current_approver_names,progress_completed,progress_total,can_process,materials_available,content_digest`

const SummarySQL = `SELECT count(*),count(*) FILTER (WHERE status='pending'),count(*) FILTER (WHERE status='running'),count(*) FILTER (WHERE status='error') FROM records`

func (f Filter) Args(user string) []any {
	return []any{user, f.View, f.Status, f.Channel, f.InitiatedBy, f.SpaceID, f.TemplateID, f.Search, f.From, f.Until}
}

func (f Filter) PageArgs(user string, limit int) []any {
	at := f.BeforeTime
	if at.IsZero() {
		at = time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	return append(f.Args(user), at, f.BeforeKind, f.BeforeID, limit)
}

func Scan(row interface{ Scan(...any) error }) (Record, error) {
	var item Record
	err := row.Scan(&item.Kind, &item.ID, &item.Type, &item.Title, &item.Channel, &item.Status, &item.BusinessStatus, &item.InitiatedBy, &item.InitiatedName, &item.CreatedAt, &item.SpaceID, &item.SpaceName, &item.SkillID, &item.VersionID, &item.Version, &item.TemplateID, &item.TaskID, &item.CurrentNode, &item.CurrentApprovers, &item.CurrentApproverNames, &item.ProgressCompleted, &item.ProgressTotal, &item.CanProcess, &item.MaterialsAvailable, &item.ContentDigest)
	item.CreatedAt = item.CreatedAt.UTC()
	return item, err
}
