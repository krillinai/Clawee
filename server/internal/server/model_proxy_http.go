package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

var errInvalidModelToken = errors.New("invalid model access token")
var modelProxyAuditSequence uint64

const (
	modelPolicyAllowed         = "allowed"
	modelPolicyRejectedAPIKey  = "rejected_api_key"
	modelPolicyRejectedScope   = "rejected_scope"
	modelPolicyRejectedAccount = "rejected_account"
)

const (
	modelProxyResponseHeaderTimeout = 45 * time.Second
	modelProxyStreamIdleTimeout     = 2 * time.Minute
	modelProxyRequestTimeout        = 15 * time.Minute
)

var errModelProxyStreamIdleTimeout = errors.New("model proxy stream idle timeout")

var modelProxyHTTPClient = &http.Client{
	Timeout: modelProxyRequestTimeout,
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: modelProxyResponseHeaderTimeout,
		ExpectContinueTimeout: 1 * time.Second,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
	},
}

type modelBearerIdentity struct {
	Token mcpgateway.AccountToken
}

type modelPolicyResult struct {
	Status  string
	Account accounts.Account
}

func resolveModelBearer(req *http.Request, store mcpgateway.Store) (modelBearerIdentity, error) {
	if req == nil || store == nil {
		return modelBearerIdentity{}, errInvalidModelToken
	}
	parts := strings.Fields(req.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return modelBearerIdentity{}, errInvalidModelToken
	}
	token, err := store.GetAccountTokenByHash(req.Context(), mcpgateway.HashToken(parts[1]))
	if err != nil {
		if errors.Is(err, mcpgateway.ErrAccountTokenNotFound) {
			return modelBearerIdentity{}, errInvalidModelToken
		}
		return modelBearerIdentity{}, err
	}
	return modelBearerIdentity{Token: token}, nil
}

func evaluateModelPolicy(ctx context.Context, identity modelBearerIdentity, store mcpgateway.Store, accountService *accounts.Service, now time.Time) (modelPolicyResult, error) {
	if identity.Token.Status != mcpgateway.StatusActive || (identity.Token.ExpiresAt != nil && !identity.Token.ExpiresAt.After(now)) {
		return modelPolicyResult{Status: modelPolicyRejectedAPIKey}, nil
	}
	if !slices.Contains(identity.Token.Scopes, mcpgateway.AccountTokenScopeModelCall) {
		return modelPolicyResult{Status: modelPolicyRejectedScope}, nil
	}
	if accountService == nil {
		return modelPolicyResult{}, errors.New("account service is not configured")
	}
	if store == nil {
		return modelPolicyResult{}, errors.New("account token store is not configured")
	}
	account, err := accountService.Account(ctx, identity.Token.UserID)
	if err != nil {
		if errors.Is(err, accounts.ErrAccountNotFound) {
			return modelPolicyResult{Status: modelPolicyRejectedAccount}, nil
		}
		return modelPolicyResult{}, err
	}
	if account.Status != accounts.StatusActive {
		return modelPolicyResult{Status: modelPolicyRejectedAccount, Account: account}, nil
	}
	if err := store.TouchAccountToken(ctx, identity.Token.ID, now); err != nil {
		return modelPolicyResult{}, err
	}
	return modelPolicyResult{Status: modelPolicyAllowed, Account: account}, nil
}

func mountModelProxyRoutes(router *gin.Engine, opts Options) {
	if modelAccessMode(opts) != ModelAccessPlatformManaged {
		return
	}
	router.GET("/v1/models", handleModelList(opts))
	router.POST("/v1/chat/completions", handleModelProxy(opts, "/chat/completions"))
	router.POST("/v1/responses", handleModelProxy(opts, "/responses"))
}

func handleModelList(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		identity, _, audit, ok := beginModelRequest(c, opts, nil, "")
		if !ok {
			return
		}
		config, err := loadModelGroupConfig(c.Request.Context(), opts, identity.Token.UserID)
		if err != nil {
			finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditRejectedConfiguration, http.StatusServiceUnavailable, 0, "model_group_unavailable", "model group is unavailable", "", nil, nil, 0, 0, false)
			writeModelError(c, http.StatusServiceUnavailable, "model_group_unavailable", "Model group is unavailable")
			return
		}
		models := modelGroupModels(config)
		routableModels := make([]string, 0, len(models))
		for _, model := range models {
			_, _, targets, routeErr := resolveModelRouteTargets(c.Request.Context(), opts, identity.Token.UserID, model)
			if routeErr == nil && len(targets) > 0 {
				routableModels = append(routableModels, model)
			}
		}
		models = routableModels
		if len(models) == 0 {
			finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditRejectedConfiguration, http.StatusServiceUnavailable, 0, "model_catalog_empty", "model group has no available models", "", nil, nil, 0, 0, false)
			writeModelError(c, http.StatusServiceUnavailable, "model_catalog_empty", "Model group has no available models")
			return
		}
		data := make([]map[string]any, 0, len(models))
		for _, model := range models {
			data = append(data, map[string]any{"id": model, "object": "model", "created": 0, "owned_by": "clawee"})
		}
		response := map[string]any{"object": "list", "data": data}
		body, _ := json.Marshal(response)
		c.Data(http.StatusOK, "application/json", body)
		finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditSucceeded, http.StatusOK, 0, "", "", "", c.Writer.Header(), body, int64(len(body)), 1, false)
	}
}

func handleModelProxy(opts Options, upstreamPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw, err := io.ReadAll(io.LimitReader(c.Request.Body, 8<<20+1))
		if err != nil || len(raw) > 8<<20 {
			_, _, audit, ok := beginModelRequest(c, opts, raw, "")
			if ok {
				finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditFailed, http.StatusBadRequest, 0, "invalid_request", "request body is invalid", "", nil, nil, 0, 0, true)
				writeModelError(c, http.StatusBadRequest, "invalid_request", "Request body is invalid")
			}
			return
		}
		payload, err := decodeModelRequestBody(raw)
		if err != nil {
			_, _, audit, ok := beginModelRequest(c, opts, raw, "")
			if ok {
				finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditFailed, http.StatusBadRequest, 0, "invalid_request", "request body is invalid", "", nil, nil, 0, 0, false)
				writeModelError(c, http.StatusBadRequest, "invalid_request", "Request body is invalid")
			}
			return
		}
		requestedModel := modelFromPayload(payload)
		identity, _, audit, ok := beginModelRequest(c, opts, raw, requestedModel)
		if !ok {
			return
		}
		_, selectedModel, targets, err := resolveModelRouteTargets(c.Request.Context(), opts, identity.Token.UserID, requestedModel)
		if err != nil {
			status := http.StatusServiceUnavailable
			code := "model_group_unavailable"
			message := "Model group is unavailable"
			if errors.Is(err, errModelNotAvailable) {
				status = http.StatusBadRequest
				code = "model_not_found"
				message = "The requested model is not available in the model group"
			}
			finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditRejectedConfiguration, status, 0, code, err.Error(), requestedModel, nil, nil, 0, 0, false)
			writeModelError(c, status, code, message)
			return
		}
		if requestedModel == "" {
			payload["model"] = selectedModel
			raw, err = json.Marshal(payload)
			if err != nil {
				finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditFailed, http.StatusBadRequest, 0, "invalid_request", "request body is invalid", selectedModel, nil, nil, 0, 0, false)
				writeModelError(c, http.StatusBadRequest, "invalid_request", "Request body is invalid")
				return
			}
		}
		proxyModelRequestByTargets(c, opts, audit, targets, upstreamPath, raw, selectedModel)
	}
}

func beginModelRequest(c *gin.Context, opts Options, requestBody []byte, model string) (modelBearerIdentity, accounts.Account, mcpgateway.ModelProxyAuditRecord, bool) {
	if opts.ProxyGateway == nil {
		writeModelError(c, http.StatusServiceUnavailable, "model_gateway_unavailable", "Model gateway is unavailable")
		return modelBearerIdentity{}, accounts.Account{}, mcpgateway.ModelProxyAuditRecord{}, false
	}
	identity, err := resolveModelBearer(c.Request, opts.ProxyGateway.Store())
	if err != nil {
		if errors.Is(err, errInvalidModelToken) {
			writeModelError(c, http.StatusUnauthorized, "invalid_api_key", "Invalid API key")
		} else {
			writeModelError(c, http.StatusServiceUnavailable, "model_auth_unavailable", "Model authentication is unavailable")
		}
		return modelBearerIdentity{}, accounts.Account{}, mcpgateway.ModelProxyAuditRecord{}, false
	}
	account := accounts.Account{}
	if opts.AccountService != nil {
		account, _ = opts.AccountService.Account(c.Request.Context(), identity.Token.UserID)
	}
	requestID := requestIDFromContext(c.Request.Context())
	if requestID == "" {
		requestID = strings.TrimSpace(c.GetHeader("X-Request-ID"))
	}
	audit := mcpgateway.ModelProxyAuditRecord{
		AuditID:           newModelProxyAuditID(),
		RequestID:         requestID,
		UserID:            identity.Token.UserID,
		UserNameSnapshot:  account.Name,
		APIKeyID:          identity.Token.ID,
		APIKeyFingerprint: identity.Token.Fingerprint,
		Endpoint:          c.Request.URL.Path,
		Method:            c.Request.Method,
		Model:             model,
		RequestedModel:    model,
		RequestType:       modelRequestType(requestBody),
		Status:            mcpgateway.ModelProxyAuditStarted,
		RequestHeaders:    sanitizeModelProxyHeaders(c.Request.Header),
		RequestBytes:      int64(len(requestBody)),
		CreatedAt:         time.Now().UTC(),
	}
	audit.RequestBody, audit.Truncated = snapshotModelProxyBody(requestBody)
	if err := opts.ProxyGateway.Store().CreateModelProxyAuditRecord(c.Request.Context(), audit); err != nil {
		writeModelError(c, http.StatusServiceUnavailable, "model_audit_unavailable", "Model audit is unavailable")
		return modelBearerIdentity{}, accounts.Account{}, mcpgateway.ModelProxyAuditRecord{}, false
	}
	decision, err := evaluateModelPolicy(c.Request.Context(), identity, opts.ProxyGateway.Store(), opts.AccountService, audit.CreatedAt)
	if err != nil {
		finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditRejectedAccount, http.StatusServiceUnavailable, 0, "model_auth_unavailable", "account authorization is unavailable", model, nil, nil, 0, 0, false)
		writeModelError(c, http.StatusServiceUnavailable, "model_auth_unavailable", "Model authentication is unavailable")
		return identity, account, audit, false
	}
	if decision.Status == modelPolicyRejectedAPIKey {
		finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditRejectedAPIKey, http.StatusForbidden, 0, "api_key_inactive", "The API key is not active", model, nil, nil, 0, 0, false)
		writeModelError(c, http.StatusForbidden, "api_key_inactive", "The API key is not active")
		return identity, account, audit, false
	}
	if decision.Status == modelPolicyRejectedScope {
		finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditRejectedScope, http.StatusForbidden, 0, "model_scope_required", "The access token does not allow model calls", model, nil, nil, 0, 0, false)
		writeModelError(c, http.StatusForbidden, "model_scope_required", "The access token does not allow model calls")
		return identity, account, audit, false
	}
	if decision.Status == modelPolicyRejectedAccount {
		finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditRejectedAccount, http.StatusForbidden, 0, "account_disabled", "The account is not active", model, nil, nil, 0, 0, false)
		writeModelError(c, http.StatusForbidden, "account_disabled", "The account is not active")
		return identity, account, audit, false
	}
	return identity, decision.Account, audit, true
}

func proxyModelRequestByTargets(c *gin.Context, opts Options, audit mcpgateway.ModelProxyAuditRecord, targets []modelRouteTarget, upstreamPath string, body []byte, model string) {
	var lastStatus int
	var lastErr error
	requestContext, cancel := modelProxyRequestContext(c.Request.Context())
	defer cancel()
	for index, target := range targets {
		if err := requestContext.Err(); err != nil {
			if errors.Is(err, context.Canceled) {
				finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditClientDisconnected, http.StatusRequestTimeout, 0, "client_disconnected", "client disconnected before upstream request", model, nil, nil, 0, 0, false)
				return
			}
			finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditFailed, http.StatusGatewayTimeout, 0, "upstream_timeout", "upstream request timed out", model, nil, nil, 0, 0, false)
			writeModelError(c, http.StatusGatewayTimeout, "upstream_timeout", "Upstream model service timed out")
			return
		}
		request, err := http.NewRequestWithContext(requestContext, http.MethodPost, modelUpstreamURLValue(target.BaseURL, upstreamPath), bytes.NewReader(body))
		if err != nil {
			lastErr = err
			continue
		}
		copyModelProxyRequestHeaders(request.Header, c.Request.Header)
		request.Header.Set("Authorization", "Bearer "+target.APIKey)
		if request.Header.Get("Accept") == "" {
			request.Header.Set("Accept", "application/json")
		}
		response, err := modelProxyHTTPClient.Do(request)
		if err != nil {
			if errors.Is(requestContext.Err(), context.Canceled) {
				finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditClientDisconnected, http.StatusRequestTimeout, 0, "client_disconnected", "client disconnected before upstream response", model, nil, nil, 0, 0, false)
				return
			}
			if errors.Is(requestContext.Err(), context.DeadlineExceeded) {
				finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditFailed, http.StatusGatewayTimeout, 0, "upstream_timeout", "upstream request timed out", model, nil, nil, 0, 0, false)
				writeModelError(c, http.StatusGatewayTimeout, "upstream_timeout", "Upstream model service timed out")
				return
			}
			lastErr = err
			continue
		}
		lastStatus = response.StatusCode
		if index < len(targets)-1 && (response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= http.StatusInternalServerError) {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2<<20))
			_ = response.Body.Close()
			if err := requestContext.Err(); err != nil {
				if errors.Is(err, context.Canceled) {
					finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditClientDisconnected, http.StatusRequestTimeout, lastStatus, "client_disconnected", "client disconnected before failover", model, nil, nil, 0, 0, false)
					return
				}
				finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditFailed, http.StatusGatewayTimeout, lastStatus, "upstream_timeout", "upstream request timed out", model, nil, nil, 0, 0, false)
				writeModelError(c, http.StatusGatewayTimeout, "upstream_timeout", "Upstream model service timed out")
				return
			}
			continue
		}
		forwardModelProxyResponse(c, opts, audit, response, model, requestContext)
		return
	}
	message := "Upstream model service is unavailable"
	status := http.StatusBadGateway
	if lastErr != nil {
		message = lastErr.Error()
	}
	errorCode := "upstream_error"
	if lastErr != nil {
		errorCode = modelProxyTransportErrorCode(lastErr)
		if errorCode == "upstream_timeout" {
			status = http.StatusGatewayTimeout
		}
	}
	finalizeModelAudit(opts, audit, mcpgateway.ModelProxyAuditFailed, status, lastStatus, errorCode, message, model, nil, nil, 0, 0, false)
	if errorCode == "upstream_timeout" {
		writeModelError(c, status, errorCode, "Upstream model service timed out")
	} else {
		writeModelError(c, status, "upstream_error", "Upstream model service is unavailable")
	}
}

func modelUpstreamURLValue(baseURL, path string) string {
	target, err := modelUpstreamURL(baseURL, path)
	if err != nil {
		return ""
	}
	return target
}

func modelProxyRequestContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, modelProxyRequestTimeout)
}

func modelProxyTransportErrorCode(err error) string {
	var networkErr net.Error
	if errors.As(err, &networkErr) && networkErr.Timeout() {
		return "upstream_timeout"
	}
	return "upstream_error"
}

func forwardModelProxyResponse(c *gin.Context, opts Options, audit mcpgateway.ModelProxyAuditRecord, response *http.Response, model string, requestContext context.Context) {
	defer response.Body.Close()
	for key, values := range response.Header {
		if hopByHopModelProxyHeader(key) {
			continue
		}
		for _, value := range values {
			c.Writer.Header().Add(key, value)
		}
	}
	c.Status(response.StatusCode)
	var captured bytes.Buffer
	var responseBytes, responseChunks int64
	var captureTruncated, clientDisconnected bool
	var usageAccumulator modelProxyUsageAccumulator
	finish := func(status mcpgateway.ModelProxyAuditStatus, gatewayStatus, upstreamStatus int, errorCode, errorMessage string, extraTruncated bool) {
		usage := usageAccumulator.Finalize()
		finalizeModelAuditWithUsage(opts, audit, status, gatewayStatus, upstreamStatus, errorCode, errorMessage, model, response.Header, captured.Bytes(), responseBytes, responseChunks, extraTruncated, &usage)
	}
	buffer := make([]byte, 32*1024)
	for {
		count, readErr := readModelProxyChunk(requestContext, response.Body, buffer)
		if count > 0 {
			if audit.FirstByteMS == 0 {
				audit.FirstByteMS = time.Since(audit.CreatedAt).Milliseconds()
			}
			responseBytes += int64(count)
			responseChunks++
			usageAccumulator.Consume(buffer[:count])
			if captured.Len() < modelProxyAuditSnapshotLimit*2 {
				remaining := modelProxyAuditSnapshotLimit*2 - captured.Len()
				if count <= remaining {
					_, _ = captured.Write(buffer[:count])
				} else {
					_, _ = captured.Write(buffer[:remaining])
					captureTruncated = true
				}
			} else {
				captureTruncated = true
			}
			if _, writeErr := c.Writer.Write(buffer[:count]); writeErr != nil {
				clientDisconnected = true
				break
			}
			if flusher, ok := c.Writer.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if errors.Is(readErr, context.Canceled) {
				finish(mcpgateway.ModelProxyAuditClientDisconnected, response.StatusCode, response.StatusCode, "client_disconnected", "client disconnected while streaming response", captureTruncated)
				return
			}
			if errors.Is(readErr, errModelProxyStreamIdleTimeout) || errors.Is(readErr, context.DeadlineExceeded) {
				finish(mcpgateway.ModelProxyAuditFailed, http.StatusGatewayTimeout, response.StatusCode, "upstream_timeout", "upstream response stream was idle", captureTruncated)
				return
			}
			if !errors.Is(readErr, io.EOF) {
				finish(mcpgateway.ModelProxyAuditFailed, http.StatusBadGateway, response.StatusCode, "upstream_error", "upstream response could not be read", captureTruncated)
				return
			}
			break
		}
	}
	if clientDisconnected {
		finish(mcpgateway.ModelProxyAuditClientDisconnected, response.StatusCode, response.StatusCode, "client_disconnected", "client disconnected while streaming response", captureTruncated)
		return
	}
	status := mcpgateway.ModelProxyAuditSucceeded
	errorCode := ""
	errorMessage := ""
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		status = mcpgateway.ModelProxyAuditFailed
		if response.StatusCode == http.StatusTooManyRequests {
			errorCode = "upstream_rate_limited"
		} else {
			errorCode = "upstream_error"
		}
		errorMessage = "upstream model service returned an error"
	}
	finish(status, response.StatusCode, response.StatusCode, errorCode, errorMessage, captureTruncated)
}

type modelProxyReadResult struct {
	count int
	err   error
}

func readModelProxyChunk(ctx context.Context, body io.ReadCloser, buffer []byte) (int, error) {
	result := make(chan modelProxyReadResult, 1)
	go func() {
		count, err := body.Read(buffer)
		result <- modelProxyReadResult{count: count, err: err}
	}()
	timer := time.NewTimer(modelProxyStreamIdleTimeout)
	defer timer.Stop()
	select {
	case value := <-result:
		return value.count, value.err
	case <-ctx.Done():
		_ = body.Close()
		return 0, ctx.Err()
	case <-timer.C:
		_ = body.Close()
		return 0, errModelProxyStreamIdleTimeout
	}
}

func decodeModelRequestBody(raw []byte) (map[string]any, error) {
	var payload map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		return nil, errors.New("invalid model request body")
	}
	return payload, nil
}

func modelFromPayload(payload map[string]any) string {
	model, _ := payload["model"].(string)
	return strings.TrimSpace(model)
}

func modelRequestType(raw []byte) string {
	if len(raw) == 0 {
		return "list"
	}
	payload, err := decodeModelRequestBody(raw)
	if err != nil {
		return "unknown"
	}
	if stream, ok := payload["stream"].(bool); ok && stream {
		return "stream"
	}
	return "non_stream"
}

func modelUpstreamURL(baseURL, path string) (string, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", fmt.Errorf("invalid model upstream URL")
	}
	return baseURL + "/" + strings.TrimLeft(path, "/"), nil
}

func copyModelProxyRequestHeaders(destination, source http.Header) {
	for key, values := range source {
		if hopByHopModelProxyHeader(key) || strings.EqualFold(key, "Authorization") || strings.EqualFold(key, "Cookie") || strings.EqualFold(key, "Host") {
			continue
		}
		for _, value := range values {
			destination.Add(key, value)
		}
	}
}

func hopByHopModelProxyHeader(key string) bool {
	switch strings.ToLower(key) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}

func finalizeModelAudit(opts Options, record mcpgateway.ModelProxyAuditRecord, status mcpgateway.ModelProxyAuditStatus, gatewayStatus, upstreamStatus int, errorCode, errorMessage, model string, responseHeaders http.Header, responseRaw []byte, responseBytes, responseChunks int64, extraTruncated bool) {
	finalizeModelAuditWithUsage(opts, record, status, gatewayStatus, upstreamStatus, errorCode, errorMessage, model, responseHeaders, responseRaw, responseBytes, responseChunks, extraTruncated, nil)
}

func finalizeModelAuditWithUsage(opts Options, record mcpgateway.ModelProxyAuditRecord, status mcpgateway.ModelProxyAuditStatus, gatewayStatus, upstreamStatus int, errorCode, errorMessage, model string, responseHeaders http.Header, responseRaw []byte, responseBytes, responseChunks int64, extraTruncated bool, usageOverride *modelProxyUsage) {
	responseBody, responseTruncated := snapshotModelProxyBody(responseRaw)
	usage := modelProxyUsage{}
	if usageOverride != nil {
		usage = *usageOverride
	}
	if !usage.available {
		usage = extractModelProxyUsageBytesDetailed(responseRaw)
	}
	if model == "" {
		model = record.Model
	}
	completedAt := time.Now().UTC()
	_, err := opts.ProxyGateway.Store().FinalizeModelProxyAuditRecord(context.Background(), mcpgateway.ModelProxyAuditFinalize{
		AuditID:             record.AuditID,
		Status:              status,
		Model:               model,
		RequestedModel:      record.RequestedModel,
		UpstreamModel:       model,
		ResponseModel:       usage.responseModel,
		GatewayStatus:       gatewayStatus,
		UpstreamStatus:      upstreamStatus,
		ErrorCode:           errorCode,
		ErrorMessage:        errorMessage,
		InputTokens:         usage.inputTokens,
		OutputTokens:        usage.outputTokens,
		TotalTokens:         usage.totalTokens,
		CacheReadTokens:     usage.cacheReadTokens,
		CacheCreationTokens: usage.cacheCreationTokens,
		ReasoningTokens:     usage.reasoningTokens,
		UsageAvailable:      usage.available,
		UsageStatus:         usage.status,
		UsageSource:         usage.source,
		ResponseHeaders:     sanitizeModelProxyHeaders(responseHeaders),
		ResponseBody:        responseBody,
		ResponseBytes:       responseBytes,
		ResponseChunks:      responseChunks,
		Truncated:           record.Truncated || responseTruncated || extraTruncated,
		DurationMS:          completedAt.Sub(record.CreatedAt).Milliseconds(),
		FirstByteMS:         record.FirstByteMS,
		CompletedAt:         completedAt,
	})
	if err != nil && opts.Logger != nil {
		opts.Logger.Error("model_audit_finalize_failed", zap.String("audit_id", record.AuditID), zap.String("request_id", record.RequestID), zap.Error(err))
	}
}

func writeModelError(c *gin.Context, status int, code, message string) {
	errorType := "invalid_request_error"
	switch code {
	case "invalid_api_key", "api_key_inactive", "model_auth_unavailable":
		errorType = "authentication_error"
	case "account_disabled", "model_scope_required":
		errorType = "permission_denied"
	case "model_gateway_unavailable", "model_audit_unavailable", "model_group_unavailable", "model_catalog_empty", "upstream_error", "upstream_timeout":
		errorType = "internal_error"
	}
	c.JSON(status, gin.H{"error": gin.H{"message": message, "type": errorType, "code": code}, "request_id": requestIDFromContext(c.Request.Context())})
}

func newModelProxyAuditID() string {
	sequence := atomic.AddUint64(&modelProxyAuditSequence, 1)
	return fmt.Sprintf("model_audit_%d_%d", time.Now().UnixNano(), sequence)
}
