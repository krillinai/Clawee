package runtime

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/krillinai/Clawee/server/internal/collector/adapter"
	"github.com/krillinai/Clawee/server/internal/collector/adapter/codex"
	"github.com/krillinai/Clawee/server/internal/collector/agentidentity"
	"github.com/krillinai/Clawee/server/internal/collector/codexrunner"
	"github.com/krillinai/Clawee/server/internal/collector/config"
	"github.com/krillinai/Clawee/server/internal/collector/debugstore"
	"github.com/krillinai/Clawee/server/internal/collector/debugui"
	collectormcp "github.com/krillinai/Clawee/server/internal/collector/mcpserver"
	"github.com/krillinai/Clawee/server/internal/collector/observability"
	"github.com/krillinai/Clawee/server/internal/collector/report"
	"github.com/krillinai/Clawee/server/internal/collector/taskworker"
	"github.com/krillinai/Clawee/server/internal/collector/version"
	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

const livenessHeartbeatInterval = 30 * time.Second

type Options struct {
	ConfigPath string
}

type heartbeatReporter interface {
	PostHeartbeat(collectorapi.HeartbeatRequest) error
	PostHeartbeatSilently(collectorapi.HeartbeatRequest) error
}

func Run(ctx context.Context, options Options) error {
	cfg, err := config.Load(options.ConfigPath)
	if err != nil {
		return err
	}
	if !agentidentity.IsValid(cfg.AgentID) {
		return errors.New("collector agent_id is missing or invalid; run collector setup to repair the configuration")
	}
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()

	var runner *codexrunner.Runner
	workDir := ""
	if cfg.MCPServer.Enabled {
		workDir = cfg.MCPServer.CodexWorkDir
	} else if cfg.PullWorker.Enabled {
		workDir = cfg.PullWorker.CodexWorkDir
	}
	if workDir != "" {
		runner, err = codexrunner.New(workDir)
		if err != nil {
			return err
		}
	}

	logger := observability.NewLogger(observability.Config{
		Debug: cfg.Debug,
		Color: cfg.LogColorEnabled(),
	})

	requestLogger, requestLogCloser, err := observability.NewRequestLogger(cfg.RequestLogDir, observability.Config{
		Debug: cfg.Debug,
		Color: cfg.LogColorEnabled(),
	})
	if err != nil {
		return err
	}
	if requestLogCloser != nil {
		defer requestLogCloser.Close()
	}

	debugStore := debugstore.New(debugstore.Config{
		Capacity:    debugstore.DefaultCapacity,
		CollectorID: cfg.CollectorID,
		DeviceID:    cfg.DeviceID,
		Version:     version.CollectorVersion(),
		OfficeURL:   cfg.OfficeURL,
	})
	reporter := report.NewClient(report.Config{
		BaseURL:        cfg.OfficeURL,
		CollectorToken: cfg.CollectorToken,
		Logger:         requestLogger,
		Observer: report.ObserverFunc(func(record report.ReportRecord) {
			debugStore.RecordReport(debugstore.ReportInput{
				ChainID:        record.ChainID,
				Kind:           record.Kind,
				Path:           record.Path,
				RawRequest:     record.RawRequest,
				ResponseStatus: record.ResponseStatus,
				Error:          record.Error,
				Duration:       record.Duration,
			})
		}),
	})
	if cfg.PullWorker.Enabled {
		taskClient := taskworker.NewClient(taskworker.ClientConfig{
			BaseURL: cfg.OfficeURL, CollectorToken: cfg.CollectorToken,
			CollectorID: cfg.CollectorID, DeviceID: cfg.DeviceID,
		})
		worker := taskworker.New(taskClient, runner, logger)
		go worker.Run(runCtx)
	}
	sink := &reportingSink{
		reporter:    reporter,
		collectorID: cfg.CollectorID,
		deviceID:    cfg.DeviceID,
		logger:      logger,
	}
	var threadEdges []codex.ThreadEdge
	if cfg.CodexStateDB != "" {
		edges, err := codex.LoadThreadEdges(cfg.CodexStateDB)
		if err != nil {
			logger.Warn("load codex thread edges failed", "error", err)
		} else {
			threadEdges = edges
			logger.Info("loaded codex thread edges", "count", len(threadEdges))
		}
	}

	initialSeenAt := time.Now().UTC()
	initialAgent := collectorapi.AgentSummary{
		AgentID:    cfg.AgentID,
		AgentType:  collectorapi.AgentTypeCodex,
		Status:     collectorapi.StatusIdle,
		LastSeenAt: initialSeenAt,
		Metadata:   map[string]string{"privacy_mode": cfg.PrivacyMode},
	}
	go func() {
		if err := reporter.PostHeartbeat(collectorapi.HeartbeatRequest{
			SchemaVersion:    collectorapi.SchemaVersion,
			CollectorID:      cfg.CollectorID,
			DeviceID:         cfg.DeviceID,
			SentAt:           initialSeenAt,
			CollectorVersion: version.CollectorVersion(),
			Agents:           []collectorapi.AgentSummary{initialAgent},
		}); err != nil {
			logger.Warn("initial heartbeat failed", "error", err)
		}
		ticker := time.NewTicker(livenessHeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				if err := postCollectorLivenessHeartbeat(reporter, cfg, time.Now().UTC()); err != nil {
					logger.Warn("collector heartbeat failed", "error", err)
				}
			}
		}
	}()

	var codexAdapter adapter.Adapter = codex.NewHookServerWithDebug(codex.MapperConfig{
		AgentID:     cfg.AgentID,
		DeviceID:    cfg.DeviceID,
		ThreadEdges: threadEdges,
	}, sink, logger, debugStore)
	debugHandler := debugui.New(debugStore)
	var mcpHandler http.Handler
	if cfg.MCPServer.Enabled {
		mcpHandler = collectormcp.NewHandler(runCtx, runner, cfg.MCPServer.BearerToken)
	}
	mux := newServeMux(codexAdapter.Handler(), debugHandler, mcpHandler)
	server := &http.Server{
		Addr:    cfg.ListenAddr,
		Handler: mux,
		BaseContext: func(net.Listener) context.Context {
			return runCtx
		},
	}
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-runCtx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	logger.Info("clawee-collector listening", "url", "http://"+cfg.ListenAddr+"/ingest/codex")
	err = server.ListenAndServe()
	cancelRun()
	<-shutdownDone
	if err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func newServeMux(codexHandler http.Handler, debugHandler *debugui.Handler, mcpHandler http.Handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/ingest/codex", localOnly(codexHandler))
	mux.HandleFunc("/healthz", debugHandler.Healthz)

	debugMux := http.NewServeMux()
	debugMux.HandleFunc("/debug/collector", debugHandler.Page)
	debugMux.HandleFunc("/debug/api/collector/state", debugHandler.State)
	mux.Handle("/debug", localOnly(http.HandlerFunc(debugHandler.Index)))
	mux.Handle("/debug/", localOnly(debugMux))
	if mcpHandler != nil {
		mux.Handle("/mcp", mcpHandler)
	}

	return mux
}

func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		ip := net.ParseIP(host)
		if err != nil || ip == nil || !ip.IsLoopback() {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func postCollectorLivenessHeartbeat(reporter heartbeatReporter, cfg config.Config, sentAt time.Time) error {
	req := collectorapi.HeartbeatRequest{
		SchemaVersion:    collectorapi.SchemaVersion,
		CollectorID:      cfg.CollectorID,
		DeviceID:         cfg.DeviceID,
		SentAt:           sentAt,
		CollectorVersion: version.CollectorVersion(),
		Agents:           []collectorapi.AgentSummary{},
	}
	if cfg.Debug {
		return reporter.PostHeartbeat(req)
	}
	return reporter.PostHeartbeatSilently(req)
}

type reportingSink struct {
	reporter    *report.Client
	collectorID string
	deviceID    string
	logger      report.Logger
}

func (s *reportingSink) Accept(events []collectorapi.CollectorEvent) {
	s.AcceptWithChain("", events)
}

func (s *reportingSink) AcceptWithChain(chainID string, events []collectorapi.CollectorEvent) {
	req := collectorapi.EventsRequest{
		SchemaVersion: collectorapi.SchemaVersion,
		CollectorID:   s.collectorID,
		DeviceID:      s.deviceID,
		SentAt:        time.Now().UTC(),
		Events:        events,
	}
	if err := s.reporter.PostEventsWithChain(chainID, req); err != nil && s.logger != nil {
		s.logger.Warn("post collector events failed", "error", err)
	}
}
