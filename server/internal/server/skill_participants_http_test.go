package server_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestSkillParticipantsAndAvatarRespectSpaceAccess(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	creator, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "creator@example.com", Name: "创建者", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	updater, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "updater@example.com", Name: "更新者", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	service := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	space, err := service.CreateSpace(ctx, "产品技能", "", creator.Account.UserID)
	if err != nil {
		t.Fatal(err)
	}
	first, err := uploadApprovedVersionForTest(service, ctx, skillhub.UploadVersionInput{SpaceID: space.SpaceID, Version: "1", Package: bytes.NewReader(skillPackageNamed(t, "participants")), CreatedBy: creator.Account.Name, UploadedByUserID: creator.Account.UserID})
	if err != nil {
		t.Fatal(err)
	}
	_, err = uploadApprovedVersionForTest(service, ctx, skillhub.UploadVersionInput{SpaceID: space.SpaceID, Version: "2", Package: bytes.NewReader(skillPackageNamed(t, "participants")), CreatedBy: updater.Account.Name, UploadedByUserID: updater.Account.UserID})
	if err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{AccountService: accountService, ProxyGateway: testProxyGateway(newClaweeOwnedAgentStore(accountService)), SkillHubService: service})
	login := loginClawee(t, router, updater.Account.Email, "passw0rd!", "participants-agent")
	if login.Status != http.StatusOK {
		t.Fatalf("login status = %d", login.Status)
	}
	request := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+login.AccessToken)
		router.ServeHTTP(recorder, req)
		return recorder
	}
	avatarPath := "/api/v1/app/skills/participant-avatar?skill_id=" + first.Skill.SkillID + "&user_id=" + creator.Account.UserID
	if response := request(avatarPath); response.Code != http.StatusNotFound {
		t.Fatalf("ungranted avatar status = %d", response.Code)
	}
	if _, err := service.SetSpaceMember(ctx, space.SpaceID, updater.Account.UserID, []string{skillhub.SpaceActionRead}, creator.Account.UserID, false); err != nil {
		t.Fatal(err)
	}
	response := request("/api/v1/app/skills?space_id=" + space.SpaceID)
	if response.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", response.Code, response.Body.String())
	}
	items := decodeAPIJSONResource[[]skillhub.PublishedItem](t, response.Body.Bytes())
	if len(items) != 1 || items[0].Creator == nil || items[0].Creator.Name != "创建者" || len(items[0].Contributors) != 1 || items[0].Contributors[0].Name != "更新者" || items[0].SpaceName != "产品技能" {
		t.Fatalf("participants = %#v", items)
	}
	response = request("/api/v1/app/skills?space_id=unknown-space")
	if response.Code != http.StatusOK || len(decodeAPIJSONResource[[]skillhub.PublishedItem](t, response.Body.Bytes())) != 0 {
		t.Fatalf("filtered list status = %d, body = %s", response.Code, response.Body.String())
	}
	response = request(avatarPath)
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "image/svg+xml" || response.Body.Len() == 0 {
		t.Fatalf("participant avatar status = %d", response.Code)
	}
	response = request("/api/v1/app/skills/participant-avatar?skill_id=" + first.Skill.SkillID + "&user_id=unrelated")
	if response.Code != http.StatusNotFound {
		t.Fatalf("unrelated avatar status = %d", response.Code)
	}
}
