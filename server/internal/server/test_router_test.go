package server_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/agentprovisioning"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
)

type authenticatedTestHandler struct {
	next    http.Handler
	cookies []*http.Cookie
	userID  string
}

var testRBACServices sync.Map

type noopModelCredentialLifecycle struct{}

func (noopModelCredentialLifecycle) DisableModelCredential(context.Context, string) error { return nil }

func newTestAccountService(store accounts.Store) *accounts.Service {
	return accounts.NewService(accounts.Config{Store: store, JWTSigningKey: []byte(testJWTKey)})
}

func cookieByName(t *testing.T, cookies []*http.Cookie, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range cookies {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("missing cookie %q in %#v", name, cookies)
	return nil
}

func frontendCookie(t *testing.T, cookies []*http.Cookie) *http.Cookie {
	return cookieByName(t, cookies, "claw_front_token")
}

func adminCookie(t *testing.T, cookies []*http.Cookie) *http.Cookie {
	return cookieByName(t, cookies, "claw_admin_token")
}

func loginCookies(t *testing.T, router http.Handler, body string) []*http.Cookie {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	return recorder.Result().Cookies()
}

func (h authenticatedTestHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	for _, cookie := range h.cookies {
		if _, err := r.Cookie(cookie.Name); err != nil {
			r.AddCookie(cookie)
		}
	}
	h.next.ServeHTTP(w, r)
}

func newTestRouter(t *testing.T, opts server.Options) http.Handler {
	t.Helper()
	ctx := context.Background()
	if opts.ModelCredentialLifecycle == nil {
		opts.ModelCredentialLifecycle = noopModelCredentialLifecycle{}
	}
	var registeredAccount accounts.Account

	if opts.AccountService == nil {
		opts.AccountService = accounts.NewService(accounts.Config{
			Store: accounts.NewMemoryStore(), JWTSigningKey: []byte("01234567890123456789012345678901"),
		})
		result, err := opts.AccountService.Register(ctx, accounts.RegisterRequest{
			Email: "test-admin@example.com", Name: "Test Admin", Password: "passw0rd!",
		})
		if err != nil {
			t.Fatal(err)
		}
		registeredAccount = result.Account
	}
	if opts.RBACService == nil {
		if existing, ok := testRBACServices.Load(opts.AccountService); ok {
			opts.RBACService = existing.(*rbac.Service)
		} else {
			opts.RBACService = rbac.NewService(rbac.Config{
				Store: rbac.NewMemoryStore(), Accounts: opts.AccountService,
			})
			if err := opts.RBACService.Initialize(ctx); err != nil {
				t.Fatal(err)
			}
			testRBACServices.Store(opts.AccountService, opts.RBACService)
		}
	}
	if opts.AgentProvisioningService == nil && opts.AccountService != nil && opts.ProxyGateway != nil {
		opts.AgentProvisioningService = agentprovisioning.NewService(opts.AccountService, opts.ProxyGateway)
	}
	adminUserID := ""
	var cookies []*http.Cookie
	if registeredAccount.UserID != "" {
		adminUserID = registeredAccount.UserID
		if err := opts.RBACService.BootstrapAdmin(ctx, adminUserID); err != nil {
			t.Fatal(err)
		}
		tokens, err := opts.AccountService.IssueTokens(ctx, registeredAccount, []accounts.TokenRequest{
			{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb},
			{Audience: accounts.AudienceAdmin, ClientID: accounts.ClientWeb},
		})
		if err != nil {
			t.Fatal(err)
		}
		cookies = []*http.Cookie{
			{Name: "claw_front_token", Value: tokens.Token(accounts.AudienceFrontend).Token},
			{Name: "claw_admin_token", Value: tokens.Token(accounts.AudienceAdmin).Token},
		}
	}

	router := server.NewRouter(opts)
	if len(cookies) == 0 {
		return router
	}
	return authenticatedTestHandler{
		next:    router,
		cookies: cookies,
		userID:  adminUserID,
	}
}

func testAdminUserID(t *testing.T, handler http.Handler) string {
	t.Helper()
	authenticated, ok := handler.(authenticatedTestHandler)
	if !ok || authenticated.userID == "" {
		t.Fatal("test router does not contain an automatic admin account")
	}
	return authenticated.userID
}
