package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestSkillContributionsAuthorizationAndConditions(t *testing.T) {
	ctx := context.Background()
	accountsService := accounts.NewService(accounts.Config{Store: accounts.NewMemoryStore(), JWTSigningKey: []byte(activityTestJWTKey)})
	registered, err := accountsService.Register(ctx, accounts.RegisterRequest{Email: "hr@example.com", Name: "人事", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountsService.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	access := dataaccess.NewService(dataaccess.NewMemoryStore())
	router := NewRouter(Options{AccountService: accountsService, DataAccessService: access, SkillHubService: skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})})
	request := func(method, path, body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: defaultSessionCookieName, Value: tokens.Token(accounts.AudienceFrontend).Token})
		router.ServeHTTP(recorder, req)
		return recorder
	}
	for _, endpoint := range []string{"summary", "records", "detail", "export"} {
		method := "GET"
		body := ""
		if endpoint == "export" {
			method = "POST"
			body = "{}"
		}
		if response := request(method, "/api/v1/app/skill-contributions/"+endpoint, body); response.Code != 403 {
			t.Fatalf("未授权%s=%d", endpoint, response.Code)
		}
	}
	if _, err = access.Create(ctx, dataaccess.SetInput{UserID: registered.Account.UserID, ResourceType: dataaccess.ResourceDataView, ResourceID: dataaccess.ViewSkillContributions, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	if response := request("GET", "/api/v1/app/data-views", ""); !strings.Contains(response.Body.String(), "skill_contributions") {
		t.Fatal("授权发现缺失")
	}
	for _, path := range []string{"summary?status=approved", "summary?report=uploads", "summary?page=0", "summary?page=1", "summary?page_size=0", "summary?page_size=50", "summary?min_total_score=0", "summary?start_date=%ZZ", "records?department_id=unknown", "records?report=employees&min_total_score=16", "records?start_date=2026-02-30&end_date=2026-03-01", "records?page=1&page=2", "records?page=0", "records?page=-1", "records?page_size=0", "records?page_size=-1", "records?page_size=101", "detail?skill_id=x&version_id=y"} {
		if response := request("GET", "/api/v1/app/skill-contributions/"+path, ""); response.Code != 400 {
			t.Fatalf("参数%s未拒绝: %d %s", path, response.Code, response.Body.String())
		}
	}
	if response := request("GET", "/api/v1/app/skill-contributions/summary", ""); response.Code != 200 || !strings.Contains(response.Body.String(), `"average_score":null`) {
		t.Fatalf("缺分不能补零: %s", response.Body.String())
	}
	for _, path := range []string{"summary?start_date=2026-10-01&end_date=2026-10-13&employee_id=" + registered.Account.UserID, "records?page=1&page_size=100"} {
		if response := request("GET", "/api/v1/app/skill-contributions/"+path, ""); response.Code != 200 {
			t.Fatalf("合法参数%s被拒绝: %d %s", path, response.Code, response.Body.String())
		}
	}
	if response := request("POST", "/api/v1/app/skill-contributions/export", `{"report":"uploads"}`); response.Code != 200 || !strings.HasPrefix(response.Body.String(), "\xef\xbb\xbf") || response.Header().Get("X-Result-Count") != "0" {
		t.Fatalf("空CSV: %d %s", response.Code, response.Body.String())
	}
	if response := request("POST", "/api/v1/app/skill-contributions/export", `{"report":"uploads","url":"https://example.com"}`); response.Code != 400 {
		t.Fatal("不允许未知条件")
	}
	for _, body := range []string{`{"page":0}`, `{"page":1}`, `{"page":null}`, `{"page_size":0}`, `{"page_size":50}`, `{"page_size":null}`, `null`, `[]`, `{} {}`, "{}" + strings.Repeat(" ", 8191)} {
		if response := request("POST", "/api/v1/app/skill-contributions/export", body); response.Code != 400 {
			t.Fatalf("非法导出正文长度%d未拒绝: %d %s", len(body), response.Code, response.Body.String())
		}
	}
	if err = access.RemoveBy(ctx, registered.Account.UserID, dataaccess.ResourceDataView, dataaccess.ViewSkillContributions, "admin", "request"); err != nil {
		t.Fatal(err)
	}
	if response := request("POST", "/api/v1/app/skill-contributions/export", `{"report":"uploads"}`); response.Code != 403 {
		t.Fatal("撤销后导出仍可用")
	}
}
