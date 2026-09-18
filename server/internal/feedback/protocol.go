package feedback

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
)

type Error struct {
	Status int
	Code   string
}

func (e *Error) Error() string           { return e.Code }
func fail(status int, code string) error { return &Error{status, code} }

var ErrNotFound = fail(404, "feedback_not_found")
var IDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

const MaxArtifactBytes int64 = 16 << 20
const MaxReportBytes int64 = 200 << 20

type Artifact struct {
	ID          string `json:"artifact_id"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size_bytes"`
	SHA256      string `json:"sha256"`
	RecordCount int64  `json:"record_count"`
	Source      string `json:"source"`
	PartIndex   int    `json:"part_index"`
	FirstRecord int64  `json:"first_record,omitempty"`
	LastRecord  int64  `json:"last_record,omitempty"`
}
type Watermark struct {
	RunID           string `json:"run_id,omitempty"`
	Source          string `json:"source,omitempty"`
	MaxEventSeq     int64  `json:"max_event_seq,omitempty"`
	Size            int64  `json:"size_bytes,omitempty"`
	ExpectedCount   int64  `json:"expected_count,omitempty"`
	ExportedCount   int64  `json:"exported_count,omitempty"`
	Boundary        string `json:"boundary,omitempty"`
	SourceTruncated bool   `json:"source_truncated,omitempty"`
}
type Manifest struct {
	SchemaVersion          int         `json:"schema_version"`
	CollectionScope        string      `json:"collection_scope,omitempty"`
	SnapshotAt             string      `json:"snapshot_at"`
	ThreadID               string      `json:"thread_id"`
	RunIDs                 []string    `json:"run_ids"`
	RuntimeThreadIDs       []string    `json:"runtime_thread_ids"`
	Watermarks             []Watermark `json:"watermarks"`
	Completeness           string      `json:"completeness"`
	RedactionPolicyVersion int         `json:"redaction_policy_version"`
	Artifacts              []Artifact  `json:"artifacts"`
	MissingItems           []string    `json:"missing_items"`
	Warnings               []string    `json:"warnings"`
}
type CreateInput struct {
	ClientID          string            `json:"client_feedback_id"`
	RecoveryToken     string            `json:"recovery_token"`
	StatusToken       string            `json:"status_token"`
	Description       string            `json:"description"`
	OccurredAt        string            `json:"occurred_at"`
	ReproductionSteps string            `json:"reproduction_steps"`
	SourceClaim       map[string]string `json:"source_claim"`
	Environment       map[string]string `json:"environment"`
	Consent           struct {
		PolicyVersion int    `json:"policy_version"`
		ConfirmedAt   string `json:"confirmed_at"`
	} `json:"consent"`
	Manifest json.RawMessage `json:"manifest"`
}

func Hash(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }
func CanonicalHash(data []byte) (string, error) {
	canonical, err := jsoncanonicalizer.Transform(data)
	if err != nil {
		return "", fail(400, "feedback_invalid_json")
	}
	return Hash(canonical), nil
}
func token() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func equalToken(raw, hash string) bool {
	return hash != "" && subtle.ConstantTimeCompare([]byte(Hash([]byte(raw))), []byte(hash)) == 1
}
func validToken(raw string) bool {
	b, e := base64.RawURLEncoding.DecodeString(raw)
	return e == nil && len(b) >= 32 && len(b) <= 64
}
func validate(in CreateInput) (Manifest, int64, string, string, error) {
	var m Manifest
	mh, err := CanonicalHash(in.Manifest)
	if err != nil {
		return m, 0, "", "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(in.Manifest))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&m); err != nil {
		return m, 0, "", "", fail(400, "feedback_invalid_manifest")
	}
	invalid := !IDPattern.MatchString(in.ClientID) || !validToken(in.RecoveryToken) || !validToken(in.StatusToken) || in.RecoveryToken == in.StatusToken || strings.TrimSpace(in.Description) == "" || utf8.RuneCountInString(in.Description) > 10000 || utf8.RuneCountInString(in.ReproductionSteps) > 10000 || in.Consent.PolicyVersion != 1 || m.SchemaVersion != 1 || m.RedactionPolicyVersion != 1 || !IDPattern.MatchString(m.ThreadID) || (m.Completeness != "complete" && m.Completeness != "partial") || len(m.Artifacts) == 0 || len(m.Artifacts) > 256
	lightweight := m.CollectionScope == "basic" || m.CollectionScope == "diagnostics"
	if m.CollectionScope != "" && !lightweight {
		invalid = true
	}
	if lightweight && (len(m.RunIDs) > 0 || len(m.RuntimeThreadIDs) > 0 || len(m.Watermarks) > 0) {
		invalid = true
	}
	for _, t := range []string{in.OccurredAt, in.Consent.ConfirmedAt, m.SnapshotAt} {
		if _, err := time.Parse(time.RFC3339Nano, t); err != nil {
			invalid = true
		}
	}
	for k, v := range in.Environment {
		if (k != "app_version" && k != "daemon_version" && k != "runtime_version" && k != "electron_version" && k != "build_sha" && k != "platform" && k != "arch" && k != "model" && k != "connection_status") || len(v) > 256 {
			invalid = true
		}
	}
	for k, v := range in.SourceClaim {
		if k != "customer_label" || len(v) > 256 {
			invalid = true
		}
	}
	var total int64
	seen := map[string]bool{}
	kinds := map[string]bool{}
	parts := map[string]int{}
	counts := map[string]int64{}
	lastRecords := map[string]int64{}
	screenshots := 0
	for _, a := range m.Artifacts {
		if !IDPattern.MatchString(a.ID) || seen[a.ID] || a.Size < 1 || a.Size > MaxArtifactBytes || !digestPattern.MatchString(a.SHA256) || a.RecordCount < 0 || a.RecordCount > 9007199254740991 || len(a.Name) > 256 || len(a.Source) > 256 || a.PartIndex != parts[a.Source]+1 {
			invalid = true
		}
		seen[a.ID] = true
		parts[a.Source] = a.PartIndex
		counts[a.Source] += a.RecordCount
		if a.FirstRecord < 0 || a.FirstRecord > 9007199254740991 || a.LastRecord < 0 || a.LastRecord > 9007199254740991 || a.PartIndex > 9007199254740991 {
			invalid = true
		}
		if a.FirstRecord != 0 || a.LastRecord != 0 {
			if a.FirstRecord <= lastRecords[a.Source] || a.LastRecord < a.FirstRecord || (m.Completeness == "complete" && (a.FirstRecord != lastRecords[a.Source]+1 || a.LastRecord-a.FirstRecord+1 != a.RecordCount)) {
				invalid = true
			}
			lastRecords[a.Source] = a.LastRecord
		}
		total += a.Size
		kinds[a.Kind] = true
		if lightweight && a.Kind != "diagnostics" && a.Kind != "screenshot" {
			invalid = true
		}
		switch a.Kind {
		case "screenshot":
			screenshots++
			if a.Size > 10<<20 || (a.ContentType != "image/png" && a.ContentType != "image/jpeg" && a.ContentType != "image/webp") {
				invalid = true
			}
		case "conversation", "logs", "environment", "diagnostics", "attachments":
			if a.ContentType != "application/x-ndjson" {
				invalid = true
			}
		default:
			invalid = true
		}
	}
	for _, w := range m.Watermarks {
		source := w.Source
		if source == "" && w.RunID != "" {
			source = "run_events:" + w.RunID
		}
		if w.ExpectedCount > 0 && w.ExportedCount != counts[source] {
			invalid = true
		}
		if w.MaxEventSeq < 0 || w.MaxEventSeq > 9007199254740991 || w.Size < 0 || w.Size > 9007199254740991 || w.ExpectedCount < 0 || w.ExpectedCount > 9007199254740991 || w.ExportedCount < 0 || w.ExportedCount > 9007199254740991 {
			invalid = true
		}
		if m.Completeness == "complete" && w.ExpectedCount != w.ExportedCount {
			invalid = true
		}
		if m.Completeness == "complete" && w.SourceTruncated {
			invalid = true
		}
	}
	if m.Completeness == "complete" && ((!lightweight && (!kinds["conversation"] || !kinds["environment"])) || !kinds["diagnostics"] || len(m.MissingItems) > 0) {
		invalid = true
	}
	if invalid {
		return m, 0, "", "", fail(400, "feedback_invalid_manifest")
	}
	if total > MaxReportBytes || screenshots > 5 {
		return m, 0, "", "", fail(413, "feedback_quota_exceeded")
	}
	in.RecoveryToken = Hash([]byte(in.RecoveryToken))
	in.StatusToken = Hash([]byte(in.StatusToken))
	raw, _ := json.Marshal(in)
	rh, err := CanonicalHash(raw)
	return m, total, mh, rh, err
}
func HTTPError(err error) (int, string) {
	var e *Error
	if errors.As(err, &e) {
		return e.Status, e.Code
	}
	return 503, "feedback_unavailable"
}
