package debugstore

import (
	"fmt"
	"sync"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
	"github.com/krillinai/Clawee/server/internal/textutil"
)

const (
	DefaultCapacity = 50
	MaxRawBytes     = 1 * 1024 * 1024
	HeartbeatWindow = 10 * time.Minute

	ParseStatusPending = "pending"
	ParseStatusSuccess = "success"
	ParseStatusFailed  = "failed"

	MapStatusPending = "pending"
	MapStatusSuccess = "success"
	MapStatusEmpty   = "empty"

	ReportStatusPending = "pending"
	ReportStatusSuccess = "success"
	ReportStatusFailed  = "failed"
)

type Config struct {
	Capacity    int
	Now         func() time.Time
	CollectorID string
	DeviceID    string
	Version     string
	OfficeURL   string
}

type Store struct {
	mu       sync.RWMutex
	now      func() time.Time
	capacity int

	startedAt   time.Time
	collectorID string
	deviceID    string
	version     string
	officeURL   string

	nextChainID  uint64
	nextReportID uint64

	chains        map[string]*IngestChainRecord
	recentChains  []string
	recentReports []ReportRecord
	heartbeats    []heartbeatRecord

	stats Stats
}

type ReceivedInput struct {
	AgentType  string
	Path       string
	RawPayload []byte
}

type ChainReportInput struct {
	Kind           string
	Path           string
	RawRequest     []byte
	ResponseStatus int
	Error          string
	Duration       time.Duration
}

type ReportInput struct {
	ChainID        string
	Kind           string
	Path           string
	RawRequest     []byte
	ResponseStatus int
	Error          string
	Duration       time.Duration
}

type Health struct {
	StartedAt   time.Time `json:"started_at"`
	UptimeSec   int64     `json:"uptime_seconds"`
	CollectorID string    `json:"collector_id,omitempty"`
	DeviceID    string    `json:"device_id,omitempty"`
	Version     string    `json:"version,omitempty"`
	OfficeURL   string    `json:"office_url,omitempty"`
}

type Stats struct {
	ChainsTotal         uint64 `json:"chains_total"`
	ChainsParseFailed   uint64 `json:"chains_parse_failed"`
	ChainsMappedEmpty   uint64 `json:"chains_mapped_empty"`
	ChainsReportSuccess uint64 `json:"chains_report_success"`
	ChainsReportFailed  uint64 `json:"chains_report_failed"`
	ReportsTotal        uint64 `json:"reports_total"`
	ReportsSuccess      uint64 `json:"reports_success"`
	ReportsFailed       uint64 `json:"reports_failed"`
	HeartbeatSuccess10m uint64 `json:"heartbeat_success_10m"`
	HeartbeatFailed10m  uint64 `json:"heartbeat_failed_10m"`
}

type State struct {
	SchemaVersion string              `json:"schema_version"`
	ServerTime    time.Time           `json:"server_time"`
	Capacity      int                 `json:"capacity"`
	Health        Health              `json:"health"`
	Stats         Stats               `json:"stats"`
	RecentChains  []IngestChainRecord `json:"recent_chains"`
	RecentReports []ReportRecord      `json:"recent_reports"`
}

type IngestChainRecord struct {
	ID string `json:"id"`

	ReceivedAt          time.Time `json:"received_at"`
	AgentType           string    `json:"agent_type"`
	Path                string    `json:"path"`
	RawPayload          string    `json:"raw_payload"`
	RawPayloadTruncated bool      `json:"raw_payload_truncated,omitempty"`

	ParseStatus string `json:"parse_status"`
	ParseError  string `json:"parse_error,omitempty"`

	MapStatus    string                        `json:"map_status"`
	MappedEvents []collectorapi.CollectorEvent `json:"mapped_events"`
	MapError     string                        `json:"map_error,omitempty"`

	ReportStatus           string    `json:"report_status"`
	ReportedAt             time.Time `json:"reported_at,omitempty"`
	ReportKind             string    `json:"report_kind,omitempty"`
	ReportPath             string    `json:"report_path,omitempty"`
	ReportRequest          string    `json:"report_request,omitempty"`
	ReportRequestTruncated bool      `json:"report_request_truncated,omitempty"`
	ReportResponseStatus   int       `json:"report_response_status,omitempty"`
	ReportError            string    `json:"report_error,omitempty"`
	ReportDurationMS       int64     `json:"report_duration_ms,omitempty"`
}

type ReportRecord struct {
	ID string `json:"id"`

	ChainID             string    `json:"chain_id,omitempty"`
	Kind                string    `json:"kind"`
	Path                string    `json:"path"`
	SentAt              time.Time `json:"sent_at"`
	RawRequest          string    `json:"raw_request"`
	RawRequestTruncated bool      `json:"raw_request_truncated,omitempty"`
	ResponseStatus      int       `json:"response_status,omitempty"`
	Error               string    `json:"error,omitempty"`
	DurationMS          int64     `json:"duration_ms"`
}

type heartbeatRecord struct {
	RecordedAt time.Time
	Success    bool
}

func New(cfg Config) *Store {
	capacity := cfg.Capacity
	if capacity <= 0 {
		capacity = DefaultCapacity
	}
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Store{
		now:         now,
		capacity:    capacity,
		startedAt:   now().UTC(),
		collectorID: cfg.CollectorID,
		deviceID:    cfg.DeviceID,
		version:     cfg.Version,
		officeURL:   cfg.OfficeURL,
		chains:      make(map[string]*IngestChainRecord),
	}
}

func (s *Store) RecordReceived(input ReceivedInput) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.nextChainID++
	id := fmt.Sprintf("ing_%06d", s.nextChainID)
	rawPayload, rawPayloadTruncated := copyRaw(input.RawPayload)
	record := &IngestChainRecord{
		ID:                  id,
		ReceivedAt:          s.now().UTC(),
		AgentType:           input.AgentType,
		Path:                input.Path,
		RawPayload:          rawPayload,
		RawPayloadTruncated: rawPayloadTruncated,
		ParseStatus:         ParseStatusPending,
		MapStatus:           MapStatusPending,
		ReportStatus:        ReportStatusPending,
	}
	s.chains[id] = record
	s.recentChains = append([]string{id}, s.recentChains...)
	if len(s.recentChains) > s.capacity {
		for _, evictedID := range s.recentChains[s.capacity:] {
			delete(s.chains, evictedID)
		}
		s.recentChains = s.recentChains[:s.capacity]
	}
	s.stats.ChainsTotal++
	return id
}

func (s *Store) RecordParsed(chainID string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	record := s.chains[chainID]
	if record == nil {
		return
	}
	if err != nil {
		if record.ParseStatus != ParseStatusFailed {
			s.stats.ChainsParseFailed++
		}
		record.ParseStatus = ParseStatusFailed
		record.ParseError = err.Error()
		return
	}
	record.ParseStatus = ParseStatusSuccess
	record.ParseError = ""
}

func (s *Store) RecordMapped(chainID string, events []collectorapi.CollectorEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()

	record := s.chains[chainID]
	if record == nil {
		return
	}
	record.MappedEvents = append([]collectorapi.CollectorEvent(nil), events...)
	if len(events) == 0 {
		if record.MapStatus != MapStatusEmpty {
			s.stats.ChainsMappedEmpty++
		}
		record.MapStatus = MapStatusEmpty
		return
	}
	record.MapStatus = MapStatusSuccess
}

func (s *Store) RecordChainReport(chainID string, input ChainReportInput) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recordChainReportLocked(chainID, input)
}

func (s *Store) RecordReport(input ReportInput) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if input.Kind == "heartbeat" {
		s.recordHeartbeatLocked(input)
		return
	}

	s.nextReportID++
	rawRequest, rawRequestTruncated := copyRaw(input.RawRequest)
	report := ReportRecord{
		ID:                  fmt.Sprintf("rep_%06d", s.nextReportID),
		ChainID:             input.ChainID,
		Kind:                input.Kind,
		Path:                input.Path,
		SentAt:              s.now().UTC(),
		RawRequest:          rawRequest,
		RawRequestTruncated: rawRequestTruncated,
		ResponseStatus:      input.ResponseStatus,
		Error:               input.Error,
		DurationMS:          input.Duration.Milliseconds(),
	}
	s.recentReports = append([]ReportRecord{report}, s.recentReports...)
	if len(s.recentReports) > s.capacity {
		s.recentReports = s.recentReports[:s.capacity]
	}
	s.stats.ReportsTotal++
	if input.Error != "" {
		s.stats.ReportsFailed++
	} else {
		s.stats.ReportsSuccess++
	}
	if input.ChainID != "" {
		s.recordChainReportLocked(input.ChainID, ChainReportInput{
			Kind:           input.Kind,
			Path:           input.Path,
			RawRequest:     input.RawRequest,
			ResponseStatus: input.ResponseStatus,
			Error:          input.Error,
			Duration:       input.Duration,
		})
	}
}

func (s *Store) Chain(chainID string) *IngestChainRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()

	record := s.chains[chainID]
	if record == nil {
		return nil
	}
	copied := copyChain(*record)
	return &copied
}

func (s *Store) State(limit int) State {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if limit <= 0 || limit > s.capacity {
		limit = s.capacity
	}
	now := s.now().UTC()
	state := State{
		SchemaVersion: "collector_debug.v1",
		ServerTime:    now,
		Capacity:      s.capacity,
		Health: Health{
			StartedAt:   s.startedAt,
			UptimeSec:   int64(now.Sub(s.startedAt).Seconds()),
			CollectorID: s.collectorID,
			DeviceID:    s.deviceID,
			Version:     s.version,
			OfficeURL:   s.officeURL,
		},
		Stats: s.statsWithHeartbeatLocked(now),
	}
	for i, chainID := range s.recentChains {
		if i >= limit {
			break
		}
		record := s.chains[chainID]
		if record != nil {
			state.RecentChains = append(state.RecentChains, copyChain(*record))
		}
	}
	for i, record := range s.recentReports {
		if i >= limit {
			break
		}
		state.RecentReports = append(state.RecentReports, copyReport(record))
	}
	return state
}

func (s *Store) recordChainReportLocked(chainID string, input ChainReportInput) {
	record := s.chains[chainID]
	if record == nil {
		return
	}
	rawRequest, rawRequestTruncated := copyRaw(input.RawRequest)
	record.ReportedAt = s.now().UTC()
	record.ReportKind = input.Kind
	record.ReportPath = input.Path
	record.ReportRequest = rawRequest
	record.ReportRequestTruncated = rawRequestTruncated
	record.ReportResponseStatus = input.ResponseStatus
	record.ReportError = input.Error
	record.ReportDurationMS = input.Duration.Milliseconds()
	if input.Error != "" {
		if record.ReportStatus != ReportStatusFailed {
			s.stats.ChainsReportFailed++
		}
		record.ReportStatus = ReportStatusFailed
		return
	}
	if record.ReportStatus != ReportStatusSuccess {
		s.stats.ChainsReportSuccess++
	}
	record.ReportStatus = ReportStatusSuccess
}

func (s *Store) recordHeartbeatLocked(input ReportInput) {
	now := s.now().UTC()
	s.heartbeats = append(s.heartbeats, heartbeatRecord{
		RecordedAt: now,
		Success:    input.Error == "",
	})
	s.pruneHeartbeatsLocked(now)
}

func (s *Store) statsWithHeartbeatLocked(now time.Time) Stats {
	stats := s.stats
	cutoff := now.Add(-HeartbeatWindow)
	for _, heartbeat := range s.heartbeats {
		if heartbeat.RecordedAt.Before(cutoff) {
			continue
		}
		if heartbeat.Success {
			stats.HeartbeatSuccess10m++
		} else {
			stats.HeartbeatFailed10m++
		}
	}
	return stats
}

func (s *Store) pruneHeartbeatsLocked(now time.Time) {
	cutoff := now.Add(-HeartbeatWindow)
	keepFrom := 0
	for keepFrom < len(s.heartbeats) && s.heartbeats[keepFrom].RecordedAt.Before(cutoff) {
		keepFrom++
	}
	if keepFrom == 0 {
		return
	}
	copy(s.heartbeats, s.heartbeats[keepFrom:])
	s.heartbeats = s.heartbeats[:len(s.heartbeats)-keepFrom]
}

func copyChain(record IngestChainRecord) IngestChainRecord {
	record.MappedEvents = append([]collectorapi.CollectorEvent(nil), record.MappedEvents...)
	return record
}

func copyReport(record ReportRecord) ReportRecord {
	return record
}

func copyRaw(raw []byte) (string, bool) {
	if raw == nil {
		return "", false
	}
	if len(raw) <= MaxRawBytes {
		return string(raw), false
	}
	return textutil.TruncateUTF8Bytes(string(raw), MaxRawBytes), true
}
