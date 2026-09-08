package server

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/businessdata"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
)

type bilibiliIntegrationFixture struct {
	createdBy          string
	authorizationErr   error
	code               string
	state              string
	callbackErr        error
	deauthorizedOpenID string
	deauthorizeErr     error
}

type bilibiliSyncFixture struct {
	provider string
	result   businessdata.SyncRequestResult
	err      error
}

type bilibiliSourceManagerFixture struct {
	items       []businessdata.BilibiliSourceItem
	listErr     error
	syncResult  businessdata.SyncRequestResult
	syncErr     error
	change      businessdata.BilibiliSourceChange
	changeErr   error
	sourceID    string
	syncEnabled bool
	changeCalls int
	deleteErr   error
	deleteCalls int
}

func (f *bilibiliSourceManagerFixture) List(context.Context) ([]businessdata.BilibiliSourceItem, error) {
	return f.items, f.listErr
}

func (f *bilibiliSourceManagerFixture) RequestSync(_ context.Context, sourceID string) (businessdata.SyncRequestResult, error) {
	f.sourceID = sourceID
	return f.syncResult, f.syncErr
}

func (f *bilibiliSourceManagerFixture) SetSyncEnabled(_ context.Context, sourceID string, enabled bool) (businessdata.BilibiliSourceChange, error) {
	f.sourceID, f.syncEnabled = sourceID, enabled
	f.changeCalls++
	return f.change, f.changeErr
}

func (f *bilibiliSourceManagerFixture) Delete(_ context.Context, sourceID string) error {
	f.sourceID = sourceID
	f.deleteCalls++
	return f.deleteErr
}

func (f *bilibiliSyncFixture) RequestSync(_ context.Context, provider string) (businessdata.SyncRequestResult, error) {
	f.provider = provider
	return f.result, f.err
}

func (f *bilibiliIntegrationFixture) AuthorizationURL(_ context.Context, createdBy string) (string, error) {
	f.createdBy = createdBy
	return "https://account.bilibili.test/oauth?state=opaque", f.authorizationErr
}

func (f *bilibiliIntegrationFixture) HandleCallback(_ context.Context, code, state string) (businessdata.Source, error) {
	f.code, f.state = code, state
	return businessdata.Source{SourceID: "bdsrc_1", Provider: businessdata.ProviderBilibili}, f.callbackErr
}

func (f *bilibiliIntegrationFixture) HandleDeauthorize(_ context.Context, openID string) error {
	f.deauthorizedOpenID = openID
	return f.deauthorizeErr
}

func TestBilibiliIntegrationHTTPUsesConnectGrantAndReturnsToDashboard(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "bilibili-admin@example.com", Name: "Bilibili Admin", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	fixture := &bilibiliIntegrationFixture{}
	syncer := &bilibiliSyncFixture{result: businessdata.SyncRequestResult{SourceCount: 1, QueuedCount: 1}}
	dataService := dataaccess.NewService(dataaccess.NewMemoryStore())
	router := NewRouter(Options{AccountService: accountService, DataAccessService: dataService, BilibiliIntegration: fixture, BilibiliSyncRequester: syncer})

	authorize := func(authenticated bool) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/v1/app/business-data-sources/bilibili/authorize", nil)
		if authenticated {
			request.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
		}
		router.ServeHTTP(recorder, request)
		return recorder
	}
	if recorder := authorize(false); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := authorize(true); recorder.Code != http.StatusForbidden {
		t.Fatalf("forbidden status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := dataService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewBilibiliOperation, Actions: []string{dataaccess.ActionRead, dataaccess.ActionConnect}, CreatedBy: "grant-admin"}); err != nil {
		t.Fatal(err)
	}
	if recorder := authorize(true); recorder.Code != http.StatusOK || fixture.createdBy != registered.Account.UserID {
		t.Fatalf("authorize status=%d body=%s createdBy=%q", recorder.Code, recorder.Body.String(), fixture.createdBy)
	}
	fixture.authorizationErr = businessdata.ErrBilibiliOAuthStateUnavailable
	if recorder := authorize(true); recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"bilibili_oauth_state_unavailable"`) || !strings.Contains(recorder.Body.String(), "迁移 00044") {
		t.Fatalf("authorize state store failure status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	fixture.authorizationErr = nil

	disabledRouter := NewRouter(Options{AccountService: accountService, DataAccessService: dataService})
	disabled := httptest.NewRecorder()
	disabledRequest := httptest.NewRequest(http.MethodPost, "/api/v1/app/business-data-sources/bilibili/authorize", nil)
	disabledRequest.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
	disabledRouter.ServeHTTP(disabled, disabledRequest)
	if disabled.Code != http.StatusServiceUnavailable || !strings.Contains(disabled.Body.String(), `"code":"bilibili_not_configured"`) || !strings.Contains(disabled.Body.String(), "client_id") {
		t.Fatalf("disabled authorize status=%d body=%s", disabled.Code, disabled.Body.String())
	}
	syncRequest := func() *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/v1/app/business-data-sources/bilibili/sync", nil)
		request.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
		router.ServeHTTP(recorder, request)
		return recorder
	}
	syncRecorder := syncRequest()
	if syncRecorder.Code != http.StatusAccepted || syncer.provider != businessdata.ProviderBilibili || !strings.Contains(syncRecorder.Body.String(), `"status":"queued"`) {
		t.Fatalf("sync status=%d body=%s provider=%q", syncRecorder.Code, syncRecorder.Body.String(), syncer.provider)
	}
	syncer.result = businessdata.SyncRequestResult{SourceCount: 1}
	if recorder := syncRequest(); recorder.Code != http.StatusAccepted || !strings.Contains(recorder.Body.String(), `"status":"already_queued"`) {
		t.Fatalf("already queued status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	syncer.result = businessdata.SyncRequestResult{}
	if recorder := syncRequest(); recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"bilibili_not_connected"`) {
		t.Fatalf("not connected status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/integrations/bilibili/oauth/callback?code=secret-code&state=opaque-state", nil))
	if recorder.Code != http.StatusFound || recorder.Header().Get("Location") != "/app/business-data/bilibili-operation?authorization=success" || fixture.code != "secret-code" || fixture.state != "opaque-state" {
		t.Fatalf("callback status=%d location=%q code=%q state=%q", recorder.Code, recorder.Header().Get("Location"), fixture.code, fixture.state)
	}
	if strings.Contains(recorder.Body.String(), "secret-code") || strings.Contains(recorder.Body.String(), "opaque-state") {
		t.Fatalf("callback body leaks callback data: %q", recorder.Body.String())
	}
	fixture.callbackErr = errors.New("authorization failed")
	failed := httptest.NewRecorder()
	router.ServeHTTP(failed, httptest.NewRequest(http.MethodGet, "/api/v1/integrations/bilibili/oauth/callback?code=failed-code&state=failed-state", nil))
	if failed.Code != http.StatusFound || failed.Header().Get("Location") != "/app/business-data/bilibili-operation?authorization=failed" {
		t.Fatalf("failed callback status=%d location=%q", failed.Code, failed.Header().Get("Location"))
	}
}

func TestBilibiliSourceManagementHTTPContract(t *testing.T) {
	ctx := context.Background()
	core, observed := observer.New(zap.InfoLevel)
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "bilibili-manager@example.com", Name: "Bilibili Manager", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	dataService := dataaccess.NewService(dataaccess.NewMemoryStore())
	if _, err := dataService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewBilibiliOperation, Actions: []string{dataaccess.ActionRead}, CreatedBy: "grant-admin"}); err != nil {
		t.Fatal(err)
	}
	manager := &bilibiliSourceManagerFixture{
		items:      []businessdata.BilibiliSourceItem{{SourceID: "bdsrc_1", Name: "账号一", Status: businessdata.SourceStatusActive}},
		syncResult: businessdata.SyncRequestResult{SourceCount: 1, QueuedCount: 1},
		change: businessdata.BilibiliSourceChange{Source: businessdata.BilibiliSourceItem{
			SourceID: "bdsrc_1", Name: "账号一", Status: businessdata.SourceStatusDisabled, StatusReason: businessdata.BilibiliSyncDisabledCode,
		}},
	}
	router := NewRouter(Options{AccountService: accountService, DataAccessService: dataService,
		BilibiliIntegration: &bilibiliIntegrationFixture{}, BilibiliSourceManager: manager, Logger: zap.New(core)})
	request := func(method, path, body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		var reader io.Reader
		if body != "" {
			reader = strings.NewReader(body)
		}
		req := httptest.NewRequest(method, path, reader)
		req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		router.ServeHTTP(recorder, req)
		return recorder
	}

	list := request(http.MethodGet, "/api/v1/app/business-data-sources/bilibili", "")
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"source_id":"bdsrc_1"`) || strings.Contains(list.Body.String(), "openid") {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
	if recorder := request(http.MethodPost, "/api/v1/app/business-data-sources/bilibili/bdsrc_1/sync", ""); recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), `"code":"business_data_connect_forbidden"`) {
		t.Fatalf("sync forbidden status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(http.MethodPatch, "/api/v1/app/business-data-sources/bilibili/bdsrc_1", `{"sync_enabled":false}`); recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), `"code":"business_data_manage_forbidden"`) {
		t.Fatalf("manage forbidden status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request(http.MethodDelete, "/api/v1/app/business-data-sources/bilibili/bdsrc_1", ""); recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), `"code":"business_data_manage_forbidden"`) {
		t.Fatalf("delete forbidden status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := dataService.Replace(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewBilibiliOperation, Actions: []string{dataaccess.ActionRead, dataaccess.ActionConnect, dataaccess.ActionManage}, CreatedBy: "grant-admin"}); err != nil {
		t.Fatal(err)
	}

	if recorder := request(http.MethodPost, "/api/v1/app/business-data-sources/bilibili/bdsrc_1/sync", ""); recorder.Code != http.StatusAccepted || !strings.Contains(recorder.Body.String(), `"status":"queued"`) || manager.sourceID != "bdsrc_1" {
		t.Fatalf("sync status=%d body=%s source=%q", recorder.Code, recorder.Body.String(), manager.sourceID)
	}
	manager.syncErr = businessdata.ErrBilibiliSourceDisabled
	if recorder := request(http.MethodPost, "/api/v1/app/business-data-sources/bilibili/bdsrc_1/sync", ""); recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"bilibili_sync_disabled"`) {
		t.Fatalf("disabled sync status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	manager.syncErr = businessdata.ErrNotFound
	if recorder := request(http.MethodPost, "/api/v1/app/business-data-sources/bilibili/missing/sync", ""); recorder.Code != http.StatusNotFound || !strings.Contains(recorder.Body.String(), `"code":"business_data_source_not_found"`) {
		t.Fatalf("missing sync status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	manager.syncErr = nil

	disabled := request(http.MethodPatch, "/api/v1/app/business-data-sources/bilibili/bdsrc_1", `{"sync_enabled":false}`)
	if disabled.Code != http.StatusOK || !strings.Contains(disabled.Body.String(), `"status_reason":"bilibili_sync_disabled"`) || !strings.Contains(disabled.Body.String(), `"sync_request_status":null`) || manager.syncEnabled {
		t.Fatalf("disable status=%d body=%s enabled=%v", disabled.Code, disabled.Body.String(), manager.syncEnabled)
	}
	manager.change.Source.Status = businessdata.SourceStatusActive
	manager.change.Source.StatusReason = ""
	manager.change.QueuedCount = 1
	enabled := request(http.MethodPatch, "/api/v1/app/business-data-sources/bilibili/bdsrc_1", `{"sync_enabled":true}`)
	if enabled.Code != http.StatusOK || !strings.Contains(enabled.Body.String(), `"sync_request_status":"queued"`) || !manager.syncEnabled {
		t.Fatalf("enable status=%d body=%s enabled=%v", enabled.Code, enabled.Body.String(), manager.syncEnabled)
	}

	calls := manager.changeCalls
	for _, body := range []string{"", `{}`, `{"unknown":false}`, `{"sync_enabled":"false"}`, `{"sync_enabled":false}{"sync_enabled":true}`} {
		recorder := request(http.MethodPatch, "/api/v1/app/business-data-sources/bilibili/bdsrc_1", body)
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"invalid_request"`) {
			t.Fatalf("invalid body %q status=%d response=%s", body, recorder.Code, recorder.Body.String())
		}
	}
	if manager.changeCalls != calls {
		t.Fatalf("invalid PATCH invoked manager: before=%d after=%d", calls, manager.changeCalls)
	}
	manager.changeErr = businessdata.ErrBilibiliSourceAuthorizationRequired
	if recorder := request(http.MethodPatch, "/api/v1/app/business-data-sources/bilibili/bdsrc_1", `{"sync_enabled":true}`); recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"bilibili_reauth_required"`) {
		t.Fatalf("reauth status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	manager.changeErr = nil

	deleted := request(http.MethodDelete, "/api/v1/app/business-data-sources/bilibili/bdsrc_1", "")
	if deleted.Code != http.StatusNoContent || deleted.Body.Len() != 0 || manager.sourceID != "bdsrc_1" {
		t.Fatalf("delete status=%d body=%q source=%q", deleted.Code, deleted.Body.String(), manager.sourceID)
	}
	deleteCalls := manager.deleteCalls
	for _, test := range []struct {
		path string
		body string
	}{
		{path: "/api/v1/app/business-data-sources/bilibili/bdsrc_1?force=true"},
		{path: "/api/v1/app/business-data-sources/bilibili/bdsrc_1", body: `{}`},
	} {
		recorder := request(http.MethodDelete, test.path, test.body)
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"invalid_request"`) {
			t.Fatalf("invalid delete status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	}
	if manager.deleteCalls != deleteCalls {
		t.Fatalf("invalid DELETE invoked manager: before=%d after=%d", deleteCalls, manager.deleteCalls)
	}
	manager.deleteErr = businessdata.ErrNotFound
	if recorder := request(http.MethodDelete, "/api/v1/app/business-data-sources/bilibili/missing", ""); recorder.Code != http.StatusNotFound || !strings.Contains(recorder.Body.String(), `"code":"business_data_source_not_found"`) {
		t.Fatalf("missing delete status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	manager.deleteErr = errors.New("store unavailable")
	if recorder := request(http.MethodDelete, "/api/v1/app/business-data-sources/bilibili/bdsrc_1", ""); recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"bilibili_source_operation_failed"`) {
		t.Fatalf("failed delete status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	manager.deleteErr = nil
	withoutConnector := NewRouter(Options{AccountService: accountService, DataAccessService: dataService, BilibiliSourceManager: manager})
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/app/business-data-sources/bilibili/bdsrc_1", nil)
	req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
	withoutConnector.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("delete without connector status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	withoutManager := NewRouter(Options{AccountService: accountService, DataAccessService: dataService})
	recorder = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/app/business-data-sources/bilibili/bdsrc_1", nil)
	req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
	withoutManager.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"business_data_unavailable"`) {
		t.Fatalf("delete without manager status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	var syncLogged, disableLogged, deleteLogged bool
	entries := observed.FilterMessage("bilibili business data operation").All()
	for _, entry := range entries {
		fields := entry.ContextMap()
		if fields["source_id"] != "bdsrc_1" {
			continue
		}
		completeContext := fields["user_id"] == registered.Account.UserID && fields["request_id"] != ""
		if fields["action"] == "account_sync_requested" && fields["result"] == "queued" && completeContext {
			syncLogged = true
		}
		if fields["action"] == "account_sync_disabled" && fields["result"] == "success" && completeContext {
			disableLogged = true
		}
		if fields["action"] == "account_deleted" && fields["result"] == "success" && completeContext {
			deleteLogged = true
		}
	}
	if !syncLogged || !disableLogged || !deleteLogged {
		t.Fatalf("missing operation audit logs: sync=%v disable=%v delete=%v entries=%#v", syncLogged, disableLogged, deleteLogged, entries)
	}
	encoded, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"openid", "access_token", "refresh_token", "oauth_code", "secret-code"} {
		if strings.Contains(strings.ToLower(string(encoded)), forbidden) {
			t.Fatalf("operation audit logs contain sensitive field %q: %s", forbidden, encoded)
		}
	}
}

func TestBilibiliWebhookVerification(t *testing.T) {
	const clientID, secret = "client-id", "webhook-secret"
	fixture := &bilibiliIntegrationFixture{}
	router := NewRouter(Options{BilibiliIntegration: fixture, BilibiliWebhookClientID: clientID, BilibiliWebhookSecret: secret})
	signature := func(body string) string {
		sum := sha1.Sum(append([]byte(secret), []byte(body)...))
		return hex.EncodeToString(sum[:])
	}
	post := func(body, header string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/v1/integrations/bilibili/webhooks", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("x-bilibili-signature", header)
		router.ServeHTTP(recorder, request)
		return recorder
	}

	verifyBody := `{"event":"verify_webhooks","content":{"data":1371848576},"timestamp":"2021-01-01 12:01:01"}`
	verified := post(verifyBody, signature(verifyBody))
	if verified.Code != http.StatusOK {
		t.Fatalf("verify status=%d body=%s", verified.Code, verified.Body.String())
	}
	var response struct {
		Data int64 `json:"data"`
	}
	if err := json.Unmarshal(verified.Body.Bytes(), &response); err != nil || response.Data != 1371848576 {
		t.Fatalf("verify response=%q err=%v", verified.Body.String(), err)
	}

	if recorder := post(verifyBody, strings.Repeat("0", sha1.Size*2)); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("invalid signature status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	eventBody := `{"event":"authorized","content":{},"timestamp":"2021-01-01 12:01:01"}`
	if recorder := post(eventBody, signature(eventBody)); recorder.Code != http.StatusNoContent {
		t.Fatalf("event acknowledgement status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	deauthorizeBody := `{"event":"deauthorize","content":{"openid":"open-1","client_id":"client-id","permits":"USER_INFO"},"timestamp":"2021-01-01 12:01:01"}`
	if recorder := post(deauthorizeBody, signature(deauthorizeBody)); recorder.Code != http.StatusNoContent || fixture.deauthorizedOpenID != "open-1" {
		t.Fatalf("deauthorize status=%d body=%s openid=%q", recorder.Code, recorder.Body.String(), fixture.deauthorizedOpenID)
	}
	wrongClientBody := `{"event":"deauthorize","content":{"openid":"open-2","client_id":"other-client"},"timestamp":"2021-01-01 12:01:01"}`
	if recorder := post(wrongClientBody, signature(wrongClientBody)); recorder.Code != http.StatusBadRequest || fixture.deauthorizedOpenID != "open-1" {
		t.Fatalf("wrong client status=%d body=%s openid=%q", recorder.Code, recorder.Body.String(), fixture.deauthorizedOpenID)
	}
	fixture.deauthorizeErr = errors.New("store unavailable")
	if recorder := post(deauthorizeBody, signature(deauthorizeBody)); recorder.Code != http.StatusInternalServerError {
		t.Fatalf("deauthorize failure status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	oldCallback := httptest.NewRecorder()
	router.ServeHTTP(oldCallback, httptest.NewRequest(http.MethodPost, "/api/v1/integrations/bilibili/oauth/callback", strings.NewReader(verifyBody)))
	if oldCallback.Code != http.StatusNotFound {
		t.Fatalf("oauth callback POST status=%d body=%s", oldCallback.Code, oldCallback.Body.String())
	}
}
