package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

const skillPermissionCheckPath = "/api/v1/app/skills/permission-check"
const skillPermissionCheckCode = "console:skill:permission_check"

type skillPermissionFixture struct {
	router   http.Handler
	accounts *accounts.Service
	rbac     *rbac.Service
	skills   *skillhub.Service
	store    *skillPermissionFaultStore
	users    *skillPermissionAccountStore
	callerID string
	userID   string
	spaceID  string
	skillID  string
	token    string
}

func newSkillPermissionFixture(t *testing.T) skillPermissionFixture {
	t.Helper()
	ctx := context.Background()
	users := &skillPermissionAccountStore{MemoryStore: accounts.NewMemoryStore()}
	accountService := newTestAccountService(users)
	caller, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "skill-check-runner@example.com", Name: "权限检查执行端", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	user, err := accountService.Register(ctx, accounts.RegisterRequest{Email: "skill-check-user@example.com", Name: "任务发起者", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	store := &skillPermissionFaultStore{MemoryStore: skillhub.NewMemoryStore()}
	packageRoot := t.TempDir()
	service := newTestSkillHubService(skillhub.Config{Store: store, PackageRoot: packageRoot})
	seedService := newTestSkillHubService(skillhub.Config{Store: store.MemoryStore, PackageRoot: packageRoot})
	space, err := service.CreateSpace(ctx, "权限检查测试空间", "", caller.Account.UserID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := uploadApprovedVersionForTest(seedService, ctx, skillhub.UploadVersionInput{
		SpaceID: space.SpaceID, Version: "1.0.0", Package: bytes.NewReader(skillPackageNamed(t, "permission-demo")), CreatedBy: caller.Account.UserID,
	})
	if err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{
		AccountService: accountService, RBACService: rbacService, SkillHubService: service,
		ProxyGateway: testProxyGateway(newClaweeOwnedAgentStore(accountService)),
	})
	login := loginClawee(t, router, caller.Account.Email, "passw0rd!", "skill-check-agent")
	if login.Status != http.StatusOK {
		t.Fatalf("runner login status=%d code=%s", login.Status, login.ErrorCode)
	}
	return skillPermissionFixture{
		router: router, accounts: accountService, rbac: rbacService, skills: service, store: store, users: users,
		callerID: caller.Account.UserID, userID: user.Account.UserID, spaceID: space.SpaceID, skillID: result.Skill.SkillID, token: login.AccessToken,
	}
}

func (fixture skillPermissionFixture) grantCaller(t *testing.T, code string) {
	t.Helper()
	ctx := context.Background()
	role, err := fixture.rbac.CreateRole(ctx, fixture.callerID, rbac.CreateRoleInput{Name: "权限检查调用者", Permissions: []string{code}})
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.rbac.AssignAccountRole(ctx, fixture.callerID, fixture.callerID, role.RoleID); err != nil {
		t.Fatal(err)
	}
}

func (fixture skillPermissionFixture) request(t *testing.T, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, skillPermissionCheckPath, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	fixture.router.ServeHTTP(recorder, request)
	return recorder
}

func (fixture skillPermissionFixture) body(t *testing.T, userID, skillID string) string {
	t.Helper()
	encoded, err := json.Marshal(map[string]string{"user_id": userID, "skill_id": skillID})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestSkillPermissionCheckRequiresAuthenticatedAuthorizedCaller(t *testing.T) {
	fixture := newSkillPermissionFixture(t)
	body := fixture.body(t, fixture.userID, fixture.skillID)
	assertSkillError(t, fixture.request(t, "", body), http.StatusUnauthorized, "unauthorized")
	assertSkillError(t, fixture.request(t, "invalid-token", body), http.StatusUnauthorized, "unauthorized")
	assertSkillError(t, fixture.request(t, fixture.token, body), http.StatusForbidden, "forbidden")
	fixture.grantCaller(t, rbac.PermissionSkillRead)
	assertSkillError(t, fixture.request(t, fixture.token, body), http.StatusForbidden, "forbidden")
	fixture.grantCaller(t, skillPermissionCheckCode)
	assertSkillPermissionResult(t, fixture.request(t, fixture.token, body), fixture.userID, fixture.skillID, false, "skill_read_denied")
}

func TestSkillPermissionCheckUsesTargetAccountAndCurrentSpaceGrant(t *testing.T) {
	fixture := newSkillPermissionFixture(t)
	fixture.grantCaller(t, skillPermissionCheckCode)
	ctx := context.Background()
	body := fixture.body(t, fixture.userID, fixture.skillID)
	assertSkillPermissionResult(t, fixture.request(t, fixture.token, body), fixture.userID, fixture.skillID, false, "skill_read_denied")
	if _, err := fixture.skills.SetSpaceMember(ctx, fixture.spaceID, fixture.userID, []string{skillhub.SpaceActionRead}, fixture.callerID, false); err != nil {
		t.Fatal(err)
	}
	assertSkillPermissionResult(t, fixture.request(t, fixture.token, body), fixture.userID, fixture.skillID, true, "allowed")
	if err := fixture.skills.RemoveSpaceMember(ctx, fixture.spaceID, fixture.callerID); err != nil {
		t.Fatal(err)
	}
	assertSkillPermissionResult(t, fixture.request(t, fixture.token, body), fixture.userID, fixture.skillID, true, "allowed")
	if _, err := fixture.skills.ClearCurrentVersion(ctx, fixture.skillID); err != nil {
		t.Fatal(err)
	}
	assertSkillPermissionResult(t, fixture.request(t, fixture.token, body), fixture.userID, fixture.skillID, true, "allowed")
	trimmedBody := fixture.body(t, "  "+fixture.userID+"  ", "  "+fixture.skillID+"  ")
	assertSkillPermissionResult(t, fixture.request(t, fixture.token, trimmedBody), fixture.userID, fixture.skillID, true, "allowed")
	missingBody := fixture.body(t, fixture.userID, "missing-skill")
	assertSkillPermissionResult(t, fixture.request(t, fixture.token, missingBody), fixture.userID, "missing-skill", false, "skill_read_denied")
	if err := fixture.skills.RemoveSpaceMember(ctx, fixture.spaceID, fixture.userID); err != nil {
		t.Fatal(err)
	}
	assertSkillPermissionResult(t, fixture.request(t, fixture.token, body), fixture.userID, fixture.skillID, false, "skill_read_denied")
}

func TestSkillPermissionCheckAcceptsSkillManageCaller(t *testing.T) {
	fixture := newSkillPermissionFixture(t)
	fixture.grantCaller(t, rbac.PermissionSkillManage)
	body := fixture.body(t, fixture.userID, fixture.skillID)
	assertSkillPermissionResult(t, fixture.request(t, fixture.token, body), fixture.userID, fixture.skillID, false, "skill_read_denied")
}

func TestSkillPermissionCheckRejectsUnavailableTargetAccountAndStoreFailure(t *testing.T) {
	fixture := newSkillPermissionFixture(t)
	fixture.grantCaller(t, skillPermissionCheckCode)
	ctx := context.Background()
	if _, err := fixture.skills.SetSpaceMember(ctx, fixture.spaceID, fixture.userID, []string{skillhub.SpaceActionRead}, fixture.callerID, false); err != nil {
		t.Fatal(err)
	}
	body := fixture.body(t, fixture.userID, fixture.skillID)
	fixture.store.err = errors.New("private database failure")
	recorder := fixture.request(t, fixture.token, body)
	assertSkillError(t, recorder, http.StatusInternalServerError, "internal_error")
	if strings.Contains(recorder.Body.String(), "private database failure") {
		t.Fatal("store error details leaked")
	}
	fixture.store.err = nil
	fixture.users.failedUserID = fixture.userID
	assertSkillError(t, fixture.request(t, fixture.token, body), http.StatusInternalServerError, "internal_error")
	fixture.users.failedUserID = ""
	if _, err := fixture.accounts.UpdateAccountStatus(ctx, fixture.userID, accounts.StatusDisabled); err != nil {
		t.Fatal(err)
	}
	assertSkillPermissionResult(t, fixture.request(t, fixture.token, body), fixture.userID, fixture.skillID, false, "account_unavailable")
	missingBody := fixture.body(t, "missing-user", fixture.skillID)
	assertSkillPermissionResult(t, fixture.request(t, fixture.token, missingBody), "missing-user", fixture.skillID, false, "account_unavailable")
}

func TestSkillPermissionCheckStrictRequestValidation(t *testing.T) {
	fixture := newSkillPermissionFixture(t)
	fixture.grantCaller(t, skillPermissionCheckCode)
	validBody := fixture.body(t, fixture.userID, fixture.skillID)
	for _, body := range []string{
		`{}`, `{"user_id":"u"}`, `{"skill_id":"s"}`, `{"user_id":" ","skill_id":"s"}`,
		`{"user_id":"u","skill_id":" "}`, `{"user_id":1,"skill_id":"s"}`, `null`,
		`{"user_id":"u","skill_id":"s","action":"execute"}`, validBody + `{}`, `{"user_id":`,
		fixture.body(t, strings.Repeat("u", 129), fixture.skillID),
		fixture.body(t, fixture.userID, strings.Repeat("s", 129)), strings.Repeat(" ", 16*1024) + validBody,
	} {
		t.Run(body[:min(len(body), 60)], func(t *testing.T) {
			assertSkillError(t, fixture.request(t, fixture.token, body), http.StatusBadRequest, "invalid_request")
		})
	}
}

func assertSkillPermissionResult(t *testing.T, recorder *httptest.ResponseRecorder, userID, skillID string, allowed bool, reason string) {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("permission check status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("permission check must not be cached")
	}
	result := decodeAPIJSONResource[struct {
		UserID  string `json:"user_id"`
		SkillID string `json:"skill_id"`
		Allowed bool   `json:"allowed"`
		Reason  string `json:"reason"`
	}](t, recorder.Body.Bytes())
	if result.UserID != userID || result.SkillID != skillID || result.Allowed != allowed || result.Reason != reason {
		t.Fatalf("unexpected permission result: %#v", result)
	}
}

type skillPermissionFaultStore struct {
	*skillhub.MemoryStore
	err error
}

func (store *skillPermissionFaultStore) CheckSkillAccess(ctx context.Context, userID, skillID, action string) error {
	if store.err != nil {
		return store.err
	}
	return store.MemoryStore.CheckSkillAccess(ctx, userID, skillID, action)
}

type skillPermissionAccountStore struct {
	*accounts.MemoryStore
	failedUserID string
}

func (store *skillPermissionAccountStore) GetAccount(ctx context.Context, userID string) (accounts.Account, error) {
	if userID == store.failedUserID {
		return accounts.Account{}, errors.New("private account store failure")
	}
	return store.MemoryStore.GetAccount(ctx, userID)
}
