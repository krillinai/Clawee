package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/krillinai/Clawee/server/internal/collector/adapter"
	"github.com/krillinai/Clawee/server/internal/collector/debugstore"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

type rawIngestLogger interface {
	RawIngest(agentType string, path string, body []byte)
}

type HookServer struct {
	mapperConfig MapperConfig
	merger       *ActivityMerger
	sink         adapter.EventSink
	rawLogger    rawIngestLogger
	debugStore   *debugstore.Store
}

func NewHookServer(cfg MapperConfig, sink adapter.EventSink, rawLogger rawIngestLogger) *HookServer {
	return NewHookServerWithDebug(cfg, sink, rawLogger, nil)
}

func NewHookServerWithDebug(cfg MapperConfig, sink adapter.EventSink, rawLogger rawIngestLogger, debugStore *debugstore.Store) *HookServer {
	return &HookServer{
		mapperConfig: cfg,
		merger:       NewActivityMerger(3 * time.Second),
		sink:         sink,
		rawLogger:    rawLogger,
		debugStore:   debugStore,
	}
}

func (s *HookServer) Type() collectorapi.AgentType {
	return collectorapi.AgentTypeCodex
}

func (s *HookServer) Start(ctx context.Context) error {
	return nil
}

func (s *HookServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ingest/codex", s.handleHook)
	return mux
}

func (s *HookServer) handleHook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if s.rawLogger != nil {
		s.rawLogger.RawIngest("codex", r.URL.Path, body)
	}
	chainID := ""
	if s.debugStore != nil {
		chainID = s.debugStore.RecordReceived(debugstore.ReceivedInput{
			AgentType:  string(collectorapi.AgentTypeCodex),
			Path:       r.URL.Path,
			RawPayload: body,
		})
	}

	payload, err := decodeHookPayload(body)
	if err != nil {
		if s.debugStore != nil {
			s.debugStore.RecordParsed(chainID, err)
		}
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if s.debugStore != nil {
		s.debugStore.RecordParsed(chainID, nil)
	}

	events := MapHook(payload, s.mapperConfig)
	events = s.merger.Merge(events)
	if s.debugStore != nil {
		s.debugStore.RecordMapped(chainID, events)
	}
	if len(events) > 0 && s.sink != nil {
		eventsForSink := append([]collectorapi.CollectorEvent(nil), events...)
		if chainSink, ok := s.sink.(interface {
			AcceptWithChain(string, []collectorapi.CollectorEvent)
		}); ok {
			go chainSink.AcceptWithChain(chainID, eventsForSink)
		} else {
			go s.sink.Accept(eventsForSink)
		}
	}

	w.WriteHeader(http.StatusAccepted)
}

func decodeHookPayload(body []byte) (HookPayload, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	var payload HookPayload
	if err := decoder.Decode(&payload); err != nil {
		return HookPayload{}, err
	}

	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return HookPayload{}, errors.New("multiple JSON values")
		}
		return HookPayload{}, err
	}

	var raw map[string]any
	rawDecoder := json.NewDecoder(bytes.NewReader(body))
	rawDecoder.UseNumber()
	if err := rawDecoder.Decode(&raw); err != nil {
		return HookPayload{}, err
	}
	payload.Raw = raw
	return payload, nil
}
