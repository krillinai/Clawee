package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/agentprovisioning"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/rbac"
)

const (
	defaultSessionCookieName      = "claw_front_token"
	defaultAdminSessionCookieName = "claw_admin_token"
	registrationRollbackTimeout   = 5 * time.Second
	accountContextKey             = "account"
	principalContextKey           = "principal"
	claweeAgentContextKey         = "clawee_agent"
)

var (
	errAgentProvisioningServiceUnavailable = errors.New("agent provisioning service is unavailable")
	errRegistrationRollbackFailed          = errors.New("registration rollback failed")
)

type authRequest struct {
	Email    string `json:"email"`
	Name     string `json:"name"`
	Password string `json:"password"`
	ClientID string `json:"client_id"`
	AgentID  string `json:"agent_id"`
}

type authCookieConfig struct {
	FrontendName string
	AdminName    string
	Secure       bool
}

func handleRegister(accountSvc *accounts.Service, rbacSvc *rbac.Service, provisioner *agentprovisioning.Service, cookies authCookieConfig) gin.HandlerFunc {
	var registerMu sync.Mutex
	return func(c *gin.Context) {
		var req authRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			authBadRequest(c)
			return
		}
		clientID := normalizedClientID(req.ClientID)
		if clientID != accounts.ClientWeb && clientID != accounts.ClientClaweeAgent {
			authBadRequest(c)
			return
		}
		registerMu.Lock()
		defer registerMu.Unlock()

		result, err := accountSvc.Register(c.Request.Context(), accounts.RegisterRequest{
			Email: req.Email, Name: req.Name, Password: req.Password,
		})
		if err != nil {
			authError(c, err)
			return
		}
		bootstrapped := false
		if result.NeedsAdminBootstrap {
			if rbacSvc == nil {
				authRegistrationError(c, errRBACServiceUnavailable, rollbackRegistration(c.Request.Context(), accountSvc, nil, result, false))
				return
			}
			if err := rbacSvc.BootstrapAdmin(c.Request.Context(), result.Account.UserID); err != nil {
				authRegistrationError(c, err, rollbackRegistration(c.Request.Context(), accountSvc, rbacSvc, result, false))
				return
			}
			bootstrapped = true
		}
		if clientID == accounts.ClientClaweeAgent {
			if provisioner == nil {
				authRegistrationError(c, errAgentProvisioningServiceUnavailable, rollbackRegistration(c.Request.Context(), accountSvc, rbacSvc, result, bootstrapped))
				return
			}
			displayName := strings.TrimSpace(result.Account.Name)
			if displayName == "" {
				displayName = strings.TrimSpace(result.Account.Email)
			}
			ensured, err := provisioner.EnsureOwnedAgent(c.Request.Context(), agentprovisioning.EnsureRequest{
				UserID: result.Account.UserID, AgentID: req.AgentID,
				ClientID: accounts.ClientClaweeAgent, DisplayName: displayName,
				Source: agentprovisioning.SourceClaweeLogin,
			})
			if err != nil {
				authRegistrationError(c, err, rollbackRegistration(c.Request.Context(), accountSvc, rbacSvc, result, bootstrapped))
				return
			}
			c.JSON(http.StatusOK, gin.H{"data": gin.H{
				"account": accountResponse(result.Account, false), "agent": claweeAgentResponse(ensured.Agent),
			}})
			return
		}
		hasAdmin, err := accountHasAdminAccess(c.Request.Context(), rbacSvc, result.Account.UserID)
		if err != nil {
			authRegistrationError(c, err, rollbackRegistration(c.Request.Context(), accountSvc, rbacSvc, result, bootstrapped))
			return
		}
		tokens, err := issueWebTokens(c.Request.Context(), accountSvc, result.Account, hasAdmin)
		if err != nil {
			authRegistrationError(c, err, rollbackRegistration(c.Request.Context(), accountSvc, rbacSvc, result, bootstrapped))
			return
		}
		setWebAuthCookies(c, cookies, tokens)
		writeWebAuthResponse(c, result.Account, hasAdmin)
	}
}

func rollbackRegistration(ctx context.Context, accountSvc *accounts.Service, rbacSvc *rbac.Service, result accounts.RegistrationResult, bootstrapped bool) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), registrationRollbackTimeout)
	defer cancel()
	var rollbackErr error
	if bootstrapped && rbacSvc != nil {
		rollbackErr = errors.Join(rollbackErr, rbacSvc.RollbackBootstrapAdmin(cleanupCtx, result.Account.UserID))
	}
	if err := accountSvc.DeleteAccount(cleanupCtx, result.Account.UserID); err != nil && !errors.Is(err, accounts.ErrAccountNotFound) {
		rollbackErr = errors.Join(rollbackErr, err)
	}
	return rollbackErr
}

func authRegistrationError(c *gin.Context, primaryErr, rollbackErr error) {
	if rollbackErr == nil {
		authError(c, primaryErr)
		return
	}
	combinedErr := errors.Join(errRegistrationRollbackFailed, primaryErr, rollbackErr)
	_ = c.Error(combinedErr)
	authError(c, combinedErr)
}

func handleLogin(accountSvc *accounts.Service, rbacSvc *rbac.Service, provisioner *agentprovisioning.Service, cookies authCookieConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req authRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			authBadRequest(c)
			return
		}
		clientID := normalizedClientID(req.ClientID)
		if clientID != accounts.ClientWeb && clientID != accounts.ClientElectron && clientID != accounts.ClientClaweeAgent {
			authBadRequest(c)
			return
		}
		account, err := accountSvc.AuthenticateCredentials(c.Request.Context(), accounts.LoginRequest{
			Email: req.Email, Password: req.Password,
		})
		if err != nil {
			authError(c, err)
			return
		}
		if clientID == accounts.ClientClaweeAgent {
			result, err := issueClaweeSession(c.Request.Context(), accountSvc, provisioner, account, req.AgentID)
			if err != nil {
				authError(c, err)
				return
			}
			writeClaweeSessionResponse(c, result)
			return
		}
		if clientID == accounts.ClientElectron {
			tokens, err := accountSvc.IssueTokens(c.Request.Context(), account, []accounts.TokenRequest{{
				Audience: accounts.AudienceFrontend, ClientID: clientID,
			}})
			if err != nil {
				authError(c, err)
				return
			}
			issued := tokens.Token(accounts.AudienceFrontend)
			c.JSON(http.StatusOK, gin.H{"data": gin.H{
				"account": accountResponse(account, false), "access_token": issued.Token,
				"token_type": "Bearer", "expires_at": issued.Session.ExpiresAt,
			}})
			return
		}

		hasAdmin, err := accountHasAdminAccess(c.Request.Context(), rbacSvc, account.UserID)
		if err != nil {
			authError(c, err)
			return
		}
		tokens, err := issueWebTokens(c.Request.Context(), accountSvc, account, hasAdmin)
		if err != nil {
			authError(c, err)
			return
		}
		setWebAuthCookies(c, cookies, tokens)
		writeWebAuthResponse(c, account, hasAdmin)
	}
}

func handleLogout(accountSvc *accounts.Service, cookies authCookieConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		var revokeErr error
		seen := make(map[string]struct{}, 3)
		revoke := func(token, audience string) {
			if token == "" {
				return
			}
			key := audience + "\x00" + token
			if _, exists := seen[key]; exists {
				return
			}
			seen[key] = struct{}{}
			revokeErr = errors.Join(revokeErr, accountSvc.RevokeToken(c.Request.Context(), token, audience))
		}
		if token := bearerToken(c.Request); token != "" {
			revoke(token, accounts.AudienceFrontend)
		}
		if cookie, err := c.Request.Cookie(cookies.FrontendName); err == nil {
			revoke(cookie.Value, accounts.AudienceFrontend)
		}
		if cookie, err := c.Request.Cookie(cookies.AdminName); err == nil {
			revoke(cookie.Value, accounts.AudienceAdmin)
		}
		if revokeErr != nil {
			authError(c, revokeErr)
			return
		}
		clearAuthCookie(c, cookies.FrontendName, cookies.Secure)
		clearAuthCookie(c, cookies.AdminName, cookies.Secure)
		c.Status(http.StatusNoContent)
	}
}

func handleMe(accountSvc *accounts.Service, rbacSvc *rbac.Service, dingtalkOpts DingTalkAuthOptions, agentActivityReportingEnabled bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		if rbacSvc == nil {
			abortAuthorizationError(c, http.StatusServiceUnavailable, "authorization_unavailable", "权限服务不可用")
			return
		}
		hasAdmin, err := rbacSvc.HasAnyPermission(c.Request.Context(), account.UserID)
		if err != nil {
			abortAuthorizationError(c, http.StatusInternalServerError, "permission_check_failed", "权限检查失败")
			return
		}
		roles, err := rbacSvc.ListEffectiveRoles(c.Request.Context(), account.UserID)
		if err != nil {
			abortAuthorizationError(c, http.StatusInternalServerError, "permission_check_failed", "权限检查失败")
			return
		}
		permissions, err := rbacSvc.ListEffectivePermissions(c.Request.Context(), account.UserID)
		if err != nil {
			abortAuthorizationError(c, http.StatusInternalServerError, "permission_check_failed", "权限检查失败")
			return
		}
		data := gin.H{
			"account":      accountResponse(account, false),
			"applications": gin.H{"frontend": true, "admin": hasAdmin},
			"admin_roles":  roles, "admin_permissions": permissions,
		}
		data["dingtalk_enabled"] = dingtalkOpts.Enabled
		data["agent_activity_reporting_enabled"] = agentActivityReportingEnabled
		bound := false
		_, err = accountSvc.AccountIdentityForUser(c.Request.Context(), account.UserID, "dingtalk", dingtalkOpts.ProviderKey)
		if err == nil {
			bound = true
		} else if !errors.Is(err, accounts.ErrAccountIdentityNotFound) {
			authError(c, err)
			return
		}
		data["dingtalk_bound"] = bound
		data["local_password_configured"] = account.PasswordHash != ""
		if agent, ok := currentClaweeAgent(c); ok {
			data["agent"] = claweeAgentResponse(agent)
		}
		c.JSON(http.StatusOK, gin.H{"data": data})
	}
}

func requireJWT(accountSvc *accounts.Service, audience, cookieName string) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := ""
		if audience == accounts.AudienceFrontend {
			token = bearerToken(c.Request)
		}
		if token == "" {
			if cookie, err := c.Request.Cookie(cookieName); err == nil {
				token = strings.TrimSpace(cookie.Value)
			}
		}
		if token == "" {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		identity, err := accountSvc.AuthenticateToken(c.Request.Context(), token, audience)
		if err != nil {
			if errors.Is(err, accounts.ErrInvalidSession) {
				abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			} else {
				abortAuthorizationError(c, http.StatusInternalServerError, "internal_error", "认证服务错误")
			}
			return
		}
		c.Set(accountContextKey, identity.Account)
		c.Set(principalContextKey, identity.Principal)
		c.Next()
	}
}

func requireClaweeAgentBinding(accountSvc *accounts.Service, proxyGateway *mcpgateway.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		principal, ok := currentPrincipal(c)
		if !ok || principal.ClientID != accounts.ClientClaweeAgent {
			c.Next()
			return
		}
		if principal.AgentID == "" {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		if proxyGateway == nil {
			abortAuthorizationError(c, http.StatusInternalServerError, "internal_error", "认证服务错误")
			return
		}
		owner, err := accountSvc.AccountForAgent(c.Request.Context(), principal.AgentID)
		if errors.Is(err, accounts.ErrAccountAgentNotFound) || errors.Is(err, accounts.ErrAccountNotFound) || (err == nil && owner.UserID != principal.UserID) {
			abortAuthorizationError(c, http.StatusForbidden, "agent_forbidden", "Agent 不可用")
			return
		}
		if err != nil {
			abortAuthorizationError(c, http.StatusInternalServerError, "internal_error", "认证服务错误")
			return
		}
		agent, err := proxyGateway.Store().GetAgent(c.Request.Context(), principal.AgentID)
		if errors.Is(err, mcpgateway.ErrAgentNotFound) || (err == nil && agent.Status != mcpgateway.StatusActive) {
			abortAuthorizationError(c, http.StatusForbidden, "agent_forbidden", "Agent 不可用")
			return
		}
		if err != nil {
			abortAuthorizationError(c, http.StatusInternalServerError, "internal_error", "认证服务错误")
			return
		}
		c.Set(claweeAgentContextKey, agent)
		c.Next()
	}
}

func requirePermission(service *rbac.Service, permissionCode string) gin.HandlerFunc {
	return requireAnyPermission(service, permissionCode)
}

func requireAdminAccess(service *rbac.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		if service == nil {
			abortAuthorizationError(c, http.StatusServiceUnavailable, "authorization_unavailable", "权限服务不可用")
			return
		}
		allowed, err := service.HasAnyPermission(c.Request.Context(), account.UserID)
		if err != nil {
			abortAuthorizationError(c, http.StatusInternalServerError, "permission_check_failed", "权限检查失败")
			return
		}
		if !allowed {
			abortAuthorizationError(c, http.StatusForbidden, "forbidden", "无权访问")
			return
		}
		c.Next()
	}
}

func requireAnyPermission(service *rbac.Service, permissionCodes ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if authorizeAnyPermission(c, service, permissionCodes...) {
			c.Next()
		}
	}
}

func authorizePermission(c *gin.Context, service *rbac.Service, permissionCode string) bool {
	return authorizeAnyPermission(c, service, permissionCode)
}

func authorizeAnyPermission(c *gin.Context, service *rbac.Service, permissionCodes ...string) bool {
	account, ok := currentAccount(c)
	if !ok {
		abortAuthorizationError(c, http.StatusUnauthorized, "unauthorized", "未认证")
		return false
	}
	if service == nil {
		abortAuthorizationError(c, http.StatusServiceUnavailable, "authorization_unavailable", "权限服务不可用")
		return false
	}
	for _, permissionCode := range permissionCodes {
		allowed, err := service.HasPermission(c.Request.Context(), account.UserID, permissionCode)
		if err != nil {
			abortAuthorizationError(c, http.StatusInternalServerError, "permission_check_failed", "权限检查失败")
			return false

		}
		if allowed {
			return true
		}
	}
	abortAuthorizationError(c, http.StatusForbidden, "forbidden", "无权访问")
	return false
}

func abortAuthorizationError(c *gin.Context, status int, code, message string) {
	if strings.HasPrefix(c.Request.URL.Path, "/api/v1/auth/") || strings.HasPrefix(c.Request.URL.Path, "/api/v1/app/") || strings.HasPrefix(c.Request.URL.Path, "/api/v1/admin/") {
		c.AbortWithStatusJSON(status, gin.H{"error": gin.H{
			"code": code, "message": message, "details": []any{},
		}})
		return
	}
	c.AbortWithStatusJSON(status, gin.H{"error": message})
}

func currentAccount(c *gin.Context) (accounts.Account, bool) {
	value, ok := c.Get(accountContextKey)
	if !ok {
		return accounts.Account{}, false
	}
	account, ok := value.(accounts.Account)
	return account, ok
}

func currentPrincipal(c *gin.Context) (accounts.Principal, bool) {
	value, ok := c.Get(principalContextKey)
	if !ok {
		return accounts.Principal{}, false
	}
	principal, ok := value.(accounts.Principal)
	return principal, ok
}

func currentClaweeAgent(c *gin.Context) (mcpgateway.AgentRegistration, bool) {
	value, ok := c.Get(claweeAgentContextKey)
	if !ok {
		return mcpgateway.AgentRegistration{}, false
	}
	agent, ok := value.(mcpgateway.AgentRegistration)
	return agent, ok
}

func claweeAgentResponse(agent mcpgateway.AgentRegistration) gin.H {
	return gin.H{"agent_id": agent.AgentID, "name": agent.Name}
}

type claweeSessionResult struct {
	Account accounts.Account
	Agent   mcpgateway.AgentRegistration
	Issued  accounts.IssuedToken
	Created bool
}

func issueClaweeSession(ctx context.Context, accountSvc *accounts.Service, provisioner *agentprovisioning.Service, account accounts.Account, agentID string) (claweeSessionResult, error) {
	if provisioner == nil {
		return claweeSessionResult{}, errAgentProvisioningServiceUnavailable
	}
	ensured, err := provisioner.EnsureOwnedAgent(ctx, agentprovisioning.EnsureRequest{
		UserID: account.UserID, AgentID: agentID, ClientID: accounts.ClientClaweeAgent,
		DisplayName: account.DisplayName(), Source: agentprovisioning.SourceClaweeLogin,
	})
	if err != nil {
		return claweeSessionResult{}, err
	}
	tokens, err := accountSvc.IssueTokens(ctx, account, []accounts.TokenRequest{{
		Audience: accounts.AudienceFrontend, ClientID: accounts.ClientClaweeAgent, AgentID: ensured.Agent.AgentID,
	}})
	if err != nil {
		return claweeSessionResult{}, err
	}
	return claweeSessionResult{
		Account: account, Agent: ensured.Agent, Issued: tokens.Token(accounts.AudienceFrontend), Created: ensured.Created,
	}, nil
}

func writeClaweeSessionResponse(c *gin.Context, result claweeSessionResult) {
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"account": accountResponse(result.Account, false), "agent": claweeAgentResponse(result.Agent),
		"access_token": result.Issued.Token, "token_type": "Bearer", "expires_at": result.Issued.Session.ExpiresAt,
	}})
}

func issueWebTokens(ctx context.Context, accountSvc *accounts.Service, account accounts.Account, hasAdmin bool) (accounts.TokenBatch, error) {
	requests := []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}}
	if hasAdmin {
		requests = append(requests, accounts.TokenRequest{Audience: accounts.AudienceAdmin, ClientID: accounts.ClientWeb})
	}
	return accountSvc.IssueTokens(ctx, account, requests)
}

func setWebAuthCookies(c *gin.Context, cookies authCookieConfig, tokens accounts.TokenBatch) {
	setAuthCookie(c, cookies.FrontendName, tokens.Token(accounts.AudienceFrontend), cookies.Secure)
	if admin := tokens.Token(accounts.AudienceAdmin); admin.Token != "" {
		setAuthCookie(c, cookies.AdminName, admin, cookies.Secure)
	} else {
		clearAuthCookie(c, cookies.AdminName, cookies.Secure)
	}
}

func setAuthCookie(c *gin.Context, name string, issued accounts.IssuedToken, secure bool) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name: name, Value: issued.Token, Path: "/", Expires: issued.Session.ExpiresAt,
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode,
	})
}

func clearAuthCookie(c *gin.Context, name string, secure bool) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name: name, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode,
	})
}

func normalizedClientID(clientID string) string {
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return accounts.ClientWeb
	}
	return clientID
}

func accountHasAdminAccess(ctx context.Context, service *rbac.Service, userID string) (bool, error) {
	if service == nil {
		return false, errRBACServiceUnavailable
	}
	return service.HasAnyPermission(ctx, userID)
}

func bearerToken(request *http.Request) string {
	value := strings.TrimSpace(request.Header.Get("Authorization"))
	if len(value) < 7 || !strings.EqualFold(value[:7], "Bearer ") {
		return ""
	}
	return strings.TrimSpace(value[7:])
}

func writeWebAuthResponse(c *gin.Context, account accounts.Account, hasAdmin bool) {
	applications := gin.H{"frontend": true, "admin": hasAdmin}
	redirectTo := "/app"
	if hasAdmin {
		redirectTo = "/admin"
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"account": accountResponse(account, false), "applications": applications, "redirect_to": redirectTo,
	}})
}

func accountResponse(account accounts.Account, legacy bool) gin.H {
	return gin.H{
		"user_id": account.UserID, "email": account.Email, "name": account.Name, "status": account.Status,
	}
}

func authBadRequest(c *gin.Context) {
	c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "invalid_request", "message": "请求无效", "details": []any{}}})
}

func authError(c *gin.Context, err error) {
	status := http.StatusInternalServerError
	code := "internal_error"
	message := "认证服务错误"
	switch {
	case errors.Is(err, errRegistrationRollbackFailed):
		status, code, message = http.StatusInternalServerError, "internal_error", "认证服务错误"
	case errors.Is(err, accounts.ErrInvalidCredentials):
		status, code, message = http.StatusUnauthorized, "unauthorized", "未认证"
	case errors.Is(err, accounts.ErrInvalidAccountRequest), errors.Is(err, accounts.ErrPasswordTooShort):
		status, code, message = http.StatusBadRequest, "invalid_request", "请求无效"
	case errors.Is(err, accounts.ErrEmailExists):
		status, code, message = http.StatusConflict, "email_exists", "该邮箱已注册"
	case errors.Is(err, agentprovisioning.ErrInvalidAgentID):
		status, code, message = http.StatusBadRequest, "invalid_agent_id", "Agent ID 无效"
	case errors.Is(err, agentprovisioning.ErrAgentForbidden):
		status, code, message = http.StatusForbidden, "agent_forbidden", "Agent 不可用"
	case errors.Is(err, agentprovisioning.ErrAgentIDConflict):
		status, code, message = http.StatusConflict, "agent_id_conflict", "Agent ID 已被占用"
	}
	c.JSON(status, gin.H{"error": gin.H{"code": code, "message": message, "details": []any{}}})
}

func mountAuthRoutes(auth *gin.RouterGroup, opts Options, cookies authCookieConfig) {
	if opts.AccountService == nil {
		return
	}
	register := handleRegister(opts.AccountService, opts.RBACService, opts.AgentProvisioningService, cookies)
	login := handleLogin(opts.AccountService, opts.RBACService, opts.AgentProvisioningService, cookies)
	logout := handleLogout(opts.AccountService, cookies)
	me := handleMe(opts.AccountService, opts.RBACService, opts.DingTalkAuth, opts.ActivityReportingEnabled)
	requireFrontend := requireJWT(opts.AccountService, accounts.AudienceFrontend, cookies.FrontendName)
	requireClaweeAgent := requireClaweeAgentBinding(opts.AccountService, opts.ProxyGateway)

	auth.POST("/register", register)
	auth.POST("/login", login)
	auth.POST("/logout", logout)
	mountDingTalkMethodsRoute(auth, opts)
	auth.POST("/dingtalk/clawee/token", handleDingTalkClaweeToken(opts))
	auth.POST("/dingtalk/unbind", requireFrontend, handleDingTalkUnbind(opts))
	auth.GET("/me", requireFrontend, requireClaweeAgent, me)
}
