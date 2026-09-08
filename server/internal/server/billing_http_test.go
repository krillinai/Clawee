package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/clawadmin"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
)

type billingProviderStub struct {
	calls         int
	rechargeCalls int
	orderCalls    int
	orderPage     int
	orderPageSize int
	err           error
}

func (s *billingProviderStub) GetBillingOverview(context.Context, string) (clawadmin.BillingSnapshot, error) {
	s.calls++
	if s.err != nil {
		return clawadmin.BillingSnapshot{}, s.err
	}
	return clawadmin.BillingSnapshot{
		Currency: "CNY", ExchangeRate: 7.5, BalanceCNY: 100,
		StartDate: "2026-08-25", EndDate: "2026-08-25", Granularity: "day", GeneratedAt: time.Now().UTC(),
		Stats: clawadmin.BillingUsage{Requests: 2, InputTokens: 100, CachedInputTokens: 10, OutputTokens: 20, TotalTokens: 130, ActualCostCNY: 9},
		Trend: []clawadmin.BillingTrendPoint{{
			BucketStart:  time.Now().UTC(),
			BillingUsage: clawadmin.BillingUsage{Requests: 2, InputTokens: 100, CachedInputTokens: 10, OutputTokens: 20, TotalTokens: 130, ActualCostCNY: 9},
		}},
		Models: []clawadmin.BillingModelUsage{{
			Model:        "deepseek-v4-flash",
			BillingUsage: clawadmin.BillingUsage{Requests: 2, InputTokens: 100, CachedInputTokens: 10, OutputTokens: 20, TotalTokens: 130, ActualCostCNY: 9},
		}},
	}, nil
}

func (s *billingProviderStub) CreateRechargeSession(context.Context) (clawadmin.RechargeSession, error) {
	s.rechargeCalls++
	if s.err != nil {
		return clawadmin.RechargeSession{}, s.err
	}
	return clawadmin.RechargeSession{RechargeURL: "https://billing.example/recharge/session-token", ExpiresAt: time.Now().Add(10 * time.Minute)}, nil
}

func (s *billingProviderStub) ListRechargeOrders(_ context.Context, page, pageSize int) (clawadmin.RechargeOrderPage, error) {
	s.orderCalls++
	s.orderPage, s.orderPageSize = page, pageSize
	if s.err != nil {
		return clawadmin.RechargeOrderPage{}, s.err
	}
	return clawadmin.RechargeOrderPage{
		Items: []clawadmin.RechargeOrder{{
			OrderNo: "PAY-TEST", AmountCents: 10_000, Currency: "CNY", Channel: "alipay",
			Status: "succeeded", PaymentStatus: "paid", FulfillmentStatus: "succeeded", CreatedAt: time.Now(),
		}},
		Page: page, PageSize: pageSize, Total: 1,
	}, nil
}

func TestBillingOverviewRequiresAgentActivityGrant(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "billing@example.com", Name: "Billing User", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	dataService := dataaccess.NewService(dataaccess.NewMemoryStore())
	provider := &billingProviderStub{}
	router := NewRouter(Options{AccountService: accountService, DataAccessService: dataService, BillingProvider: provider})
	request := func(authenticated bool) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/app/billing/overview?range=7d", nil)
		if authenticated {
			req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
		}
		router.ServeHTTP(recorder, req)
		return recorder
	}

	if recorder := request(false); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(true); recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), `"code":"data_view_forbidden"`) {
		t.Fatalf("forbidden status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if provider.calls != 0 {
		t.Fatal("无权限请求不应访问账单服务")
	}
	if _, err := dataService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewAgentActivity, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	response := request(true)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Body.String(), `"balance_cny":100`) || strings.Contains(response.Body.String(), "actual_cost_cny") || strings.Contains(strings.ToLower(response.Body.String()), "sub2api") {
		t.Fatalf("billing status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	if provider.calls != 1 {
		t.Fatalf("provider calls=%d", provider.calls)
	}
}

func TestEnterpriseManagedBillingRejectsAllRoutesWithoutProviderCalls(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "enterprise-billing@example.com", Name: "Enterprise Billing", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	dataService := dataaccess.NewService(dataaccess.NewMemoryStore())
	if _, err := dataService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewAgentActivity, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	provider := &billingProviderStub{}
	router := NewRouter(Options{
		AccountService: accountService, DataAccessService: dataService,
		BillingProvider: provider, ModelAccessMode: ModelAccessEnterpriseManaged,
	})
	requests := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/app/billing/overview?range=7d"},
		{http.MethodPost, "/api/v1/app/billing/recharge-session?invalid=1"},
		{http.MethodGet, "/api/v1/app/billing/recharge-orders?invalid=1"},
	}
	for _, request := range requests {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(request.method, request.path, nil)
		req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
		router.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"billing_not_managed"`) {
			t.Fatalf("%s %s status=%d body=%s", request.method, request.path, recorder.Code, recorder.Body.String())
		}
	}
	if provider.calls != 0 || provider.rechargeCalls != 0 || provider.orderCalls != 0 {
		t.Fatalf("provider called: %+v", provider)
	}
}

func TestBillingOverviewDoesNotDowngradeUnavailableDataToZero(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "billing-error@example.com", Name: "Billing Error", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	dataService := dataaccess.NewService(dataaccess.NewMemoryStore())
	if _, err := dataService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewAgentActivity, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	router := NewRouter(Options{AccountService: accountService, DataAccessService: dataService, BillingProvider: &billingProviderStub{err: errors.New("upstream unavailable")}})
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/app/billing/overview?range=7d", nil)
	req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
	router.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"billing_unavailable"`) || strings.Contains(recorder.Body.String(), `"balance_cny":0`) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestRechargeSessionRequiresAgentActivityGrant(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "recharge@example.com", Name: "Recharge User", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	dataService := dataaccess.NewService(dataaccess.NewMemoryStore())
	provider := &billingProviderStub{}
	router := NewRouter(Options{AccountService: accountService, DataAccessService: dataService, BillingProvider: provider})
	request := func() *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/app/billing/recharge-session", nil)
		req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
		router.ServeHTTP(recorder, req)
		return recorder
	}

	if recorder := request(); recorder.Code != http.StatusForbidden {
		t.Fatalf("forbidden status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if provider.rechargeCalls != 0 {
		t.Fatal("无权限请求不应创建充值会话")
	}
	if _, err := dataService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewAgentActivity, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	recorder := request()
	if recorder.Code != http.StatusOK || recorder.Header().Get("Cache-Control") != "no-store" || !strings.Contains(recorder.Body.String(), `"recharge_url":"https://billing.example/recharge/session-token"`) {
		t.Fatalf("recharge status=%d headers=%v body=%s", recorder.Code, recorder.Header(), recorder.Body.String())
	}
	if provider.rechargeCalls != 1 {
		t.Fatalf("recharge calls=%d", provider.rechargeCalls)
	}
}

func TestRechargeSessionDoesNotReturnFallbackURLWhenUnavailable(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "recharge-error@example.com", Name: "Recharge Error", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	dataService := dataaccess.NewService(dataaccess.NewMemoryStore())
	if _, err := dataService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewAgentActivity, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	router := NewRouter(Options{AccountService: accountService, DataAccessService: dataService, BillingProvider: &billingProviderStub{err: errors.New("upstream unavailable")}})
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/app/billing/recharge-session", nil)
	req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
	router.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"recharge_unavailable"`) || strings.Contains(recorder.Body.String(), "recharge_url") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestRechargeOrdersRequiresGrantAndPreservesPageEnvelope(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "recharge-orders@example.com", Name: "Recharge Orders", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	dataService := dataaccess.NewService(dataaccess.NewMemoryStore())
	provider := &billingProviderStub{}
	router := NewRouter(Options{AccountService: accountService, DataAccessService: dataService, BillingProvider: provider})
	request := func(authenticated bool) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/app/billing/recharge-orders?page=2&page_size=20", nil)
		if authenticated {
			req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
		}
		router.ServeHTTP(recorder, req)
		return recorder
	}
	if recorder := request(false); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(true); recorder.Code != http.StatusForbidden || provider.orderCalls != 0 {
		t.Fatalf("forbidden status=%d calls=%d body=%s", recorder.Code, provider.orderCalls, recorder.Body.String())
	}
	if _, err := dataService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewAgentActivity, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	recorder := request(true)
	body := recorder.Body.String()
	if recorder.Code != http.StatusOK || recorder.Header().Get("Cache-Control") != "no-store" || provider.orderCalls != 1 || provider.orderPage != 2 || provider.orderPageSize != 20 {
		t.Fatalf("status=%d headers=%v provider=%+v body=%s", recorder.Code, recorder.Header(), provider, body)
	}
	for _, expected := range []string{`"data":{"items":`, `"page":2`, `"page_size":20`, `"total":1`} {
		if !strings.Contains(body, expected) {
			t.Fatalf("missing %s in body=%s", expected, body)
		}
	}
	for _, forbidden := range []string{"next_cursor", "sub2api", "provider_trade_no", "last_error"} {
		if strings.Contains(strings.ToLower(body), forbidden) {
			t.Fatalf("response contains %q: %s", forbidden, body)
		}
	}
}

func TestRechargeOrdersRejectsInvalidPaginationWithoutCallingProvider(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "recharge-orders-invalid@example.com", Name: "Recharge Orders Invalid", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	dataService := dataaccess.NewService(dataaccess.NewMemoryStore())
	if _, err := dataService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewAgentActivity, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	provider := &billingProviderStub{}
	router := NewRouter(Options{AccountService: accountService, DataAccessService: dataService, BillingProvider: provider})
	for _, query := range []string{"page=x", "page=0", "page=-1", "page_size=x", "page_size=0", "page_size=-1", "page_size=101", "page=" + strconv.Itoa(int(^uint(0)>>1)) + "&page_size=20", "status=paid"} {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/app/billing/recharge-orders?"+query, nil)
		req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
		router.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"invalid_recharge_records_page"`) {
			t.Fatalf("query=%s status=%d body=%s", query, recorder.Code, recorder.Body.String())
		}
	}
	if provider.orderCalls != 0 {
		t.Fatalf("invalid pagination called provider %d times", provider.orderCalls)
	}
}

func TestRechargeOrdersUnavailableDoesNotReturnEmptyPage(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "recharge-orders-error@example.com", Name: "Recharge Orders Error", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	dataService := dataaccess.NewService(dataaccess.NewMemoryStore())
	if _, err := dataService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewAgentActivity, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	router := NewRouter(Options{AccountService: accountService, DataAccessService: dataService, BillingProvider: &billingProviderStub{err: errors.New("upstream unavailable")}})
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/app/billing/recharge-orders?page=1&page_size=20", nil)
	req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
	router.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"recharge_records_unavailable"`) || strings.Contains(recorder.Body.String(), `"items":[]`) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
