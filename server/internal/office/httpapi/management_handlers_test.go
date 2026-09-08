package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/management"
	"github.com/krillinai/Clawee/server/internal/office/registration"
)

func TestManagementOverviewReturnsCollectors(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	createdAt := now.Add(-time.Hour)
	expiresAt := now.Add(7 * 24 * time.Hour)
	store := &fakeManagementStore{
		overview: management.CollectorsOverview{
			SchemaVersion:          management.SchemaVersion,
			ServerTime:             now,
			OnlineThresholdSeconds: 60,
			RegistrationCode: management.RegistrationCodeSummary{
				Exists:    true,
				Code:      "reg_active",
				CreatedBy: "local-admin",
				CreatedAt: &createdAt,
				ExpiresAt: &expiresAt,
			},
			Summary: management.CollectorSummary{
				TotalCollectors:   2,
				OnlineCollectors:  1,
				OfflineCollectors: 1,
			},
			Collectors: []management.CollectorItem{
				{
					CollectorID: "collector_1",
					DeviceID:    "device_1",
					Status:      management.CollectorStatusOnline,
				},
			},
		},
	}
	api := NewManagementAPI(store, func() time.Time { return now })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://admin.local/api/v1/admin/collectors/overview", nil)
	api.CollectorsOverviewHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if store.overviewCalls != 1 {
		t.Fatalf("overviewCalls = %d, want 1", store.overviewCalls)
	}
	if !store.lastOverviewNow.Equal(now) {
		t.Fatalf("lastOverviewNow = %s, want %s", store.lastOverviewNow, now)
	}
	if store.lastOnlineThreshold != 60*time.Second {
		t.Fatalf("lastOnlineThreshold = %s, want 60s", store.lastOnlineThreshold)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"registration_code":{"exists":true`) ||
		!strings.Contains(body, `"summary":{"total_collectors":2,"online_collectors":1,"offline_collectors":1`) {
		t.Fatalf("body missing overview fields: %s", body)
	}
	if strings.Contains(body, "reg_active") || strings.Contains(body, "install_command") {
		t.Fatalf("overview leaked registration code or install command: %s", body)
	}
}

func TestManagementCreateRegistrationCodeReturnsCreated(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	store := &fakeManagementStore{
		createResp: management.CreateRegistrationCodeResponse{
			RegistrationCode: "reg_new",
			CreatedAt:        now,
		},
	}
	api := NewManagementAPI(store, func() time.Time { return now })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "http://admin.local/api/v1/admin/collector-registration-codes", strings.NewReader(`{"user_id":"usr_1"}`))
	req = req.WithContext(ContextWithManagementOperator(req.Context(), "usr_operator"))
	req = req.WithContext(ContextWithManagementOperatorName(req.Context(), "平台管理员"))
	api.RegistrationCodeHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	if store.createCalls != 1 {
		t.Fatalf("createCalls = %d, want 1", store.createCalls)
	}
	if store.lastCreatedUserID != "usr_1" {
		t.Fatalf("lastCreatedUserID = %q, want usr_1", store.lastCreatedUserID)
	}
	if store.lastCreatedBy != "平台管理员" {
		t.Fatalf("lastCreatedBy = %q, want 平台管理员", store.lastCreatedBy)
	}
	if !store.lastCreatedAt.Equal(now) {
		t.Fatalf("lastCreatedAt = %s, want %s", store.lastCreatedAt, now)
	}
	if !strings.Contains(rec.Body.String(), `"registration_code":"reg_new"`) {
		t.Fatalf("body missing registration code: %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"expires_at"`) {
		t.Fatalf("body should omit expires_at for non-expiring registration code: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"install_url":"http://admin.local/office/collectors/install?code=reg_new"`) ||
		!strings.Contains(rec.Body.String(), `"install_script_url":"http://admin.local/office/collectors/install.sh?code=reg_new"`) ||
		!strings.Contains(rec.Body.String(), `"install_command":"curl -fsSL 'http://admin.local/office/collectors/install.sh?code=reg_new' | sh"`) {
		t.Fatalf("body missing install links: %s", rec.Body.String())
	}
}

func TestManagementGetRegistrationCodeReturnsPersistentCodeAndUsage(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	createdAt := now.Add(-time.Hour)
	lastUsedAt := now.Add(-time.Minute)
	store := &fakeManagementStore{
		overview: management.CollectorsOverview{
			RegistrationCode: management.RegistrationCodeSummary{
				Exists:     true,
				Code:       "reg_saved",
				CreatedAt:  &createdAt,
				UsedCount:  3,
				LastUsedAt: &lastUsedAt,
			},
		},
	}
	api := NewManagementAPI(store, func() time.Time { return now })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://admin.local/api/v1/admin/collector-registration-codes?user_id=usr_1", nil)
	api.RegistrationCodeHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if store.lastUserOverviewID != "usr_1" {
		t.Fatalf("queried user = %q, want usr_1", store.lastUserOverviewID)
	}
	for _, fragment := range []string{
		`"registration_code":"reg_saved"`,
		`"used_count":3`,
		`"last_used_at":"2026-01-02T03:03:05Z"`,
		`"install_url":"http://admin.local/office/collectors/install?code=reg_saved"`,
		`"install_powershell_command":"irm 'http://admin.local/office/collectors/install.ps1?code=reg_saved' | iex"`,
	} {
		if !strings.Contains(rec.Body.String(), fragment) {
			t.Fatalf("body missing %q: %s", fragment, rec.Body.String())
		}
	}
}

func TestManagementEnsureRegistrationCodeReturnsInstallCommands(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	store := &fakeManagementStore{
		createResp: management.CreateRegistrationCodeResponse{RegistrationCode: "reg_ensured"},
	}
	api := NewManagementAPIWithOptions(store, func() time.Time { return now }, ManagementAPIOptions{
		PublicBaseURL: "https://collectors.example.com/",
	})
	req := httptest.NewRequest(http.MethodGet, "http://internal.local/api/v1/auth/me", nil)

	detail, err := api.EnsureAccountRegistrationCode(req, "usr_1", "张三")
	if err != nil {
		t.Fatal(err)
	}
	if store.ensureCalls != 1 || store.lastCreatedUserID != "usr_1" || store.lastCreatedBy != "张三" {
		t.Fatalf("unexpected ensure call: %#v", store)
	}
	if !detail.Exists || detail.RegistrationCode != "reg_ensured" {
		t.Fatalf("detail = %#v", detail)
	}
	if detail.InstallCommand != "curl -fsSL 'https://collectors.example.com/office/collectors/install.sh?code=reg_ensured' | sh" {
		t.Fatalf("install command = %q", detail.InstallCommand)
	}
	if detail.InstallPowerShellCommand != "irm 'https://collectors.example.com/office/collectors/install.ps1?code=reg_ensured' | iex" {
		t.Fatalf("powershell command = %q", detail.InstallPowerShellCommand)
	}
}

func TestManagementCreateRegistrationCodeReturnsFixedExpiry(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	expiresAt := now.Add(10 * time.Minute)
	store := &fakeManagementStore{
		createResp: management.CreateRegistrationCodeResponse{
			RegistrationCode: "reg_new",
			CreatedAt:        now,
			ExpiresAt:        &expiresAt,
		},
	}
	api := NewManagementAPI(store, func() time.Time { return now })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "http://admin.local/api/v1/admin/collector-registration-codes", strings.NewReader(`{"user_id":"usr_1"}`))
	api.RegistrationCodeHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"expires_at":"2026-01-02T03:14:05Z"`) {
		t.Fatalf("body missing expires_at: %s", rec.Body.String())
	}
}

func TestManagementCreateRegistrationCodeRejectsInvalidOwner(t *testing.T) {
	store := &fakeManagementStore{createErr: registration.ErrRegistrationOwnerInvalid}
	api := NewManagementAPI(store, func() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC) })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/collector-registration-codes", strings.NewReader(`{"user_id":"disabled"}`))
	api.RegistrationCodeHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "invalid_user_id")
}

func TestManagementInstallLinksPreferConfiguredPublicBaseURL(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	store := &fakeManagementStore{
		overview: management.CollectorsOverview{
			SchemaVersion: management.SchemaVersion,
			ServerTime:    now,
			RegistrationCode: management.RegistrationCodeSummary{
				Exists: true,
				Code:   "reg_active",
			},
		},
	}
	api := NewManagementAPIWithOptions(store, func() time.Time { return now }, ManagementAPIOptions{
		PublicBaseURL: "https://collectors.example.com/",
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://dev.local:5904/api/v1/admin/collectors/overview", nil)
	req.Header.Set("X-Forwarded-Host", "dev.local:5904")
	api.CollectorsOverviewHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "reg_active") {
		t.Fatalf("overview leaked registration code: %s", rec.Body.String())
	}
}

func TestManagementCreateRegistrationCodeRejectsMissingUserID(t *testing.T) {
	store := &fakeManagementStore{}
	api := NewManagementAPI(store, func() time.Time {
		return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/collector-registration-codes", strings.NewReader(`{}`))
	api.RegistrationCodeHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	if store.createCalls != 0 {
		t.Fatalf("createCalls = %d, want 0", store.createCalls)
	}
	assertErrorCode(t, rec.Body.String(), "invalid_user_id")
}

func TestManagementRevokeCollectorTokenReturnsOK(t *testing.T) {
	store := &fakeManagementStore{}
	api := NewManagementAPI(store, func() time.Time {
		return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/collectors/token/revoke", strings.NewReader(`{"collector_id":"collector_1"}`))
	api.CollectorTokenRevokeHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if store.deleteCalls != 1 {
		t.Fatalf("deleteCalls = %d, want 1", store.deleteCalls)
	}
	if store.lastDeletedCollectorID != "collector_1" {
		t.Fatalf("lastDeletedCollectorID = %q, want collector_1", store.lastDeletedCollectorID)
	}
}

func TestManagementRevokeCollectorTokenRejectsAlreadyRevoked(t *testing.T) {
	store := &fakeManagementStore{deleteErr: management.ErrCollectorTokenRevoked}
	api := NewManagementAPI(store, func() time.Time {
		return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/collectors/token/revoke", strings.NewReader(`{"collector_id":"collector_online"}`))
	api.CollectorTokenRevokeHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "collector_token_revoked")
}

func TestManagementRevokeCollectorTokenReturnsNotFound(t *testing.T) {
	store := &fakeManagementStore{deleteErr: management.ErrCollectorNotFound}
	api := NewManagementAPI(store, func() time.Time {
		return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/collectors/token/revoke", strings.NewReader(`{"collector_id":"missing"}`))
	api.CollectorTokenRevokeHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusNotFound, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "collector_not_found")
}

func TestManagementOverviewStoreErrorReturnsInternalError(t *testing.T) {
	store := &fakeManagementStore{overviewErr: errors.New("query failed")}
	api := NewManagementAPI(store, func() time.Time {
		return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/collectors/overview", nil)
	api.CollectorsOverviewHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusInternalServerError, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "internal_error")
}

func TestManagementBindMCPAgentReturnsOK(t *testing.T) {
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	store := &fakeManagementStore{}
	api := NewManagementAPI(store, func() time.Time { return now })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/activity/mcp-agent-binding", strings.NewReader(`{"collector_id":"collector_1","agent_id":"office_1","mcp_agent_id":"mcp_1"}`))
	api.AgentBindingHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if store.bindCalls != 1 || store.lastBoundCollectorID != "collector_1" || store.lastBoundOfficeAgentID != "office_1" || store.lastBoundMCPAgentID != "mcp_1" {
		t.Fatalf("unexpected bind call: %#v", store)
	}
	if !strings.Contains(rec.Body.String(), `"status":"bound"`) {
		t.Fatalf("body missing bound status: %s", rec.Body.String())
	}
}

func TestManagementBindMCPAgentRejectsOwnerMismatch(t *testing.T) {
	store := &fakeManagementStore{bindErr: management.ErrAgentOwnerMismatch}
	api := NewManagementAPI(store, func() time.Time { return time.Now().UTC() })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/activity/mcp-agent-binding", strings.NewReader(`{"collector_id":"collector_1","agent_id":"office_1","mcp_agent_id":"mcp_other"}`))
	api.AgentBindingHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "agent_owner_mismatch")
}

func TestManagementUnbindMCPAgentReturnsNoContent(t *testing.T) {
	store := &fakeManagementStore{}
	api := NewManagementAPI(store, func() time.Time { return time.Now().UTC() })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/admin/activity/mcp-agent-binding/remove", strings.NewReader(`{"collector_id":"collector_1","agent_id":"office_1"}`))
	api.AgentUnbindingHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
	if store.unbindCalls != 1 || store.lastUnboundCollectorID != "collector_1" || store.lastUnboundOfficeAgentID != "office_1" {
		t.Fatalf("unexpected unbind call: %#v", store)
	}
}

func TestManagementDeleteOfficeAgentReturnsNoContent(t *testing.T) {
	store := &fakeManagementStore{}
	api := NewManagementAPI(store, func() time.Time { return time.Now().UTC() })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/activity/agents/remove", strings.NewReader(`{"collector_id":"collector_1","agent_id":"office_1"}`))
	api.AgentDeleteHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
	if store.deleteOfficeAgentCalls != 1 || store.lastDeletedOfficeCollectorID != "collector_1" || store.lastDeletedOfficeAgentID != "office_1" {
		t.Fatalf("unexpected office agent delete call: %#v", store)
	}
}

func TestManagementDeleteOfficeAgentRejectsBoundAgent(t *testing.T) {
	store := &fakeManagementStore{deleteOfficeAgentErr: management.ErrOfficeAgentBound}
	api := NewManagementAPI(store, func() time.Time { return time.Now().UTC() })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/activity/agents/remove", strings.NewReader(`{"collector_id":"collector_1","agent_id":"office_1"}`))
	api.AgentDeleteHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "office_agent_bound")
}

func TestUserCollectorsHandlerScopesListDetailAndRevoke(t *testing.T) {
	store := &fakeManagementStore{overview: management.CollectorsOverview{Collectors: []management.CollectorItem{
		{CollectorID: "collector_owned", UserID: "usr_1"},
		{CollectorID: "collector_other", UserID: "usr_2"},
	}}}
	api := NewManagementAPI(store, func() time.Time { return time.Now().UTC() })
	handler := api.UserCollectorsHandler()
	request := func(method, target, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		req = req.WithContext(ContextWithManagementOperator(req.Context(), "usr_1"))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		handler.ServeHTTP(rec, req)
		return rec
	}

	rec := request(http.MethodGet, "/api/v1/app/collectors", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "collector_owned") || strings.Contains(rec.Body.String(), "collector_other") {
		t.Fatalf("list status = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = request(http.MethodGet, "/api/v1/app/collectors/detail?collector_id=collector_other", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("other detail status = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = request(http.MethodPost, "/api/v1/app/collectors/token/revoke", `{"collector_id":"collector_owned"}`)
	if rec.Code != http.StatusOK || store.lastDeletedCollectorID != "collector_owned" {
		t.Fatalf("revoke status = %d body=%s store=%#v", rec.Code, rec.Body.String(), store)
	}
}

func TestUserCollectorsHandlerReturnsEmptyItemsAndDoesNotListBeforeRevoke(t *testing.T) {
	store := &fakeManagementStore{}
	api := NewManagementAPI(store, func() time.Time { return time.Now().UTC() })
	handler := api.UserCollectorsHandler()
	request := func(method, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, "/api/v1/app/collectors", strings.NewReader(body))
		req = req.WithContext(ContextWithManagementOperator(req.Context(), "usr_1"))
		handler.ServeHTTP(rec, req)
		return rec
	}

	rec := request(http.MethodGet, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"items":[]`) {
		t.Fatalf("empty list status = %d body=%s", rec.Code, rec.Body.String())
	}

	store.overviewCalls = 0
	store.overview = management.CollectorsOverview{Collectors: []management.CollectorItem{{CollectorID: "collector_owned", UserID: "usr_1"}}}
	rec = request(http.MethodPost, `{"collector_id":"collector_owned"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke status = %d body=%s", rec.Code, rec.Body.String())
	}
	if store.overviewCalls != 0 {
		t.Fatalf("revoke listed collectors %d times, want 0", store.overviewCalls)
	}
}

func TestUserCollectorDeleteHandlerScopesCollectorOwnership(t *testing.T) {
	store := &fakeManagementStore{overview: management.CollectorsOverview{Collectors: []management.CollectorItem{
		{CollectorID: "collector_owned", UserID: "usr_1"},
		{CollectorID: "collector_other", UserID: "usr_2"},
	}}}
	api := NewManagementAPI(store, func() time.Time { return time.Now().UTC() })
	handler := api.UserCollectorDeleteHandler()
	request := func(collectorID string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/app/collectors/remove", strings.NewReader(`{"collector_id":"`+collectorID+`"}`))
		req = req.WithContext(ContextWithManagementOperator(req.Context(), "usr_1"))
		handler.ServeHTTP(rec, req)
		return rec
	}

	if rec := request("collector_other"); rec.Code != http.StatusNotFound {
		t.Fatalf("other collector status = %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := request("collector_owned"); rec.Code != http.StatusNoContent {
		t.Fatalf("owned collector status = %d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastRemovedCollectorID != "collector_owned" {
		t.Fatalf("removed collector = %q", store.lastRemovedCollectorID)
	}
}

func TestManagementCollectorsListAndDetail(t *testing.T) {
	store := &fakeManagementStore{overview: management.CollectorsOverview{Collectors: []management.CollectorItem{{CollectorID: "collector_1", UserID: "usr_1"}}}}
	api := NewManagementAPI(store, func() time.Time { return time.Now().UTC() })

	for _, tt := range []struct {
		target  string
		handler http.Handler
	}{
		{target: "/api/v1/admin/collectors", handler: api.CollectorsHandler()},
		{target: "/api/v1/admin/collectors/detail?collector_id=collector_1", handler: api.CollectorDetailHandler()},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, tt.target, nil)
		tt.handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "collector_1") {
			t.Fatalf("GET %s status = %d body=%s", tt.target, rec.Code, rec.Body.String())
		}
	}
}

func TestManagementDeleteCollectorReturnsNoContent(t *testing.T) {
	store := &fakeManagementStore{}
	api := NewManagementAPI(store, func() time.Time { return time.Date(2026, 8, 5, 9, 0, 0, 0, time.UTC) })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/collectors/remove", strings.NewReader(`{"collector_id":"collector_1"}`))
	api.CollectorDeleteHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
	if store.removeCalls != 1 || store.lastRemovedCollectorID != "collector_1" {
		t.Fatalf("unexpected delete call: %#v", store)
	}
}

func TestManagementDeleteCollectorRejectsActiveCollector(t *testing.T) {
	store := &fakeManagementStore{removeErr: management.ErrCollectorNotDisabled}
	api := NewManagementAPI(store, func() time.Time { return time.Now().UTC() })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/collectors/remove", strings.NewReader(`{"collector_id":"collector_active"}`))
	api.CollectorDeleteHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	assertErrorCode(t, rec.Body.String(), "collector_not_disabled")
}

type fakeManagementStore struct {
	overview                     management.CollectorsOverview
	overviewErr                  error
	overviewCalls                int
	lastOverviewNow              time.Time
	lastOnlineThreshold          time.Duration
	lastUserOverviewID           string
	createResp                   management.CreateRegistrationCodeResponse
	createErr                    error
	createCalls                  int
	ensureCalls                  int
	lastCreatedBy                string
	lastCreatedUserID            string
	lastCreatedAt                time.Time
	deleteErr                    error
	deleteCalls                  int
	lastDeletedCollectorID       string
	removeErr                    error
	removeCalls                  int
	lastRemovedCollectorID       string
	bindErr                      error
	bindCalls                    int
	lastBoundCollectorID         string
	lastBoundOfficeAgentID       string
	lastBoundMCPAgentID          string
	unbindErr                    error
	unbindCalls                  int
	lastUnboundCollectorID       string
	lastUnboundOfficeAgentID     string
	deleteOfficeAgentErr         error
	deleteOfficeAgentCalls       int
	lastDeletedOfficeCollectorID string
	lastDeletedOfficeAgentID     string
}

func (s *fakeManagementStore) CollectorsOverview(ctx context.Context, now time.Time, onlineThreshold time.Duration) (management.CollectorsOverview, error) {
	s.overviewCalls++
	s.lastOverviewNow = now
	s.lastOnlineThreshold = onlineThreshold
	return s.overview, s.overviewErr
}

func (s *fakeManagementStore) UserCollectorsOverview(ctx context.Context, userID string, now time.Time, onlineThreshold time.Duration) (management.CollectorsOverview, error) {
	s.lastUserOverviewID = userID
	overview, err := s.CollectorsOverview(ctx, now, onlineThreshold)
	if err != nil {
		return management.CollectorsOverview{}, err
	}
	items := make([]management.CollectorItem, 0)
	for _, item := range overview.Collectors {
		if item.UserID == userID {
			items = append(items, item)
		}
	}
	overview.Collectors = items
	return overview, nil
}

func (s *fakeManagementStore) CreateManagementRegistrationCode(ctx context.Context, userID, createdBy string, createdAt time.Time) (management.CreateRegistrationCodeResponse, error) {
	s.createCalls++
	s.lastCreatedUserID = userID
	s.lastCreatedBy = createdBy
	s.lastCreatedAt = createdAt
	return s.createResp, s.createErr
}

func (s *fakeManagementStore) EnsureManagementRegistrationCode(_ context.Context, userID, createdBy string, createdAt time.Time) (management.RegistrationCodeSummary, error) {
	s.ensureCalls++
	s.lastCreatedUserID = userID
	s.lastCreatedBy = createdBy
	s.lastCreatedAt = createdAt
	if s.overviewErr != nil {
		return management.RegistrationCodeSummary{}, s.overviewErr
	}
	if s.overview.RegistrationCode.Exists {
		return s.overview.RegistrationCode, nil
	}
	return management.RegistrationCodeSummary{
		Exists: true, Code: s.createResp.RegistrationCode, CreatedBy: createdBy, CreatedAt: &createdAt,
	}, s.createErr
}

func (s *fakeManagementStore) RevokeCollectorToken(ctx context.Context, collectorID string, now time.Time) error {
	s.deleteCalls++
	s.lastDeletedCollectorID = collectorID
	return s.deleteErr
}

func (s *fakeManagementStore) RevokeUserCollectorToken(ctx context.Context, userID, collectorID string, now time.Time) error {
	for _, item := range s.overview.Collectors {
		if item.CollectorID == collectorID && item.UserID == userID {
			return s.RevokeCollectorToken(ctx, collectorID, now)
		}
	}
	return management.ErrCollectorNotFound
}

func (s *fakeManagementStore) DeleteCollector(_ context.Context, collectorID string, _ time.Time, _ time.Duration) error {
	s.removeCalls++
	s.lastRemovedCollectorID = collectorID
	return s.removeErr
}

func (s *fakeManagementStore) DeleteUserCollector(_ context.Context, userID, collectorID string, _ time.Time, _ time.Duration) error {
	for _, item := range s.overview.Collectors {
		if item.CollectorID == collectorID && item.UserID == userID {
			return s.DeleteCollector(context.Background(), collectorID, time.Time{}, 0)
		}
	}
	return management.ErrCollectorNotFound
}

func (s *fakeManagementStore) BindMCPAgent(ctx context.Context, collectorID, officeAgentID, mcpAgentID string, now time.Time) error {
	s.bindCalls++
	s.lastBoundCollectorID = collectorID
	s.lastBoundOfficeAgentID = officeAgentID
	s.lastBoundMCPAgentID = mcpAgentID
	return s.bindErr
}

func (s *fakeManagementStore) UnbindMCPAgent(ctx context.Context, collectorID, officeAgentID string, now time.Time) error {
	s.unbindCalls++
	s.lastUnboundCollectorID = collectorID
	s.lastUnboundOfficeAgentID = officeAgentID
	return s.unbindErr
}

func (s *fakeManagementStore) DeleteOfficeAgent(_ context.Context, collectorID, officeAgentID string) error {
	s.deleteOfficeAgentCalls++
	s.lastDeletedOfficeCollectorID = collectorID
	s.lastDeletedOfficeAgentID = officeAgentID
	return s.deleteOfficeAgentErr
}
