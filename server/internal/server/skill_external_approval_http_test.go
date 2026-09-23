package server_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/dingtalk"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

type fakeApprovalClient struct {
	originator string
	template   string
	fields     []dingtalk.ApprovalField
	createErr  error
	detail     dingtalk.ApprovalDetail
}

func (f *fakeApprovalClient) CreateApproval(_ context.Context, originator, template string, fields []dingtalk.ApprovalField) (string, error) {
	f.originator, f.template, f.fields = originator, template, fields
	if f.createErr != nil {
		return "", f.createErr
	}
	return "instance-1", nil
}
func (f *fakeApprovalClient) GetApproval(_ context.Context, instanceID string) (dingtalk.ApprovalDetail, error) {
	if f.detail.ProcessInstanceID != "" {
		return f.detail, nil
	}
	return dingtalk.ApprovalDetail{ProcessInstanceID: instanceID, ProcessCode: "PROC-1", Status: "COMPLETED", Result: "agree"}, nil
}

func TestExternalSkillApprovalHTTPFlow(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	svc := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	client := &fakeApprovalClient{}
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, RBACService: rbacService, SkillHubService: svc, DingTalkAuth: server.DingTalkAuthOptions{OAEnabled: true, ProviderKey: "default", OAClient: client, PublicBaseURL: "https://gateway.test"}})
	admin := register(t, router, `{"email":"oa-admin@example.com","password":"passw0rd!"}`)
	adminID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", admin, http.StatusOK), "data", "account", "user_id")
	config := `{"space_id":"skillspace_default","approval_provider":"dingtalk","external_approval_template_id":"PROC-1"}`
	doJSON(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approval", config, admin, http.StatusNoContent)
	body, contentType := skillUploadBody(t, map[string]string{"version": "1"}, true)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/versions", body)
	req.Header.Set("Content-Type", contentType)
	req.AddCookie(adminCookie(t, admin))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload: %s", rec.Body.String())
	}
	created := decodeAPIJSONResource[skillhub.MutationResult](t, rec.Body.Bytes())
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodGet, "/api/v1/app/skills/approval-detail?skill_id="+created.Skill.SkillID, "", nil), http.StatusUnauthorized, "unauthorized")
	preview := doJSON(t, router, http.MethodGet, "/api/v1/app/skills/approval-detail?skill_id="+created.Skill.SkillID, "", admin, http.StatusOK)
	if preview["data"].(map[string]any)["skill"].(map[string]any)["skill_id"] != created.Skill.SkillID {
		t.Fatalf("approval preview: %#v", preview)
	}
	payload := `{"skill_id":"` + created.Skill.SkillID + `","version_id":"` + created.Version.VersionID + `"}`
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skills/current-version", payload, admin), http.StatusConflict, "skill_approval_required")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/current-version/own", payload, admin), http.StatusConflict, "skill_approval_required")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", `{"skill_id":"`+created.Skill.SkillID+`","version_id":"`+created.Version.VersionID+`","decision":"approved"}`, admin), http.StatusForbidden, "skill_review_forbidden")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/submit-approval", payload, nil), http.StatusUnauthorized, "unauthorized")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/submit-approval", payload, admin), http.StatusConflict, "dingtalk_not_bound")
	if err := accountService.BindExternalIdentity(ctx, adminID, accounts.AccountIdentity{ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-1", ExternalUserID: "staff-1", VerifiedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/submit-approval", payload, admin, http.StatusOK)
	forged := httptest.NewRequest(http.MethodPost, "/api/v1/integrations/dingtalk/skill-approval/callback?timestamp=123&nonce=nonce&signature=invalid", strings.NewReader(`{"encrypt":"fake"}`))
	forged.Header.Set("Content-Type", "application/json")
	forgedResponse := httptest.NewRecorder()
	router.ServeHTTP(forgedResponse, forged)
	if forgedResponse.Code != http.StatusForbidden {
		t.Fatalf("forged callback status: %d", forgedResponse.Code)
	}
	if client.originator != "staff-1" || client.template != "PROC-1" || len(client.fields) != 5 {
		t.Fatalf("OA request: %#v", client)
	}
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/submit-approval", payload, admin), http.StatusConflict, "skill_external_approval_conflict")
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPut, "/api/v1/admin/skill-spaces/approval", `{"space_id":"skillspace_default","approval_provider":"dingtalk","external_approval_template_id":"PROC-2"}`, admin), http.StatusConflict, "skill_external_approval_conflict")
	doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/sync-approval", payload, admin, http.StatusOK)
	doJSON(t, router, http.MethodPut, "/api/v1/admin/skills/current-version", payload, admin, http.StatusOK)
	client.createErr = &dingtalk.APIError{Step: "create_approval", Code: "upstream_error", HTTPStatus: http.StatusBadGateway}
	body, contentType = skillUploadBody(t, map[string]string{"version": "2"}, true)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/admin/skills/versions", body)
	req.Header.Set("Content-Type", contentType)
	req.AddCookie(adminCookie(t, admin))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("second upload: %s", rec.Body.String())
	}
	second := decodeAPIJSONResource[skillhub.MutationResult](t, rec.Body.Bytes())
	secondPayload := `{"skill_id":"` + second.Skill.SkillID + `","version_id":"` + second.Version.VersionID + `"}`
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/submit-approval", secondPayload, admin), http.StatusBadGateway, "oa_submission_failed")
	instance, err := svc.GetApproval(ctx, second.Skill.SkillID, second.Version.VersionID)
	if err != nil || instance.Status != "uncertain" {
		t.Fatalf("5xx submission state: %#v %v", instance, err)
	}
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/submit-approval", secondPayload, admin), http.StatusConflict, "skill_external_approval_conflict")
	if _, err = accountService.UnbindExternalIdentity(ctx, adminID, "dingtalk", "default", "passw0rd!"); err != nil {
		t.Fatal(err)
	}
	if err = accountService.BindExternalIdentity(ctx, adminID, accounts.AccountIdentity{ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-2", ExternalUserID: "staff-2", VerifiedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	client.detail = dingtalk.ApprovalDetail{
		ProcessInstanceID: "instance-2", ProcessCode: "PROC-1", OriginatorUserID: "other-staff", Status: "COMPLETED", Result: "agree",
		FormComponentValues: []dingtalk.ApprovalField{{Name: "包 SHA-256", Value: second.Version.PackageSHA256}},
	}
	resolvePayload := `{"application_id":"` + instance.ID + `","resolution":"bind_instance","provider_instance_id":"instance-2"}`
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/resolve-approval", resolvePayload, admin), http.StatusConflict, "skill_external_approval_conflict")
	client.detail.OriginatorUserID = "staff-1"
	client.detail.FormComponentValues[0].Value = "wrong-sha"
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/resolve-approval", resolvePayload, admin), http.StatusConflict, "skill_external_approval_conflict")
	client.detail.FormComponentValues[0].Value = second.Version.PackageSHA256
	doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/resolve-approval", resolvePayload, admin, http.StatusOK)
	doJSON(t, router, http.MethodPut, "/api/v1/admin/skills/current-version", secondPayload, admin, http.StatusOK)
}
