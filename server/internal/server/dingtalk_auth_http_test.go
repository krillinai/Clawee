package server_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/dingtalk"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/office/httpapi"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
)

type fakeDingTalkClient struct {
	member dingtalk.Member
	err    error
	calls  *int
}

func (f fakeDingTalkClient) AuthorizationURL(redirectURL, state string) string {
	return "https://login.dingtalk.test/auth?redirect_uri=" + url.QueryEscape(redirectURL) + "&state=" + url.QueryEscape(state)
}

func (f fakeDingTalkClient) ResolveMember(context.Context, string) (dingtalk.Member, error) {
	if f.calls != nil {
		(*f.calls)++
	}
	return f.member, f.err
}

func TestDingTalkMethodsAndStateReplayProtection(t *testing.T) {
	store := accounts.NewMemoryStore()
	accountSvc := accounts.NewService(accounts.Config{Store: store, JWTSigningKey: []byte(testJWTKey)})
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{
			Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback",
			StateTTL: 10 * time.Minute, Client: fakeDingTalkClient{member: dingtalk.Member{
				UnionID: "union-1", UserID: "staff-1", Name: "成员", Email: "member@example.com",
			}},
		},
	})

	methods := httptest.NewRecorder()
	router.ServeHTTP(methods, httptest.NewRequest(http.MethodGet, "/api/v1/auth/methods", nil))
	if methods.Code != http.StatusOK || !strings.Contains(methods.Body.String(), `"enabled":true`) || strings.Contains(methods.Body.String(), "provider_key") {
		t.Fatalf("methods status=%d body=%s", methods.Code, methods.Body.String())
	}

	start := httptest.NewRecorder()
	router.ServeHTTP(start, httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/start?redirect=//evil.example", nil))
	if start.Code != http.StatusFound {
		t.Fatalf("start status=%d body=%s", start.Code, start.Body.String())
	}
	stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")
	location, err := url.Parse(start.Header().Get("Location"))
	if err != nil || location.Query().Get("state") != stateCookie.Value {
		t.Fatalf("authorization location=%q cookie=%#v err=%v", start.Header().Get("Location"), stateCookie, err)
	}

	callbackURL := "/api/v1/auth/dingtalk/callback?code=code&state=" + url.QueryEscape(stateCookie.Value)
	callback := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, callbackURL, nil)
	request.AddCookie(stateCookie)
	router.ServeHTTP(callback, request)
	if callback.Code != http.StatusFound || callback.Header().Get("Location") != "/login?oauth_error=auto_provision_disabled&oauth_provider=dingtalk" {
		t.Fatalf("callback status=%d location=%q", callback.Code, callback.Header().Get("Location"))
	}

	replay := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, callbackURL, nil)
	request.AddCookie(stateCookie)
	router.ServeHTTP(replay, request)
	if replay.Code != http.StatusFound || !strings.Contains(replay.Header().Get("Location"), "oauth_state_invalid") {
		t.Fatalf("replay status=%d location=%q", replay.Code, replay.Header().Get("Location"))
	}
}

func TestDingTalkBoundLoginIssuesExistingWebCookies(t *testing.T) {
	ctx := context.Background()
	store := accounts.NewMemoryStore()
	accountSvc := accounts.NewService(accounts.Config{Store: store, JWTSigningKey: []byte(testJWTKey)})
	registration, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "admin@example.com", Name: "Admin", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	if err := rbacSvc.BootstrapAdmin(ctx, registration.Account.UserID); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	identity := accounts.AccountIdentity{ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-1", ExternalUserID: "staff-1", VerifiedAt: now}
	if err := accountSvc.BindExternalIdentity(ctx, registration.Account.UserID, identity); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{
			Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback", StateTTL: 10 * time.Minute,
			Client: fakeDingTalkClient{member: dingtalk.Member{UnionID: "union-1", UserID: "staff-2"}},
		},
	})
	start := httptest.NewRecorder()
	router.ServeHTTP(start, httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/start?redirect=/admin/accounts", nil))
	stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")
	callback := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/callback?code=code&state="+url.QueryEscape(stateCookie.Value), nil)
	request.AddCookie(stateCookie)
	router.ServeHTTP(callback, request)
	if callback.Code != http.StatusFound || callback.Header().Get("Location") != "/admin/accounts" {
		t.Fatalf("callback status=%d location=%q", callback.Code, callback.Header().Get("Location"))
	}
	frontendCookie(t, callback.Result().Cookies())
	adminCookie(t, callback.Result().Cookies())
}

func TestDingTalkBindRequiresCurrentFrontendSession(t *testing.T) {
	ctx := context.Background()
	store := accounts.NewMemoryStore()
	accountSvc := accounts.NewService(accounts.Config{Store: store, JWTSigningKey: []byte(testJWTKey)})
	registration, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "user@example.com", Name: "User", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, registration.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	frontCookie := &http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token}
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{
			Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback", StateTTL: 10 * time.Minute,
			Client: fakeDingTalkClient{member: dingtalk.Member{UnionID: "union-bind", UserID: "staff-bind", Name: "User", Email: "user@example.com"}},
		},
	})

	unauthorized := httptest.NewRecorder()
	router.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/bind/start", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized bind start status = %d", unauthorized.Code)
	}

	start := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/bind/start?redirect=/app/agents", nil)
	request.AddCookie(frontCookie)
	router.ServeHTTP(start, request)
	stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")

	callback := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/callback?code=code&state="+url.QueryEscape(stateCookie.Value), nil)
	request.AddCookie(stateCookie)
	request.AddCookie(frontCookie)
	router.ServeHTTP(callback, request)
	if callback.Code != http.StatusFound || callback.Header().Get("Location") != "/app/agents" {
		t.Fatalf("bind callback status=%d location=%q", callback.Code, callback.Header().Get("Location"))
	}
	identity, err := accountSvc.AccountIdentityForUser(ctx, registration.Account.UserID, "dingtalk", "default")
	if err != nil || identity.ProviderSubject != "union-bind" {
		t.Fatalf("bound identity = %#v, %v", identity, err)
	}
}

func TestDingTalkCallbackRejectsMissingAndMismatchedStateCookie(t *testing.T) {
	store := accounts.NewMemoryStore()
	accountSvc := accounts.NewService(accounts.Config{Store: store, JWTSigningKey: []byte(testJWTKey)})
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	calls := 0
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{
			Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback", StateTTL: 10 * time.Minute,
			Client: fakeDingTalkClient{calls: &calls},
		},
	})
	start := httptest.NewRecorder()
	router.ServeHTTP(start, httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/start", nil))
	stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")
	callbackURL := "/api/v1/auth/dingtalk/callback?code=code&state=" + url.QueryEscape(stateCookie.Value)

	for _, cookie := range []*http.Cookie{nil, {Name: stateCookie.Name, Value: "wrong", Path: stateCookie.Path}} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, callbackURL, nil)
		if cookie != nil {
			request.AddCookie(cookie)
		}
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusFound || !strings.Contains(recorder.Header().Get("Location"), "oauth_state_invalid") {
			t.Fatalf("invalid cookie status=%d location=%q", recorder.Code, recorder.Header().Get("Location"))
		}
	}
	if calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", calls)
	}

	valid := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, callbackURL, nil)
	request.AddCookie(stateCookie)
	router.ServeHTTP(valid, request)
	if strings.Contains(valid.Header().Get("Location"), "oauth_state_invalid") || calls != 1 {
		t.Fatalf("valid state location=%q calls=%d", valid.Header().Get("Location"), calls)
	}
}

func TestDingTalkProviderDenialConsumesTrustedState(t *testing.T) {
	store := accounts.NewMemoryStore()
	accountSvc := accounts.NewService(accounts.Config{Store: store, JWTSigningKey: []byte(testJWTKey)})
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	_ = rbacSvc.Initialize(context.Background())
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback", StateTTL: 10 * time.Minute, Client: fakeDingTalkClient{}},
	})
	start := httptest.NewRecorder()
	router.ServeHTTP(start, httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/start", nil))
	stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")

	denied := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/callback?error=access_denied&state="+url.QueryEscape(stateCookie.Value), nil)
	request.AddCookie(stateCookie)
	router.ServeHTTP(denied, request)
	if !strings.Contains(denied.Header().Get("Location"), "oauth_provider_denied") {
		t.Fatalf("denied location=%q", denied.Header().Get("Location"))
	}

	callback := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/callback?code=code&state="+url.QueryEscape(stateCookie.Value), nil)
	request.AddCookie(stateCookie)
	router.ServeHTTP(callback, request)
	if !strings.Contains(callback.Header().Get("Location"), "oauth_state_invalid") {
		t.Fatalf("provider denial did not consume state: %q", callback.Header().Get("Location"))
	}
}

func TestDingTalkClaweeStartValidatesAndPersistsBoundState(t *testing.T) {
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{
			Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback",
			StateTTL: 10 * time.Minute, Client: fakeDingTalkClient{},
		},
	})
	state := dingTalkTestSecret('s')
	challenge := dingTalkTestSecret('c')
	redirectURI := "http://127.0.0.1:49152/enterprise/dingtalk/callback"
	startURL := claweeDingTalkStartURL("clawee_agent_1", redirectURI, challenge, "S256", state)

	start := httptest.NewRecorder()
	router.ServeHTTP(start, httptest.NewRequest(http.MethodGet, startURL, nil))
	if start.Code != http.StatusFound || start.Header().Get("Cache-Control") != "no-store" || start.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("start status=%d headers=%v body=%s", start.Code, start.Header(), start.Body.String())
	}
	stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")
	if stateCookie.Value != state || !stateCookie.HttpOnly || stateCookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("state cookie = %#v", stateCookie)
	}
	stored, err := accountSvc.ConsumeOAuthLoginState(context.Background(), dingTalkTestHash(state), time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if stored.Intent != "login_clawee" || stored.AgentID != "clawee_agent_1" || stored.RedirectTo != redirectURI || stored.PKCEChallenge != challenge || stored.BindUserID != "" {
		t.Fatalf("stored state = %#v", stored)
	}
}

func TestDingTalkClaweeStartRejectsUnsafeInputs(t *testing.T) {
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	router := server.NewRouter(server.Options{
		AccountService: accountSvc,
		DingTalkAuth: server.DingTalkAuthOptions{
			Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback",
			StateTTL: 10 * time.Minute, Client: fakeDingTalkClient{},
		},
	})
	validState := dingTalkTestSecret('s')
	validChallenge := dingTalkTestSecret('c')
	validRedirect := "http://127.0.0.1:49152/enterprise/dingtalk/callback"
	tests := []struct {
		name, agentID, redirectURI, challenge, method, state, code string
	}{
		{name: "empty agent", redirectURI: validRedirect, challenge: validChallenge, method: "S256", state: validState, code: "invalid_agent_id"},
		{name: "long agent", agentID: strings.Repeat("a", 65), redirectURI: validRedirect, challenge: validChallenge, method: "S256", state: validState, code: "invalid_agent_id"},
		{name: "localhost", agentID: "agent", redirectURI: "http://localhost:49152/enterprise/dingtalk/callback", challenge: validChallenge, method: "S256", state: validState, code: "invalid_redirect_uri"},
		{name: "zero host", agentID: "agent", redirectURI: "http://0.0.0.0:49152/enterprise/dingtalk/callback", challenge: validChallenge, method: "S256", state: validState, code: "invalid_redirect_uri"},
		{name: "public host", agentID: "agent", redirectURI: "http://example.com:49152/enterprise/dingtalk/callback", challenge: validChallenge, method: "S256", state: validState, code: "invalid_redirect_uri"},
		{name: "fake host", agentID: "agent", redirectURI: "http://127.0.0.1.evil.example:49152/enterprise/dingtalk/callback", challenge: validChallenge, method: "S256", state: validState, code: "invalid_redirect_uri"},
		{name: "ipv6", agentID: "agent", redirectURI: "http://[::1]:49152/enterprise/dingtalk/callback", challenge: validChallenge, method: "S256", state: validState, code: "invalid_redirect_uri"},
		{name: "https", agentID: "agent", redirectURI: "https://127.0.0.1:49152/enterprise/dingtalk/callback", challenge: validChallenge, method: "S256", state: validState, code: "invalid_redirect_uri"},
		{name: "userinfo", agentID: "agent", redirectURI: "http://user@127.0.0.1:49152/enterprise/dingtalk/callback", challenge: validChallenge, method: "S256", state: validState, code: "invalid_redirect_uri"},
		{name: "missing port", agentID: "agent", redirectURI: "http://127.0.0.1/enterprise/dingtalk/callback", challenge: validChallenge, method: "S256", state: validState, code: "invalid_redirect_uri"},
		{name: "query", agentID: "agent", redirectURI: validRedirect + "?x=1", challenge: validChallenge, method: "S256", state: validState, code: "invalid_redirect_uri"},
		{name: "fragment", agentID: "agent", redirectURI: validRedirect + "#x", challenge: validChallenge, method: "S256", state: validState, code: "invalid_redirect_uri"},
		{name: "trailing slash", agentID: "agent", redirectURI: validRedirect + "/", challenge: validChallenge, method: "S256", state: validState, code: "invalid_redirect_uri"},
		{name: "encoded path", agentID: "agent", redirectURI: "http://127.0.0.1:49152/enterprise/dingtalk/%63allback", challenge: validChallenge, method: "S256", state: validState, code: "invalid_redirect_uri"},
		{name: "low port", agentID: "agent", redirectURI: "http://127.0.0.1:80/enterprise/dingtalk/callback", challenge: validChallenge, method: "S256", state: validState, code: "invalid_redirect_uri"},
		{name: "plain pkce", agentID: "agent", redirectURI: validRedirect, challenge: validChallenge, method: "plain", state: validState, code: "invalid_pkce"},
		{name: "bad challenge", agentID: "agent", redirectURI: validRedirect, challenge: strings.Repeat("a", 42), method: "S256", state: validState, code: "invalid_pkce"},
		{name: "bad state", agentID: "agent", redirectURI: validRedirect, challenge: validChallenge, method: "S256", state: strings.Repeat("s", 42) + "!", code: "invalid_state"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
				claweeDingTalkStartURL(test.agentID, test.redirectURI, test.challenge, test.method, test.state), nil))
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestDingTalkClaweeProviderDenialUsesTrustedLoopback(t *testing.T) {
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	router := server.NewRouter(server.Options{
		AccountService: accountSvc,
		DingTalkAuth: server.DingTalkAuthOptions{
			Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback",
			StateTTL: 10 * time.Minute, Client: fakeDingTalkClient{},
		},
	})
	state := dingTalkTestSecret('s')
	redirectURI := "http://127.0.0.1:49152/enterprise/dingtalk/callback"
	start := httptest.NewRecorder()
	router.ServeHTTP(start, httptest.NewRequest(http.MethodGet,
		claweeDingTalkStartURL("clawee_agent_1", redirectURI, dingTalkTestSecret('c'), "S256", state), nil))
	stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")

	denied := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/callback?error=access_denied&state="+url.QueryEscape(state), nil)
	request.AddCookie(stateCookie)
	router.ServeHTTP(denied, request)
	want := redirectURI + "?error=oauth_provider_denied&state=" + url.QueryEscape(state)
	if denied.Code != http.StatusFound || denied.Header().Get("Location") != want {
		t.Fatalf("denied status=%d location=%q want=%q", denied.Code, denied.Header().Get("Location"), want)
	}

	replay := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/callback?error=access_denied&state="+url.QueryEscape(state), nil)
	request.AddCookie(stateCookie)
	router.ServeHTTP(replay, request)
	if strings.HasPrefix(replay.Header().Get("Location"), redirectURI) || !strings.Contains(replay.Header().Get("Location"), "oauth_state_invalid") {
		t.Fatalf("replay used loopback: %q", replay.Header().Get("Location"))
	}
}

func TestDingTalkClaweeAccountErrorUsesTrustedLoopback(t *testing.T) {
	ctx := context.Background()
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	admin, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "admin-loopback@example.com", Name: "Admin", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	if err := rbacSvc.BootstrapAdmin(ctx, admin.Account.UserID); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{
			Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback",
			StateTTL: 10 * time.Minute, AutoProvision: false,
			Client: fakeDingTalkClient{member: dingtalk.Member{UnionID: "union-new", UserID: "staff-new", Email: "new@example.com"}},
		},
	})
	state := dingTalkTestSecret('s')
	redirectURI := "http://127.0.0.1:49152/enterprise/dingtalk/callback"
	start := httptest.NewRecorder()
	router.ServeHTTP(start, httptest.NewRequest(http.MethodGet,
		claweeDingTalkStartURL("clawee_agent_1", redirectURI, dingTalkTestSecret('c'), "S256", state), nil))
	stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")

	callback := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/callback?code=code&state="+url.QueryEscape(state), nil)
	request.AddCookie(stateCookie)
	router.ServeHTTP(callback, request)
	location, err := url.Parse(callback.Header().Get("Location"))
	if err != nil || callback.Code != http.StatusFound || location.Scheme != "http" || location.Host != "127.0.0.1:49152" ||
		location.Query().Get("error") != "auto_provision_disabled" || location.Query().Get("state") != state {
		t.Fatalf("callback status=%d location=%q err=%v", callback.Code, callback.Header().Get("Location"), err)
	}
}

func TestDingTalkClaweeAuthorizationCodeExchangeAndReplay(t *testing.T) {
	ctx := context.Background()
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	registered, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "clawee-dingtalk@example.com", Name: "Clawee DingTalk", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if err := accountSvc.BindExternalIdentity(ctx, registered.Account.UserID, accounts.AccountIdentity{
		ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-clawee", ExternalUserID: "staff-clawee", VerifiedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	proxyStore := newClaweeOwnedAgentStore(accountSvc)
	collectorStore := &captureManagementStoreForRouteTest{}
	logCore, observedLogs := observer.New(zap.InfoLevel)
	router := newTestRouter(t, server.Options{
		AccountService: accountSvc, RBACService: rbacSvc, ProxyGateway: testProxyGateway(proxyStore),
		OfficeManagementAPI: httpapi.NewManagementAPI(collectorStore, nil), Logger: zap.New(logCore),
		DingTalkAuth: server.DingTalkAuthOptions{
			Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback", StateTTL: 10 * time.Minute,
			Client: fakeDingTalkClient{member: dingtalk.Member{UnionID: "union-clawee", UserID: "staff-clawee"}},
		},
	})
	state := dingTalkTestSecret('s')
	verifier := dingTalkTestSecret('v')
	challengeDigest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeDigest[:])
	agentID := "clawee_dingtalk_agent"
	redirectURI := "http://127.0.0.1:49152/enterprise/dingtalk/callback"

	start := httptest.NewRecorder()
	router.ServeHTTP(start, httptest.NewRequest(http.MethodGet, claweeDingTalkStartURL(agentID, redirectURI, challenge, "S256", state), nil))
	stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")
	callback := httptest.NewRecorder()
	callbackRequest := httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/callback?code=dingtalk-code&state="+url.QueryEscape(state), nil)
	callbackRequest.AddCookie(stateCookie)
	router.ServeHTTP(callback, callbackRequest)
	if callback.Code != http.StatusFound || callback.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("callback status=%d headers=%v body=%s", callback.Code, callback.Header(), callback.Body.String())
	}
	callbackLocation, err := url.Parse(callback.Header().Get("Location"))
	if err != nil || callbackLocation.Scheme != "http" || callbackLocation.Host != "127.0.0.1:49152" || callbackLocation.Query().Get("state") != state {
		t.Fatalf("callback location=%q err=%v", callback.Header().Get("Location"), err)
	}
	authorizationCode := callbackLocation.Query().Get("code")
	if authorizationCode == "" || strings.Contains(callback.Header().Get("Location"), "access_token") {
		t.Fatalf("callback location=%q", callback.Header().Get("Location"))
	}
	for _, cookie := range callback.Result().Cookies() {
		if (cookie.Name == "claw_front_token" || cookie.Name == "claw_admin_token") && cookie.Value != "" {
			t.Fatalf("callback issued web cookie: %#v", cookie)
		}
	}

	tokenBody := map[string]string{
		"grant_type": "authorization_code", "client_id": "clawee-agent", "agent_id": agentID,
		"code": authorizationCode, "redirect_uri": redirectURI, "code_verifier": verifier,
	}
	wrong := make(map[string]string, len(tokenBody))
	for key, value := range tokenBody {
		wrong[key] = value
	}
	wrong["code_verifier"] = dingTalkTestSecret('x')
	wrongRecorder := postDingTalkClaweeToken(t, router, wrong)
	if wrongRecorder.Code != http.StatusBadRequest || wrongRecorder.Header().Get("Cache-Control") != "no-store" ||
		wrongRecorder.Header().Get("Pragma") != "no-cache" || len(wrongRecorder.Result().Cookies()) != 0 ||
		!strings.Contains(wrongRecorder.Body.String(), `"code":"invalid_grant"`) {
		t.Fatalf("wrong verifier status=%d body=%s", wrongRecorder.Code, wrongRecorder.Body.String())
	}
	rejected := observedLogs.FilterMessage("dingtalk_login_rejected").All()
	if len(rejected) != 1 {
		t.Fatalf("rejected logs = %#v", rejected)
	}
	fields := rejected[0].ContextMap()
	if fields["error_code"] != "invalid_grant" || fields["intent"] != "login_clawee" || fields["agent_id"] != agentID {
		t.Fatalf("rejected log fields = %#v", fields)
	}
	for _, forbidden := range []string{"code", "code_verifier", "state", "access_token", "authorization"} {
		if _, exists := fields[forbidden]; exists {
			t.Fatalf("rejected log exposed %q: %#v", forbidden, fields)
		}
	}

	token := postDingTalkClaweeToken(t, router, tokenBody)
	if token.Code != http.StatusOK || token.Header().Get("Cache-Control") != "no-store" || token.Header().Get("Pragma") != "no-cache" || len(token.Result().Cookies()) != 0 {
		t.Fatalf("token status=%d headers=%v cookies=%#v body=%s", token.Code, token.Header(), token.Result().Cookies(), token.Body.String())
	}
	var response struct {
		Data struct {
			AccessToken string `json:"access_token"`
			Agent       struct {
				AgentID string `json:"agent_id"`
			} `json:"agent"`
		} `json:"data"`
	}
	if err := json.Unmarshal(token.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Data.AccessToken == "" || response.Data.Agent.AgentID != agentID {
		t.Fatalf("token response=%s", token.Body.String())
	}
	identity, err := accountSvc.AuthenticateToken(ctx, response.Data.AccessToken, accounts.AudienceFrontend)
	if err != nil || identity.Principal.ClientID != accounts.ClientClaweeAgent || identity.Principal.AgentID != agentID || identity.Session.AgentID != agentID {
		t.Fatalf("identity=%#v err=%v", identity, err)
	}
	if agent, err := proxyStore.GetAgent(ctx, agentID); err != nil || agent.Status != mcpgateway.StatusActive {
		t.Fatalf("agent=%#v err=%v", agent, err)
	}
	me := httptest.NewRecorder()
	meRequest := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	meRequest.Header.Set("Authorization", "Bearer "+response.Data.AccessToken)
	router.ServeHTTP(me, meRequest)
	if me.Code != http.StatusOK || !strings.Contains(me.Body.String(), `"agent_id":"`+agentID+`"`) {
		t.Fatalf("me status=%d body=%s", me.Code, me.Body.String())
	}
	replay := postDingTalkClaweeToken(t, router, tokenBody)
	if replay.Code != http.StatusBadRequest || !strings.Contains(replay.Body.String(), `"code":"invalid_grant"`) {
		t.Fatalf("replay status=%d body=%s", replay.Code, replay.Body.String())
	}
}

func TestDingTalkClaweeTokenMapsAgentConflictAndConsumesCode(t *testing.T) {
	ctx := context.Background()
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	owner, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "owner@example.com", Name: "Owner", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	requester, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "requester@example.com", Name: "Requester", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	proxyStore := newClaweeOwnedAgentStore(accountSvc)
	proxyGateway := testProxyGateway(proxyStore)
	createOwnedAgentForCatalogTest(t, ctx, accountSvc, proxyGateway, owner.Account.UserID, "shared-agent")
	router := newTestRouter(t, server.Options{
		AccountService: accountSvc, ProxyGateway: proxyGateway,
		DingTalkAuth: server.DingTalkAuthOptions{Enabled: true, Client: fakeDingTalkClient{}},
	})
	code := dingTalkTestSecret('a')
	verifier := dingTalkTestSecret('v')
	challengeDigest := sha256.Sum256([]byte(verifier))
	redirectURI := "http://127.0.0.1:49152/enterprise/dingtalk/callback"
	if err := accountSvc.SaveOAuthAuthorizationCode(ctx, accounts.OAuthAuthorizationCode{
		CodeHash: dingTalkTestHash(code), UserID: requester.Account.UserID, AgentID: "shared-agent", RedirectURI: redirectURI,
		PKCEChallenge: base64.RawURLEncoding.EncodeToString(challengeDigest[:]), CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().UTC().Add(time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	body := map[string]string{
		"grant_type": "authorization_code", "client_id": "clawee-agent", "agent_id": "shared-agent",
		"code": code, "redirect_uri": redirectURI, "code_verifier": verifier,
	}
	conflict := postDingTalkClaweeToken(t, router, body)
	if conflict.Code != http.StatusConflict || !strings.Contains(conflict.Body.String(), `"code":"agent_id_conflict"`) {
		t.Fatalf("conflict status=%d body=%s", conflict.Code, conflict.Body.String())
	}
	replay := postDingTalkClaweeToken(t, router, body)
	if replay.Code != http.StatusBadRequest || !strings.Contains(replay.Body.String(), `"code":"invalid_grant"`) {
		t.Fatalf("replay status=%d body=%s", replay.Code, replay.Body.String())
	}
}

func TestDingTalkClaweeTokenRejectsMismatchedAndExpiredGrants(t *testing.T) {
	ctx := context.Background()
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	registered, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "grant@example.com", Name: "Grant", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{
		AccountService: accountSvc, ProxyGateway: testProxyGateway(newClaweeOwnedAgentStore(accountSvc)),
		DingTalkAuth: server.DingTalkAuthOptions{Enabled: true, Client: fakeDingTalkClient{}},
	})
	redirectURI := "http://127.0.0.1:49152/enterprise/dingtalk/callback"
	verifier := dingTalkTestSecret('v')
	tests := []struct {
		name       string
		fill       byte
		mutate     func(map[string]string)
		expiresAt  time.Time
		stillValid bool
	}{
		{name: "agent", fill: 'a', mutate: func(body map[string]string) { body["agent_id"] = "other-agent" }, expiresAt: time.Now().Add(time.Minute), stillValid: true},
		{name: "redirect", fill: 'b', mutate: func(body map[string]string) {
			body["redirect_uri"] = "http://127.0.0.1:49153/enterprise/dingtalk/callback"
		}, expiresAt: time.Now().Add(time.Minute), stillValid: true},
		{name: "expired", fill: 'c', mutate: func(map[string]string) {}, expiresAt: time.Now().Add(-time.Second)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code := dingTalkTestSecret(test.fill)
			saveDingTalkAuthorizationCode(t, accountSvc, registered.Account.UserID, "bound-agent", redirectURI, code, verifier, test.expiresAt)
			body := map[string]string{
				"grant_type": "authorization_code", "client_id": "clawee-agent", "agent_id": "bound-agent",
				"code": code, "redirect_uri": redirectURI, "code_verifier": verifier,
			}
			test.mutate(body)
			recorder := postDingTalkClaweeToken(t, router, body)
			if recorder.Code != http.StatusBadRequest || recorder.Header().Get("Cache-Control") != "no-store" ||
				recorder.Header().Get("Pragma") != "no-cache" || len(recorder.Result().Cookies()) != 0 ||
				!strings.Contains(recorder.Body.String(), `"code":"invalid_grant"`) {
				t.Fatalf("status=%d headers=%v body=%s", recorder.Code, recorder.Header(), recorder.Body.String())
			}
			_, consumeErr := accountSvc.ConsumeOAuthAuthorizationCode(ctx, accounts.OAuthAuthorizationCodeConsumeRequest{
				CodeHash: dingTalkTestHash(code), AgentID: "bound-agent", RedirectURI: redirectURI,
				PKCEChallenge: dingTalkTestChallenge(verifier), Now: time.Now().UTC(),
			})
			if test.stillValid && consumeErr != nil {
				t.Fatalf("mismatched request consumed code: %v", consumeErr)
			}
			if !test.stillValid && !errors.Is(consumeErr, accounts.ErrOAuthAuthorizationCodeNotFound) {
				t.Fatalf("expired consume error = %v", consumeErr)
			}
		})
	}
}

func TestDingTalkClaweeTokenConsumesCodeBeforeProvisioningAndSessionFailures(t *testing.T) {
	for _, test := range []struct {
		name       string
		buildStore func() accounts.Store
		withProxy  bool
		wantStatus int
		wantCode   string
	}{
		{name: "provisioning unavailable", buildStore: func() accounts.Store { return accounts.NewMemoryStore() }, wantStatus: http.StatusServiceUnavailable, wantCode: "agent_provisioning_unavailable"},
		{name: "session save", buildStore: func() accounts.Store { return &sessionFailureStore{Store: accounts.NewMemoryStore(), failAt: 1} }, withProxy: true, wantStatus: http.StatusInternalServerError, wantCode: "internal_error"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			accountSvc := accounts.NewService(accounts.Config{Store: test.buildStore(), JWTSigningKey: []byte(testJWTKey)})
			registered, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: strings.ReplaceAll(test.name, " ", "-") + "@example.com", Name: test.name, Password: "passw0rd!"})
			if err != nil {
				t.Fatal(err)
			}
			opts := server.Options{
				AccountService: accountSvc,
				DingTalkAuth:   server.DingTalkAuthOptions{Enabled: true, Client: fakeDingTalkClient{}},
			}
			if test.withProxy {
				opts.ProxyGateway = testProxyGateway(newClaweeOwnedAgentStore(accountSvc))
			}
			router := newTestRouter(t, opts)
			code := dingTalkTestSecret('f')
			verifier := dingTalkTestSecret('v')
			redirectURI := "http://127.0.0.1:49152/enterprise/dingtalk/callback"
			saveDingTalkAuthorizationCode(t, accountSvc, registered.Account.UserID, "failure-agent", redirectURI, code, verifier, time.Now().Add(time.Minute))
			body := map[string]string{
				"grant_type": "authorization_code", "client_id": "clawee-agent", "agent_id": "failure-agent",
				"code": code, "redirect_uri": redirectURI, "code_verifier": verifier,
			}
			failed := postDingTalkClaweeToken(t, router, body)
			if failed.Code != test.wantStatus || !strings.Contains(failed.Body.String(), `"code":"`+test.wantCode+`"`) {
				t.Fatalf("status=%d body=%s", failed.Code, failed.Body.String())
			}
			replay := postDingTalkClaweeToken(t, router, body)
			if replay.Code != http.StatusBadRequest || !strings.Contains(replay.Body.String(), `"code":"invalid_grant"`) {
				t.Fatalf("replay status=%d body=%s", replay.Code, replay.Body.String())
			}
		})
	}
}

func dingTalkTestSecret(fill byte) string {
	return base64.RawURLEncoding.EncodeToString(bytesOf(fill, 32))
}

func bytesOf(fill byte, count int) []byte {
	value := make([]byte, count)
	for index := range value {
		value[index] = fill
	}
	return value
}

func dingTalkTestHash(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func dingTalkTestChallenge(verifier string) string {
	digest := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func saveDingTalkAuthorizationCode(t *testing.T, accountSvc *accounts.Service, userID, agentID, redirectURI, code, verifier string, expiresAt time.Time) {
	t.Helper()
	if err := accountSvc.SaveOAuthAuthorizationCode(context.Background(), accounts.OAuthAuthorizationCode{
		CodeHash: dingTalkTestHash(code), UserID: userID, AgentID: agentID, RedirectURI: redirectURI,
		PKCEChallenge: dingTalkTestChallenge(verifier), CreatedAt: expiresAt.Add(-time.Minute), ExpiresAt: expiresAt,
	}); err != nil {
		t.Fatal(err)
	}
}

func claweeDingTalkStartURL(agentID, redirectURI, challenge, method, state string) string {
	query := url.Values{
		"agent_id": {agentID}, "redirect_uri": {redirectURI}, "code_challenge": {challenge},
		"code_challenge_method": {method}, "state": {state},
	}
	return "/api/v1/auth/dingtalk/clawee/start?" + query.Encode()
}

func postDingTalkClaweeToken(t *testing.T, router http.Handler, body map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/dingtalk/clawee/token", strings.NewReader(string(encoded)))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestDingTalkDisabledAccountCannotLogin(t *testing.T) {
	ctx := context.Background()
	store := accounts.NewMemoryStore()
	accountSvc := accounts.NewService(accounts.Config{Store: store, JWTSigningKey: []byte(testJWTKey)})
	registration, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "disabled@example.com", Name: "Disabled", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	identity := accounts.AccountIdentity{ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-disabled", ExternalUserID: "staff-disabled", VerifiedAt: now}
	if err := accountSvc.BindExternalIdentity(ctx, registration.Account.UserID, identity); err != nil {
		t.Fatal(err)
	}
	if _, err := accountSvc.UpdateAccountStatus(ctx, registration.Account.UserID, accounts.StatusDisabled); err != nil {
		t.Fatal(err)
	}
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	_ = rbacSvc.Initialize(ctx)
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback", StateTTL: 10 * time.Minute,
			Client: fakeDingTalkClient{member: dingtalk.Member{UnionID: "union-disabled", UserID: "staff-disabled"}}},
	})
	start := httptest.NewRecorder()
	router.ServeHTTP(start, httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/start", nil))
	stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")
	callback := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/callback?code=code&state="+url.QueryEscape(stateCookie.Value), nil)
	request.AddCookie(stateCookie)
	router.ServeHTTP(callback, request)
	if !strings.Contains(callback.Header().Get("Location"), "account_disabled") {
		t.Fatalf("disabled callback location=%q", callback.Header().Get("Location"))
	}
	for _, cookie := range callback.Result().Cookies() {
		if (cookie.Name == "claw_front_token" || cookie.Name == "claw_admin_token") && cookie.Value != "" {
			t.Fatalf("disabled login issued cookie %#v", cookie)
		}
	}
}

func TestDingTalkAutoProvisionCreatesPlainUser(t *testing.T) {
	ctx := context.Background()
	store := accounts.NewMemoryStore()
	accountSvc := accounts.NewService(accounts.Config{Store: store, JWTSigningKey: []byte(testJWTKey)})
	admin, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "admin@example.com", Name: "Admin", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	if err := rbacSvc.BootstrapAdmin(ctx, admin.Account.UserID); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{
			Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback",
			StateTTL: 10 * time.Minute, AutoProvision: true,
			Client: fakeDingTalkClient{member: dingtalk.Member{UnionID: "union-new", UserID: "staff-new", Name: "New User", Email: "new@example.com"}},
		},
	})

	start := httptest.NewRecorder()
	router.ServeHTTP(start, httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/start?redirect=/admin/accounts", nil))
	stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")
	callback := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/callback?code=code&state="+url.QueryEscape(stateCookie.Value), nil)
	request.AddCookie(stateCookie)
	router.ServeHTTP(callback, request)

	if callback.Code != http.StatusFound || callback.Header().Get("Location") != "/app" {
		t.Fatalf("callback status=%d location=%q", callback.Code, callback.Header().Get("Location"))
	}
	frontendCookie(t, callback.Result().Cookies())
	clearedAdmin := adminCookie(t, callback.Result().Cookies())
	if clearedAdmin.Value != "" || clearedAdmin.MaxAge != -1 {
		t.Fatalf("admin cookie was not cleared: %#v", clearedAdmin)
	}
	created, err := accountSvc.ResolveExternalIdentity(ctx, accounts.AccountIdentity{
		ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-new", ExternalUserID: "staff-new", VerifiedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Email != "new@example.com" || created.PasswordHash != "" {
		t.Fatalf("created account = %#v", created)
	}
	roles, err := rbacSvc.ListAccountRoles(ctx, created.UserID)
	if err != nil || len(roles) != 0 {
		t.Fatalf("created account roles = %#v, %v", roles, err)
	}
}

func TestDingTalkLoginRequiresBindingForExistingEmail(t *testing.T) {
	ctx := context.Background()
	store := accounts.NewMemoryStore()
	accountSvc := accounts.NewService(accounts.Config{Store: store, JWTSigningKey: []byte(testJWTKey)})
	admin, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "member@example.com", Name: "Member", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	_ = rbacSvc.Initialize(ctx)
	_ = rbacSvc.BootstrapAdmin(ctx, admin.Account.UserID)
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{
			Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback",
			StateTTL: 10 * time.Minute, AutoProvision: true,
			Client: fakeDingTalkClient{member: dingtalk.Member{UnionID: "union-conflict", UserID: "staff-conflict", Email: "MEMBER@example.com"}},
		},
	})

	start := httptest.NewRecorder()
	router.ServeHTTP(start, httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/start", nil))
	stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")
	callback := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/callback?code=code&state="+url.QueryEscape(stateCookie.Value), nil)
	request.AddCookie(stateCookie)
	router.ServeHTTP(callback, request)
	if callback.Header().Get("Location") != "/login?oauth_error=account_binding_required&oauth_provider=dingtalk" {
		t.Fatalf("callback location=%q", callback.Header().Get("Location"))
	}
	if _, err := accountSvc.AccountIdentityForUser(ctx, admin.Account.UserID, "dingtalk", "default"); !errors.Is(err, accounts.ErrAccountIdentityNotFound) {
		t.Fatalf("email conflict wrote identity: %v", err)
	}
}

func TestDingTalkBindRejectsDifferentCurrentUser(t *testing.T) {
	ctx := context.Background()
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	first, _ := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "first@example.com", Name: "First", Password: "passw0rd!"})
	second, _ := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "second@example.com", Name: "Second", Password: "passw0rd!"})
	firstTokens, _ := accountSvc.IssueTokens(ctx, first.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	secondTokens, _ := accountSvc.IssueTokens(ctx, second.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	_ = rbacSvc.Initialize(ctx)
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{
			Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback", StateTTL: 10 * time.Minute,
			Client: fakeDingTalkClient{member: dingtalk.Member{UnionID: "union-bind-mismatch", UserID: "staff-bind-mismatch"}},
		},
	})

	start := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/bind/start", nil)
	request.AddCookie(&http.Cookie{Name: "claw_front_token", Value: firstTokens.Token(accounts.AudienceFrontend).Token})
	router.ServeHTTP(start, request)
	stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")
	callback := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/callback?code=code&state="+url.QueryEscape(stateCookie.Value), nil)
	request.AddCookie(stateCookie)
	request.AddCookie(&http.Cookie{Name: "claw_front_token", Value: secondTokens.Token(accounts.AudienceFrontend).Token})
	router.ServeHTTP(callback, request)
	if !strings.Contains(callback.Header().Get("Location"), "oauth_error=unauthorized") {
		t.Fatalf("callback location=%q", callback.Header().Get("Location"))
	}
	if _, err := accountSvc.AccountIdentityForUser(ctx, first.Account.UserID, "dingtalk", "default"); !errors.Is(err, accounts.ErrAccountIdentityNotFound) {
		t.Fatalf("mismatched bind wrote identity: %v", err)
	}
}

func TestAuthMeReportsExistingDingTalkBindingWhenProviderDisabled(t *testing.T) {
	ctx := context.Background()
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	registered, _ := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "bound@example.com", Name: "Bound", Password: "passw0rd!"})
	if err := accountSvc.BindExternalIdentity(ctx, registered.Account.UserID, accounts.AccountIdentity{
		ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-bound", ExternalUserID: "staff-bound", VerifiedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	tokens, _ := accountSvc.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	_ = rbacSvc.Initialize(ctx)
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{Enabled: false, ProviderKey: "default"},
	})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	request.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"dingtalk_enabled":false`) || !strings.Contains(recorder.Body.String(), `"dingtalk_bound":true`) {
		t.Fatalf("me status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestDingTalkUnbindRequiresPasswordAndWorksWhenProviderDisabled(t *testing.T) {
	ctx := context.Background()
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	registered, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "unbind@example.com", Name: "Unbind", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if err := accountSvc.BindExternalIdentity(ctx, registered.Account.UserID, accounts.AccountIdentity{
		ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-unbind", ExternalUserID: "staff-unbind", VerifiedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	frontCookie := &http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token}
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{Enabled: false, ProviderKey: "default"},
	})

	request := func(password string, cookie *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/dingtalk/unbind", strings.NewReader(`{"password":"`+password+`"}`))
		req.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			req.AddCookie(cookie)
		}
		router.ServeHTTP(recorder, req)
		return recorder
	}

	if recorder := request("passw0rd!", nil); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request("wrong-password", frontCookie); recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), `"code":"invalid_password"`) {
		t.Fatalf("wrong password status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := accountSvc.AccountIdentityForUser(ctx, registered.Account.UserID, "dingtalk", "default"); err != nil {
		t.Fatalf("wrong password removed identity: %v", err)
	}
	if recorder := request("passw0rd!", frontCookie); recorder.Code != http.StatusNoContent {
		t.Fatalf("unbind status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	me := httptest.NewRecorder()
	meRequest := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	meRequest.AddCookie(frontCookie)
	router.ServeHTTP(me, meRequest)
	if me.Code != http.StatusOK || !strings.Contains(me.Body.String(), `"dingtalk_bound":false`) || !strings.Contains(me.Body.String(), `"local_password_configured":true`) {
		t.Fatalf("me after unbind status=%d body=%s", me.Code, me.Body.String())
	}
	if recorder := request("passw0rd!", frontCookie); recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"dingtalk_not_bound"`) {
		t.Fatalf("repeated unbind status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestDingTalkUnbindRejectsAccountWithoutLocalPassword(t *testing.T) {
	ctx := context.Background()
	accountSvc := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(testJWTKey)})
	identity := accounts.AccountIdentity{
		ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-only", ExternalUserID: "staff-only", VerifiedAt: time.Now().UTC(),
	}
	account, err := accountSvc.ProvisionExternalAccount(ctx, identity, accounts.ExternalAccountRequest{Email: "only@example.com", Name: "Only"}, true, true)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{
		AccountService: accountSvc, RBACService: rbacSvc,
		DingTalkAuth: server.DingTalkAuthOptions{ProviderKey: "default"},
	})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/dingtalk/unbind", strings.NewReader(`{"password":"anything"}`))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token})
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"local_password_required"`) {
		t.Fatalf("passwordless unbind status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := accountSvc.AccountIdentityForUser(ctx, account.UserID, "dingtalk", "default"); err != nil {
		t.Fatalf("passwordless unbind removed identity: %v", err)
	}
}
