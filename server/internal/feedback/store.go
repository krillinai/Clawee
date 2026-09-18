package feedback

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"
)

type StoredArtifact struct {
	UploadLease  string    `json:"upload_lease,omitempty"`
	LeaseExpires time.Time `json:"lease_expires_at,omitempty"`
	Artifact
	UploadState      string     `json:"upload_state"`
	StorageKey       string     `json:"storage_key"`
	StorageProfileID string     `json:"storage_profile_id"`
	UploadedAt       *time.Time `json:"uploaded_at,omitempty"`
}
type Event struct {
	ID            string         `json:"event_id"`
	Operation     string         `json:"operation"`
	BeforeStatus  string         `json:"before_status"`
	AfterStatus   string         `json:"after_status"`
	VersionBefore int            `json:"version_before"`
	VersionAfter  int            `json:"version_after"`
	Actor         Actor          `json:"actor"`
	CreatedAt     time.Time      `json:"created_at"`
	Input         OperationInput `json:"input"`
	RequestHash   string         `json:"request_hash"`
}
type Report struct {
	Consent                 json.RawMessage   `json:"consent,omitempty"`
	TombstoneExpires        *time.Time        `json:"tombstone_expires_at,omitempty"`
	ID                      string            `json:"report_id"`
	DisplayNumber           string            `json:"display_number"`
	ClientID                string            `json:"client_feedback_id"`
	Description             string            `json:"description"`
	OccurredAt              string            `json:"occurred_at"`
	ReproductionSteps       string            `json:"reproduction_steps"`
	SourceClaim             map[string]string `json:"source_claim"`
	TrustedSource           string            `json:"trusted_source,omitempty"`
	Environment             map[string]string `json:"environment"`
	Manifest                json.RawMessage   `json:"manifest"`
	ManifestHash            string            `json:"manifest_sha256"`
	RequestHash             string            `json:"request_hash"`
	RecoveryHash            string            `json:"recovery_hash"`
	StatusHash              string            `json:"status_hash"`
	UploadHash              string            `json:"upload_hash"`
	UploadExpires           time.Time         `json:"upload_expires_at"`
	RecoveryExpires         time.Time         `json:"recovery_expires_at"`
	CreatedAt               time.Time         `json:"created_at"`
	ExpiresAt               time.Time         `json:"expires_at"`
	SubmittedAt             *time.Time        `json:"submitted_at,omitempty"`
	UploadState             string            `json:"upload_state"`
	SecurityState           string            `json:"security_state"`
	Completeness            string            `json:"completeness"`
	ProcessingStatus        string            `json:"processing_status"`
	Version                 int               `json:"version"`
	AssignedTo              string            `json:"assigned_to,omitempty"`
	ResolvedAt              *time.Time        `json:"resolved_at,omitempty"`
	ResolvedBy              string            `json:"resolved_by,omitempty"`
	PublicResolutionSummary string            `json:"public_resolution_summary,omitempty"`
	Artifacts               []StoredArtifact  `json:"artifacts"`
	Events                  []Event           `json:"events"`
	ReservedBytes           int64             `json:"reserved_bytes"`
}
type Filter struct {
	Status, Source, Version, Keyword, From, To, Cursor string
	Limit                                              int
	IncludeUnavailable                                 bool
}
type CleanupTask struct {
	Key, ReportID, Reason string
	Attempts              int
	NextAttempt           time.Time
}
type DeploymentCredential struct {
	ID, SourceID, TokenHash string
	Enabled                 bool
	ExpiresAt               time.Time
	CapacityBytes           int64
}
type ReadTransaction interface {
	Get(string) (Report, error)
	List(Filter) ([]Report, error)
	Reserved() (int64, error)
}
type Transaction interface {
	ReadTransaction
	SourceReserved(string) (int64, error)
	PendingObject(string) (bool, error)
	Expired(time.Time) ([]Report, error)
	PendingCleanup(string) (bool, error)
	Delete(string) error
	RevokeCredential(string) error
	FindClient(string) (Report, error)
	Save(Report) error
	Rate(string, time.Time, int) (bool, error)
	AddCleanup(CleanupTask) error
	Cleanup(time.Time) ([]CleanupTask, error)
	FinishCleanup(CleanupTask, bool) error
	Credential(string) (DeploymentCredential, error)
	SaveCredential(DeploymentCredential) error
}
type Store interface {
	Update(context.Context, func(Transaction) error) error
	View(context.Context, func(ReadTransaction) error) error
}
type MemoryStore struct {
	mu          sync.Mutex
	reports     map[string]Report
	tasks       map[string]CleanupTask
	credentials map[string]DeploymentCredential
	rates       map[string]rate
}
type rate struct {
	At    time.Time
	Count int
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{reports: map[string]Report{}, tasks: map[string]CleanupTask{}, credentials: map[string]DeploymentCredential{}, rates: map[string]rate{}}
}
func (s *MemoryStore) Expired(now time.Time) ([]Report, error) {
	out := []Report{}
	for _, r := range s.reports {
		if (!now.Before(r.ExpiresAt) && r.UploadState != "expired") || (r.TombstoneExpires != nil && !now.Before(*r.TombstoneExpires) && r.ReservedBytes == 0) {
			out = append(out, r)
			if len(out) == 100 {
				break
			}
		}
	}
	return out, nil
}
func (s *MemoryStore) PendingCleanup(id string) (bool, error) {
	for _, t := range s.tasks {
		if t.ReportID == id {
			return true, nil
		}
	}
	return false, nil
}
func (s *MemoryStore) PendingObject(prefix string) (bool, error) {
	for key := range s.tasks {
		if strings.HasPrefix(key, prefix+"/") {
			return true, nil
		}
	}
	return false, nil
}
func (s *MemoryStore) Delete(id string) error { delete(s.reports, id); return nil }
func (s *MemoryStore) RevokeCredential(id string) error {
	c, ok := s.credentials[id]
	if !ok {
		return ErrNotFound
	}
	c.Enabled = false
	s.credentials[id] = c
	return nil
}
func (s *MemoryStore) Update(ctx context.Context, fn func(Transaction) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	copy := NewMemoryStore()
	b, _ := json.Marshal(s.reports)
	_ = json.Unmarshal(b, &copy.reports)
	for k, v := range s.tasks {
		copy.tasks[k] = v
	}
	for k, v := range s.credentials {
		copy.credentials[k] = v
	}
	for k, v := range s.rates {
		copy.rates[k] = v
	}
	if err := fn(copy); err != nil {
		return err
	}
	s.reports = copy.reports
	s.tasks = copy.tasks
	s.credentials = copy.credentials
	s.rates = copy.rates
	return nil
}
func (s *MemoryStore) View(ctx context.Context, fn func(ReadTransaction) error) error {
	return s.Update(ctx, func(tx Transaction) error { return fn(tx) })
}
func (s *MemoryStore) Get(id string) (Report, error) {
	r, ok := s.reports[id]
	if !ok {
		return r, ErrNotFound
	}
	return r, nil
}
func (s *MemoryStore) FindClient(id string) (Report, error) {
	for _, r := range s.reports {
		if r.ClientID == id || (r.UploadState == "expired" && r.ClientID == Hash([]byte(id))) {
			return r, nil
		}
	}
	return Report{}, ErrNotFound
}
func (s *MemoryStore) Save(r Report) error { s.reports[r.ID] = r; return nil }
func (s *MemoryStore) Reserved() (int64, error) {
	var n int64
	for _, r := range s.reports {
		n += r.ReservedBytes
	}
	return n, nil
}
func (s *MemoryStore) SourceReserved(source string) (int64, error) {
	var n int64
	for _, r := range s.reports {
		if r.TrustedSource == source {
			n += r.ReservedBytes
		}
	}
	return n, nil
}
func (s *MemoryStore) List(f Filter) ([]Report, error) {
	out := []Report{}
	for _, r := range s.reports {
		if matches(r, f) {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].ID > out[j].ID
		}
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	if f.Limit > 0 && len(out) > f.Limit {
		out = out[:f.Limit]
	}
	return out, nil
}
func matches(r Report, f Filter) bool {
	if !f.IncludeUnavailable && (r.UploadState != "ready" || r.SecurityState != "normal" || !time.Now().Before(r.ExpiresAt)) {
		return false
	}
	status := f.Status
	if status == "" {
		if r.ProcessingStatus == "resolved" {
			return false
		}
	} else if status != "all" && status != r.ProcessingStatus {
		return false
	}
	if f.Source != "" && f.Source != r.TrustedSource && f.Source != r.SourceClaim["customer_label"] {
		return false
	}
	if f.Version != "" && f.Version != r.Environment["app_version"] {
		return false
	}
	if f.Keyword != "" && !strings.Contains(strings.ToLower(r.Description+" "+r.DisplayNumber), strings.ToLower(f.Keyword)) {
		return false
	}
	if f.From != "" && r.CreatedAt.Format(time.RFC3339Nano) < f.From || f.To != "" && r.CreatedAt.Format(time.RFC3339Nano) > f.To {
		return false
	}
	if f.Cursor != "" && r.CreatedAt.Format(time.RFC3339Nano)+"|"+r.ID >= f.Cursor {
		return false
	}
	return true
}
func (s *MemoryStore) Rate(key string, now time.Time, limit int) (bool, error) {
	v := s.rates[key]
	if now.Sub(v.At) >= time.Hour {
		v = rate{At: now}
	}
	v.Count++
	s.rates[key] = v
	return v.Count <= limit, nil
}
func (s *MemoryStore) AddCleanup(t CleanupTask) error { s.tasks[t.Key] = t; return nil }
func (s *MemoryStore) Cleanup(now time.Time) ([]CleanupTask, error) {
	out := []CleanupTask{}
	for _, t := range s.tasks {
		if !now.Before(t.NextAttempt) {
			out = append(out, t)
			if len(out) == 100 {
				break
			}
		}
	}
	return out, nil
}
func (s *MemoryStore) FinishCleanup(t CleanupTask, success bool) error {
	if success {
		delete(s.tasks, t.Key)
	} else {
		t.Attempts++
		t.NextAttempt = time.Now().Add(time.Minute)
		s.tasks[t.Key] = t
	}
	return nil
}
func (s *MemoryStore) Credential(hash string) (DeploymentCredential, error) {
	for _, v := range s.credentials {
		if v.TokenHash == hash {
			return v, nil
		}
	}
	return DeploymentCredential{}, ErrNotFound
}
func (s *MemoryStore) SaveCredential(c DeploymentCredential) error {
	s.credentials[c.ID] = c
	return nil
}
