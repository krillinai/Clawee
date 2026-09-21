package feedback

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/sharedfiles"
	"github.com/krillinai/Clawee/server/internal/textutil"
	_ "golang.org/x/image/webp"
)

type Actor struct {
	UserID    string `json:"user_id"`
	AgentID   string `json:"agent_id,omitempty"`
	TokenID   string `json:"token_id,omitempty"`
	RequestID string `json:"request_id,omitempty"`
}
type Authorizer func(context.Context, Actor, string) error
type Service struct {
	store     Store
	storage   sharedfiles.Storage
	authorize Authorizer
	capacity  int64
	clock     func() time.Time
}

func NewService(store Store, storage sharedfiles.Storage, authorize Authorizer, capacity int64) *Service {
	if capacity <= 0 {
		capacity = 20 << 30
	}
	return &Service{store, storage, authorize, capacity, func() time.Time { return time.Now().UTC() }}
}
func (s *Service) check(ctx context.Context, a Actor, action string) error {
	if s.authorize == nil || a.UserID == "" {
		return fail(403, "feedback_forbidden")
	}
	return s.authorize(ctx, a, action)
}
func live(r Report, now time.Time) error {
	if !now.Before(r.ExpiresAt) || r.UploadState == "expired" {
		return fail(410, "feedback_expired")
	}
	return nil
}
func readable(r Report, now time.Time) error {
	if err := live(r, now); err != nil {
		return err
	}
	if r.UploadState != "ready" || r.SecurityState != "normal" {
		return fail(409, "feedback_materials_unavailable")
	}
	return nil
}
func credential(r Report, raw, kind string, now time.Time) error {
	ok := false
	switch kind {
	case "upload":
		ok = now.Before(r.UploadExpires) && equalToken(raw, r.UploadHash)
	case "recovery":
		ok = now.Before(r.RecoveryExpires) && equalToken(raw, r.RecoveryHash)
	case "status":
		ok = equalToken(raw, r.StatusHash)
	case "progress":
		ok = (now.Before(r.UploadExpires) && equalToken(raw, r.UploadHash)) || (now.Before(r.RecoveryExpires) && equalToken(raw, r.RecoveryHash))
	}
	if !ok {
		return fail(401, "feedback_invalid_credential")
	}
	return live(r, now)
}
func progress(r Report) map[string]any {
	received := []string{}
	for _, a := range r.Artifacts {
		if a.UploadState == "received" {
			received = append(received, a.ID)
		}
	}
	return map[string]any{"report_id": r.ID, "display_number": r.DisplayNumber, "upload_state": r.UploadState, "security_state": r.SecurityState, "received_artifact_ids": received, "expires_at": r.ExpiresAt, "recovery_expires_at": r.RecoveryExpires, "status_expires_at": r.ExpiresAt, "limits": map[string]any{"max_artifact_bytes": MaxArtifactBytes, "max_report_bytes": MaxReportBytes, "max_artifacts": 256, "upload_concurrency": 2}}
}
func issue(r *Report, now time.Time) map[string]any {
	raw := token()
	r.UploadHash = Hash([]byte(raw))
	r.UploadExpires = now.Add(30 * time.Minute)
	out := progress(*r)
	out["upload_token"] = raw
	out["upload_expires_at"] = r.UploadExpires
	return out
}
func (s *Service) Create(ctx context.Context, in CreateInput, ip, deployment string) (out map[string]any, created bool, err error) {
	defer func() { observeOperation("create", err) }()
	m, total, mh, rh, err := validate(in)
	if err != nil {
		return nil, false, err
	}
	if s.storage == nil || s.storage.Probe(ctx) != nil {
		return nil, false, fail(503, "feedback_storage_unavailable")
	}
	var reserved int64
	err = s.store.Update(ctx, func(tx Transaction) error {
		now := s.clock()
		existing, e := tx.FindClient(in.ClientID)
		if e == nil {
			if existing.UploadState == "expired" {
				return fail(410, "feedback_expired")
			}
			if !equalToken(in.RecoveryToken, existing.RecoveryHash) || existing.RequestHash != rh {
				return fail(409, "feedback_create_conflict")
			}
			if e = credential(existing, in.RecoveryToken, "recovery", now); e != nil {
				return e
			}
			if existing.SubmittedAt != nil {
				out = progress(existing)
				return nil
			}
			out = issue(&existing, now)
			return tx.Save(existing)
		}
		if !errors.Is(e, ErrNotFound) {
			return e
		}
		source := ""
		if deployment != "" {
			c, e := tx.Credential(Hash([]byte(deployment)))
			if e != nil || !c.Enabled || !now.Before(c.ExpiresAt) {
				return fail(401, "feedback_invalid_deployment_credential")
			}
			source = c.SourceID
			used, e := tx.SourceReserved(source)
			if e != nil {
				return e
			}
			if total > c.CapacityBytes-used {
				return fail(429, "feedback_source_capacity_exceeded")
			}
		}
		allowed, e := tx.Rate(Hash([]byte(ip)), now, 10)
		if e != nil {
			return e
		}
		if !allowed {
			return fail(429, "feedback_rate_limited")
		}
		n, e := tx.Reserved()
		if e != nil {
			return e
		}
		if total > s.capacity-n {
			return fail(429, "feedback_capacity_exceeded")
		}
		reserved = n + total
		r := Report{ID: "fb_" + token(), ClientID: in.ClientID, Description: in.Description, OccurredAt: in.OccurredAt, ReproductionSteps: in.ReproductionSteps, SourceClaim: in.SourceClaim, TrustedSource: source, Environment: in.Environment, Manifest: in.Manifest, ManifestHash: mh, RequestHash: rh, RecoveryHash: Hash([]byte(in.RecoveryToken)), StatusHash: Hash([]byte(in.StatusToken)), CreatedAt: now, ExpiresAt: now.Add(7 * 24 * time.Hour), RecoveryExpires: now.Add(7 * 24 * time.Hour), UploadState: "uploading", SecurityState: "normal", Completeness: m.Completeness, ProcessingStatus: "open", Version: 1, ReservedBytes: total, Artifacts: []StoredArtifact{}, Events: []Event{}}
		r.DisplayNumber = "FB-" + now.Format("20060102") + "-" + strings.ToUpper(r.ID[len(r.ID)-8:])
		r.Consent, _ = json.Marshal(in.Consent)
		if suspicious([]byte(in.Description + "\n" + in.ReproductionSteps)) {
			r.SecurityState = "quarantine"
		}
		for _, a := range m.Artifacts {
			r.Artifacts = append(r.Artifacts, StoredArtifact{Artifact: a, UploadState: "declared", StorageProfileID: "feedback-local"})
		}
		out = issue(&r, now)
		created = true
		return tx.Save(r)
	})
	if err == nil && created {
		missingItems.Add(float64(len(m.MissingItems)))
		capacityRemaining.Set(float64(s.capacity - reserved))
	}
	return out, created, err
}
func (s *Service) Recover(ctx context.Context, id, raw string) (map[string]any, error) {
	var out map[string]any
	err := s.store.Update(ctx, func(tx Transaction) error {
		r, e := tx.Get(id)
		if e != nil {
			return fail(401, "feedback_invalid_credential")
		}
		if e = credential(r, raw, "recovery", s.clock()); e != nil {
			return e
		}
		if r.SubmittedAt != nil {
			out = progress(r)
			return nil
		}
		if r.UploadState != "uploading" {
			return fail(409, "feedback_upload_conflict")
		}
		out = issue(&r, s.clock())
		return tx.Save(r)
	})
	return out, err
}
func (s *Service) Progress(ctx context.Context, id, raw string) (map[string]any, error) {
	var out map[string]any
	err := s.store.View(ctx, func(tx ReadTransaction) error {
		r, e := tx.Get(id)
		if e != nil {
			return fail(401, "feedback_invalid_credential")
		}
		if e = credential(r, raw, "progress", s.clock()); e != nil {
			return e
		}
		out = progress(r)
		return nil
	})
	return out, err
}
func (s *Service) Status(ctx context.Context, id, raw string) (map[string]any, error) {
	var out map[string]any
	err := s.store.View(ctx, func(tx ReadTransaction) error {
		r, e := tx.Get(id)
		if e != nil {
			return fail(401, "feedback_invalid_credential")
		}
		if e = credential(r, raw, "status", s.clock()); e != nil {
			return e
		}
		out = map[string]any{"report_id": r.ID, "upload_state": r.UploadState, "processing_status": r.ProcessingStatus, "public_resolution_summary": r.PublicResolutionSummary}
		return nil
	})
	return out, err
}
func (s *Service) Upload(ctx context.Context, id, aid, raw, ctype, digest string, size int64, src io.Reader) (received bool, err error) {
	defer func() {
		observeOperation("upload", err)
		if err == nil && received {
			uploadedBytes.Add(float64(size))
		}
	}()
	if !IDPattern.MatchString(id) || !IDPattern.MatchString(aid) {
		return false, ErrNotFound
	}
	lease := token()
	prefix := "space_feedback/file_" + Hash([]byte(id+":"+aid))
	key := prefix + "/blob_" + lease
	task := CleanupTask{Key: key, ReportID: id, Reason: "upload_compensation", NextAttempt: s.clock().Add(15 * time.Minute)}
	var art Artifact
	already := false
	err = s.store.Update(ctx, func(tx Transaction) error {
		r, e := tx.Get(id)
		if e != nil {
			return fail(401, "feedback_invalid_credential")
		}
		if e = credential(r, raw, "upload", s.clock()); e != nil {
			return e
		}
		if r.UploadState != "uploading" || r.SubmittedAt != nil {
			return fail(409, "feedback_upload_conflict")
		}
		index := -1
		active := 0
		for i, a := range r.Artifacts {
			if a.UploadState == "uploading" && s.clock().Before(a.LeaseExpires) {
				active++
			}
			if a.ID == aid {
				index = i
			}
		}
		if index < 0 {
			return ErrNotFound
		}
		a := &r.Artifacts[index]
		if size != a.Size || ctype != a.ContentType || digest != a.SHA256 {
			return fail(409, "feedback_artifact_mismatch")
		}
		if a.UploadState == "received" {
			already = true
			return nil
		}
		pending, e := tx.PendingObject(prefix)
		if e != nil {
			return e
		}
		if pending {
			return fail(503, "feedback_cleanup_pending")
		}
		if (a.UploadState == "uploading" && s.clock().Before(a.LeaseExpires)) || active >= 2 {
			return fail(409, "feedback_upload_in_progress")
		}
		a.UploadState = "uploading"
		a.UploadLease = lease
		a.LeaseExpires = s.clock().Add(5 * time.Minute)
		art = a.Artifact
		if e = tx.AddCleanup(task); e != nil {
			return e
		}
		return tx.Save(r)
	})
	if err != nil || already {
		return false, err
	}
	// HTTP 正文与解码在事务外执行，慢客户端不持有模块数据库锁。
	uploadCtx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	meta, err := s.storage.Put(uploadCtx, key, src, sharedfiles.PutOptions{DeclaredSize: art.Size, MaxBytes: art.Size, ContentType: art.ContentType})
	if err != nil {
		if errors.Is(err, sharedfiles.ErrFileTooLarge) || errors.Is(err, sharedfiles.ErrContentLengthMismatch) {
			err = fail(413, "feedback_upload_invalid")
		} else {
			err = fail(503, "feedback_storage_unavailable")
		}
	}
	if err == nil && (meta.SizeBytes != art.Size || meta.SHA256 != art.SHA256) {
		err = fail(409, "feedback_artifact_mismatch")
	}
	quarantined := false
	if err == nil {
		quarantined, err = s.validateObject(uploadCtx, key, art)
	}
	if err != nil {
		repairCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		deleted := s.storage.Delete(repairCtx, key) == nil
		_ = s.store.Update(repairCtx, func(tx Transaction) error {
			r, e := tx.Get(id)
			if e != nil {
				return e
			}
			for i := range r.Artifacts {
				a := &r.Artifacts[i]
				if a.ID == aid && a.UploadLease == lease {
					a.UploadState = "declared"
					a.UploadLease = ""
				}
			}
			if e = tx.Save(r); e != nil {
				return e
			}
			if deleted {
				return tx.FinishCleanup(task, true)
			}
			return nil
		})
		return false, err
	}
	err = s.store.Update(ctx, func(tx Transaction) error {
		r, e := tx.Get(id)
		if e != nil {
			return e
		}
		if e = live(r, s.clock()); e != nil {
			return e
		}
		if r.UploadState != "uploading" {
			return fail(409, "feedback_upload_conflict")
		}
		for i := range r.Artifacts {
			a := &r.Artifacts[i]
			if a.ID == aid && a.UploadLease == lease {
				now := s.clock()
				a.UploadState = "received"
				a.StorageKey = key
				a.UploadedAt = &now
				a.UploadLease = ""
				if quarantined {
					r.SecurityState = "quarantine"
				}
				if e = tx.Save(r); e != nil {
					return e
				}
				return tx.FinishCleanup(task, true)
			}
		}
		return fail(409, "feedback_upload_conflict")
	})
	return err == nil, err
}

var secretPattern = regexp.MustCompile(`(?i)(\bsk-[a-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:authorization|cookie|password|passwd|api[_ -]?key|access[_ -]?token|secret|x-feedback-deployment-token)["\s]*[:=]["\s]*(?:bearer\s+)?[a-z0-9_/-]{8,})`)

func suspicious(b []byte) bool { return secretPattern.Match(b) }
func (s *Service) validateObject(ctx context.Context, key string, a Artifact) (bool, error) {
	f, e := s.storage.Open(ctx, key)
	if e != nil {
		return false, fail(503, "feedback_storage_unavailable")
	}
	defer f.Close()
	if a.Kind == "screenshot" {
		cfg, format, e := image.DecodeConfig(f)
		if e != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > 25000000 || "image/"+format != a.ContentType {
			return false, fail(400, "feedback_invalid_image")
		}
		_ = f.Close()
		f, e = s.storage.Open(ctx, key)
		if e != nil {
			return false, e
		}
		defer f.Close()
		if _, _, e = image.Decode(f); e != nil {
			return false, fail(400, "feedback_invalid_image")
		}
		return false, nil
	}
	reader := bufio.NewScanner(f)
	reader.Buffer(make([]byte, 4096), int(MaxArtifactBytes)+1)
	var count int64
	quarantine := false
	for reader.Scan() {
		b := reader.Bytes()
		if len(b) == 0 {
			return false, fail(400, "feedback_invalid_ndjson")
		}
		if _, e = CanonicalHash(b); e != nil {
			return false, fail(400, "feedback_invalid_ndjson")
		}
		quarantine = quarantine || suspicious(b)
		count++
	}
	if reader.Err() != nil || count != a.RecordCount {
		return false, fail(409, "feedback_record_count_mismatch")
	}
	return quarantine, nil
}
func (s *Service) Submit(ctx context.Context, id, raw, mh string, partial bool) (out map[string]any, err error) {
	defer func() { observeOperation("submit", err) }()
	err = s.store.Update(ctx, func(tx Transaction) error {
		r, e := tx.Get(id)
		if e != nil {
			return fail(401, "feedback_invalid_credential")
		}
		if e = credential(r, raw, "upload", s.clock()); e != nil {
			return e
		}
		if mh != r.ManifestHash {
			return fail(409, "feedback_manifest_mismatch")
		}
		if r.Completeness == "partial" && !partial {
			return fail(409, "feedback_partial_consent_required")
		}
		if r.SubmittedAt != nil {
			out = progress(r)
			return nil
		}
		if r.UploadState != "uploading" {
			return fail(409, "feedback_upload_conflict")
		}
		for _, a := range r.Artifacts {
			if a.UploadState != "received" {
				return fail(409, "feedback_artifacts_missing")
			}
		}
		now := s.clock()
		r.SubmittedAt = &now
		r.ExpiresAt = now.Add(30 * 24 * time.Hour)
		r.UploadState = "ready"
		if e = tx.Save(r); e != nil {
			return e
		}
		out = progress(r)
		return nil
	})
	return out, err
}
func publicReport(r Report) map[string]any {
	out := map[string]any{"report_id": r.ID, "display_number": r.DisplayNumber, "description": r.Description, "occurred_at": r.OccurredAt, "reproduction_steps": r.ReproductionSteps, "source_claim": r.SourceClaim, "trusted_source": r.TrustedSource, "environment": r.Environment, "created_at": r.CreatedAt, "expires_at": r.ExpiresAt, "upload_state": r.UploadState, "security_state": r.SecurityState, "completeness": r.Completeness, "processing_status": r.ProcessingStatus, "version": r.Version, "assigned_to": r.AssignedTo, "resolved_at": r.ResolvedAt, "resolved_by": r.ResolvedBy, "public_resolution_summary": r.PublicResolutionSummary}
	if r.SecurityState == "normal" && time.Now().Before(r.ExpiresAt) {
		arts := []any{}
		for _, a := range r.Artifacts {
			arts = append(arts, map[string]any{"artifact_id": a.ID, "kind": a.Kind, "name": a.Name, "content_type": a.ContentType, "size_bytes": a.Size, "sha256": a.SHA256, "record_count": a.RecordCount, "source": a.Source, "part_index": a.PartIndex, "upload_state": a.UploadState})
		}
		out["manifest"] = r.Manifest
		out["artifacts"] = arts
		out["events"] = r.Events
	} else {
		delete(out, "description")
		delete(out, "reproduction_steps")
	}
	return out
}
func (s *Service) Get(ctx context.Context, a Actor, id string) (map[string]any, error) {
	if e := s.check(ctx, a, "read"); e != nil {
		return nil, e
	}
	var out map[string]any
	err := s.store.View(ctx, func(tx ReadTransaction) error {
		r, e := tx.Get(id)
		if e != nil {
			return e
		}
		out = publicReport(r)
		return nil
	})
	return out, err
}
func (s *Service) List(ctx context.Context, a Actor, f Filter) ([]map[string]any, string, error) {
	f.Keyword = textutil.TrimInput(f.Keyword)
	f.Source = textutil.TrimInput(f.Source)
	f.Version = textutil.TrimInput(f.Version)
	if e := s.check(ctx, a, "read"); e != nil {
		return nil, "", e
	}
	if f.Limit < 1 {
		f.Limit = 30
	}
	if f.Limit > 100 {
		f.Limit = 100
	}
	limit := f.Limit
	f.Limit++
	for _, v := range []string{f.From, f.To} {
		if v != "" {
			if _, e := time.Parse(time.RFC3339Nano, v); e != nil {
				return nil, "", fail(400, "feedback_invalid_filter")
			}
		}
	}
	var reports []Report
	err := s.store.View(ctx, func(tx ReadTransaction) error { var e error; reports, e = tx.List(f); return e })
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(reports) > limit {
		reports = reports[:limit]
		last := reports[len(reports)-1]
		next = last.CreatedAt.Format(time.RFC3339Nano) + "|" + last.ID
	}
	out := []map[string]any{}
	bytes := 0
	for _, r := range reports {
		v := publicReport(r)
		delete(v, "manifest")
		delete(v, "artifacts")
		delete(v, "events")
		delete(v, "reproduction_steps")
		delete(v, "public_resolution_summary")
		v["environment"] = map[string]string{"app_version": r.Environment["app_version"]}
		description := []rune(r.Description)
		if _, visible := v["description"]; visible && len(description) > 256 {
			v["description"] = string(description[:256])
			v["description_truncated"] = true
		}
		encoded, _ := json.Marshal(v)
		if len(out) > 0 && bytes+len(encoded) > 200<<10 {
			last := reports[len(out)-1]
			next = last.CreatedAt.Format(time.RFC3339Nano) + "|" + last.ID
			break
		}
		bytes += len(encoded)
		out = append(out, v)
	}
	return out, next, nil
}

type OperationInput struct {
	ExpectedVersion         int    `json:"expected_version"`
	IdempotencyKey          string `json:"idempotency_key"`
	ResolutionSummary       string `json:"resolution_summary"`
	Verification            string `json:"verification"`
	PublicResolutionSummary string `json:"public_resolution_summary"`
	FixCommit               string `json:"fix_commit"`
	FixedVersion            string `json:"fixed_version"`
	Reason                  string `json:"reason"`
}

func eventResult(id string, e Event) map[string]any {
	return map[string]any{"report_id": id, "processing_status": e.AfterStatus, "version": e.VersionAfter, "resolved_at": e.CreatedAt, "actor": e.Actor}
}
func (s *Service) Operate(ctx context.Context, a Actor, id, op string, in OperationInput) (out map[string]any, err error) {
	in.ResolutionSummary = textutil.TrimInput(in.ResolutionSummary)
	in.Verification = textutil.TrimInput(in.Verification)
	in.PublicResolutionSummary = textutil.TrimInput(in.PublicResolutionSummary)
	in.FixCommit = textutil.CleanInputIdentifier(in.FixCommit)
	in.FixedVersion = textutil.CleanInputIdentifier(in.FixedVersion)
	in.Reason = textutil.TrimInput(in.Reason)
	if op != "investigate" && op != "resolve" && op != "reopen" {
		return nil, fail(400, "feedback_invalid_operation")
	}
	defer func() { observeOperation(op, err) }()
	if e := s.check(ctx, a, op); e != nil {
		return nil, e
	}
	if !IDPattern.MatchString(in.IdempotencyKey) || in.ExpectedVersion < 1 || len(in.ResolutionSummary) > 10000 || len(in.Verification) > 10000 || len(in.PublicResolutionSummary) > 10000 || len(in.Reason) > 10000 || len(in.FixCommit) > 128 || len(in.FixedVersion) > 128 || (op == "resolve" && (strings.TrimSpace(in.ResolutionSummary) == "" || strings.TrimSpace(in.Verification) == "")) || (op == "reopen" && strings.TrimSpace(in.Reason) == "") {
		return nil, fail(400, "feedback_invalid_operation")
	}
	b, _ := json.Marshal(in)
	rh, _ := CanonicalHash(b)
	err = s.store.Update(ctx, func(tx Transaction) error {
		r, e := tx.Get(id)
		if e != nil {
			return e
		}
		if e = readable(r, s.clock()); e != nil {
			return e
		}
		for _, event := range r.Events {
			if event.Actor.UserID == a.UserID && event.Operation == op && event.Input.IdempotencyKey == in.IdempotencyKey {
				if event.RequestHash != rh {
					return fail(409, "feedback_idempotency_conflict")
				}
				out = eventResult(id, event)
				return nil
			}
		}
		if r.Version != in.ExpectedVersion {
			return fail(409, "feedback_version_conflict")
		}
		before := r.ProcessingStatus
		now := s.clock()
		switch op {
		case "investigate":
			if before != "open" {
				return fail(409, "feedback_state_conflict")
			}
			r.ProcessingStatus = "investigating"
			r.AssignedTo = a.UserID
		case "resolve":
			if before != "open" && before != "investigating" {
				return fail(409, "feedback_state_conflict")
			}
			r.ProcessingStatus = "resolved"
			r.ResolvedAt = &now
			r.ResolvedBy = a.UserID
			r.PublicResolutionSummary = in.PublicResolutionSummary
		case "reopen":
			if before != "resolved" {
				return fail(409, "feedback_state_conflict")
			}
			r.ProcessingStatus = "open"
			r.ResolvedAt = nil
			r.ResolvedBy = ""
			r.AssignedTo = ""
			r.PublicResolutionSummary = ""
		}
		event := Event{ID: "fbe_" + token(), Operation: op, BeforeStatus: before, AfterStatus: r.ProcessingStatus, VersionBefore: r.Version, VersionAfter: r.Version + 1, Actor: a, CreatedAt: now, Input: in, RequestHash: rh}
		r.Version++
		r.Events = append(r.Events, event)
		if e = tx.Save(r); e != nil {
			return e
		}
		out = eventResult(id, event)
		return nil
	})
	return out, err
}
func (s *Service) Open(ctx context.Context, a Actor, id, aid string, download bool) (io.ReadCloser, Artifact, error) {
	if e := s.check(ctx, a, "read"); e != nil {
		return nil, Artifact{}, e
	}
	if download {
		if e := s.check(ctx, a, "download"); e != nil {
			return nil, Artifact{}, e
		}
	}
	var art StoredArtifact
	err := s.store.View(ctx, func(tx ReadTransaction) error {
		r, e := tx.Get(id)
		if e != nil {
			return e
		}
		if e = readable(r, s.clock()); e != nil {
			return e
		}
		for _, v := range r.Artifacts {
			if v.ID == aid {
				art = v
				return nil
			}
		}
		return ErrNotFound
	})
	if err != nil {
		return nil, Artifact{}, err
	}
	f, e := s.storage.Open(ctx, art.StorageKey)
	return f, art.Artifact, e
}
func (s *Service) Cleanup(ctx context.Context) (err error) {
	defer func() { observeOperation("cleanup", err) }()
	now := s.clock()
	if storage, ok := s.storage.(interface{ CleanStaleTemp(time.Time) error }); ok {
		if e := storage.CleanStaleTemp(now); e != nil {
			return e
		}
	}
	err = s.store.Update(ctx, func(tx Transaction) error {
		reports, e := tx.Expired(now)
		if e != nil {
			return e
		}
		for _, r := range reports {
			if r.UploadState == "expired" {
				if e = tx.Delete(r.ID); e != nil {
					return e
				}
				continue
			}
			if now.Before(r.ExpiresAt) || r.UploadState == "expired" {
				continue
			}
			for _, a := range r.Artifacts {
				if a.StorageKey != "" {
					if e = tx.AddCleanup(CleanupTask{Key: a.StorageKey, ReportID: r.ID, Reason: "expired"}); e != nil {
						return e
					}
				}
			}
			r.UploadState = "expired"
			r.RecoveryHash = ""
			r.StatusHash = ""
			r.UploadHash = ""
			r.Description = ""
			r.ReproductionSteps = ""
			r.SourceClaim = nil
			r.TrustedSource = ""
			r.Environment = nil
			r.Manifest = nil
			r.Artifacts = nil
			r.Events = nil
			r.PublicResolutionSummary = ""
			r.OccurredAt = ""
			r.Consent = nil
			r.ClientID = Hash([]byte(r.ClientID))
			r.AssignedTo = ""
			r.ResolvedBy = ""
			tombstoneExpiry := now.Add(30 * 24 * time.Hour)
			r.TombstoneExpires = &tombstoneExpiry
			pending, e := tx.PendingCleanup(r.ID)
			if e != nil {
				return e
			}
			if !pending {
				r.ReservedBytes = 0
			}
			if e = tx.Save(r); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	var tasks []CleanupTask
	if err = s.store.Update(ctx, func(tx Transaction) error { var e error; tasks, e = tx.Cleanup(now); return e }); err != nil {
		return err
	}
	for _, t := range tasks {
		e := s.storage.Delete(ctx, t.Key)
		if err = s.store.Update(ctx, func(tx Transaction) error {
			if e2 := tx.FinishCleanup(t, e == nil); e2 != nil {
				return e2
			}
			if e == nil {
				pending, e2 := tx.PendingCleanup(t.ReportID)
				if e2 != nil {
					return e2
				}
				if pending {
					return nil
				}
				r, e2 := tx.Get(t.ReportID)
				if e2 != nil {
					return e2
				}
				if r.UploadState != "expired" {
					return nil
				}
				r.ReservedBytes = 0
				return tx.Save(r)
			}
			return nil
		}); err != nil {
			return err
		}
	}
	var reserved int64
	if err = s.store.View(ctx, func(tx ReadTransaction) error { var e error; reserved, e = tx.Reserved(); return e }); err != nil {
		return err
	}
	capacityRemaining.Set(float64(s.capacity - reserved))
	return nil
}
func (s *Service) RevokeDeploymentCredential(ctx context.Context, id string) error {
	return s.store.Update(ctx, func(tx Transaction) error { return tx.RevokeCredential(id) })
}
func (s *Service) GetReady(ctx context.Context, a Actor, id string) (out map[string]any, err error) {
	defer func() { observeOperation("get_report", err) }()
	if e := s.check(ctx, a, "read"); e != nil {
		return nil, e
	}
	e := s.store.View(ctx, func(tx ReadTransaction) error {
		r, e := tx.Get(id)
		if e != nil {
			return e
		}
		if e = readable(r, s.clock()); e != nil {
			return e
		}
		out = publicReport(r)
		return nil
	})
	return out, e
}
func (s *Service) CreateDeploymentCredential(ctx context.Context, source string, expires time.Time, quota ...int64) (DeploymentCredential, string, error) {
	raw := token()
	capacity := int64(2 << 30)
	if len(quota) > 0 {
		capacity = quota[0]
	}
	c := DeploymentCredential{ID: "fdc_" + token(), SourceID: source, TokenHash: Hash([]byte(raw)), Enabled: true, ExpiresAt: expires, CapacityBytes: capacity}
	if strings.TrimSpace(source) == "" || len(source) > 256 || capacity <= 0 || !s.clock().Before(expires) {
		return c, "", fail(400, "feedback_invalid_credential")
	}
	e := s.store.Update(ctx, func(tx Transaction) error { return tx.SaveCredential(c) })
	return c, raw, e
}
