package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
)

func TestClaweeSessionRenewalHTTP(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)
	accountSvc := accounts.NewService(accounts.Config{
		Store: accounts.NewMemoryStore(), Clock: func() time.Time { return now },
		SessionDuration: 7 * 24 * time.Hour, JWTSigningKey: []byte(testJWTKey),
	})
	rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
	if err := rbacSvc.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	registration, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "renew@example.com", Name: "续期用户", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	proxyStore := newClaweeOwnedAgentStore(accountSvc)
	router := newTestRouter(t, server.Options{AccountService: accountSvc, RBACService: rbacSvc, ProxyGateway: testProxyGateway(proxyStore)})
	login := loginClawee(t, router, registration.Account.Email, "passw0rd!", "clawee-renew-agent")
	if login.Status != http.StatusOK {
		t.Fatalf("登录 = %#v", login)
	}
	request := func(path, token string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		router.ServeHTTP(rec, req)
		return rec
	}
	now = now.Add(6 * 24 * time.Hour)
	renewed := request("/api/v1/auth/session/renew", login.AccessToken)
	if renewed.Code != http.StatusOK {
		t.Fatalf("续期 = %d: %s", renewed.Code, renewed.Body.String())
	}
	if renewed.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("续期凭据响应不能被缓存")
	}
	var body struct {
		Data struct {
			AccessToken string    `json:"access_token"`
			ExpiresAt   time.Time `json:"expires_at"`
		} `json:"data"`
	}
	if err := json.Unmarshal(renewed.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.AccessToken == login.AccessToken || !body.Data.ExpiresAt.Equal(now.Add(7*24*time.Hour)) {
		t.Fatal("未换发 Token 或未延长闲置期限")
	}
	var sessionID string
	for _, token := range []string{login.AccessToken, body.Data.AccessToken} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		router.ServeHTTP(rec, req)
		var me struct {
			Data struct {
				SessionID string `json:"session_id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &me); err != nil {
			t.Fatal(err)
		}
		if rec.Code != http.StatusOK || me.Data.SessionID == "" {
			t.Fatalf("会话身份 = %d %s", rec.Code, rec.Body.String())
		}
		if sessionID != "" && sessionID != me.Data.SessionID {
			t.Fatal("续期改变了登录身份")
		}
		sessionID = me.Data.SessionID
	}
	if rec := request("/api/v1/auth/logout", login.AccessToken); rec.Code != http.StatusNoContent {
		t.Fatalf("退出 = %d", rec.Code)
	}
	if rec := request("/api/v1/auth/session/renew", body.Data.AccessToken); rec.Code != http.StatusUnauthorized {
		t.Fatalf("退出后续期 = %d", rec.Code)
	}
	if rec := request("/api/v1/auth/session/renew", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("匿名续期 = %d", rec.Code)
	}
	web, err := accountSvc.IssueTokens(ctx, registration.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	if rec := request("/api/v1/auth/session/renew", web.Token(accounts.AudienceFrontend).Token); rec.Code != http.StatusUnauthorized {
		t.Fatalf("Web 会话续期 = %d", rec.Code)
	}
	idle := loginClawee(t, router, registration.Account.Email, "passw0rd!", login.AgentID)
	if idle.Status != http.StatusOK {
		t.Fatalf("重新登录 = %#v", idle)
	}
	now = now.Add(7 * 24 * time.Hour)
	if rec := request("/api/v1/auth/session/renew", idle.AccessToken); rec.Code != http.StatusUnauthorized {
		t.Fatalf("闲置到期后续期 = %d", rec.Code)
	}
}
