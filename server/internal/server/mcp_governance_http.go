package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

type createGrantRequest struct {
	AgentID      json.RawMessage    `json:"agent_id"`
	UserID       string             `json:"user_id"`
	CapabilityID string             `json:"capability_id"`
	GrantType    string             `json:"grant_type"`
	DataScope    mcpgateway.JSONMap `json:"data_scope"`
	ExpiresAt    *time.Time         `json:"expires_at"`
}

type rejectGateRequest struct {
	GateID   string `json:"gate_id"`
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

type removeGrantRequest struct {
	AgentID json.RawMessage `json:"agent_id"`
	GrantID string          `json:"grant_id"`
}

func newMCPGrantID() (string, error) {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "grt_" + hex.EncodeToString(raw[:]), nil
}

func adminListLimit(c *gin.Context) int {
	limit, err := strconv.Atoi(c.Query("limit"))
	if err != nil {
		return 50
	}
	if limit <= 0 {
		return 50
	}
	if limit > 200 {
		return 200
	}
	return limit
}

func adminProxyAuditFilter(c *gin.Context) (mcpgateway.ProxyAuditFilter, error) {
	filter := mcpgateway.ProxyAuditFilter{
		Limit:            adminListLimit(c),
		Decision:         c.Query("decision"),
		AgentID:          c.Query("agent_id"),
		UpstreamServerID: c.Query("upstream_server_id"),
		Tool:             c.Query("tool"),
	}
	if c.Query("error_only") != "" {
		errorOnly, err := strconv.ParseBool(c.Query("error_only"))
		if err != nil {
			return mcpgateway.ProxyAuditFilter{}, err
		}
		filter.ErrorOnly = errorOnly
	}
	if raw := c.Query("created_from"); raw != "" {
		value, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return mcpgateway.ProxyAuditFilter{}, err
		}
		filter.CreatedFrom = value
	}
	if raw := c.Query("created_to"); raw != "" {
		value, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return mcpgateway.ProxyAuditFilter{}, err
		}
		filter.CreatedTo = value
	}
	return filter, nil
}

func adminGateFilter(c *gin.Context) (mcpgateway.GateFilter, error) {
	filter := mcpgateway.GateFilter{
		Limit:        adminListLimit(c),
		Type:         c.Query("gate_type"),
		Status:       c.Query("status"),
		AgentID:      c.Query("agent_id"),
		ActorID:      c.Query("actor_id"),
		TenantID:     c.Query("tenant_id"),
		CapabilityID: c.Query("capability_id"),
	}
	if raw := c.Query("created_from"); raw != "" {
		value, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return mcpgateway.GateFilter{}, err
		}
		filter.CreatedFrom = value
	}
	if raw := c.Query("created_to"); raw != "" {
		value, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return mcpgateway.GateFilter{}, err
		}
		filter.CreatedTo = value
	}
	return filter, nil
}

func adminGateDecisionError(c *gin.Context, gate mcpgateway.GateRequest, err error) {
	if errors.Is(err, mcpgateway.ErrGateNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if errors.Is(err, mcpgateway.ErrGateConflict) {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "gate": gate})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
}

func mountAdminMCPGovernanceRoutes(admin *gin.RouterGroup, opts Options) {
	admin.POST("/mcp/grants", requirePermission(opts.RBACService, rbac.PermissionMCPGrantCreate), func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		var req createGrantRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		if len(req.AgentID) > 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		if strings.TrimSpace(req.UserID) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		if strings.TrimSpace(req.CapabilityID) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		if strings.TrimSpace(req.GrantType) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		if opts.AccountService == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "account service is disabled"})
			return
		}
		targetAccount, err := opts.AccountService.Account(c.Request.Context(), req.UserID)
		if errors.Is(err, accounts.ErrAccountNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "account_not_found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if targetAccount.Status != accounts.StatusActive {
			c.JSON(http.StatusConflict, gin.H{"error": "account_not_active"})
			return
		}
		capabilities, err := opts.ProxyGateway.Store().ListCapabilities(c.Request.Context(), mcpgateway.CapabilityFilter{})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		var capability mcpgateway.Capability
		for _, item := range capabilities {
			if item.ID == req.CapabilityID {
				capability = item
				break
			}
		}
		if capability.ID == "" {
			c.JSON(http.StatusNotFound, gin.H{"error": mcpgateway.ErrCapabilityNotFound.Error()})
			return
		}
		if capability.Status != mcpgateway.StatusActive {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		existing, err := opts.ProxyGateway.Store().ListGrants(c.Request.Context(), mcpgateway.GrantFilter{UserID: req.UserID, CapabilityID: req.CapabilityID, GrantType: req.GrantType})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if len(existing) > 0 {
			c.JSON(http.StatusConflict, gin.H{"error": "grant_already_exists"})
			return
		}
		grantID, err := newMCPGrantID()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate grant id"})
			return
		}
		grant := mcpgateway.AccountGrant{
			ID:           grantID,
			UserID:       req.UserID,
			CapabilityID: req.CapabilityID,
			GrantType:    req.GrantType,
			DataScope:    req.DataScope,
			ExpiresAt:    req.ExpiresAt,
			CreatedBy:    account.DisplayName(),
		}
		if mcpgateway.IsKnowledgeSearchCapability(capability) {
			if req.GrantType != mcpgateway.GrantTool {
				c.JSON(http.StatusBadRequest, gin.H{"error": "knowledge.search requires tool grant"})
				return
			}
			if len(req.DataScope) > 0 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "knowledge search scope is managed by account mcp permission"})
				return
			}
			grant.DataScope = nil
		}
		if err := opts.ProxyGateway.Store().SaveGrant(c.Request.Context(), grant); err != nil {
			if errors.Is(err, mcpgateway.ErrGrantAlreadyExists) {
				c.JSON(http.StatusConflict, gin.H{"error": "grant_already_exists"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusCreated, grant)
	})
	admin.GET("/mcp/grants", requirePermission(opts.RBACService, rbac.PermissionMCPGrantRead), func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		if _, exists := c.Request.URL.Query()["agent_id"]; exists {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		items, err := opts.ProxyGateway.Store().ListGrants(c.Request.Context(), mcpgateway.GrantFilter{UserID: c.Query("user_id"), CapabilityID: c.Query("capability_id"), GrantType: c.Query("grant_type")})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	})
	admin.GET("/mcp/gates", requirePermission(opts.RBACService, rbac.PermissionMCPGateRead), func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		filter, err := adminGateFilter(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		items, err := opts.ProxyGateway.Store().ListGateRequests(c.Request.Context(), filter)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	})
	gateDetail := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		gate, err := opts.ProxyGateway.Store().GetGateRequest(c.Request.Context(), strings.TrimSpace(c.Query("gate_id")))
		if err != nil {
			if errors.Is(err, mcpgateway.ErrGateNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gate)
	}
	admin.GET("/mcp/gates/detail", requirePermission(opts.RBACService, rbac.PermissionMCPGateRead), gateDetail)
	admin.POST("/mcp/gates/decide", func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		var req rejectGateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		permissionCode := rbac.PermissionMCPGateReject
		if req.Decision == "approved" || req.Decision == "accepted" {
			permissionCode = rbac.PermissionMCPGateApprove
		}
		if !authorizePermission(c, opts.RBACService, permissionCode) {
			return
		}
		var gate mcpgateway.GateRequest
		var err error
		switch req.Decision {
		case "approved", "accepted":
			gate, err = opts.ProxyGateway.AcceptConfirmation(c.Request.Context(), strings.TrimSpace(req.GateID))
		case "rejected", "declined":
			gate, err = opts.ProxyGateway.DeclineConfirmation(c.Request.Context(), strings.TrimSpace(req.GateID), req.Reason)
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": "decision must be approved or rejected"})
			return
		}
		if err != nil {
			adminGateDecisionError(c, gate, err)
			return
		}
		c.JSON(http.StatusOK, gate)
	})
	removeGrant := func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		var req removeGrantRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		if len(req.AgentID) > 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		grantID := strings.TrimSpace(req.GrantID)
		if grantID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
		if err := opts.ProxyGateway.Store().DeleteGrant(c.Request.Context(), grantID); err != nil {
			if errors.Is(err, mcpgateway.ErrGrantNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "grant_not_found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.Status(http.StatusNoContent)
	}
	admin.POST("/mcp/grants/remove", requirePermission(opts.RBACService, rbac.PermissionMCPGrantRevoke), removeGrant)
	admin.GET("/mcp/audits", requirePermission(opts.RBACService, rbac.PermissionMCPAuditRead), func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		filter, err := adminProxyAuditFilter(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		items, err := opts.ProxyGateway.Store().ListProxyAuditRecords(c.Request.Context(), filter)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, itemsResponse(items))
	})
	admin.GET("/mcp/audits/detail", requirePermission(opts.RBACService, rbac.PermissionMCPAuditRead), func(c *gin.Context) {
		if opts.ProxyGateway == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "mcp gateway proxy is disabled"})
			return
		}
		id := strings.TrimSpace(c.Query("audit_id"))
		items, err := opts.ProxyGateway.Store().ListProxyAuditRecords(c.Request.Context(), mcpgateway.ProxyAuditFilter{ID: id, Limit: 1})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if len(items) == 1 {
			c.JSON(http.StatusOK, items[0])
			return
		}
		c.JSON(http.StatusNotFound, gin.H{"error": "audit not found"})
	})
}
