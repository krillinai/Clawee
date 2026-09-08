package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/agentactivitymcp"
	"github.com/krillinai/Clawee/server/internal/businessdatamcp"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/management"
)

type appAccountTokenActionRequest struct {
	AgentID   json.RawMessage `json:"agent_id"`
	UserID    json.RawMessage `json:"user_id"`
	ExpiresAt *time.Time      `json:"expires_at"`
	Scopes    []string        `json:"scopes"`
}

type appAgentActionRequest struct {
	AgentID string `json:"agent_id"`
}

type appAgentNameUpdateRequest struct {
	AgentID string `json:"agent_id"`
	Name    string `json:"name"`
}

type appMCPCatalogResponse struct {
	Upstreams []appMCPUpstreamResponse `json:"upstreams"`
}

type appMCPUpstreamResponse struct {
	ID        string               `json:"id"`
	Name      string               `json:"name"`
	Domain    string               `json:"domain"`
	IconURL   string               `json:"icon_url"`
	MCPURL    string               `json:"mcp_endpoint"`
	Transport string               `json:"upstream_transport"`
	Namespace string               `json:"namespace"`
	Status    string               `json:"status"`
	Tools     []appMCPToolResponse `json:"tools"`
}

type appMCPToolResponse struct {
	ID                     string     `json:"id"`
	UpstreamName           string     `json:"upstream_name"`
	Name                   string     `json:"name"`
	ExposedName            string     `json:"exposed_name"`
	Title                  string     `json:"title"`
	Description            string     `json:"description"`
	RiskLevel              string     `json:"risk_level"`
	ConfirmRequired        bool       `json:"confirm_required"`
	Status                 string     `json:"status"`
	Authorized             bool       `json:"authorized"`
	AuthorizationExpiresAt *time.Time `json:"authorization_expires_at"`
}

func handleAccountToken(proxyGateway *mcpgateway.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		if hasUnsupportedAppAccountTokenQuery(c) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		token, err := proxyGateway.Store().GetLatestAccountToken(c.Request.Context(), account.UserID)
		if err != nil {
			agentAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"token": accountTokenMetadataResponse(token)})
	}
}

func handleRevealAccountToken(proxyGateway *mcpgateway.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			return
		}
		if _, ok := bindAppAccountTokenAction(c); !ok {
			return
		}
		copied, err := proxyGateway.CopyActiveAccountToken(c.Request.Context(), account.UserID)
		if err != nil {
			agentAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, accountTokenSecretResponse(copied.Token, copied.Plaintext))
	}
}

func handleRotateAccountToken(proxyGateway *mcpgateway.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			return
		}
		req, ok := bindAppAccountTokenAction(c)
		if !ok {
			return
		}
		scopes := req.Scopes
		if len(scopes) == 0 {
			scopes = []string{"mcp:call"}
		}
		issued, err := proxyGateway.RotateAccountToken(c.Request.Context(), mcpgateway.AccountTokenIssueRequest{
			UserID: account.UserID, ExpiresAt: req.ExpiresAt, Scopes: scopes, Issuer: "claw-mcp-user",
		})
		if err != nil {
			agentAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, accountTokenSecretResponse(issued.Token, issued.Plaintext))
	}
}

func handleRevokeAccountToken(proxyGateway *mcpgateway.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			return
		}
		if _, ok := bindAppAccountTokenAction(c); !ok {
			return
		}
		count, err := proxyGateway.RevokeAccountToken(c.Request.Context(), account.UserID)
		if err != nil {
			agentAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"user_id": account.UserID, "revoked_token_count": count, "token_status": mcpgateway.StatusRevoked})
	}
}

func handleAgentTools(accountSvc *accounts.Service, proxyGateway *mcpgateway.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, agent, ok := currentAccountAgentByID(c, accountSvc, proxyGateway, c.Query("agent_id"))
		if !ok {
			return
		}
		tools, err := proxyGateway.VisibleTools(c.Request.Context(), mcpgateway.AgentIdentity{
			UserID:  account.UserID,
			Subject: account.UserID,
			AgentID: agent.AgentID,
		})
		if err != nil {
			agentAPIError(c, err)
			return
		}
		out := make([]gin.H, 0, len(tools))
		for _, tool := range tools {
			out = append(out, agentToolResponse(tool))
		}
		c.JSON(http.StatusOK, itemsResponse(out))
	}
}

func handleAgentMCPCatalog(accountSvc *accounts.Service, proxyGateway *mcpgateway.Service, dataAccessSvc *dataaccess.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		if hasUnsupportedAppAccountTokenQuery(c) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		account, agent, ok := currentAccountAgentByID(c, accountSvc, proxyGateway, "")
		if !ok {
			return
		}
		upstreams, err := proxyGateway.AuthorizedToolCatalog(c.Request.Context(), mcpgateway.AgentIdentity{
			UserID:  account.UserID,
			Subject: account.UserID,
			AgentID: agent.AgentID,
		})
		if err != nil {
			agentAPIError(c, err)
			return
		}
		upstreams, err = filterDataAuthorizedMCPUpstreams(c.Request.Context(), dataAccessSvc, account.UserID, upstreams)
		if err != nil {
			abortAuthorizationError(c, http.StatusServiceUnavailable, "data_authorization_unavailable", "数据授权服务不可用")
			return
		}
		out := make([]appMCPUpstreamResponse, 0, len(upstreams))
		for _, upstream := range upstreams {
			tools := make([]appMCPToolResponse, 0, len(upstream.Tools))
			for _, tool := range upstream.Tools {
				tools = append(tools, appMCPToolResponse{
					ID: tool.ID, UpstreamName: tool.UpstreamName, Name: tool.Name, ExposedName: tool.ExposedName,
					Title: tool.Title, Description: tool.Description,
					RiskLevel: tool.RiskLevel, ConfirmRequired: tool.ConfirmRequired,
					Status: tool.Status, Authorized: tool.Authorized, AuthorizationExpiresAt: tool.AuthorizationExpiresAt,
				})
			}
			out = append(out, appMCPUpstreamResponse{
				ID: upstream.ID, Name: upstream.Name, Domain: upstream.Domain, Transport: upstream.Transport,
				IconURL: mcpCatalogIconURL(upstream.ID), MCPURL: mcpUpstreamEndpointURL(c.Request, upstream.ID),
				Namespace: upstream.Namespace, Status: upstream.Status, Tools: tools,
			})
		}
		c.JSON(http.StatusOK, appMCPCatalogResponse{Upstreams: out})
	}
}

func filterDataAuthorizedMCPUpstreams(ctx context.Context, service *dataaccess.Service, userID string, upstreams []mcpgateway.ToolCatalogUpstream) ([]mcpgateway.ToolCatalogUpstream, error) {
	if service == nil {
		return excludeDataMCPUpstreams(upstreams, false, false), nil
	}
	grants, err := service.List(ctx, dataaccess.Filter{
		UserID: userID, ResourceType: dataaccess.ResourceDataView, Action: dataaccess.ActionRead,
	})
	if err != nil {
		return nil, err
	}
	allowedViews := make(map[string]bool, len(grants))
	for _, grant := range grants {
		allowedViews[grant.ResourceID] = true
	}
	canReadBusinessData := allowedViews[dataaccess.ViewXiaohongshuOperation] ||
		allowedViews[dataaccess.ViewDouyinAds] || allowedViews[dataaccess.ViewBilibiliOperation]
	return excludeDataMCPUpstreams(upstreams, allowedViews[dataaccess.ViewAgentActivity], canReadBusinessData), nil
}

func excludeDataMCPUpstreams(upstreams []mcpgateway.ToolCatalogUpstream, canReadAgentActivity, canReadBusinessData bool) []mcpgateway.ToolCatalogUpstream {
	out := make([]mcpgateway.ToolCatalogUpstream, 0, len(upstreams))
	for _, upstream := range upstreams {
		if upstream.ID == agentactivitymcp.ServerID && !canReadAgentActivity {
			continue
		}
		if upstream.ID == businessdatamcp.ServerID && !canReadBusinessData {
			continue
		}
		out = append(out, upstream)
	}
	return out
}

func handleAgentList(accountSvc *accounts.Service, proxyGateway *mcpgateway.Service, collectorLookup AgentCollectorLookup) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated"})
			return
		}
		if proxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": errMCPGatewayProxyDisabled.Error()})
			return
		}
		if agent, ok := currentClaweeAgent(c); ok {
			if requestedAgentID := strings.TrimSpace(c.Query("agent_id")); requestedAgentID != "" && requestedAgentID != agent.AgentID {
				abortAuthorizationError(c, http.StatusForbidden, "agent_context_mismatch", "Agent 上下文不匹配")
				return
			}
			item, err := agentAccessItem(c.Request.Context(), collectorLookup, account, agent)
			if err != nil {
				agentAPIError(c, err)
				return
			}
			c.JSON(http.StatusOK, itemsResponse([]gin.H{item}))
			return
		}
		ids, err := accountSvc.AgentIDs(c.Request.Context(), account.UserID)
		if err != nil {
			agentAPIError(c, err)
			return
		}
		items := make([]gin.H, 0, len(ids))
		for _, id := range ids {
			agent, err := proxyGateway.Store().GetAgent(c.Request.Context(), id)
			if err != nil {
				agentAPIError(c, err)
				return
			}
			item, err := agentAccessItem(c.Request.Context(), collectorLookup, account, agent)
			if err != nil {
				agentAPIError(c, err)
				return
			}
			items = append(items, item)
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	}
}

func handleAgentDetail(accountSvc *accounts.Service, proxyGateway *mcpgateway.Service, collectorLookup AgentCollectorLookup) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, agent, ok := currentAccountAgentByID(c, accountSvc, proxyGateway, c.Query("agent_id"))
		if !ok {
			return
		}
		item, err := agentAccessItem(c.Request.Context(), collectorLookup, account, agent)
		if err != nil {
			agentAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	}
}

func handleUpdateAgentName(accountSvc *accounts.Service, proxyGateway *mcpgateway.Service, collectorLookup AgentCollectorLookup) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req appAgentNameUpdateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
			return
		}
		req.AgentID = strings.TrimSpace(req.AgentID)
		if req.AgentID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "agent_id is required"})
			return
		}
		account, agent, ok := currentAccountAgentByID(c, accountSvc, proxyGateway, req.AgentID)
		if !ok {
			return
		}
		updated, err := proxyGateway.UpdateAgentName(c.Request.Context(), agent.AgentID, req.Name)
		if err != nil {
			agentAPIError(c, err)
			return
		}
		item, err := agentAccessItem(c.Request.Context(), collectorLookup, account, updated)
		if err != nil {
			agentAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, item)
	}
}

func handleDeleteAgent(accountSvc *accounts.Service, proxyGateway *mcpgateway.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		req, ok := bindAppAgentAction(c)
		if !ok {
			return
		}
		req.AgentID = strings.TrimSpace(req.AgentID)
		if req.AgentID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "agent_id is required"})
			return
		}
		_, agent, ok := currentAccountAgentByID(c, accountSvc, proxyGateway, req.AgentID)
		if !ok {
			return
		}
		if err := proxyGateway.Store().DeleteAgent(c.Request.Context(), agent.AgentID); err != nil {
			agentAPIError(c, err)
			return
		}
		c.Status(http.StatusNoContent)
	}
}

func handleCreateAgent(accountSvc *accounts.Service, proxyGateway *mcpgateway.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		if principal, ok := currentPrincipal(c); ok && principal.ClientID == accounts.ClientClaweeAgent {
			abortAuthorizationError(c, http.StatusForbidden, "forbidden", "无权访问")
			return
		}
		account, ok := currentAccount(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated"})
			return
		}
		if proxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": errMCPGatewayProxyDisabled.Error()})
			return
		}
		var req registerAgentRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
			return
		}
		if req.UserID != "" && strings.TrimSpace(req.UserID) != account.UserID {
			c.JSON(http.StatusBadRequest, gin.H{"error": "user_id must match current account"})
			return
		}
		req.AgentID = strings.TrimSpace(req.AgentID)
		if req.AgentID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "agent_id is required"})
			return
		}
		agent := mcpgateway.AgentRegistration{
			AgentID: req.AgentID, ClientID: req.ClientID, Name: req.Name, TenantID: req.TenantID,
			ActorID: account.UserID, Status: mcpgateway.StatusActive, CreationSource: mcpgateway.AgentCreationSourceManual,
		}
		err := proxyGateway.CreateOwnedAgent(c.Request.Context(), account.UserID, agent)
		if err != nil {
			agentAPIError(c, err)
			return
		}
		if err := accountSvc.BindAgent(c.Request.Context(), account.UserID, agent.AgentID); err != nil {
			agentAPIError(c, err)
			return
		}
		c.JSON(http.StatusCreated, gin.H{"agent": agentAccessResponse(agent), "account": accountResponse(account, false)})
	}
}

func currentAccountAgentByID(c *gin.Context, accountSvc *accounts.Service, proxyGateway *mcpgateway.Service, requestedAgentID string) (accounts.Account, mcpgateway.AgentRegistration, bool) {
	account, ok := currentAccount(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated"})
		return accounts.Account{}, mcpgateway.AgentRegistration{}, false
	}
	if principal, principalOK := currentPrincipal(c); principalOK && principal.ClientID == accounts.ClientClaweeAgent {
		requestedAgentID = strings.TrimSpace(requestedAgentID)
		if requestedAgentID != "" && requestedAgentID != principal.AgentID {
			abortAuthorizationError(c, http.StatusForbidden, "agent_context_mismatch", "Agent 上下文不匹配")
			return accounts.Account{}, mcpgateway.AgentRegistration{}, false
		}
		if agent, agentOK := currentClaweeAgent(c); agentOK {
			return account, agent, true
		}
	}
	if proxyGateway == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": errMCPGatewayProxyDisabled.Error()})
		return accounts.Account{}, mcpgateway.AgentRegistration{}, false
	}
	agentID := strings.TrimSpace(requestedAgentID)
	var err error
	if agentID != "" {
		owner, ownerErr := accountSvc.AccountForAgent(c.Request.Context(), agentID)
		if ownerErr != nil || owner.UserID != account.UserID {
			agentAPIError(c, accounts.ErrAccountAgentNotFound)
			return accounts.Account{}, mcpgateway.AgentRegistration{}, false
		}
	} else {
		agentID, err = accountSvc.PrimaryAgentID(c.Request.Context(), account.UserID)
	}
	if err != nil {
		agentAPIError(c, err)
		return accounts.Account{}, mcpgateway.AgentRegistration{}, false
	}
	agent, err := proxyGateway.Store().GetAgent(c.Request.Context(), agentID)
	if err != nil {
		agentAPIError(c, err)
		return accounts.Account{}, mcpgateway.AgentRegistration{}, false
	}
	return account, agent, true
}

func bindAppAccountTokenAction(c *gin.Context) (appAccountTokenActionRequest, bool) {
	var req appAccountTokenActionRequest
	if hasUnsupportedAppAccountTokenQuery(c) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return req, false
	}
	if c.Request.Body == nil || c.Request.ContentLength == 0 {
		return req, true
	}
	if err := c.ShouldBindJSON(&req); err != nil && !errors.Is(err, io.EOF) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return appAccountTokenActionRequest{}, false
	}
	if len(req.AgentID) > 0 || len(req.UserID) > 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return appAccountTokenActionRequest{}, false
	}
	return req, true
}

func hasUnsupportedAppAccountTokenQuery(c *gin.Context) bool {
	query := c.Request.URL.Query()
	_, hasAgentID := query["agent_id"]
	_, hasUserID := query["user_id"]
	return hasAgentID || hasUserID
}

func bindAppAgentAction(c *gin.Context) (appAgentActionRequest, bool) {
	var req appAgentActionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return appAgentActionRequest{}, false
	}
	return req, true
}

func agentAccessItem(ctx context.Context, collectorLookup AgentCollectorLookup, account accounts.Account, agent mcpgateway.AgentRegistration) (gin.H, error) {
	response := agentAccessResponse(agent)
	if agent.CreationSource == mcpgateway.AgentCreationSourceCollector && collectorLookup != nil {
		collector, ok, err := collectorLookup.FindAgentCollector(ctx, agent.AgentID, time.Now().UTC(), management.DefaultCollectorOnlineThreshold)
		if err != nil {
			return nil, err
		}
		if ok {
			response["collector"] = collector
			response["Collector"] = collector
		}
	}
	return gin.H{"account": accountResponse(account, false), "agent": response}, nil
}

func agentAPIError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, accounts.ErrInvalidAccountRequest), errors.Is(err, accounts.ErrPasswordTooShort):
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
	case errors.Is(err, mcpgateway.ErrAccountTokenNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "account_token_not_found"})
	case errors.Is(err, accounts.ErrAccountNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "account_not_found"})
	case errors.Is(err, accounts.ErrAccountNotActive):
		c.JSON(http.StatusConflict, gin.H{"error": "account_not_active"})
	case errors.Is(err, mcpgateway.ErrGrantNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "grant_not_found"})
	case errors.Is(err, mcpgateway.ErrGrantAlreadyExists):
		c.JSON(http.StatusConflict, gin.H{"error": "grant_already_exists"})
	case errors.Is(err, accounts.ErrAccountAgentNotFound), errors.Is(err, mcpgateway.ErrAgentNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
	case errors.Is(err, mcpgateway.ErrAgentAlreadyExists):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
	case errors.Is(err, mcpgateway.ErrTokenCipherNotConfigured), errors.Is(err, errMCPGatewayProxyDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}

func agentAccessResponse(agent mcpgateway.AgentRegistration) gin.H {
	return gin.H{
		"agent_id":        agent.AgentID,
		"client_id":       agent.ClientID,
		"tenant_id":       agent.TenantID,
		"actor_id":        agent.ActorID,
		"created_at":      agent.CreatedAt,
		"updated_at":      agent.UpdatedAt,
		"AgentID":         agent.AgentID,
		"ClientID":        agent.ClientID,
		"Name":            agent.Name,
		"TenantID":        agent.TenantID,
		"ActorID":         agent.ActorID,
		"Status":          agent.Status,
		"CreatedAt":       agent.CreatedAt,
		"UpdatedAt":       agent.UpdatedAt,
		"agentId":         agent.AgentID,
		"clientId":        agent.ClientID,
		"name":            agent.Name,
		"tenantId":        agent.TenantID,
		"actorId":         agent.ActorID,
		"status":          agent.Status,
		"creation_source": agent.CreationSource,
		"CreationSource":  agent.CreationSource,
		"creationSource":  agent.CreationSource,
		"createdAt":       agent.CreatedAt,
		"updatedAt":       agent.UpdatedAt,
	}
}

func accountTokenMetadataResponse(token mcpgateway.AccountToken) gin.H {
	return gin.H{
		"user_id":            token.UserID,
		"token_id":           token.ID,
		"token_fingerprint":  token.Fingerprint,
		"token_status":       token.Status,
		"token_expires_at":   token.ExpiresAt,
		"token_last_used_at": token.LastUsedAt,
		"token_issuer":       token.Issuer,
		"token_scopes":       token.Scopes,
		"created_at":         token.CreatedAt,
	}
}

func mcpUpstreamEndpointURL(req *http.Request, upstreamID string) string {
	return mcpEndpointURL(req) + "/servers/" + upstreamID
}

func mcpCatalogIconURL(upstreamID string) string {
	iconPath := "/assets/app-icons/mcp-f654f2a2.png"
	if upstreamID == mcpgateway.KnowledgeAdapterServerID {
		iconPath = "/assets/app-icons/knowledge-base-24aee5a4.png"
	}
	return iconPath
}

func accountTokenSecretResponse(token mcpgateway.AccountToken, plaintext string) gin.H {
	metadata := accountTokenMetadataResponse(token)
	return gin.H{
		"token":                plaintext,
		"token_info":           metadata,
		"authorization_header": "Authorization: Bearer " + plaintext,
	}
}

func agentToolResponse(tool mcpgateway.VisibleTool) gin.H {
	return gin.H{
		"id":                 tool.ID,
		"exposed_name":       tool.Name,
		"title":              tool.Title,
		"description":        tool.Description,
		"upstream_server_id": tool.UpstreamServerID,
		"risk_level":         tool.RiskLevel,
		"confirm_required":   tool.ConfirmRequired,
		"expires_at":         tool.ExpiresAt,
		"input_schema":       tool.InputSchema,
		"output_schema":      tool.OutputSchema,
		"ID":                 tool.ID,
		"Name":               tool.Name,
		"Title":              tool.Title,
		"Description":        tool.Description,
		"UpstreamServerID":   tool.UpstreamServerID,
		"RiskLevel":          tool.RiskLevel,
		"ConfirmRequired":    tool.ConfirmRequired,
		"ExpiresAt":          tool.ExpiresAt,
		"InputSchema":        tool.InputSchema,
		"OutputSchema":       tool.OutputSchema,
		"exposedName":        tool.Name,
		"upstreamServerId":   tool.UpstreamServerID,
		"riskLevel":          tool.RiskLevel,
		"confirmRequired":    tool.ConfirmRequired,
		"expiresAt":          tool.ExpiresAt,
	}
}

func mountAgentRoutes(app *gin.RouterGroup, opts Options) {
	if opts.AccountService == nil {
		return
	}
	list := handleAgentList(opts.AccountService, opts.ProxyGateway, opts.AgentCollectorLookup)
	detail := handleAgentDetail(opts.AccountService, opts.ProxyGateway, opts.AgentCollectorLookup)
	updateName := handleUpdateAgentName(opts.AccountService, opts.ProxyGateway, opts.AgentCollectorLookup)
	remove := handleDeleteAgent(opts.AccountService, opts.ProxyGateway)
	create := handleCreateAgent(opts.AccountService, opts.ProxyGateway)
	token := handleAccountToken(opts.ProxyGateway)
	revealToken := handleRevealAccountToken(opts.ProxyGateway)
	rotateToken := handleRotateAccountToken(opts.ProxyGateway)
	revokeToken := handleRevokeAccountToken(opts.ProxyGateway)
	tools := handleAgentTools(opts.AccountService, opts.ProxyGateway)
	mcpCatalog := handleAgentMCPCatalog(opts.AccountService, opts.ProxyGateway, opts.DataAccessService)

	app.GET("/agents", list)
	app.GET("/agents/detail", detail)
	app.PATCH("/agents/name", updateName)
	app.POST("/agents/remove", remove)
	app.POST("/agents", create)
	app.GET("/agents/tools", tools)
	app.GET("/mcp/token", token)
	app.GET("/mcp/catalog", mcpCatalog)
	app.POST("/mcp/token/reveal", revealToken)
	app.POST("/mcp/token/rotate", rotateToken)
	app.POST("/mcp/token/revoke", revokeToken)

	mountOfficeAgentRoutes(app, opts)
}
