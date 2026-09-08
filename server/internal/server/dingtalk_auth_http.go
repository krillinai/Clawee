package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/agentprovisioning"
	"github.com/krillinai/Clawee/server/internal/dingtalk"
)

const (
	dingtalkProviderType    = "dingtalk"
	dingtalkStateCookie     = "claw_dingtalk_oauth_state"
	dingtalkCookiePath      = "/api/v1/auth/dingtalk"
	intentLogin             = "login"
	intentBind              = "bind_current_user"
	intentClaweeLogin       = "login_clawee"
	pkceMethodS256          = "S256"
	claweeLoopbackHost      = "127.0.0.1"
	claweeLoopbackPath      = "/enterprise/dingtalk/callback"
	authorizationCodeTTL    = time.Minute
	claweeTokenBodyLimit    = 4096
	dingtalkUnbindBodyLimit = 4096
)

type dingtalkClaweeTokenRequest struct {
	GrantType    string `json:"grant_type"`
	ClientID     string `json:"client_id"`
	AgentID      string `json:"agent_id"`
	Code         string `json:"code"`
	RedirectURI  string `json:"redirect_uri"`
	CodeVerifier string `json:"code_verifier"`
}

type dingtalkUnbindRequest struct {
	Password string `json:"password"`
}

var errDingTalkEmailMissing = errors.New("dingtalk email is missing")

func mountDingTalkMethodsRoute(auth *gin.RouterGroup, opts Options) {
	auth.GET("/methods", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"password": true, "dingtalk": gin.H{"enabled": opts.DingTalkAuth.Enabled}}})
	})
}

func mountDingTalkBrowserRoutes(api *gin.RouterGroup, opts Options, cookies authCookieConfig) {
	auth := api.Group("/auth")
	auth.GET("/dingtalk/start", handleDingTalkStart(opts, cookies, intentLogin))
	auth.GET("/dingtalk/clawee/start", handleDingTalkClaweeStart(opts, cookies))
	auth.GET("/dingtalk/callback", handleDingTalkCallback(opts, cookies))
	auth.GET("/dingtalk/bind/start", requireJWT(opts.AccountService, accounts.AudienceFrontend, cookies.FrontendName), handleDingTalkStart(opts, cookies, intentBind))
}

func handleDingTalkClaweeStart(opts Options, cookies authCookieConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		setDingTalkBrowserSecurityHeaders(c)
		config := opts.DingTalkAuth
		if !config.Enabled || config.Client == nil {
			dingtalkJSONError(c, http.StatusNotFound, "dingtalk_disabled", "钉钉登录暂未启用")
			return
		}
		agentID, ok := normalizeClaweeAgentID(c.Query("agent_id"))
		if !ok {
			dingtalkJSONError(c, http.StatusBadRequest, "invalid_agent_id", "登录请求无效")
			return
		}
		redirectURI := c.Query("redirect_uri")
		if !validClaweeLoopbackURI(redirectURI) {
			dingtalkJSONError(c, http.StatusBadRequest, "invalid_redirect_uri", "登录请求无效")
			return
		}
		challenge := c.Query("code_challenge")
		if c.Query("code_challenge_method") != pkceMethodS256 || !validBase64URL32(challenge) {
			dingtalkJSONError(c, http.StatusBadRequest, "invalid_pkce", "登录请求无效")
			return
		}
		state := c.Query("state")
		if !validBase64URL32(state) {
			dingtalkJSONError(c, http.StatusBadRequest, "invalid_state", "登录请求无效")
			return
		}
		now := time.Now().UTC()
		if err := opts.AccountService.DeleteExpiredOAuthLoginStates(c.Request.Context(), now); err != nil {
			dingtalkJSONError(c, http.StatusInternalServerError, "internal_error", "登录失败，请稍后重试")
			return
		}
		if err := opts.AccountService.SaveOAuthLoginState(c.Request.Context(), accounts.OAuthLoginState{
			StateHash: hashOAuthState(state), ProviderType: dingtalkProviderType, ProviderKey: config.ProviderKey,
			Intent: intentClaweeLogin, RedirectTo: redirectURI, AgentID: agentID, PKCEChallenge: challenge,
			CreatedAt: now, ExpiresAt: now.Add(config.StateTTL),
		}); err != nil {
			dingtalkJSONError(c, http.StatusInternalServerError, "internal_error", "登录失败，请稍后重试")
			return
		}
		http.SetCookie(c.Writer, &http.Cookie{
			Name: dingtalkStateCookie, Value: state, Path: dingtalkCookiePath, MaxAge: int(config.StateTTL.Seconds()),
			HttpOnly: true, Secure: cookies.Secure, SameSite: http.SameSiteLaxMode,
		})
		c.Redirect(http.StatusFound, config.Client.AuthorizationURL(config.RedirectURL, state))
	}
}

func handleDingTalkStart(opts Options, cookies authCookieConfig, intent string) gin.HandlerFunc {
	return func(c *gin.Context) {
		setDingTalkBrowserSecurityHeaders(c)
		config := opts.DingTalkAuth
		if !config.Enabled || config.Client == nil {
			dingtalkJSONError(c, http.StatusNotFound, "dingtalk_disabled", "钉钉登录暂未启用")
			return
		}
		bindUserID := ""
		if intent == intentBind {
			principal, ok := currentPrincipal(c)
			if !ok {
				dingtalkJSONError(c, http.StatusUnauthorized, "unauthorized", "未认证")
				return
			}
			if _, err := opts.AccountService.AccountIdentityForUser(c.Request.Context(), principal.UserID, dingtalkProviderType, config.ProviderKey); err == nil {
				dingtalkJSONError(c, http.StatusConflict, "dingtalk_already_bound", "当前账户已绑定钉钉")
				return
			} else if !errors.Is(err, accounts.ErrAccountIdentityNotFound) {
				dingtalkJSONError(c, http.StatusInternalServerError, "internal_error", "登录失败，请稍后重试")
				return
			}
			bindUserID = principal.UserID
		}
		state, err := randomOAuthState()
		if err != nil {
			dingtalkJSONError(c, http.StatusInternalServerError, "internal_error", "登录失败，请稍后重试")
			return
		}
		now := time.Now().UTC()
		if err := opts.AccountService.DeleteExpiredOAuthLoginStates(c.Request.Context(), now); err != nil {
			dingtalkJSONError(c, http.StatusInternalServerError, "internal_error", "登录失败，请稍后重试")
			return
		}
		if err := opts.AccountService.SaveOAuthLoginState(c.Request.Context(), accounts.OAuthLoginState{
			StateHash: hashOAuthState(state), ProviderType: dingtalkProviderType, ProviderKey: config.ProviderKey,
			Intent: intent, RedirectTo: normalizeOAuthRedirect(c.Query("redirect")), BindUserID: bindUserID,
			CreatedAt: now, ExpiresAt: now.Add(config.StateTTL),
		}); err != nil {
			dingtalkJSONError(c, http.StatusInternalServerError, "internal_error", "登录失败，请稍后重试")
			return
		}
		http.SetCookie(c.Writer, &http.Cookie{
			Name: dingtalkStateCookie, Value: state, Path: dingtalkCookiePath, MaxAge: int(config.StateTTL.Seconds()),
			HttpOnly: true, Secure: cookies.Secure, SameSite: http.SameSiteLaxMode,
		})
		c.Redirect(http.StatusFound, config.Client.AuthorizationURL(config.RedirectURL, state))
	}
}

func handleDingTalkCallback(opts Options, cookies authCookieConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		setDingTalkBrowserSecurityHeaders(c)
		config := opts.DingTalkAuth
		if !config.Enabled || config.Client == nil {
			rejectDingTalkLogin(c, opts, "dingtalk_disabled", "")
			return
		}
		code := strings.TrimSpace(c.Query("code"))
		state := strings.TrimSpace(c.Query("state"))
		providerDenied := strings.TrimSpace(c.Query("error")) != ""
		cookie, cookieErr := c.Request.Cookie(dingtalkStateCookie)
		if (!providerDenied && code == "") || state == "" || cookieErr != nil || subtle.ConstantTimeCompare([]byte(state), []byte(cookie.Value)) != 1 {
			rejectDingTalkLogin(c, opts, "oauth_state_invalid", "")
			return
		}
		loginState, err := opts.AccountService.ConsumeOAuthLoginState(c.Request.Context(), hashOAuthState(state), time.Now().UTC())
		clearDingTalkStateCookie(c, cookies.Secure)
		if err != nil || loginState.ProviderType != dingtalkProviderType || loginState.ProviderKey != config.ProviderKey ||
			!validDingTalkLoginIntent(loginState) {
			rejectDingTalkLogin(c, opts, "oauth_state_invalid", "")
			return
		}
		if providerDenied {
			rejectTrustedDingTalkLogin(c, opts, loginState, state, "oauth_provider_denied", "")
			return
		}
		member, err := config.Client.ResolveMember(c.Request.Context(), code)
		if err != nil {
			if dingtalk.IsNotEnterpriseMember(err) {
				rejectTrustedDingTalkLogin(c, opts, loginState, state, "not_enterprise_member", "")
			} else {
				logDingTalkUpstreamError(opts.Logger, err)
				rejectTrustedDingTalkLogin(c, opts, loginState, state, "dingtalk_upstream_unavailable", "")
			}
			return
		}
		identity := accounts.AccountIdentity{
			ProviderType: dingtalkProviderType, ProviderKey: config.ProviderKey, ProviderSubject: member.UnionID,
			ExternalUserID: member.UserID, VerifiedAt: time.Now().UTC(),
		}
		if loginState.Intent == intentBind {
			handleDingTalkBindCallback(c, opts, cookies, loginState, identity)
			return
		}
		account, _, err := resolveDingTalkAccount(c, opts, identity, member)
		if err != nil {
			rejectTrustedDingTalkLogin(c, opts, loginState, state, dingtalkAccountErrorCode(err), identity.ProviderSubject)
			return
		}
		if loginState.Intent == intentClaweeLogin {
			handleDingTalkClaweeCallback(c, opts, loginState, state, account, identity.ProviderSubject)
			return
		}
		handleDingTalkLoginCallback(c, opts, cookies, loginState, account, identity.ProviderSubject)
	}
}

func resolveDingTalkAccount(c *gin.Context, opts Options, identity accounts.AccountIdentity, member dingtalk.Member) (accounts.Account, bool, error) {
	account, err := opts.AccountService.ResolveExternalIdentity(c.Request.Context(), identity)
	created := false
	if errors.Is(err, accounts.ErrAccountIdentityNotFound) {
		if strings.TrimSpace(member.Email) == "" {
			return accounts.Account{}, false, errDingTalkEmailMissing
		}
		hasActiveAdmin, adminErr := opts.RBACService.HasActiveAdmin(c.Request.Context())
		if adminErr != nil {
			return accounts.Account{}, false, adminErr
		}
		account, created, err = opts.AccountService.ProvisionExternalAccountWithCreated(c.Request.Context(), identity,
			accounts.ExternalAccountRequest{Email: member.Email, Name: member.Name}, opts.DingTalkAuth.AutoProvision, hasActiveAdmin)
		if err == nil && created {
			logDingTalkEvent(c, opts, "dingtalk_account_provisioned", account.UserID, identity.ProviderSubject,
				zap.Bool("auto_provisioned", true))
		}
	}
	return account, created, err
}

func handleDingTalkLoginCallback(c *gin.Context, opts Options, cookies authCookieConfig, state accounts.OAuthLoginState, account accounts.Account, providerSubject string) {
	hasAdmin, err := opts.RBACService.HasAnyPermission(c.Request.Context(), account.UserID)
	if err != nil {
		rejectDingTalkLogin(c, opts, "internal_error", providerSubject)
		return
	}
	tokens, err := issueWebTokens(c.Request.Context(), opts.AccountService, account, hasAdmin)
	if err != nil {
		rejectDingTalkLogin(c, opts, "internal_error", providerSubject)
		return
	}
	setWebAuthCookies(c, cookies, tokens)
	logDingTalkEvent(c, opts, "dingtalk_login_succeeded", account.UserID, providerSubject,
		zap.Bool("has_admin", hasAdmin))
	redirectTo := state.RedirectTo
	if strings.HasPrefix(redirectTo, "/admin") && !hasAdmin {
		redirectTo = "/app"
	}
	c.Redirect(http.StatusFound, redirectTo)
}

func handleDingTalkClaweeCallback(c *gin.Context, opts Options, state accounts.OAuthLoginState, rawState string, account accounts.Account, providerSubject string) {
	now := time.Now().UTC()
	if err := opts.AccountService.DeleteExpiredOAuthAuthorizationCodes(c.Request.Context(), now); err != nil {
		rejectTrustedDingTalkLogin(c, opts, state, rawState, "internal_error", providerSubject)
		return
	}
	code, err := randomOAuthState()
	if err != nil {
		rejectTrustedDingTalkLogin(c, opts, state, rawState, "internal_error", providerSubject)
		return
	}
	if err := opts.AccountService.SaveOAuthAuthorizationCode(c.Request.Context(), accounts.OAuthAuthorizationCode{
		CodeHash: hashOAuthState(code), UserID: account.UserID, AgentID: state.AgentID,
		RedirectURI: state.RedirectTo, PKCEChallenge: state.PKCEChallenge,
		CreatedAt: now, ExpiresAt: now.Add(authorizationCodeTTL),
	}); err != nil {
		rejectTrustedDingTalkLogin(c, opts, state, rawState, "internal_error", providerSubject)
		return
	}
	redirectTrustedClawee(c, state.RedirectTo, url.Values{"code": {code}, "state": {rawState}})
}

func handleDingTalkClaweeToken(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		setDingTalkTokenSecurityHeaders(c)
		if !opts.DingTalkAuth.Enabled || opts.DingTalkAuth.Client == nil {
			rejectDingTalkClaweeToken(c, opts, http.StatusNotFound, "dingtalk_disabled", "钉钉登录暂未启用", "", "")
			return
		}
		mediaType, _, mediaTypeErr := mime.ParseMediaType(c.GetHeader("Content-Type"))
		if mediaTypeErr != nil || mediaType != "application/json" {
			rejectDingTalkClaweeToken(c, opts, http.StatusBadRequest, "invalid_request", "请求无效", "", "")
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, claweeTokenBodyLimit)
		var req dingtalkClaweeTokenRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			rejectDingTalkClaweeToken(c, opts, http.StatusBadRequest, "invalid_request", "请求无效", "", "")
			return
		}
		agentID, validAgentID := normalizeClaweeAgentID(req.AgentID)
		if req.GrantType != "authorization_code" || req.ClientID != accounts.ClientClaweeAgent ||
			!validAgentID || agentID != req.AgentID || !validBase64URL32(req.Code) ||
			!validClaweeLoopbackURI(req.RedirectURI) || !validBase64URL32(req.CodeVerifier) {
			if !validAgentID || agentID != req.AgentID {
				agentID = ""
			}
			rejectDingTalkClaweeToken(c, opts, http.StatusBadRequest, "invalid_request", "请求无效", "", agentID)
			return
		}
		challenge := pkceChallenge(req.CodeVerifier)
		code, err := opts.AccountService.ConsumeOAuthAuthorizationCode(c.Request.Context(), accounts.OAuthAuthorizationCodeConsumeRequest{
			CodeHash: hashOAuthState(req.Code), AgentID: agentID, RedirectURI: req.RedirectURI,
			PKCEChallenge: challenge, Now: time.Now().UTC(),
		})
		if err != nil {
			if errors.Is(err, accounts.ErrOAuthAuthorizationCodeNotFound) {
				rejectDingTalkClaweeToken(c, opts, http.StatusBadRequest, "invalid_grant", "授权请求无效或已失效", "", agentID)
			} else {
				rejectDingTalkClaweeToken(c, opts, http.StatusInternalServerError, "internal_error", "认证服务错误", "", agentID)
			}
			return
		}
		account, err := opts.AccountService.Account(c.Request.Context(), code.UserID)
		if err != nil {
			rejectDingTalkClaweeToken(c, opts, http.StatusInternalServerError, "internal_error", "认证服务错误", code.UserID, agentID)
			return
		}
		if account.Status != accounts.StatusActive {
			rejectDingTalkClaweeToken(c, opts, http.StatusForbidden, "account_disabled", "账户不可用", account.UserID, agentID)
			return
		}
		result, err := issueClaweeSession(c.Request.Context(), opts.AccountService, opts.AgentProvisioningService, account, agentID)
		if err != nil {
			status, errorCode, message := dingtalkClaweeSessionError(err)
			rejectDingTalkClaweeToken(c, opts, status, errorCode, message, account.UserID, agentID)
			return
		}
		logDingTalkEvent(c, opts, "dingtalk_login_succeeded", account.UserID, "",
			zap.String("intent", intentClaweeLogin), zap.String("agent_id", result.Agent.AgentID), zap.Bool("agent_created", result.Created))
		writeClaweeSessionResponse(c, result)
	}
}

func handleDingTalkBindCallback(c *gin.Context, opts Options, cookies authCookieConfig, state accounts.OAuthLoginState, identity accounts.AccountIdentity) {
	cookie, err := c.Request.Cookie(cookies.FrontendName)
	if err != nil {
		rejectDingTalkLogin(c, opts, "unauthorized", identity.ProviderSubject)
		return
	}
	authenticated, err := opts.AccountService.AuthenticateToken(c.Request.Context(), cookie.Value, accounts.AudienceFrontend)
	if err != nil || authenticated.Principal.UserID != state.BindUserID {
		rejectDingTalkLogin(c, opts, "unauthorized", identity.ProviderSubject)
		return
	}
	if err := opts.AccountService.BindExternalIdentity(c.Request.Context(), authenticated.Principal.UserID, identity); err != nil {
		rejectDingTalkLogin(c, opts, dingtalkAccountErrorCode(err), identity.ProviderSubject)
		return
	}
	logDingTalkEvent(c, opts, "dingtalk_identity_bound", authenticated.Principal.UserID, identity.ProviderSubject,
		zap.Bool("bound", true))
	c.Redirect(http.StatusFound, "/app/agents")
}

func handleDingTalkUnbind(opts Options) gin.HandlerFunc {
	return func(c *gin.Context) {
		account, ok := currentAccount(c)
		if !ok {
			dingtalkJSONError(c, http.StatusUnauthorized, "unauthorized", "未认证")
			return
		}
		var req dingtalkUnbindRequest
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, dingtalkUnbindBodyLimit)
		if err := c.ShouldBindJSON(&req); err != nil {
			dingtalkJSONError(c, http.StatusBadRequest, "invalid_request", "请求无效")
			return
		}
		identity, err := opts.AccountService.UnbindExternalIdentity(
			c.Request.Context(), account.UserID, dingtalkProviderType, opts.DingTalkAuth.ProviderKey, req.Password,
		)
		if err != nil {
			status, code, message := http.StatusInternalServerError, "internal_error", "解绑失败，请稍后重试"
			switch {
			case errors.Is(err, accounts.ErrInvalidCredentials):
				status, code, message = http.StatusForbidden, "invalid_password", "当前密码错误"
			case errors.Is(err, accounts.ErrLocalPasswordRequired):
				status, code, message = http.StatusConflict, "local_password_required", "当前账户未设置本地密码，无法解绑钉钉"
			case errors.Is(err, accounts.ErrAccountIdentityNotFound):
				status, code, message = http.StatusConflict, "dingtalk_not_bound", "当前账户未绑定钉钉"
			}
			logDingTalkEvent(c, opts, "dingtalk_identity_unbind_rejected", account.UserID, "", zap.String("error_code", code))
			dingtalkJSONError(c, status, code, message)
			return
		}
		logDingTalkEvent(c, opts, "dingtalk_identity_unbound", account.UserID, identity.ProviderSubject,
			zap.Bool("bound", false))
		c.Status(http.StatusNoContent)
	}
}

func randomOAuthState() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func validBase64URL32(value string) bool {
	if len(value) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func normalizeClaweeAgentID(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	return value, value != "" && utf8.RuneCountInString(value) <= 64
}

func pkceChallenge(verifier string) string {
	digest := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func validClaweeLoopbackURI(raw string) bool {
	if raw == "" || strings.TrimSpace(raw) != raw || strings.ContainsAny(raw, "\r\n") {
		return false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" || parsed.Opaque != "" || parsed.User != nil ||
		parsed.Hostname() != claweeLoopbackHost || parsed.Path != claweeLoopbackPath || parsed.RawPath != "" ||
		parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return false
	}
	port := parsed.Port()
	if port == "" || parsed.Host != claweeLoopbackHost+":"+port {
		return false
	}
	portNumber, err := strconv.Atoi(port)
	return err == nil && portNumber >= 1024 && portNumber <= 65535
}

func validDingTalkLoginIntent(state accounts.OAuthLoginState) bool {
	switch state.Intent {
	case intentLogin:
		return state.BindUserID == "" && state.AgentID == "" && state.PKCEChallenge == ""
	case intentBind:
		return state.BindUserID != "" && state.AgentID == "" && state.PKCEChallenge == ""
	case intentClaweeLogin:
		agentID, ok := normalizeClaweeAgentID(state.AgentID)
		return ok && agentID == state.AgentID && state.BindUserID == "" && validClaweeLoopbackURI(state.RedirectTo) && validBase64URL32(state.PKCEChallenge)
	default:
		return false
	}
}

func hashOAuthState(state string) string {
	digest := sha256.Sum256([]byte(state))
	return hex.EncodeToString(digest[:])
}

func normalizeOAuthRedirect(raw string) string {
	if raw == "" {
		return "/admin"
	}
	decoded, err := url.QueryUnescape(raw)
	if err != nil || strings.ContainsAny(decoded, "\\\r\n") || strings.Contains(decoded, "://") || strings.HasPrefix(decoded, "//") {
		return "/app"
	}
	parsed, err := url.Parse(decoded)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.RawQuery != "" || parsed.Fragment != "" || path.Clean(parsed.Path) != parsed.Path {
		return "/app"
	}
	if parsed.Path == "/app" || strings.HasPrefix(parsed.Path, "/app/") || parsed.Path == "/admin" || strings.HasPrefix(parsed.Path, "/admin/") {
		return parsed.Path
	}
	return "/app"
}

func clearDingTalkStateCookie(c *gin.Context, secure bool) {
	http.SetCookie(c.Writer, &http.Cookie{Name: dingtalkStateCookie, Value: "", Path: dingtalkCookiePath, MaxAge: -1, HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})
}

func redirectDingTalkError(c *gin.Context, code string) {
	query := url.Values{"oauth_provider": {"dingtalk"}, "oauth_error": {code}}
	c.Redirect(http.StatusFound, "/login?"+query.Encode())
}

func rejectDingTalkLogin(c *gin.Context, opts Options, code, providerSubject string) {
	logDingTalkEvent(c, opts, "dingtalk_login_rejected", "", providerSubject, zap.String("error_code", code))
	redirectDingTalkError(c, code)
}

func rejectTrustedDingTalkLogin(c *gin.Context, opts Options, state accounts.OAuthLoginState, rawState, code, providerSubject string) {
	if state.Intent != intentClaweeLogin || !validDingTalkLoginIntent(state) {
		rejectDingTalkLogin(c, opts, code, providerSubject)
		return
	}
	logDingTalkEvent(c, opts, "dingtalk_login_rejected", "", providerSubject,
		zap.String("error_code", code), zap.String("intent", intentClaweeLogin), zap.String("agent_id", state.AgentID))
	redirectTrustedClawee(c, state.RedirectTo, url.Values{"error": {code}, "state": {rawState}})
}

func redirectTrustedClawee(c *gin.Context, redirectURI string, query url.Values) {
	if !validClaweeLoopbackURI(redirectURI) {
		redirectDingTalkError(c, "oauth_state_invalid")
		return
	}
	parsed, _ := url.Parse(redirectURI)
	parsed.RawQuery = query.Encode()
	c.Redirect(http.StatusFound, parsed.String())
}

func setDingTalkBrowserSecurityHeaders(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Header("Referrer-Policy", "no-referrer")
}

func setDingTalkTokenSecurityHeaders(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Header("Pragma", "no-cache")
}

func rejectDingTalkClaweeToken(c *gin.Context, opts Options, status int, code, message, userID, agentID string) {
	fields := []zap.Field{zap.String("error_code", code), zap.String("intent", intentClaweeLogin)}
	if agentID != "" {
		fields = append(fields, zap.String("agent_id", agentID))
	}
	logDingTalkEvent(c, opts, "dingtalk_login_rejected", userID, "", fields...)
	dingtalkJSONError(c, status, code, message)
}

func dingtalkClaweeSessionError(err error) (int, string, string) {
	switch {
	case errors.Is(err, errAgentProvisioningServiceUnavailable):
		return http.StatusServiceUnavailable, "agent_provisioning_unavailable", "Agent 服务暂不可用"
	case errors.Is(err, agentprovisioning.ErrAgentIDConflict):
		return http.StatusConflict, "agent_id_conflict", "Agent ID 已被占用"
	case errors.Is(err, agentprovisioning.ErrAgentForbidden):
		return http.StatusForbidden, "agent_forbidden", "Agent 不可用"
	default:
		return http.StatusInternalServerError, "internal_error", "认证服务错误"
	}
}

func logDingTalkEvent(c *gin.Context, opts Options, event, userID, providerSubject string, extra ...zap.Field) {
	if opts.Logger == nil {
		return
	}
	fields := []zap.Field{
		zap.String("request_id", requestIDFromContext(c.Request.Context())),
		zap.String("user_id", userID),
		zap.String("provider_type", dingtalkProviderType),
		zap.String("provider_key", opts.DingTalkAuth.ProviderKey),
	}
	if providerSubject != "" {
		digest := sha256.Sum256([]byte(providerSubject))
		fields = append(fields, zap.String("provider_subject_hash", hex.EncodeToString(digest[:])[:12]))
	}
	opts.Logger.Info(event, append(fields, extra...)...)
}

func dingtalkJSONError(c *gin.Context, status int, code, message string) {
	c.JSON(status, gin.H{"error": gin.H{"code": code, "message": message, "details": []any{}}})
}

func dingtalkAccountErrorCode(err error) string {
	switch {
	case errors.Is(err, errDingTalkEmailMissing):
		return "dingtalk_email_missing"
	case errors.Is(err, accounts.ErrExternalAccountConflict):
		return "account_binding_required"
	case errors.Is(err, accounts.ErrExternalAccountProvisionDisabled):
		return "auto_provision_disabled"
	case errors.Is(err, accounts.ErrSystemNotInitialized):
		return "system_not_initialized"
	case errors.Is(err, accounts.ErrAccountNotActive):
		return "account_disabled"
	case errors.Is(err, accounts.ErrAccountIdentityExists), errors.Is(err, accounts.ErrAccountIdentityUserConflict):
		return "identity_conflict"
	default:
		return "internal_error"
	}
}

func logDingTalkUpstreamError(logger *zap.Logger, err error) {
	if logger == nil {
		return
	}
	var apiErr *dingtalk.APIError
	if errors.As(err, &apiErr) {
		logger.Warn("dingtalk upstream call failed", zap.String("step", apiErr.Step), zap.String("code", apiErr.Code), zap.Int("status", apiErr.HTTPStatus))
		return
	}
	logger.Warn("dingtalk upstream call failed")
}
