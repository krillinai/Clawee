package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/textutil"
)

const internalServerErrorLogBodyLimit = 4096
const collectorHeartbeatPath = "/api/v1/collector/heartbeat"

type requestIDContextKey struct{}

const requestIDHeader = "X-Request-ID"

func recoveryMiddleware(logger *zap.Logger) gin.HandlerFunc {
	return gin.CustomRecovery(func(c *gin.Context, recovered any) {
		if logger != nil {
			logger.Error("panic recovered in HTTP handler",
				zap.Any("panic", recovered),
				zap.String("request_id", requestIDFromContext(c.Request.Context())),
				zap.String("method", c.Request.Method),
				zap.String("path", c.Request.URL.Path),
				zap.Stack("stacktrace"),
			)
		}
		c.AbortWithStatus(http.StatusInternalServerError)
	})
}

func requestIDMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		requestID := strings.TrimSpace(c.GetHeader(requestIDHeader))
		if requestID == "" {
			requestID = newRequestID(time.Now().UTC())
		}
		c.Request.Header.Set(requestIDHeader, requestID)
		c.Header(requestIDHeader, requestID)
		ctx := context.WithValue(c.Request.Context(), requestIDContextKey{}, requestID)
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	}
}

func requestIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	requestID, _ := ctx.Value(requestIDContextKey{}).(string)
	return requestID
}

func newRequestID(t time.Time) string {
	return fmt.Sprintf("req_%d", t.UnixNano())
}

func accessLogMiddleware(logger *zap.Logger, enabled bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		if logger == nil || !enabled || shouldSkipAccessLog(c.Request.URL.Path) {
			c.Next()
			return
		}

		started := time.Now()
		c.Next()

		logger.Info("http request completed",
			zap.String("request_id", requestIDFromContext(c.Request.Context())),
			zap.String("method", c.Request.Method),
			zap.String("path", c.Request.URL.Path),
			zap.String("client_ip", c.ClientIP()),
			zap.String("user_agent", c.Request.UserAgent()),
			zap.Int("status", c.Writer.Status()),
			zap.Int64("duration_ms", time.Since(started).Milliseconds()),
		)
	}
}

func shouldSkipAccessLog(path string) bool {
	return path == "/healthz" ||
		path == "/readyz" ||
		path == "/metrics" ||
		path == collectorHeartbeatPath
}

func logAPIErrorResponses(logger *zap.Logger, includeResponseBody bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		if logger == nil || c.Request.URL.Path == collectorHeartbeatPath {
			c.Next()
			return
		}

		writer := &internalServerErrorLogWriter{ResponseWriter: c.Writer}
		c.Writer = writer
		c.Next()

		status := c.Writer.Status()
		if status < http.StatusBadRequest {
			return
		}

		fields := []zap.Field{
			zap.String("request_id", requestIDFromContext(c.Request.Context())),
			zap.String("method", c.Request.Method),
			zap.String("path", c.Request.URL.Path),
			zap.String("client_ip", c.ClientIP()),
			zap.String("user_agent", c.Request.UserAgent()),
			zap.Int("status", status),
		}
		if includeResponseBody {
			if body := strings.TrimSpace(writer.body.String()); body != "" {
				fields = append(fields, zap.String("response_body", body))
			}
		}
		if len(c.Errors) > 0 {
			fields = append(fields, zap.String("errors", c.Errors.String()))
		}
		if status >= http.StatusInternalServerError {
			logger.Error("internal server error", append(fields, zap.Stack("stacktrace"))...)
			return
		}
		logger.Warn("api error response", fields...)
	}
}

type internalServerErrorLogWriter struct {
	gin.ResponseWriter
	body strings.Builder
}

func (w *internalServerErrorLogWriter) Write(data []byte) (int, error) {
	w.capture(string(data))
	return w.ResponseWriter.Write(data)
}

func (w *internalServerErrorLogWriter) WriteString(data string) (int, error) {
	w.capture(data)
	return w.ResponseWriter.WriteString(data)
}

func (w *internalServerErrorLogWriter) capture(data string) {
	remaining := internalServerErrorLogBodyLimit - w.body.Len()
	if remaining <= 0 {
		return
	}
	if len(data) > remaining {
		data = textutil.TruncateUTF8Bytes(data, remaining)
	}
	_, _ = w.body.WriteString(data)
}
