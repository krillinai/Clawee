package feedback

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const MaxIncidentBytes = 32 << 10
const MaxIncidentLogBytes = 256 << 10

type IncidentEnvironment struct {
	AppVersion          string `json:"app_version,omitempty"`
	DaemonVersion       string `json:"daemon_version,omitempty"`
	RuntimeVersion      string `json:"runtime_version,omitempty"`
	ElectronVersion     string `json:"electron_version,omitempty"`
	BuildSHA            string `json:"build_sha,omitempty"`
	Platform            string `json:"platform,omitempty"`
	Arch                string `json:"arch,omitempty"`
	OSVersion           string `json:"os_version,omitempty"`
	Model               string `json:"model,omitempty"`
	EndpointFingerprint string `json:"endpoint_fingerprint,omitempty"`
	Protocol            string `json:"protocol,omitempty"`
	Transport           string `json:"transport,omitempty"`
	TimeoutMS           *int64 `json:"timeout_ms,omitempty"`
	InactivityTimeoutMS *int64 `json:"inactivity_timeout_ms,omitempty"`
	SpawnTimeoutMS      *int64 `json:"spawn_timeout_ms,omitempty"`
	RetryLimit          *int64 `json:"retry_limit,omitempty"`
	ProxyEnvSet         *bool  `json:"proxy_env_set,omitempty"`
}

type IncidentReporterIdentity struct {
	EnterpriseKey string `json:"enterprise_key"`
	SubjectID     string `json:"subject_id,omitempty"`
	DisplayName   string `json:"display_name,omitempty"`
	AgentID       string `json:"agent_id,omitempty"`
}

type IncidentDiagnostics struct {
	ErrorName         string `json:"error_name,omitempty"`
	ErrorMessage      string `json:"error_message,omitempty"`
	ErrorStack        string `json:"error_stack,omitempty"`
	AdditionalDetails string `json:"additional_details,omitempty"`
	CauseCode         string `json:"cause_code,omitempty"`
	RequestMethod     string `json:"request_method,omitempty"`
	RequestPath       string `json:"request_path,omitempty"`
	RequestID         string `json:"request_id,omitempty"`
}

type IncidentTimelineEntry struct {
	At         string `json:"at"`
	EventType  string `json:"event_type"`
	Stage      string `json:"stage"`
	ErrorCode  string `json:"error_code"`
	DurationMS *int64 `json:"duration_ms,omitempty"`
	RetryCount *int64 `json:"retry_count,omitempty"`
}

type AutomaticIncident struct {
	SchemaVersion     int                       `json:"schema_version"`
	PolicyVersion     int                       `json:"policy_version"`
	ID                string                    `json:"incident_id"`
	InstallationID    string                    `json:"installation_id"`
	SessionID         string                    `json:"app_session_id"`
	Revision          int64                     `json:"revision"`
	Source            string                    `json:"source"`
	Layer             string                    `json:"layer"`
	Stage             string                    `json:"stage"`
	ErrorCode         string                    `json:"error_code"`
	ScopeID           string                    `json:"scope_id,omitempty"`
	RunID             string                    `json:"run_id,omitempty"`
	ThreadID          string                    `json:"thread_id,omitempty"`
	TransportCode     string                    `json:"transport_code,omitempty"`
	HTTPStatus        *int                      `json:"http_status,omitempty"`
	ExitCode          *int64                    `json:"exit_code,omitempty"`
	ExitSignal        string                    `json:"exit_signal,omitempty"`
	UpstreamRequestID string                    `json:"upstream_request_id,omitempty"`
	RetryCount        *int64                    `json:"retry_count,omitempty"`
	DurationMS        *int64                    `json:"duration_ms,omitempty"`
	UnresponsiveMS    *int64                    `json:"unresponsive_ms,omitempty"`
	TaskOutcome       string                    `json:"task_outcome,omitempty"`
	FirstSeenAt       string                    `json:"first_seen_at"`
	LastSeenAt        string                    `json:"last_seen_at"`
	OccurrenceCount   int64                     `json:"occurrence_count"`
	Outcome           string                    `json:"outcome"`
	Message           string                    `json:"message"`
	FirstMessage      string                    `json:"first_message"`
	Environment       IncidentEnvironment       `json:"environment"`
	Reporter          *IncidentReporterIdentity `json:"reporter,omitempty"`
	Diagnostics       *IncidentDiagnostics      `json:"diagnostics,omitempty"`
	FirstDiagnostics  *IncidentDiagnostics      `json:"first_diagnostics,omitempty"`
	Timeline          []IncidentTimelineEntry   `json:"timeline,omitempty"`
	LogsExpected      *bool                     `json:"logs_expected,omitempty"`
}

var incidentUUID = regexp.MustCompile(`(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var incidentIdentifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$`)
var incidentSecret = regexp.MustCompile(`(?i)(sk-|sk_|bearer|token|password|secret|api[_-]?key|credential|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|(?:AKIA|ASIA)[a-z0-9]{16}|AIza[a-z0-9_-]{35}|xox[baprs]-[a-z0-9-]{10,}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)`)
var incidentMessagePattern = regexp.MustCompile(`^[a-zA-Z0-9_.: -]+$`)

func incidentSafe(value string) bool {
	return incidentIdentifier.MatchString(value) && !incidentSecret.MatchString(value)
}
func oneOf(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}
func (in AutomaticIncident) validate() error {
	invalid := fail(400, "feedback_invalid_incident")
	if in.Reporter != nil {
		r := in.Reporter
		hasEmployee := r.SubjectID != "" || r.DisplayName != ""
		if !digestPattern.MatchString(r.EnterpriseKey) || (r.AgentID != "" && !incidentSafe(r.AgentID)) || (!hasEmployee && r.AgentID == "") {
			return invalid
		}
		if hasEmployee && (!incidentSafe(r.SubjectID) || strings.TrimSpace(r.DisplayName) == "" || len(r.DisplayName) > 256 || !utf8.ValidString(r.DisplayName) || strings.ContainsAny(r.DisplayName, "\r\n\x00")) {
			return invalid
		}
	}
	for _, d := range []*IncidentDiagnostics{in.Diagnostics, in.FirstDiagnostics} {
		if d == nil {
			continue
		}
		if d.RequestID != "" && !incidentSafe(d.RequestID) {
			return invalid
		}
		for _, field := range []struct {
			value   string
			maximum int
		}{{d.ErrorName, 128}, {d.ErrorMessage, 2048}, {d.ErrorStack, 4096}, {d.AdditionalDetails, 2048}, {d.CauseCode, 128}, {d.RequestMethod, 16}, {d.RequestPath, 512}} {
			if len(field.value) > field.maximum || !utf8.ValidString(field.value) {
				return invalid
			}
		}
		if (d.RequestMethod != "" && !oneOf(d.RequestMethod, "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")) || (d.RequestPath != "" && (!strings.HasPrefix(d.RequestPath, "/") || strings.HasPrefix(d.RequestPath, "//") || strings.ContainsAny(d.RequestPath, "?#\r\n"))) {
			return invalid
		}
		data, _ := json.Marshal(d)
		if suspicious(data) || consoleBearerPattern.Match(data) {
			return invalid
		}
	}
	if len(in.Timeline) > 20 {
		return invalid
	}
	var previous time.Time
	for _, entry := range in.Timeline {
		at, err := time.Parse(time.RFC3339Nano, entry.At)
		if err != nil || at.Before(previous) || !oneOf(entry.EventType, "error", "recovered", "finished") || !incidentSafe(entry.Stage) || !incidentSafe(entry.ErrorCode) {
			return invalid
		}
		for _, value := range []*int64{entry.DurationMS, entry.RetryCount} {
			if value != nil && (*value < 0 || *value > 9007199254740991) {
				return invalid
			}
		}
		previous = at
	}
	if in.SchemaVersion != 1 || in.PolicyVersion != 1 || !incidentUUID.MatchString(in.ID) || !incidentUUID.MatchString(in.InstallationID) || !incidentUUID.MatchString(in.SessionID) || in.Revision < 1 || in.Revision > 9007199254740991 || in.OccurrenceCount < 1 || in.OccurrenceCount > 9007199254740991 {
		return invalid
	}
	if !oneOf(in.Source, "desktop", "daemon", "web") || !oneOf(in.Layer, "desktop_bootstrap", "web_daemon", "daemon_codex", "codex_model") || !oneOf(in.Outcome, "ongoing", "recovered", "failed", "unknown") || !incidentSafe(in.Stage) || !incidentSafe(in.ErrorCode) {
		return invalid
	}
	if (in.Source == "desktop" && in.Layer != "desktop_bootstrap") || (in.Source == "daemon" && !oneOf(in.Layer, "daemon_codex", "codex_model")) || (in.Source == "web" && (in.Layer != "web_daemon" || !oneOf(in.Stage, "connection", "request", "event_stream") || !oneOf(in.ErrorCode, "WEB_DISCONNECTED", "WEB_REQUEST_FAILED", "WEB_REQUEST_TIMEOUT", "WEB_HTTP_FAILED", "WEB_STREAM_ENDED"))) {
		return invalid
	}
	for _, value := range []string{in.ScopeID, in.RunID, in.ThreadID, in.TransportCode, in.ExitSignal, in.UpstreamRequestID, in.Environment.AppVersion, in.Environment.DaemonVersion, in.Environment.RuntimeVersion, in.Environment.ElectronVersion, in.Environment.BuildSHA, in.Environment.Platform, in.Environment.Arch, in.Environment.OSVersion, in.Environment.Model, in.Environment.Protocol, in.Environment.Transport} {
		if value != "" && !incidentSafe(value) {
			return invalid
		}
	}
	for _, value := range []*int64{in.RetryCount, in.DurationMS, in.UnresponsiveMS, in.Environment.TimeoutMS, in.Environment.InactivityTimeoutMS, in.Environment.SpawnTimeoutMS, in.Environment.RetryLimit} {
		if value != nil && (*value < 0 || *value > 9007199254740991) {
			return invalid
		}
	}
	if in.ExitCode != nil && (*in.ExitCode < -2147483647 || *in.ExitCode > 2147483647) {
		return invalid
	}
	if in.HTTPStatus != nil && (*in.HTTPStatus < 100 || *in.HTTPStatus > 599) {
		return invalid
	}
	if in.TaskOutcome != "" && !oneOf(in.TaskOutcome, "succeeded", "failed", "cancelled", "interrupted") {
		return invalid
	}
	if value := in.Environment.EndpointFingerprint; value != "" {
		decoded, err := hex.DecodeString(value)
		if err != nil || len(decoded) != 32 || strings.ToLower(value) != value {
			return invalid
		}
	}
	first, err := time.Parse(time.RFC3339Nano, in.FirstSeenAt)
	if err != nil {
		return invalid
	}
	last, err := time.Parse(time.RFC3339Nano, in.LastSeenAt)
	if err != nil || last.Before(first) {
		return invalid
	}
	for _, value := range []string{in.Message, in.FirstMessage} {
		if len(value) > 1024 || !incidentMessagePattern.MatchString(value) || incidentSecret.MatchString(value) || suspicious([]byte(value)) {
			return invalid
		}
	}
	expectedMessage := in.ErrorCode
	if in.TransportCode != "" {
		expectedMessage += " " + in.TransportCode
	}
	if in.HTTPStatus != nil {
		expectedMessage += " HTTP " + strconv.Itoa(*in.HTTPStatus)
	}
	modelResponse := in.Source == "daemon" && in.Layer == "codex_model" && in.Stage == "response" && in.RunID != ""
	if in.Message != expectedMessage || (!modelResponse && in.FirstMessage != in.Message) {
		return invalid
	}
	data, _ := json.Marshal(in)
	if len(data) > MaxIncidentBytes {
		return fail(413, "feedback_request_too_large")
	}
	return nil
}

func (s *Service) PutIncident(ctx context.Context, id, raw string, in AutomaticIncident, ip, deployment string) (out map[string]any, created bool, err error) {
	if err = in.validate(); err != nil {
		return nil, false, err
	}
	if id != in.ID {
		return nil, false, fail(400, "feedback_invalid_incident")
	}
	if len(raw) != 64 {
		return nil, false, fail(403, "feedback_invalid_credential")
	}
	if decoded, e := hex.DecodeString(raw); e != nil || len(decoded) != 32 {
		return nil, false, fail(403, "feedback_invalid_credential")
	}
	data, _ := json.Marshal(in)
	hash, _ := CanonicalHash(data)
	last, _ := time.Parse(time.RFC3339Nano, in.LastSeenAt)
	err = s.store.Update(ctx, func(tx Transaction) error {
		now := s.clock()
		allowed, e := tx.Rate(Hash([]byte("incident-ip:"+ip)), now, 240)
		if e != nil {
			return e
		}
		if !allowed {
			return fail(429, "feedback_rate_limited")
		}
		r, e := tx.Get(id)
		if e == nil {
			if r.Kind != "automatic_incident" || !equalToken(raw, r.UploadHash) {
				return fail(403, "feedback_invalid_credential")
			}
			if e = live(r, now); e != nil {
				return e
			}
			if r.Incident == nil {
				return fail(409, "feedback_incident_conflict")
			}
			if (in.Reporter == nil) != (r.Incident.Reporter == nil) || (in.Reporter != nil && *in.Reporter != *r.Incident.Reporter) || (in.LogsExpected != nil && *in.LogsExpected) != (r.Incident.LogsExpected != nil && *r.Incident.LogsExpected) {
				return fail(409, "feedback_incident_conflict")
			}
			httpStatusMatches := in.HTTPStatus == nil && r.Incident.HTTPStatus == nil || in.HTTPStatus != nil && r.Incident.HTTPStatus != nil && *in.HTTPStatus == *r.Incident.HTTPStatus
			modelResponse := in.Source == "daemon" && in.Layer == "codex_model" && in.Stage == "response" && r.Incident.Stage == "response" && in.RunID != ""
			classificationChanged := in.ErrorCode != r.Incident.ErrorCode || in.TransportCode != r.Incident.TransportCode || !httpStatusMatches
			if in.InstallationID != r.Incident.InstallationID || in.SessionID != r.Incident.SessionID || in.Source != r.Incident.Source || in.Layer != r.Incident.Layer || (!modelResponse && classificationChanged) || in.ScopeID != r.Incident.ScopeID || in.RunID != r.Incident.RunID || in.FirstSeenAt != r.Incident.FirstSeenAt || in.FirstMessage != r.Incident.FirstMessage || !reflect.DeepEqual(in.FirstDiagnostics, r.Incident.FirstDiagnostics) {
				return fail(409, "feedback_incident_conflict")
			}
			if in.Revision == r.Incident.Revision && hash != r.RequestHash {
				return fail(409, "feedback_incident_conflict")
			}
			if in.Revision <= r.Incident.Revision {
				out = map[string]any{"incident_id": id, "accepted_revision": r.Incident.Revision}
				return nil
			}
			previousLast, _ := time.Parse(time.RFC3339Nano, r.Incident.LastSeenAt)
			if in.OccurrenceCount < r.Incident.OccurrenceCount || last.Before(previousLast) {
				return fail(409, "feedback_incident_conflict")
			}
		} else {
			if !errors.Is(e, ErrNotFound) {
				return e
			}
			source := ""
			if deployment != "" {
				credential, e := tx.Credential(Hash([]byte(deployment)))
				if e != nil || !credential.Enabled || !now.Before(credential.ExpiresAt) {
					return fail(403, "feedback_invalid_deployment_credential")
				}
				source = credential.SourceID
				used, e := tx.SourceReserved(source)
				if e != nil {
					return e
				}
				reserved := int64(MaxIncidentBytes)
				if in.LogsExpected != nil && *in.LogsExpected {
					reserved += MaxIncidentLogBytes
				}
				if reserved > credential.CapacityBytes-used {
					return fail(429, "feedback_source_capacity_exceeded")
				}
			}
			allowed, e := tx.DailyRate(Hash([]byte("incident-install:"+in.InstallationID+":"+now.Format("2006-01-02"))), now, 100)
			if e != nil {
				return e
			}
			if !allowed {
				return fail(429, "feedback_installation_rate_limited")
			}
			r = Report{ID: id, Kind: "automatic_incident", ClientID: id, TrustedSource: source, CreatedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour), UploadHash: Hash([]byte(raw)), UploadState: "ready", SecurityState: "normal", Completeness: "technical", ProcessingStatus: "open", Version: 1, ReservedBytes: MaxIncidentBytes, Artifacts: []StoredArtifact{}, Events: []Event{}}
			if in.LogsExpected != nil && *in.LogsExpected {
				r.ReservedBytes += MaxIncidentLogBytes
			}
			r.DisplayNumber = "AI-" + now.Format("20060102") + "-" + strings.ToUpper(id[len(id)-8:])
			used, e := tx.Reserved()
			if e != nil {
				return e
			}
			if r.ReservedBytes > s.capacity-used {
				return fail(429, "feedback_capacity_exceeded")
			}
			created = true
		}
		r.Incident = &in
		r.RequestHash = hash
		r.Description = in.Message
		r.Environment = map[string]string{"app_version": in.Environment.AppVersion, "runtime_version": in.Environment.RuntimeVersion}
		r.LastOccurredAt = &last
		out = map[string]any{"incident_id": id, "accepted_revision": in.Revision}
		return tx.Save(r)
	})
	return out, created, err
}

func reportSortTime(r Report) time.Time {
	occurredAt := r.CreatedAt
	if r.LastOccurredAt != nil {
		occurredAt = *r.LastOccurredAt
	}
	return occurredAt.UTC().Truncate(time.Microsecond)
}
