package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/management"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

type registerUpstreamServerRequest struct {
	ServerID           string                 `json:"server_id"`
	Name               string                 `json:"name"`
	Domain             string                 `json:"domain"`
	Transport          string                 `json:"transport"`
	Endpoint           string                 `json:"endpoint"`
	Stdio              mcpgateway.StdioConfig `json:"stdio"`
	Namespace          string                 `json:"namespace"`
	OwnerTeam          string                 `json:"owner_team"`
	RoutingDescription *string                `json:"routing_description"`
	CollectorID        *string                `json:"collector_id"`
	Token              string                 `json:"token"`
	Status             string                 `json:"status"`
}

type registerAgentRequest struct {
	UserID   string `json:"user_id"`
	AgentID  string `json:"agent_id"`
	ClientID string `json:"client_id"`
	Name     string `json:"name"`
	TenantID string `json:"tenant_id"`
	ActorID  string `json:"actor_id"`
	Status   string `json:"status"`
}

type updateCapabilityStatusRequest struct {
	CapabilityID string `json:"capability_id"`
	Status       string `json:"status"`
	ExposedName  string `json:"exposed_name"`
}

type updateCapabilityGatesRequest struct {
	CapabilityID     string `json:"capability_id"`
	ApprovalRequired bool   `json:"approval_required"`
	ConfirmRequired  bool   `json:"confirm_required"`
}

type accountTokenRequest struct {
	AgentID   json.RawMessage `json:"agent_id"`
	UserID    string          `json:"user_id"`
	ExpiresAt *time.Time      `json:"expires_at"`
	Scopes    []string        `json:"scopes"`
}

type accountTokenActionRequest struct {
	AgentID json.RawMessage `json:"agent_id"`
	UserID  string          `json:"user_id"`
}

type renameCapabilityRequest struct {
	CapabilityID string `json:"capability_id"`
	ExposedName  string `json:"exposed_name"`
}

type mcpResourceActionRequest struct {
	ServerID     string `json:"server_id"`
	AgentID      string `json:"agent_id"`
	UserID       string `json:"user_id"`
	CapabilityID string `json:"capability_id"`
}

type upstreamServerResponse struct {
	mcpgateway.UpstreamServer
	CapabilitiesCount            int        `json:"capabilities_count"`
	HasToken                     bool       `json:"has_token"`
	LastSyncedAt                 *time.Time `json:"last_synced_at"`
	LastSyncResult               string     `json:"last_sync_result"`
	MCPEndpoint                  string     `json:"mcp_endpoint"`
	MCPCanonicalEndpoint         string     `json:"mcp_canonical_endpoint"`
	ResourceMetadataURL          string     `json:"resource_metadata_url"`
	CanonicalResourceMetadataURL string     `json:"canonical_resource_metadata_url"`
}

func validateUpstreamRegistration(req registerUpstreamServerRequest) error {
	if !upstreamEndpointServerIDPattern.MatchString(strings.TrimSpace(req.ServerID)) {
		return errors.New("server_id must contain only letters, numbers, dots, underscores, or hyphens")
	}
	if strings.TrimSpace(req.Token) != "" && normalizedUpstreamTransport(req.Transport) != mcpgateway.TransportStreamableHTTP {
		return errors.New("token is only supported for streamable_http upstream servers")
	}
	switch normalizedUpstreamTransport(req.Transport) {
	case "", mcpgateway.TransportStreamableHTTP:
		if strings.TrimSpace(req.Endpoint) == "" {
			return errors.New("endpoint is required for streamable_http upstream servers")
		}
	case mcpgateway.TransportStdio:
		if strings.TrimSpace(req.Stdio.Command) == "" {
			return errors.New("stdio.command is required for stdio upstream servers")
		}
	case mcpgateway.TransportSSE:
		return errors.New("sse upstream transport is not supported yet")
	case mcpgateway.TransportCollectorPull:
		if req.CollectorID == nil || strings.TrimSpace(*req.CollectorID) == "" {
			return errors.New("collector_id is required for collector_pull upstream servers")
		}
		if strings.TrimSpace(req.Endpoint) != "" || hasStdioConfig(req.Stdio) {
			return errors.New("endpoint and stdio are not supported for collector_pull upstream servers")
		}
	default:
		return errors.New("unsupported upstream transport")
	}
	return nil
}

func hasStdioConfig(stdio mcpgateway.StdioConfig) bool {
	return strings.TrimSpace(stdio.Command) != "" || len(stdio.Args) > 0 || strings.TrimSpace(stdio.CWD) != "" || len(stdio.Env) > 0
}

func upstreamServerFromRequest(serverID string, req registerUpstreamServerRequest, status string, createdAt time.Time) mcpgateway.UpstreamServer {
	routingDescription := ""
	if req.RoutingDescription != nil {
		routingDescription = strings.TrimSpace(*req.RoutingDescription)
	}
	collectorID := ""
	if req.CollectorID != nil {
		collectorID = strings.TrimSpace(*req.CollectorID)
	}
	return mcpgateway.UpstreamServer{
		ID:                 serverID,
		Name:               req.Name,
		Domain:             req.Domain,
		Transport:          normalizedUpstreamTransport(req.Transport),
		Endpoint:           req.Endpoint,
		Stdio:              req.Stdio,
		OwnerTeam:          req.OwnerTeam,
		Namespace:          req.Namespace,
		RoutingDescription: routingDescription,
		CollectorID:        collectorID,
		Status:             status,
		CreatedAt:          createdAt,
	}
}

func normalizedUpstreamTransport(transport string) string {
	transport = strings.TrimSpace(transport)
	if transport == "" {
		return mcpgateway.TransportStreamableHTTP
	}
	return transport
}

func isApplicationManagedBuiltinServerID(serverID string) bool {
	switch strings.TrimSpace(serverID) {
	case mcpgateway.KnowledgeAdapterServerID, "agent-activity", "business-data":
		return true
	default:
		return false
	}
}

func upstreamServerResponses(ctx context.Context, store mcpgateway.Store, servers []mcpgateway.UpstreamServer, authOpts MCPAuthOptions) ([]upstreamServerResponse, error) {
	out := make([]upstreamServerResponse, 0, len(servers))
	for _, server := range servers {
		item, err := upstreamServerResponseFor(ctx, store, server, authOpts)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

func upstreamServerResponseFor(ctx context.Context, store mcpgateway.Store, server mcpgateway.UpstreamServer, authOpts MCPAuthOptions) (upstreamServerResponse, error) {
	capabilities, err := store.ListCapabilities(ctx, mcpgateway.CapabilityFilter{UpstreamServerID: server.ID})
	if err != nil {
		return upstreamServerResponse{}, err
	}
	item := upstreamServerResponse{
		UpstreamServer:    server,
		CapabilitiesCount: len(capabilities),
		HasToken:          len(server.TokenCiphertext) > 0,
	}
	canonicalPath := "/mcp/servers/" + server.ID
	endpointPath := canonicalPath
	if server.ID == mcpgateway.KnowledgeAdapterServerID {
		endpointPath = "/mcp/knowledge"
	}
	item.MCPEndpoint = endpointResourceURL(authOpts, endpointPath)
	item.MCPCanonicalEndpoint = endpointResourceURL(authOpts, canonicalPath)
	item.ResourceMetadataURL = endpointResourceURL(authOpts, "/.well-known/oauth-protected-resource"+endpointPath)
	item.CanonicalResourceMetadataURL = endpointResourceURL(authOpts, "/.well-known/oauth-protected-resource"+canonicalPath)
	for _, capability := range capabilities {
		if capability.LastSyncedAt.IsZero() {
			continue
		}
		if item.LastSyncedAt == nil || capability.LastSyncedAt.After(*item.LastSyncedAt) {
			lastSyncedAt := capability.LastSyncedAt
			item.LastSyncedAt = &lastSyncedAt
		}
	}
	if item.LastSyncedAt != nil {
		item.LastSyncResult = "ok"
	}
	if log, err := store.GetLatestUpstreamSyncLog(ctx, server.ID); err == nil {
		completedAt := log.CompletedAt
		item.LastSyncedAt = &completedAt
		if log.Status == mcpgateway.StatusSyncFailed {
			item.LastSyncResult = "sync_failed: " + log.Message
		} else {
			item.LastSyncResult = log.Message
			if item.LastSyncResult == "" {
				item.LastSyncResult = "ok"
			}
		}
	}
	return item, nil
}

func agentListItem(ctx context.Context, accountSvc *accounts.Service, collectorLookup AgentCollectorLookup, agent mcpgateway.AgentRegistration) (gin.H, error) {
	item := gin.H{
		"AgentID":        agent.AgentID,
		"ClientID":       agent.ClientID,
		"Name":           agent.Name,
		"TenantID":       agent.TenantID,
		"ActorID":        agent.ActorID,
		"Status":         agent.Status,
		"CreationSource": agent.CreationSource,
		"CreatedAt":      agent.CreatedAt,
		"UpdatedAt":      agent.UpdatedAt,
	}
	if agent.CreationSource == mcpgateway.AgentCreationSourceCollector && collectorLookup != nil {
		collector, ok, err := collectorLookup.FindAgentCollector(ctx, agent.AgentID, time.Now().UTC(), management.DefaultCollectorOnlineThreshold)
		if err != nil {
			return nil, err
		}
		if ok {
			item["Collector"] = collector
			item["collector"] = collector
		}
	}
	if accountSvc != nil {
		account, err := accountSvc.AccountForAgent(ctx, agent.AgentID)
		if err == nil {
			item["BoundUserID"] = account.UserID
			item["BoundUserName"] = account.Name
			item["BoundUserEmail"] = account.Email
		}
	}
	return item, nil
}

func mcpEndpointURL(req *http.Request) string {
	scheme := "http"
	if req.TLS != nil {
		scheme = "https"
	}
	if forwardedProto := req.Header.Get("X-Forwarded-Proto"); forwardedProto != "" {
		scheme = forwardedProto
	}
	return scheme + "://" + req.Host + "/mcp"
}

func delegatedBearerToken(header string) (string, bool) {
	if header == "" {
		return "", true
	}
	if len(header) < len("Bearer ") || !strings.EqualFold(header[:len("Bearer ")], "Bearer ") {
		return "", false
	}
	return header[len("Bearer "):], true
}

func mountAdminMCPRoutes(admin *gin.RouterGroup, opts Options) {
	mountAdminMCPResourceRoutes(admin, opts)
	mountAdminMCPGovernanceRoutes(admin, opts)
}

func mountAdminMCPResourceRoutes(admin *gin.RouterGroup, opts Options) {
	createUpstream := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		var req registerUpstreamServerRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		req.ServerID = strings.TrimSpace(req.ServerID)
		if isApplicationManagedBuiltinServerID(req.ServerID) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "builtin upstream server id is reserved"})
			return
		}
		if err := validateUpstreamRegistration(req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		server := upstreamServerFromRequest(req.ServerID, req, mcpgateway.StatusActive, time.Time{})
		if strings.TrimSpace(req.Token) != "" {
			if err := opts.ProxyGateway.SetUpstreamBearerToken(&server, req.Token); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		}
		if err := opts.ProxyGateway.Store().SaveUpstreamServer(c.Request.Context(), server); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		server, err := opts.ProxyGateway.Store().GetUpstreamServer(c.Request.Context(), server.ID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		out, err := upstreamServerResponseFor(c.Request.Context(), opts.ProxyGateway.Store(), server, opts.MCPAuth)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusCreated, out)
	}
	listUpstreams := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		items, err := opts.ProxyGateway.Store().ListUpstreamServers(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		out, err := upstreamServerResponses(c.Request.Context(), opts.ProxyGateway.Store(), items, opts.MCPAuth)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, itemsResponse(out))
	}
	upstreamDetail := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		item, err := opts.ProxyGateway.Store().GetUpstreamServer(c.Request.Context(), upstreamServerID(c))
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		out, err := upstreamServerResponseFor(c.Request.Context(), opts.ProxyGateway.Store(), item, opts.MCPAuth)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
	updateUpstream := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		var req registerUpstreamServerRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		serverID := strings.TrimSpace(req.ServerID)
		if serverID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "server_id is required"})
			return
		}
		req.ServerID = serverID
		if isApplicationManagedBuiltinServerID(serverID) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "builtin upstream server is managed by the application"})
			return
		}
		existing, err := opts.ProxyGateway.Store().GetUpstreamServer(c.Request.Context(), serverID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		if strings.TrimSpace(req.Name) == "" {
			req.Name = existing.Name
		}
		if strings.TrimSpace(req.Domain) == "" {
			req.Domain = existing.Domain
		}
		if strings.TrimSpace(req.Transport) == "" {
			req.Transport = existing.Transport
		}
		if normalizedUpstreamTransport(req.Transport) != mcpgateway.TransportCollectorPull && strings.TrimSpace(req.Endpoint) == "" {
			req.Endpoint = existing.Endpoint
		}
		if normalizedUpstreamTransport(req.Transport) != mcpgateway.TransportCollectorPull && strings.TrimSpace(req.Stdio.Command) == "" {
			req.Stdio = existing.Stdio
		}
		if strings.TrimSpace(req.Namespace) == "" {
			req.Namespace = existing.Namespace
		}
		if strings.TrimSpace(req.OwnerTeam) == "" {
			req.OwnerTeam = existing.OwnerTeam
		}
		if req.RoutingDescription == nil {
			req.RoutingDescription = &existing.RoutingDescription
		}
		if normalizedUpstreamTransport(req.Transport) == mcpgateway.TransportCollectorPull {
			if req.CollectorID == nil {
				req.CollectorID = &existing.CollectorID
			}
		} else {
			emptyCollectorID := ""
			req.CollectorID = &emptyCollectorID
		}
		if err := validateUpstreamRegistration(req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		status := existing.Status
		if strings.TrimSpace(req.Status) != "" {
			status = req.Status
		}
		server := upstreamServerFromRequest(serverID, req, status, existing.CreatedAt)
		if server.Transport == mcpgateway.TransportStreamableHTTP {
			server.AuthType = existing.AuthType
			server.CredentialRef = existing.CredentialRef
			server.TokenCiphertext = existing.TokenCiphertext
		}
		server.DeletedAt = existing.DeletedAt
		if strings.TrimSpace(req.Token) != "" {
			if err := opts.ProxyGateway.SetUpstreamBearerToken(&server, req.Token); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		}
		if err := opts.ProxyGateway.Store().SaveUpstreamServer(c.Request.Context(), server); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		server, err = opts.ProxyGateway.Store().GetUpstreamServer(c.Request.Context(), server.ID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		out, err := upstreamServerResponseFor(c.Request.Context(), opts.ProxyGateway.Store(), server, opts.MCPAuth)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
	removeUpstream := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		var req mcpResourceActionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		serverID := strings.TrimSpace(req.ServerID)
		if isApplicationManagedBuiltinServerID(serverID) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "builtin upstream server is managed by the application"})
			return
		}
		server, err := opts.ProxyGateway.Store().GetUpstreamServer(c.Request.Context(), serverID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		if server.Status != mcpgateway.StatusDisabled {
			c.JSON(http.StatusBadRequest, gin.H{"error": "disable upstream server before delete"})
			return
		}
		if err := opts.ProxyGateway.Store().DeleteUpstreamServer(c.Request.Context(), server.ID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.Status(http.StatusNoContent)
	}
	syncUpstream := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		var req mcpResourceActionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		serverID := strings.TrimSpace(req.ServerID)
		server, err := opts.ProxyGateway.Store().GetUpstreamServer(c.Request.Context(), serverID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		token := ""
		if server.AuthType != "static_bearer" {
			var ok bool
			token, ok = delegatedBearerToken(c.GetHeader("Authorization"))
			if !ok {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid authorization header"})
				return
			}
		}
		if err := opts.ProxyGateway.SyncTools(c.Request.Context(), serverID, token); err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	}
	createAgent := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		var req registerAgentRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if strings.TrimSpace(req.AgentID) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "agent_id is required"})
			return
		}
		if strings.TrimSpace(req.UserID) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "user_id is required"})
			return
		}
		status := req.Status
		if status == "" {
			status = mcpgateway.StatusActive
		}
		if status != mcpgateway.StatusActive {
			c.JSON(http.StatusBadRequest, gin.H{"error": "new agent status must be active"})
			return
		}
		if opts.AccountService != nil {
			owner, err := opts.AccountService.Account(c.Request.Context(), req.UserID)
			if err != nil || owner.Status != accounts.StatusActive {
				c.JSON(http.StatusBadRequest, gin.H{"error": "target account must exist and be active"})
				return
			}
		}
		agent := mcpgateway.AgentRegistration{
			AgentID:        req.AgentID,
			ClientID:       req.ClientID,
			Name:           req.Name,
			TenantID:       req.TenantID,
			ActorID:        req.UserID,
			Status:         status,
			CreationSource: mcpgateway.AgentCreationSourceManual,
		}
		err := opts.ProxyGateway.CreateOwnedAgent(c.Request.Context(), req.UserID, agent)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusCreated, gin.H{"agent": agent})
	}
	listAgents := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		items, err := opts.ProxyGateway.Store().ListAgents(c.Request.Context(), mcpgateway.AgentFilter{Status: c.Query("status")})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		out := make([]gin.H, 0, len(items))
		for _, agent := range items {
			item, err := agentListItem(c.Request.Context(), opts.AccountService, opts.AgentCollectorLookup, agent)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			out = append(out, item)
		}
		c.JSON(http.StatusOK, itemsResponse(out))
	}
	removeAgent := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		var req mcpResourceActionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		id := strings.TrimSpace(req.AgentID)
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "agent_id is required"})
			return
		}
		if err := opts.ProxyGateway.Store().DeleteAgent(c.Request.Context(), id); err != nil {
			if errors.Is(err, mcpgateway.ErrAgentNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.Status(http.StatusNoContent)
	}
	agentDetail := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		agent, err := opts.ProxyGateway.Store().GetAgent(c.Request.Context(), agentID(c))
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		item, err := agentListItem(c.Request.Context(), opts.AccountService, opts.AgentCollectorLookup, agent)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, item)
	}
	accountTokenMetadata := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		if rejectLegacyAgentIDQuery(c) {
			return
		}
		userID := strings.TrimSpace(c.Query("user_id"))
		if userID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		if !validateAdminAccountTokenTarget(c, opts.AccountService, userID, false) {
			return
		}
		token, err := opts.ProxyGateway.Store().GetLatestAccountToken(c.Request.Context(), userID)
		if err != nil {
			agentAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"token": accountTokenMetadataResponse(token)})
	}
	rotateAccountToken := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		if rejectLegacyAgentIDQuery(c) {
			return
		}
		var req accountTokenRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		if len(req.AgentID) > 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		userID := strings.TrimSpace(req.UserID)
		if userID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		if !validateAdminAccountTokenTarget(c, opts.AccountService, userID, true) {
			return
		}
		issued, err := opts.ProxyGateway.RotateAccountToken(c.Request.Context(), mcpgateway.AccountTokenIssueRequest{UserID: userID, ExpiresAt: req.ExpiresAt, Scopes: req.Scopes, Issuer: "claw-mcp-admin"})
		if err != nil {
			agentAPIError(c, err)
			return
		}
		c.JSON(http.StatusOK, accountTokenSecretResponse(issued.Token, issued.Plaintext))
	}
	revealAccountToken := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		if rejectLegacyAgentIDQuery(c) {
			return
		}
		var req accountTokenActionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		if len(req.AgentID) > 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		userID := strings.TrimSpace(req.UserID)
		if userID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		if !validateAdminAccountTokenTarget(c, opts.AccountService, userID, false) {
			return
		}
		copied, err := opts.ProxyGateway.CopyActiveAccountToken(c.Request.Context(), userID)
		if err != nil {
			if errors.Is(err, mcpgateway.ErrAccountTokenNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "account_token_not_found"})
				return
			}
			if errors.Is(err, mcpgateway.ErrTokenCipherNotConfigured) {
				c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, accountTokenSecretResponse(copied.Token, copied.Plaintext))
	}
	revokeAccountToken := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		if rejectLegacyAgentIDQuery(c) {
			return
		}
		var req accountTokenActionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		if len(req.AgentID) > 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		userID := strings.TrimSpace(req.UserID)
		if userID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		if !validateAdminAccountTokenTarget(c, opts.AccountService, userID, false) {
			return
		}
		count, err := opts.ProxyGateway.RevokeAccountToken(c.Request.Context(), userID)
		if err != nil {
			if errors.Is(err, mcpgateway.ErrAccountTokenNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "account_token_not_found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"user_id": userID, "revoked_token_count": count, "token_status": mcpgateway.StatusRevoked})
	}
	listCapabilities := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		items, err := opts.ProxyGateway.Store().ListCapabilities(c.Request.Context(), mcpgateway.CapabilityFilter{
			UpstreamServerID: c.Query("server_id"),
			Type:             c.Query("type"),
			Status:           c.Query("status"),
			Domain:           c.Query("domain"),
			RiskLevel:        c.Query("risk_level"),
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	}
	capabilityDetail := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		items, err := opts.ProxyGateway.Store().ListCapabilities(c.Request.Context(), mcpgateway.CapabilityFilter{ID: capabilityID(c)})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if len(items) == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": mcpgateway.ErrCapabilityNotFound.Error()})
			return
		}
		c.JSON(http.StatusOK, items[0])
	}
	updateCapabilityGates := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		var req updateCapabilityGatesRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		capabilityID := strings.TrimSpace(req.CapabilityID)
		if capabilityID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "capability_id is required"})
			return
		}
		capabilities, err := opts.ProxyGateway.Store().ListCapabilities(c.Request.Context(), mcpgateway.CapabilityFilter{ID: capabilityID})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if len(capabilities) == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": mcpgateway.ErrCapabilityNotFound.Error()})
			return
		}
		capability := capabilities[0]
		capability.ApprovalRequired = req.ApprovalRequired
		capability.ConfirmRequired = req.ConfirmRequired
		if err := opts.ProxyGateway.Store().SaveCapability(c.Request.Context(), capability); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, capability)
	}
	removeCapability := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		var req mcpResourceActionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		capabilityID := strings.TrimSpace(req.CapabilityID)
		if capabilityID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "capability_id is required"})
			return
		}
		capability, err := findCapability(c.Request.Context(), opts.ProxyGateway.Store(), capabilityID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		if capability.Status != mcpgateway.StatusMissing {
			c.JSON(http.StatusBadRequest, gin.H{"error": "only missing capability can be deleted"})
			return
		}
		if err := opts.ProxyGateway.Store().DeleteCapability(c.Request.Context(), capability.ID); err != nil {
			if errors.Is(err, mcpgateway.ErrCapabilityNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.Status(http.StatusNoContent)
	}

	upstreamRead := requirePermission(opts.RBACService, rbac.PermissionMCPUpstreamRead)
	upstreamManage := requirePermission(opts.RBACService, rbac.PermissionMCPUpstreamManage)
	agentRead := requireAnyPermission(opts.RBACService, rbac.PermissionAgentRead, rbac.PermissionMCPGrantRead)
	agentManage := requirePermission(opts.RBACService, rbac.PermissionAgentManage)
	capabilityRead := requireAnyPermission(opts.RBACService, rbac.PermissionMCPCapabilityRead, rbac.PermissionMCPGrantManage)
	capabilityManage := requirePermission(opts.RBACService, rbac.PermissionMCPCapabilityManage)
	admin.POST("/mcp/upstream-servers", upstreamManage, createUpstream)
	admin.GET("/mcp/upstream-servers", upstreamRead, listUpstreams)
	admin.GET("/mcp/upstream-servers/detail", upstreamRead, upstreamDetail)
	admin.PATCH("/mcp/upstream-servers", upstreamManage, updateUpstream)
	admin.POST("/mcp/upstream-servers/remove", upstreamManage, removeUpstream)
	admin.POST("/mcp/upstream-servers/sync-tools", upstreamManage, syncUpstream)

	admin.POST("/mcp/agents", agentManage, createAgent)
	admin.GET("/mcp/agents", agentRead, listAgents)
	admin.GET("/mcp/agents/detail", agentRead, agentDetail)
	admin.POST("/mcp/agents/remove", agentManage, removeAgent)
	admin.GET("/mcp/accounts/token", agentManage, accountTokenMetadata)
	admin.POST("/mcp/accounts/token/reveal", agentManage, revealAccountToken)
	admin.POST("/mcp/accounts/token/rotate", agentManage, rotateAccountToken)
	admin.POST("/mcp/accounts/token/revoke", agentManage, revokeAccountToken)

	admin.GET("/mcp/capabilities", capabilityRead, listCapabilities)
	admin.GET("/mcp/capabilities/detail", capabilityRead, capabilityDetail)
	admin.POST("/mcp/capabilities/remove", capabilityManage, removeCapability)
	admin.PATCH("/mcp/capabilities", capabilityManage, func(c *gin.Context) {
		var req updateCapabilityStatusRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if strings.TrimSpace(req.ExposedName) != "" {
			renameCapabilityFromRequest(c, opts, renameCapabilityRequest{CapabilityID: req.CapabilityID, ExposedName: req.ExposedName})
			return
		}
		updateCapabilityStatusFromRequest(c, opts, req)
	})
	admin.PUT("/mcp/capabilities/gate-policy", capabilityManage, updateCapabilityGates)
}

func upstreamServerID(c *gin.Context) string {
	return strings.TrimSpace(c.Query("server_id"))
}

func agentID(c *gin.Context) string {
	return strings.TrimSpace(c.Query("agent_id"))
}

func rejectLegacyAgentIDQuery(c *gin.Context) bool {
	if _, exists := c.Request.URL.Query()["agent_id"]; !exists {
		return false
	}
	c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
	return true
}

func validateAdminAccountTokenTarget(c *gin.Context, accountService *accounts.Service, userID string, requireActive bool) bool {
	if accountService == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account service is disabled"})
		return false
	}
	account, err := accountService.Account(c.Request.Context(), userID)
	if err != nil {
		agentAPIError(c, err)
		return false
	}
	if requireActive && account.Status != accounts.StatusActive {
		agentAPIError(c, accounts.ErrAccountNotActive)
		return false
	}
	return true
}

func capabilityID(c *gin.Context) string {
	return strings.TrimSpace(c.Query("capability_id"))
}

func findCapability(ctx context.Context, store mcpgateway.Store, id string) (mcpgateway.Capability, error) {
	items, err := store.ListCapabilities(ctx, mcpgateway.CapabilityFilter{ID: id})
	if err != nil {
		return mcpgateway.Capability{}, err
	}
	if len(items) > 0 {
		return items[0], nil
	}
	return store.GetCapabilityByExposedName(ctx, id)
}

func updateCapabilityStatusFromRequest(c *gin.Context, opts Options, req updateCapabilityStatusRequest) {
	if opts.ProxyGateway == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
		return
	}
	if strings.TrimSpace(req.Status) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "status is required"})
		return
	}
	capabilityID := strings.TrimSpace(req.CapabilityID)
	if capabilityID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "capability_id is required"})
		return
	}
	capability, err := findCapability(c.Request.Context(), opts.ProxyGateway.Store(), capabilityID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	capability.Status = req.Status
	if err := opts.ProxyGateway.Store().SaveCapability(c.Request.Context(), capability); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, capability)
}

func renameCapabilityFromRequest(c *gin.Context, opts Options, req renameCapabilityRequest) {
	if opts.ProxyGateway == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
		return
	}
	newName := strings.TrimSpace(req.ExposedName)
	if newName == "" || strings.Contains(newName, " ") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "exposed_name is invalid"})
		return
	}
	capabilityID := strings.TrimSpace(req.CapabilityID)
	if capabilityID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "capability_id is required"})
		return
	}
	capability, err := findCapability(c.Request.Context(), opts.ProxyGateway.Store(), capabilityID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if capability.Status == mcpgateway.StatusMissing {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing capability cannot be renamed"})
		return
	}
	if existing, err := opts.ProxyGateway.Store().GetCapabilityByExposedName(c.Request.Context(), newName); err == nil && existing.ID != capability.ID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "exposed_name already exists"})
		return
	}
	grants, err := opts.ProxyGateway.Store().ListGrants(c.Request.Context(), mcpgateway.GrantFilter{CapabilityID: capability.ID})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if capability.Status == mcpgateway.StatusActive && len(grants) > 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "active capability with grants cannot be renamed"})
		return
	}
	capability.ExposedName = newName
	if err := opts.ProxyGateway.Store().SaveCapability(c.Request.Context(), capability); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, capability)
}
