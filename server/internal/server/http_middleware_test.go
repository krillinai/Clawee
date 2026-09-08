package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	officeHTTPAPI "github.com/krillinai/Clawee/server/internal/office/httpapi"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

func TestRequestIDMiddlewareUsesInboundHeader(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(requestIDMiddleware())
	router.GET("/ok", func(c *gin.Context) {
		if c.Request.Header.Get("X-Request-ID") != "req_known_123" {
			t.Fatalf("request header X-Request-ID = %q, want req_known_123", c.Request.Header.Get("X-Request-ID"))
		}
		c.String(http.StatusOK, requestIDFromContext(c.Request.Context()))
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/ok", nil)
	req.Header.Set("X-Request-ID", "req_known_123")
	router.ServeHTTP(rec, req)

	if got := rec.Header().Get("X-Request-ID"); got != "req_known_123" {
		t.Fatalf("X-Request-ID response header = %q, want req_known_123", got)
	}
	if strings.TrimSpace(rec.Body.String()) != "req_known_123" {
		t.Fatalf("body = %q, want req_known_123", rec.Body.String())
	}
}

func TestInternalServerErrorLogWriterTruncatesAtUTF8Boundary(t *testing.T) {
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	writer := &internalServerErrorLogWriter{ResponseWriter: context.Writer}
	writer.capture(strings.Repeat("a", internalServerErrorLogBodyLimit-1) + "中")

	got := writer.body.String()
	if len(got) > internalServerErrorLogBodyLimit {
		t.Fatalf("captured body has %d bytes, want at most %d", len(got), internalServerErrorLogBodyLimit)
	}
	if !utf8.ValidString(got) {
		t.Fatal("captured body is invalid UTF-8")
	}
}

func TestRequestIDMiddlewareGeneratesMissingID(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(requestIDMiddleware())
	router.GET("/ok", func(c *gin.Context) {
		if c.Request.Header.Get("X-Request-ID") == "" {
			t.Fatal("request header X-Request-ID is empty")
		}
		c.String(http.StatusOK, requestIDFromContext(c.Request.Context()))
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/ok", nil)
	router.ServeHTTP(rec, req)

	requestID := rec.Header().Get("X-Request-ID")
	if requestID == "" {
		t.Fatal("X-Request-ID response header is empty")
	}
	bodyRequestID := strings.TrimSpace(rec.Body.String())
	if bodyRequestID == "" {
		t.Fatal("request id in context is empty")
	}
	if bodyRequestID != requestID {
		t.Fatalf("request id in context = %q, want response header %q", bodyRequestID, requestID)
	}
}

func TestAccessLogMiddlewareLogsSuccessfulRequest(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	core, logs := observer.New(zapcore.InfoLevel)
	router := gin.New()
	router.Use(requestIDMiddleware())
	router.Use(accessLogMiddleware(zap.New(core), true))
	router.GET("/api/v1/admin/status", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/status?access_token=secret", nil)
	req.Header.Set("X-Request-ID", "req_access_1")
	router.ServeHTTP(rec, req)

	if logs.Len() != 1 {
		t.Fatalf("log count = %d, want 1", logs.Len())
	}
	entry := logs.All()[0]
	if entry.Level != zapcore.InfoLevel {
		t.Fatalf("level = %s, want info", entry.Level)
	}
	if entry.Message != "http request completed" {
		t.Fatalf("message = %q, want http request completed", entry.Message)
	}
	fields := entry.ContextMap()
	if fields["request_id"] != "req_access_1" {
		t.Fatalf("request_id = %#v, want req_access_1", fields["request_id"])
	}
	if fields["method"] != http.MethodGet {
		t.Fatalf("method = %#v, want GET", fields["method"])
	}
	if fields["path"] != "/api/v1/admin/status" {
		t.Fatalf("path = %#v, want /api/v1/admin/status", fields["path"])
	}
	if _, ok := fields["query"]; ok {
		t.Fatalf("query should not be logged, fields %#v", fields)
	}
	if fields["status"] != int64(http.StatusOK) {
		t.Fatalf("status = %#v, want 200", fields["status"])
	}
	if _, ok := fields["duration_ms"]; !ok {
		t.Fatalf("duration_ms missing from fields %#v", fields)
	}
}

func TestAccessLogMiddlewareDisabledAndNilLoggerDoNotLog(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)

	tests := []struct {
		name    string
		logger  *zap.Logger
		enabled bool
		logs    *observer.ObservedLogs
	}{
		{
			name:    "disabled",
			enabled: false,
		},
		{
			name:    "nil logger",
			enabled: true,
		},
	}

	for i := range tests {
		t.Run(tests[i].name, func(t *testing.T) {
			if tests[i].name == "disabled" {
				core, logs := observer.New(zapcore.InfoLevel)
				tests[i].logger = zap.New(core)
				tests[i].logs = logs
			}

			router := gin.New()
			router.Use(requestIDMiddleware())
			router.Use(accessLogMiddleware(tests[i].logger, tests[i].enabled))
			router.GET("/api/v1/admin/status", func(c *gin.Context) {
				c.String(http.StatusOK, "ok")
			})

			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/status", nil)
			router.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", rec.Code)
			}
			if strings.TrimSpace(rec.Body.String()) != "ok" {
				t.Fatalf("body = %q, want ok", rec.Body.String())
			}
			if tests[i].logs != nil && tests[i].logs.Len() != 0 {
				t.Fatalf("log count = %d, want 0", tests[i].logs.Len())
			}
		})
	}
}

func TestAccessLogMiddlewareSkipsConfiguredPaths(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	core, logs := observer.New(zapcore.InfoLevel)
	router := gin.New()
	router.Use(requestIDMiddleware())
	router.Use(accessLogMiddleware(zap.New(core), true))
	router.GET("/healthz", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
	router.GET("/readyz", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
	router.GET("/metrics", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
	router.POST("/api/v1/collector/heartbeat", func(c *gin.Context) { c.Status(http.StatusUnauthorized) })

	for _, path := range []string{"/healthz", "/readyz", "/metrics", "/api/v1/collector/heartbeat"} {
		rec := httptest.NewRecorder()
		method := http.MethodGet
		if path == "/api/v1/collector/heartbeat" {
			method = http.MethodPost
		}
		req := httptest.NewRequest(method, path, nil)
		router.ServeHTTP(rec, req)
	}

	if logs.Len() != 0 {
		t.Fatalf("log count = %d, want 0", logs.Len())
	}
}

func TestLogAPIErrorResponsesSkipsCollectorHeartbeat(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	core, logs := observer.New(zapcore.WarnLevel)
	router := gin.New()
	router.Use(logAPIErrorResponses(zap.New(core), true))
	router.POST("/api/v1/collector/heartbeat", func(c *gin.Context) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/heartbeat", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if logs.Len() != 0 {
		t.Fatalf("log count = %d, want 0", logs.Len())
	}
}

func TestLogAPIErrorResponsesLogsDirect500Responses(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	core, logs := observer.New(zapcore.ErrorLevel)
	router := gin.New()
	router.Use(logAPIErrorResponses(zap.New(core), true))
	router.GET("/direct-500", func(c *gin.Context) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database unavailable"})
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/direct-500?access_token=secret", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if logs.Len() != 1 {
		t.Fatalf("log count = %d, want 1", logs.Len())
	}
	entry := logs.All()[0]
	if entry.Message != "internal server error" {
		t.Fatalf("log message = %q, want internal server error", entry.Message)
	}
	fields := entry.ContextMap()
	if fields["method"] != http.MethodGet {
		t.Fatalf("method field = %#v, want GET", fields["method"])
	}
	if fields["path"] != "/direct-500" {
		t.Fatalf("path field = %#v, want /direct-500", fields["path"])
	}
	if _, ok := fields["query"]; ok {
		t.Fatalf("query should not be logged, fields %#v", fields)
	}
	if fields["status"] != int64(http.StatusInternalServerError) {
		t.Fatalf("status field = %#v, want 500", fields["status"])
	}
	body, ok := fields["response_body"].(string)
	if !ok || !strings.Contains(body, "database unavailable") {
		t.Fatalf("response_body field = %#v, want error summary", fields["response_body"])
	}
	stack, ok := fields["stacktrace"].(string)
	if !ok || !strings.Contains(stack, "logAPIErrorResponses") {
		t.Fatalf("stacktrace field = %#v, want middleware stack", fields["stacktrace"])
	}
}

func TestLogAPIErrorResponsesLogsDirect400Responses(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	core, logs := observer.New(zapcore.WarnLevel)
	router := gin.New()
	router.Use(logAPIErrorResponses(zap.New(core), true))
	router.POST("/api/v1/auth/register", func(c *gin.Context) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "password must be at least 8 characters"})
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"email":"admin@example.com","password":"admin"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "test-browser")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if logs.Len() != 1 {
		t.Fatalf("log count = %d, want 1", logs.Len())
	}
	entry := logs.All()[0]
	if entry.Level != zapcore.WarnLevel {
		t.Fatalf("log level = %s, want warn", entry.Level)
	}
	if entry.Message != "api error response" {
		t.Fatalf("log message = %q, want api error response", entry.Message)
	}
	fields := entry.ContextMap()
	if fields["method"] != http.MethodPost {
		t.Fatalf("method field = %#v, want POST", fields["method"])
	}
	if fields["path"] != "/api/v1/auth/register" {
		t.Fatalf("path field = %#v, want /api/v1/auth/register", fields["path"])
	}
	if fields["status"] != int64(http.StatusBadRequest) {
		t.Fatalf("status field = %#v, want 400", fields["status"])
	}
	if fields["user_agent"] != "test-browser" {
		t.Fatalf("user_agent field = %#v, want test-browser", fields["user_agent"])
	}
	body, ok := fields["response_body"].(string)
	if !ok || !strings.Contains(body, "password must be at least 8 characters") {
		t.Fatalf("response_body field = %#v, want password message", fields["response_body"])
	}
}

func TestLogAPIErrorResponsesCanSuppressResponseBody(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	core, logs := observer.New(zapcore.WarnLevel)
	router := gin.New()
	router.Use(logAPIErrorResponses(zap.New(core), false))
	router.GET("/bad-request", func(c *gin.Context) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "sensitive validation detail"})
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/bad-request", nil)
	router.ServeHTTP(rec, req)

	if logs.Len() != 1 {
		t.Fatalf("log count = %d, want 1", logs.Len())
	}
	fields := logs.All()[0].ContextMap()
	if _, ok := fields["response_body"]; ok {
		t.Fatalf("response_body should be suppressed, fields %#v", fields)
	}
}

func TestNewRouterLogsExistingRoute500Responses(t *testing.T) {
	core, logs := observer.New(zapcore.ErrorLevel)
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte("01234567890123456789012345678901")})
	auth, err := accountService.Register(context.Background(), accounts.RegisterRequest{Email: "admin@example.com", Name: "Admin", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := rbacService.BootstrapAdmin(context.Background(), auth.Account.UserID); err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(context.Background(), auth.Account, []accounts.TokenRequest{{Audience: accounts.AudienceAdmin, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	router := NewRouter(Options{
		ProxyGateway:         mcpgateway.NewService(mcpgateway.Config{Store: failingListUpstreamServersStore{err: errors.New("database down")}}),
		AccountService:       accountService,
		RBACService:          rbacService,
		Logger:               zap.New(core),
		ErrorResponseBodyLog: true,
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/mcp/upstream-servers", nil)
	req.AddCookie(&http.Cookie{Name: defaultAdminSessionCookieName, Value: tokens.Token(accounts.AudienceAdmin).Token})
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if logs.Len() != 1 {
		t.Fatalf("log count = %d, want 1", logs.Len())
	}
	fields := logs.All()[0].ContextMap()
	if fields["path"] != "/api/v1/admin/mcp/upstream-servers" {
		t.Fatalf("path field = %#v, want upstream server path", fields["path"])
	}
	body, ok := fields["response_body"].(string)
	if !ok || !strings.Contains(body, "database down") {
		t.Fatalf("response_body field = %#v, want database down", fields["response_body"])
	}
	if _, ok := fields["stacktrace"].(string); !ok {
		t.Fatalf("stacktrace field = %#v, want stacktrace", fields["stacktrace"])
	}
}

func TestWrappedOfficeHandlerLogsAttachedErrors(t *testing.T) {
	core, logs := observer.New(zapcore.ErrorLevel)
	router := NewRouter(Options{
		Logger: zap.New(core),
		OfficeCollectorAPI: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"code":"internal_error","message":"failed to apply events"}}`))
			officeHTTPAPI.AttachRequestError(r, errors.New("insert office_agent_tool_calls: relation does not exist"))
		}),
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/collector/events", strings.NewReader(`{}`))
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if logs.Len() != 1 {
		t.Fatalf("log count = %d, want 1", logs.Len())
	}
	fields := logs.All()[0].ContextMap()
	got, ok := fields["errors"].(string)
	if !ok || !strings.Contains(got, "office_agent_tool_calls") {
		t.Fatalf("errors field = %#v, want database error", fields["errors"])
	}
}

type failingListUpstreamServersStore struct {
	mcpgateway.Store
	err error
}

func (s failingListUpstreamServersStore) ListUpstreamServers(ctx context.Context) ([]mcpgateway.UpstreamServer, error) {
	return nil, s.err
}
