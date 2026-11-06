package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/textutil"
)

type modelUpstreamAccountRequest struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	BaseURL      string   `json:"base_url"`
	APIKey       string   `json:"api_key"`
	Models       []string `json:"models"`
	SyncedModels []string `json:"synced_models"`
	ManualModels []string `json:"manual_models"`
	Status       string   `json:"status"`
}

type modelGroupAccountRequest struct {
	UpstreamAccountID string `json:"upstream_account_id"`
	Priority          int    `json:"priority"`
	Weight            int    `json:"weight"`
}

type modelGroupRequest struct {
	ID            string                     `json:"id"`
	Name          string                     `json:"name"`
	RouteStrategy string                     `json:"route_strategy"`
	DefaultModel  string                     `json:"default_model"`
	Status        string                     `json:"status"`
	Accounts      []modelGroupAccountRequest `json:"accounts"`
}

type modelUpstreamAccountResponse struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	BaseURL        string     `json:"base_url"`
	Models         []string   `json:"models"`
	SyncedModels   []string   `json:"synced_models"`
	ManualModels   []string   `json:"manual_models"`
	ModelSyncAt    *time.Time `json:"model_sync_at,omitempty"`
	ModelSyncError string     `json:"model_sync_error,omitempty"`
	Status         string     `json:"status"`
	HealthStatus   string     `json:"health_status"`
	HasAPIKey      bool       `json:"has_api_key"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

type modelGroupAccountResponse struct {
	UpstreamAccountID string   `json:"upstream_account_id"`
	Name              string   `json:"name"`
	BaseURL           string   `json:"base_url"`
	Models            []string `json:"models"`
	Status            string   `json:"status"`
	HealthStatus      string   `json:"health_status"`
	Priority          int      `json:"priority"`
	Weight            int      `json:"weight"`
}

type modelGroupResponse struct {
	ID            string                      `json:"id"`
	Name          string                      `json:"name"`
	RouteStrategy string                      `json:"route_strategy"`
	DefaultModel  string                      `json:"default_model"`
	Status        string                      `json:"status"`
	Accounts      []modelGroupAccountResponse `json:"accounts"`
	CreatedAt     time.Time                   `json:"created_at"`
	UpdatedAt     time.Time                   `json:"updated_at"`
}

func mountModelUpstreamAdminRoutes(admin *gin.RouterGroup, opts Options) {
	read := requirePermission(opts.RBACService, rbac.PermissionMCPUpstreamRead)
	store := opts.ModelUpstreamStore

	admin.GET("/model-proxy/upstream-accounts", read, func(c *gin.Context) {
		if store == nil {
			modelUpstreamAdminUnavailable(c)
			return
		}
		items, err := store.ListModelUpstreamAccounts(c.Request.Context())
		if err != nil {
			modelUpstreamAdminError(c, err)
			return
		}
		out := make([]modelUpstreamAccountResponse, 0, len(items))
		for _, item := range items {
			out = append(out, modelUpstreamAccountResponseFrom(item))
		}
		c.JSON(http.StatusOK, gin.H{"items": out})
	})

	admin.POST("/model-proxy/upstream-accounts", requirePermission(opts.RBACService, rbac.PermissionMCPUpstreamCreate), func(c *gin.Context) {
		if store == nil {
			modelUpstreamAdminUnavailable(c)
			return
		}
		var req modelUpstreamAccountRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			modelUpstreamAdminBadRequest(c, err)
			return
		}
		account, err := modelUpstreamAccountFromRequest(c, store, opts.ModelCredentialCipher, req, false)
		if err != nil {
			modelUpstreamAdminBadRequest(c, err)
			return
		}
		if err := store.SaveModelUpstreamAccount(c.Request.Context(), account); err != nil {
			modelUpstreamAdminError(c, err)
			return
		}
		created, err := store.GetModelUpstreamAccount(c.Request.Context(), account.ID)
		if err != nil {
			modelUpstreamAdminError(c, err)
			return
		}
		c.JSON(http.StatusCreated, modelUpstreamAccountResponseFrom(created))
	})

	admin.PUT("/model-proxy/upstream-accounts", requirePermission(opts.RBACService, rbac.PermissionMCPUpstreamUpdate), func(c *gin.Context) {
		if store == nil {
			modelUpstreamAdminUnavailable(c)
			return
		}
		var req modelUpstreamAccountRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			modelUpstreamAdminBadRequest(c, err)
			return
		}
		account, err := modelUpstreamAccountFromRequest(c, store, opts.ModelCredentialCipher, req, true)
		if err != nil {
			modelUpstreamAdminBadRequest(c, err)
			return
		}
		if err := store.SaveModelUpstreamAccount(c.Request.Context(), account); err != nil {
			modelUpstreamAdminError(c, err)
			return
		}
		updated, err := store.GetModelUpstreamAccount(c.Request.Context(), account.ID)
		if err != nil {
			modelUpstreamAdminError(c, err)
			return
		}
		c.JSON(http.StatusOK, modelUpstreamAccountResponseFrom(updated))
	})

	admin.POST("/model-proxy/upstream-accounts/preview-models", requirePermission(opts.RBACService, rbac.PermissionMCPUpstreamUpdate), func(c *gin.Context) {
		var req struct {
			BaseURL string `json:"base_url"`
			APIKey  string `json:"api_key"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			modelUpstreamAdminBadRequest(c, err)
			return
		}
		baseURL := strings.TrimRight(textutil.TrimInput(req.BaseURL), "/")
		apiKey := strings.TrimSpace(req.APIKey)
		if baseURL == "" || apiKey == "" {
			modelUpstreamAdminBadRequest(c, errors.New("base_url and api_key are required"))
			return
		}
		models, err := fetchModelUpstreamModels(c.Request.Context(), baseURL, apiKey)
		if err != nil {
			modelUpstreamAdminError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"models": models})
	})

	admin.POST("/model-proxy/upstream-accounts/sync", requirePermission(opts.RBACService, rbac.PermissionMCPUpstreamUpdate), func(c *gin.Context) {
		if store == nil {
			modelUpstreamAdminUnavailable(c)
			return
		}
		var req struct {
			ID string `json:"id"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.ID) == "" {
			modelUpstreamAdminBadRequest(c, errors.New("id is required"))
			return
		}
		account, err := syncModelUpstreamAccount(c.Request.Context(), store, opts.ModelCredentialCipher, strings.TrimSpace(req.ID))
		if err != nil {
			modelUpstreamAdminError(c, err)
			return
		}
		c.JSON(http.StatusOK, modelUpstreamAccountResponseFrom(account))
	})

	admin.POST("/model-proxy/upstream-accounts/test", requirePermission(opts.RBACService, rbac.PermissionMCPUpstreamUpdate), func(c *gin.Context) {
		if store == nil {
			modelUpstreamAdminUnavailable(c)
			return
		}
		var req struct {
			ID string `json:"id"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.ID) == "" {
			modelUpstreamAdminBadRequest(c, errors.New("id is required"))
			return
		}
		result, err := testModelUpstreamAccount(c.Request.Context(), store, opts.ModelCredentialCipher, strings.TrimSpace(req.ID))
		if err != nil {
			modelUpstreamAdminError(c, err)
			return
		}
		c.JSON(http.StatusOK, result)
	})

	admin.POST("/model-proxy/upstream-accounts/remove", requirePermission(opts.RBACService, rbac.PermissionMCPUpstreamDelete), func(c *gin.Context) {
		if store == nil {
			modelUpstreamAdminUnavailable(c)
			return
		}
		var req struct {
			ID string `json:"id"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.ID) == "" {
			modelUpstreamAdminBadRequest(c, errors.New("id is required"))
			return
		}
		if err := store.DeleteModelUpstreamAccount(c.Request.Context(), strings.TrimSpace(req.ID)); err != nil {
			modelUpstreamAdminError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})

	admin.GET("/model-proxy/groups", read, func(c *gin.Context) {
		if store == nil {
			modelUpstreamAdminUnavailable(c)
			return
		}
		items, err := store.ListModelGroups(c.Request.Context())
		if err != nil {
			modelUpstreamAdminError(c, err)
			return
		}
		out := make([]modelGroupResponse, 0, len(items))
		for _, item := range items {
			out = append(out, modelGroupResponseFrom(item))
		}
		c.JSON(http.StatusOK, gin.H{"items": out})
	})

	admin.POST("/model-proxy/groups", requirePermission(opts.RBACService, rbac.PermissionMCPUpstreamCreate), saveModelGroupHandler(store))
	admin.PUT("/model-proxy/groups", requirePermission(opts.RBACService, rbac.PermissionMCPUpstreamUpdate), saveModelGroupHandler(store))
	admin.POST("/model-proxy/groups/remove", requirePermission(opts.RBACService, rbac.PermissionMCPUpstreamDelete), func(c *gin.Context) {
		if store == nil {
			modelUpstreamAdminUnavailable(c)
			return
		}
		var req struct {
			ID string `json:"id"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.ID) == "" {
			modelUpstreamAdminBadRequest(c, errors.New("id is required"))
			return
		}
		if strings.TrimSpace(req.ID) == "default" {
			modelUpstreamAdminBadRequest(c, errors.New("default group cannot be deleted"))
			return
		}
		if err := store.DeleteModelGroup(c.Request.Context(), strings.TrimSpace(req.ID)); err != nil {
			modelUpstreamAdminError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	})
}

func saveModelGroupHandler(store mcpgateway.ModelUpstreamStore) gin.HandlerFunc {
	return func(c *gin.Context) {
		if store == nil {
			modelUpstreamAdminUnavailable(c)
			return
		}
		var req modelGroupRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			modelUpstreamAdminBadRequest(c, err)
			return
		}
		id := textutil.CleanInputIdentifier(req.ID)
		if id == "" {
			id = newModelRoutingID("group")
		}
		name := textutil.TrimInput(req.Name)
		if name == "" {
			modelUpstreamAdminBadRequest(c, errors.New("name is required"))
			return
		}
		strategy := strings.TrimSpace(req.RouteStrategy)
		if strategy == "" {
			strategy = mcpgateway.ModelGroupRouteFailover
		}
		if strategy != mcpgateway.ModelGroupRouteFailover && strategy != mcpgateway.ModelGroupRouteRoundRobin {
			modelUpstreamAdminBadRequest(c, errors.New("invalid route_strategy"))
			return
		}
		status := strings.TrimSpace(req.Status)
		if status == "" {
			status = mcpgateway.ModelGroupStatusActive
		}
		if status != mcpgateway.ModelGroupStatusActive && status != mcpgateway.ModelGroupStatusDisabled {
			modelUpstreamAdminBadRequest(c, errors.New("invalid status"))
			return
		}
		now := time.Now().UTC()
		createdAt := now
		if existing, err := store.GetModelGroup(c.Request.Context(), id); err == nil {
			createdAt = existing.CreatedAt
		}
		accounts := make([]mcpgateway.ModelGroupAccount, 0, len(req.Accounts))
		for index, member := range req.Accounts {
			accountID := textutil.CleanInputIdentifier(member.UpstreamAccountID)
			if accountID == "" {
				modelUpstreamAdminBadRequest(c, errors.New("upstream_account_id is required"))
				return
			}
			if _, err := store.GetModelUpstreamAccount(c.Request.Context(), accountID); err != nil {
				modelUpstreamAdminBadRequest(c, fmt.Errorf("upstream account %s is unavailable", accountID))
				return
			}
			weight := member.Weight
			if weight <= 0 {
				weight = 1
			}
			priority := member.Priority
			if priority < 0 {
				priority = index
			}
			accounts = append(accounts, mcpgateway.ModelGroupAccount{UpstreamAccountID: accountID, Priority: priority, Weight: weight})
		}
		config := mcpgateway.ModelGroupConfig{
			ModelGroup: mcpgateway.ModelGroup{ID: id, Name: name, RouteStrategy: strategy, DefaultModel: textutil.TrimInput(req.DefaultModel), Status: status, CreatedAt: createdAt, UpdatedAt: now},
			Accounts:   accounts,
		}
		if err := store.SaveModelGroup(c.Request.Context(), config); err != nil {
			modelUpstreamAdminError(c, err)
			return
		}
		stored, err := store.GetModelGroup(c.Request.Context(), id)
		if err != nil {
			modelUpstreamAdminError(c, err)
			return
		}
		statusCode := http.StatusOK
		if req.ID == "" {
			statusCode = http.StatusCreated
		}
		c.JSON(statusCode, modelGroupResponseFrom(stored))
	}
}

func modelUpstreamAccountFromRequest(c *gin.Context, store mcpgateway.ModelUpstreamStore, cipher mcpgateway.TokenCipher, req modelUpstreamAccountRequest, update bool) (mcpgateway.ModelUpstreamAccount, error) {
	id := textutil.CleanInputIdentifier(req.ID)
	if id == "" {
		if update {
			return mcpgateway.ModelUpstreamAccount{}, errors.New("id is required")
		}
		id = newModelRoutingID("upstream")
	}
	name := textutil.TrimInput(req.Name)
	baseURL := strings.TrimRight(textutil.TrimInput(req.BaseURL), "/")
	if name == "" || baseURL == "" {
		return mcpgateway.ModelUpstreamAccount{}, errors.New("name and base_url are required")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return mcpgateway.ModelUpstreamAccount{}, errors.New("base_url must be an http or https URL")
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = mcpgateway.ModelGroupStatusActive
	}
	if status != mcpgateway.ModelGroupStatusActive && status != mcpgateway.ModelGroupStatusDisabled {
		return mcpgateway.ModelUpstreamAccount{}, errors.New("invalid status")
	}
	now := time.Now().UTC()
	manualModels := normalizeModelNames(req.ManualModels)
	if req.ManualModels == nil {
		manualModels = normalizeModelNames(req.Models)
	}
	account := mcpgateway.ModelUpstreamAccount{ID: id, Name: name, BaseURL: baseURL, ManualModels: manualModels, Status: status, HealthStatus: "unknown", CreatedAt: now, UpdatedAt: now}
	if existing, err := store.GetModelUpstreamAccount(c.Request.Context(), id); err == nil {
		account.CreatedAt = existing.CreatedAt
		account.HealthStatus = existing.HealthStatus
		account.APIKeyCiphertext = existing.APIKeyCiphertext
		account.SyncedModels = existing.SyncedModels
		account.ModelSyncAt = existing.ModelSyncAt
		account.ModelSyncError = existing.ModelSyncError
		if req.ManualModels == nil && req.Models == nil {
			account.ManualModels = existing.ManualModels
		}
	} else if update && !errors.Is(err, mcpgateway.ErrModelUpstreamAccountNotFound) {
		return mcpgateway.ModelUpstreamAccount{}, err
	} else if update {
		return mcpgateway.ModelUpstreamAccount{}, mcpgateway.ErrModelUpstreamAccountNotFound
	}
	if req.SyncedModels != nil {
		account.SyncedModels = normalizeModelNames(req.SyncedModels)
		account.ModelSyncAt = &now
		account.ModelSyncError = ""
		account.HealthStatus = "healthy"
	}
	if strings.TrimSpace(req.APIKey) != "" {
		if cipher == nil {
			return mcpgateway.ModelUpstreamAccount{}, errors.New("model credential cipher is not configured")
		}
		account.APIKeyCiphertext, err = cipher.Encrypt([]byte(strings.TrimSpace(req.APIKey)))
		if err != nil {
			return mcpgateway.ModelUpstreamAccount{}, err
		}
	}
	mcpgateway.NormalizeModelUpstreamAccount(&account)
	return account, nil
}

func normalizeModelNames(models []string) []string {
	seen := make(map[string]struct{}, len(models))
	out := make([]string, 0, len(models))
	for _, model := range models {
		model = textutil.TrimInput(model)
		if model == "" {
			continue
		}
		if _, ok := seen[model]; ok {
			continue
		}
		seen[model] = struct{}{}
		out = append(out, model)
	}
	return out
}

func modelUpstreamAccountResponseFrom(account mcpgateway.ModelUpstreamAccount) modelUpstreamAccountResponse {
	mcpgateway.NormalizeModelUpstreamAccount(&account)
	return modelUpstreamAccountResponse{ID: account.ID, Name: account.Name, BaseURL: account.BaseURL, Models: account.Models, SyncedModels: account.SyncedModels, ManualModels: account.ManualModels, ModelSyncAt: account.ModelSyncAt, ModelSyncError: account.ModelSyncError, Status: account.Status, HealthStatus: account.HealthStatus, HasAPIKey: len(account.APIKeyCiphertext) > 0, CreatedAt: account.CreatedAt, UpdatedAt: account.UpdatedAt}
}

func modelGroupResponseFrom(config mcpgateway.ModelGroupConfig) modelGroupResponse {
	accounts := make([]modelGroupAccountResponse, 0, len(config.Accounts))
	for _, account := range config.Accounts {
		accounts = append(accounts, modelGroupAccountResponse{UpstreamAccountID: account.UpstreamAccountID, Name: account.Name, BaseURL: account.BaseURL, Models: account.Models, Status: account.Status, HealthStatus: account.HealthStatus, Priority: account.Priority, Weight: account.Weight})
	}
	return modelGroupResponse{ID: config.ID, Name: config.Name, RouteStrategy: config.RouteStrategy, DefaultModel: config.DefaultModel, Status: config.Status, Accounts: accounts, CreatedAt: config.CreatedAt, UpdatedAt: config.UpdatedAt}
}

func modelUpstreamAdminUnavailable(c *gin.Context) {
	c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{"code": "model_upstream_unavailable", "message": "模型上游管理暂不可用", "details": []any{}}})
}

func modelUpstreamAdminBadRequest(c *gin.Context, err error) {
	c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "invalid_model_upstream_request", "message": err.Error(), "details": []any{}}})
}

func modelUpstreamAdminError(c *gin.Context, err error) {
	status := http.StatusInternalServerError
	if errors.Is(err, mcpgateway.ErrModelGroupNotFound) || errors.Is(err, mcpgateway.ErrModelUpstreamAccountNotFound) {
		status = http.StatusNotFound
	}
	c.JSON(status, gin.H{"error": gin.H{"code": "model_upstream_request_failed", "message": err.Error(), "details": []any{}}})
}

func newModelRoutingID(prefix string) string {
	return fmt.Sprintf("%s_%d", prefix, time.Now().UTC().UnixNano())
}

func syncModelUpstreamAccount(ctx context.Context, store mcpgateway.ModelUpstreamStore, cipher mcpgateway.TokenCipher, id string) (mcpgateway.ModelUpstreamAccount, error) {
	account, err := store.GetModelUpstreamAccount(ctx, id)
	if err != nil {
		return mcpgateway.ModelUpstreamAccount{}, err
	}
	if cipher == nil || len(account.APIKeyCiphertext) == 0 {
		return mcpgateway.ModelUpstreamAccount{}, errors.New("model upstream api key is not configured")
	}
	apiKey, err := cipher.Decrypt(account.APIKeyCiphertext)
	if err != nil {
		return mcpgateway.ModelUpstreamAccount{}, errors.New("model upstream api key could not be decrypted")
	}
	models, err := fetchModelUpstreamModels(ctx, account.BaseURL, string(apiKey))
	if err != nil {
		return saveModelUpstreamSyncFailure(ctx, store, account, err)
	}
	now := time.Now().UTC()
	account.SyncedModels = models
	account.ModelSyncAt = &now
	account.ModelSyncError = ""
	account.HealthStatus = "healthy"
	mcpgateway.NormalizeModelUpstreamAccount(&account)
	account.UpdatedAt = now
	if err := store.SaveModelUpstreamAccount(ctx, account); err != nil {
		return mcpgateway.ModelUpstreamAccount{}, err
	}
	return store.GetModelUpstreamAccount(ctx, account.ID)
}

func fetchModelUpstreamModels(ctx context.Context, baseURL, apiKey string) ([]string, error) {
	target, err := modelUpstreamURL(baseURL, "/models")
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Accept", "application/json")
	response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("upstream models request returned %d", response.StatusCode)
	}
	return parseUpstreamModelNames(body)
}

func testModelUpstreamAccount(ctx context.Context, store mcpgateway.ModelUpstreamStore, cipher mcpgateway.TokenCipher, id string) (gin.H, error) {
	account, err := store.GetModelUpstreamAccount(ctx, id)
	if err != nil {
		return nil, err
	}
	if cipher == nil || len(account.APIKeyCiphertext) == 0 {
		return nil, errors.New("model upstream api key is not configured")
	}
	apiKey, err := cipher.Decrypt(account.APIKeyCiphertext)
	if err != nil {
		return nil, errors.New("model upstream api key could not be decrypted")
	}
	mcpgateway.NormalizeModelUpstreamAccount(&account)
	if len(account.Models) == 0 {
		return nil, errors.New("model upstream has no available models")
	}
	target, err := modelUpstreamURL(account.BaseURL, "/responses")
	if err != nil {
		return nil, err
	}
	payloadData := map[string]any{
		"model": account.Models[0],
		"input": []map[string]string{{
			"role":    "user",
			"content": "请只回复 OK",
		}},
		"stream": true,
		"store":  false,
	}
	payload, err := json.Marshal(payloadData)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+string(apiKey))
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Content-Type", "application/json")
	startedAt := time.Now()
	response, err := (&http.Client{Timeout: 30 * time.Second}).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return nil, fmt.Errorf("upstream responses request returned %d", response.StatusCode)
	}
	if contentType := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])); contentType != "text/event-stream" {
		return nil, errors.New("upstream responses content type is not text/event-stream")
	}
	reply, err := parseModelUpstreamResponsesStream(response.Body)
	if err != nil {
		return nil, err
	}
	return gin.H{
		"model":      account.Models[0],
		"reply":      reply,
		"latency_ms": time.Since(startedAt).Milliseconds(),
	}, nil
}

func parseModelUpstreamResponsesStream(body io.Reader) (string, error) {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 4<<10), 2<<20)
	var eventName string
	var data strings.Builder
	var reply strings.Builder
	var completed, emitted bool
	flush := func() error {
		if data.Len() == 0 {
			eventName = ""
			return nil
		}
		if strings.TrimSpace(data.String()) == "[DONE]" {
			data.Reset()
			eventName = ""
			return nil
		}
		var event struct {
			Type  string `json:"type"`
			Delta string `json:"delta"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error,omitempty"`
		}
		if err := json.Unmarshal([]byte(data.String()), &event); err != nil {
			return errors.New("upstream responses event is invalid")
		}
		typeName := event.Type
		if typeName == "" {
			typeName = eventName
		}
		switch typeName {
		case "response.output_text.delta":
			if strings.TrimSpace(event.Delta) != "" {
				reply.WriteString(event.Delta)
				emitted = true
			}
		case "response.completed":
			completed = true
		case "error", "response.failed", "response.incomplete":
			if event.Error != nil && strings.TrimSpace(event.Error.Message) != "" {
				return fmt.Errorf("upstream responses request failed: %s", strings.TrimSpace(event.Error.Message))
			}
			return fmt.Errorf("upstream responses request failed: %s", typeName)
		}
		data.Reset()
		eventName = ""
		return nil
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		switch {
		case line == "":
			if err := flush(); err != nil {
				return "", err
			}
		case strings.HasPrefix(line, "event:"):
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	if err := flush(); err != nil {
		return "", err
	}
	if !emitted || !completed {
		return "", errors.New("upstream responses stream ended before completion")
	}
	return strings.TrimSpace(reply.String()), nil
}

func parseModelUpstreamTestReply(body []byte) (string, error) {
	var payload struct {
		Choices []struct {
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
			Text string `json:"text"`
		} `json:"choices"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", errors.New("upstream chat response is invalid")
	}
	if strings.TrimSpace(payload.Error.Message) != "" {
		return "", fmt.Errorf("upstream chat request failed: %s", strings.TrimSpace(payload.Error.Message))
	}
	if len(payload.Choices) == 0 {
		return "", errors.New("upstream chat response is empty")
	}
	choice := payload.Choices[0]
	if strings.TrimSpace(choice.Text) != "" {
		return strings.TrimSpace(choice.Text), nil
	}
	if content := modelUpstreamContentText(choice.Message.Content); content != "" {
		return content, nil
	}
	return "", errors.New("upstream chat response has no text")
}

func modelUpstreamContentText(raw json.RawMessage) string {
	var content string
	if err := json.Unmarshal(raw, &content); err == nil {
		return strings.TrimSpace(content)
	}

	var parts []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err != nil {
		return ""
	}
	texts := make([]string, 0, len(parts))
	for _, part := range parts {
		if strings.TrimSpace(part.Text) != "" {
			texts = append(texts, part.Text)
		}
	}
	return strings.TrimSpace(strings.Join(texts, ""))
}

func saveModelUpstreamSyncFailure(ctx context.Context, store mcpgateway.ModelUpstreamStore, account mcpgateway.ModelUpstreamAccount, syncErr error) (mcpgateway.ModelUpstreamAccount, error) {
	now := time.Now().UTC()
	account.ModelSyncError = syncErr.Error()
	account.HealthStatus = "unhealthy"
	account.UpdatedAt = now
	_ = store.SaveModelUpstreamAccount(ctx, account)
	return mcpgateway.ModelUpstreamAccount{}, syncErr
}

func parseUpstreamModelNames(body []byte) ([]string, error) {
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []string `json:"models"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, errors.New("upstream models response is invalid")
	}
	models := make([]string, 0, len(payload.Data)+len(payload.Models))
	for _, item := range payload.Data {
		models = append(models, item.ID)
	}
	models = append(models, payload.Models...)
	models = normalizeModelNames(models)
	if len(models) == 0 {
		return nil, errors.New("upstream models response is empty")
	}
	return models, nil
}
