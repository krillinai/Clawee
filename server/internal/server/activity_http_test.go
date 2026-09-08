package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/activity"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
)

const activityTestJWTKey = "01234567890123456789012345678901"

type activityHTTPSnapshotClient struct {
	calls int
	err   error
}

func (f *activityHTTPSnapshotClient) Snapshot(context.Context, activity.SnapshotRequest) (activity.Snapshot, error) {
	f.calls++
	if f.err != nil {
		return activity.Snapshot{}, f.err
	}
	return activity.Snapshot{
		GeneratedAt: time.Now().UTC(), Trend: []activity.TrendPoint{}, Models: []activity.ModelUsage{},
	}, nil
}

type activityHTTPStore struct{}

func (activityHTTPStore) Statistics(context.Context, time.Time, time.Time) (activity.ActivitySnapshot, error) {
	return activity.ActivitySnapshot{}, nil
}

func (activityHTTPStore) MCPUsage(context.Context, time.Time, time.Time) ([]activity.MCPUsage, error) {
	return []activity.MCPUsage{}, nil
}

type failingActivityDataAccessStore struct{ *dataaccess.MemoryStore }

func (failingActivityDataAccessStore) ListGrants(context.Context, dataaccess.Filter) ([]dataaccess.Grant, error) {
	return nil, errors.New("authorization store unavailable")
}

func TestActivityHTTPRequiresCurrentAccountDataViewGrant(t *testing.T) {
	ctx := context.Background()
	accountService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "activity@example.com", Name: "Activity User", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	dataStore := dataaccess.NewMemoryStore()
	dataService := dataaccess.NewService(dataStore)
	snapshotClient := &activityHTTPSnapshotClient{}
	activityService, err := activity.NewService(snapshotClient, activityHTTPStore{}, activityHTTPStore{}, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	router := NewRouter(Options{AccountService: accountService, DataAccessService: dataService, ActivityService: activityService})
	request := func(path string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
		router.ServeHTTP(recorder, req)
		return recorder
	}
	if recorder := request("/api/v1/app/data-views"); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"data":[]`) {
		t.Fatalf("empty views status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request("/api/v1/app/activity/statistics?range=7d"); recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), `"code":"data_view_forbidden"`) {
		t.Fatalf("forbidden status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if snapshotClient.calls != 0 {
		t.Fatalf("unauthorized request called billing provider %d times", snapshotClient.calls)
	}
	if _, err := dataService.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView,
		ResourceID: dataaccess.ViewAgentActivity, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	if recorder := request("/api/v1/app/data-views"); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"view_id":"agent_activity"`) {
		t.Fatalf("granted views status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := request("/api/v1/app/activity/statistics?range=invalid"); recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"invalid_activity_range"`) {
		t.Fatalf("invalid range status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if snapshotClient.calls != 0 {
		t.Fatalf("invalid range called billing provider %d times", snapshotClient.calls)
	}
	if recorder := request("/api/v1/app/activity/statistics?range=7d&user_id=other"); recorder.Code != http.StatusOK {
		t.Fatalf("statistics status=%d body=%s", recorder.Code, recorder.Body.String())
	} else {
		if strings.Contains(strings.ToLower(recorder.Body.String()), "sub2api") {
			t.Fatalf("statistics leaked upstream brand: %s", recorder.Body.String())
		}
		for _, forbidden := range []string{"reasoning_output_tokens", "employee_tokens", "agent_tokens", "cost"} {
			if strings.Contains(recorder.Body.String(), forbidden) {
				t.Fatalf("response contains unsupported field %q: %s", forbidden, recorder.Body.String())
			}
		}
	}
	snapshotClient.err = errors.New("upstream detail must stay private")
	if recorder := request("/api/v1/app/activity/statistics?range=7d"); recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"model_usage":"unavailable"`) || strings.Contains(recorder.Body.String(), snapshotClient.err.Error()) {
		t.Fatalf("partial statistics status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if err := dataService.RemoveBy(ctx, registered.Account.UserID, dataaccess.ResourceDataView, dataaccess.ViewAgentActivity, "admin", "req_remove"); err != nil {
		t.Fatal(err)
	}
	if recorder := request("/api/v1/app/activity/statistics"); recorder.Code != http.StatusForbidden {
		t.Fatalf("revoked status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	providerCalls := snapshotClient.calls
	failingDataService := dataaccess.NewService(failingActivityDataAccessStore{MemoryStore: dataaccess.NewMemoryStore()})
	failingRouter := NewRouter(Options{AccountService: accountService, DataAccessService: failingDataService, ActivityService: activityService})
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/app/activity/statistics?range=7d", nil)
	req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
	failingRouter.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"data_authorization_unavailable"`) {
		t.Fatalf("authorization failure status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if snapshotClient.calls != providerCalls {
		t.Fatalf("authorization failure called provider %d times", snapshotClient.calls-providerCalls)
	}
}

func TestActivityHTTPRoutesRequireLogin(t *testing.T) {
	router := NewRouter(Options{AccountService: accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)}), DataAccessService: dataaccess.NewService(dataaccess.NewMemoryStore())})
	for _, path := range []string{"/api/v1/app/data-views", "/api/v1/app/activity/statistics"} {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s status=%d body=%s", path, recorder.Code, recorder.Body.String())
		}
	}
}
