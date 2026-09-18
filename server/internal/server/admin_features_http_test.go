package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

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
	for _, feature := range []string{"feedback", "knowledge", "skills", "skill_sources", "shared_files", "shared_file_storage", "shared_file_migrations", "activity", "agent_management", "account_governance", "mcp", "data_permissions", "platform_branding", "client_downloads"} {
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
