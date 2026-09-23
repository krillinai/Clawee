package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/feedback"
	"github.com/krillinai/Clawee/server/internal/knowledge"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestAdminStatusReportsDisabledFeatures(t *testing.T) {
	router := newTestRouter(t, server.Options{})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/admin/status", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var response struct {
		Data struct {
			Features map[string]bool `json:"features"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	for _, feature := range []string{"feedback", "knowledge", "skills", "skill_oa", "skill_sources", "shared_files", "shared_file_storage", "shared_file_migrations", "activity", "agent_management", "account_governance", "mcp", "data_permissions", "platform_branding", "client_downloads"} {
		if enabled, exists := response.Data.Features[feature]; !exists || enabled {
			t.Errorf("feature %s = %v, exists = %v; want false", feature, enabled, exists)
		}
	}
	for _, feature := range []string{"accounts", "rbac"} {
		if !response.Data.Features[feature] {
			t.Errorf("test router feature %s should be enabled", feature)
		}
	}
}

func TestAdminStatusReportsSkillOAAvailability(t *testing.T) {
	for _, tc := range []struct {
		name    string
		enabled bool
		client  bool
		want    bool
	}{
		{name: "关闭", client: true},
		{name: "缺少客户端", enabled: true},
		{name: "开启且可用", enabled: true, client: true, want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opts := server.Options{DingTalkAuth: server.DingTalkAuthOptions{OAEnabled: tc.enabled}}
			if tc.client {
				opts.DingTalkAuth.OAClient = &fakeApprovalClient{}
			}
			router := newTestRouter(t, opts)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/admin/status", nil))
			var response struct {
				Data struct {
					Features map[string]bool `json:"features"`
				} `json:"data"`
			}
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if got := response.Data.Features["skill_oa"]; got != tc.want {
				t.Fatalf("skill_oa = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestAdminStatusReportsEnabledFeatures(t *testing.T) {
	router := newTestRouter(t, server.Options{
		KnowledgeService:   knowledge.NewService(knowledge.NewMemoryStore(), nil),
		SkillHubService:    skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()}),
		SkillSourceService: &skillhub.GitHubSourceService{},
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/admin/status", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var response struct {
		Data struct {
			Features map[string]bool `json:"features"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	for _, feature := range []string{"knowledge", "skills", "skill_sources"} {
		if !response.Data.Features[feature] {
			t.Errorf("feature %s should be enabled", feature)
		}
	}
}

func TestAdminStatusStillRequiresAuthentication(t *testing.T) {
	router := server.NewRouter(server.Options{AccountService: newTestAccountService(nil)})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/admin/status", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestAdminStatusFeedbackUIRequiresOptInAndService(t *testing.T) {
	for _, tc := range []struct {
		name    string
		showUI  bool
		service bool
		want    bool
	}{
		{name: "默认隐藏", service: true},
		{name: "显式开启", showUI: true, service: true, want: true},
		{name: "服务未开启", showUI: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opts := server.Options{
				FeedbackAdminUIEnabled: tc.showUI,
				DataAccessService:      dataaccess.NewService(dataaccess.NewMemoryStore()),
			}
			if tc.service {
				opts.FeedbackService = feedback.NewService(feedback.NewMemoryStore(), nil, nil, 0)
			}
			router := newTestRouter(t, opts)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/admin/status", nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d", rec.Code)
			}
			var response struct {
				Data struct {
					Features map[string]bool `json:"features"`
				} `json:"data"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if got := response.Data.Features["feedback"]; got != tc.want {
				t.Fatalf("feedback = %v, want %v", got, tc.want)
			}
		})
	}
}
