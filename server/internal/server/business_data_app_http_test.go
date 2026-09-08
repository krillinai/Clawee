package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/businessdata"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
)

type businessDashboardHTTPStore struct {
	bilibiliErr error
}

func (businessDashboardHTTPStore) XiaohongshuDashboard(context.Context, businessdata.DashboardRange) (businessdata.XiaohongshuDashboardData, error) {
	return businessdata.XiaohongshuDashboardData{State: businessdata.DashboardState{DataStatus: businessdata.DataStatusUnconfigured}}, nil
}
func (businessDashboardHTTPStore) DouyinAdsDashboard(context.Context, businessdata.DashboardRange) (businessdata.DouyinAdsDashboardData, error) {
	return businessdata.DouyinAdsDashboardData{State: businessdata.DashboardState{DataStatus: businessdata.DataStatusUnconfigured}}, nil
}
func (s businessDashboardHTTPStore) BilibiliDashboard(_ context.Context, sourceID string, _ businessdata.DashboardRange) (businessdata.BilibiliDashboardData, error) {
	if s.bilibiliErr != nil {
		return businessdata.BilibiliDashboardData{}, s.bilibiliErr
	}
	return businessdata.BilibiliDashboardData{
		State:   businessdata.DashboardState{DataStatus: businessdata.DataStatusUnavailable},
		Account: businessdata.BilibiliDashboardAccount{SourceID: sourceID, Name: "账号一", Status: businessdata.SourceStatusActive},
	}, nil
}
func (businessDashboardHTTPStore) BilibiliDashboardOverview(context.Context) (businessdata.DashboardState, error) {
	return businessdata.DashboardState{DataStatus: businessdata.DataStatusUnconfigured}, nil
}

func TestBusinessDashboardHTTPAuthorizationAndUnconfigured(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "business@example.com", Name: "Business User", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	dataService := dataaccess.NewService(dataaccess.NewMemoryStore())
	dashboardStore := &businessDashboardHTTPStore{}
	router := NewRouter(Options{AccountService: accountService, DataAccessService: dataService, BusinessDashboardService: businessdata.NewDashboardService(dashboardStore)})
	request := func(path string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
		router.ServeHTTP(recorder, req)
		return recorder
	}
	if recorder := request("/api/v1/app/business-dashboards/xiaohongshu-operation"); recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), `"code":"business_data_view_forbidden"`) {
		t.Fatalf("forbidden status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request("/api/v1/app/business-dashboards/bilibili-operation?source_id=bdsrc_1"); recorder.Code != http.StatusForbidden {
		t.Fatalf("bilibili forbidden status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, err := dataService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView, ResourceID: dataaccess.ViewXiaohongshuOperation, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	if _, err := dataService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView, ResourceID: dataaccess.ViewBilibiliOperation, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	if recorder := request("/api/v1/app/data-views"); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"view_id":"xiaohongshu_operation"`) || !strings.Contains(recorder.Body.String(), `"view_id":"bilibili_operation"`) {
		t.Fatalf("views status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request("/api/v1/app/business-dashboards/xiaohongshu-operation?range=7d"); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"data_status":"unconfigured"`) || !strings.Contains(recorder.Body.String(), `"summary":null`) {
		t.Fatalf("dashboard status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request("/api/v1/app/business-dashboards/bilibili-operation"); recorder.Code != http.StatusBadRequest {
		t.Fatalf("bilibili dashboard status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request("/api/v1/app/business-dashboards/bilibili-operation?range=7d&source_id=bdsrc_1"); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"status":"unavailable"`) || !strings.Contains(recorder.Body.String(), `"source_id":"bdsrc_1"`) || !strings.Contains(recorder.Body.String(), `"range":"7d"`) {
		t.Fatalf("bilibili range status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	dashboardStore.bilibiliErr = businessdata.ErrNotFound
	if recorder := request("/api/v1/app/business-dashboards/bilibili-operation?source_id=bdsrc_missing"); recorder.Code != http.StatusNotFound || !strings.Contains(recorder.Body.String(), `"code":"business_data_source_not_found"`) {
		t.Fatalf("bilibili missing status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	dashboardStore.bilibiliErr = nil
	for _, path := range []string{
		"/api/v1/app/business-dashboards/bilibili-operation?source_id=",
		"/api/v1/app/business-dashboards/bilibili-operation?source_id=bdsrc_1&source_id=bdsrc_2",
		"/api/v1/app/business-dashboards/bilibili-operation?source_id=bdsrc_1&unknown=1",
		"/api/v1/app/business-dashboards/bilibili-operation?source_id=bdsrc_1&range=90d",
	} {
		if recorder := request(path); recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s status=%d body=%s", path, recorder.Code, recorder.Body.String())
		}
	}
	for _, path := range []string{
		"/api/v1/app/business-dashboards/xiaohongshu-operation?range=90d",
		"/api/v1/app/business-dashboards/xiaohongshu-operation?range=7d&range=30d",
		"/api/v1/app/business-dashboards/xiaohongshu-operation?other=1",
		"/api/v1/app/business-dashboards/xiaohongshu-operation?range=",
		"/api/v1/app/business-dashboards/xiaohongshu-operation?range=7d&unknown=1;bad=2",
	} {
		if recorder := request(path); recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s status=%d body=%s", path, recorder.Code, recorder.Body.String())
		}
	}
	if recorder := request("/api/v1/app/business-dashboards"); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"view_id":"xiaohongshu_operation"`) || !strings.Contains(recorder.Body.String(), `"view_id":"bilibili_operation"`) || strings.Contains(recorder.Body.String(), `"view_id":"douyin_ads"`) {
		t.Fatalf("overview status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestBusinessDashboardHTTPRequiresLogin(t *testing.T) {
	router := NewRouter(Options{AccountService: accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)}), DataAccessService: dataaccess.NewService(dataaccess.NewMemoryStore()), BusinessDashboardService: businessdata.NewDashboardService(businessDashboardHTTPStore{})})
	for _, path := range []string{"/api/v1/app/business-dashboards", "/api/v1/app/business-dashboards/douyin-ads", "/api/v1/app/business-dashboards/bilibili-operation?source_id=bdsrc_1"} {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s status=%d body=%s", path, recorder.Code, recorder.Body.String())
		}
	}
}
