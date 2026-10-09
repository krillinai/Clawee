package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func skillReviewInputForTest(ctx context.Context, service *skillhub.Service, skillID, versionID string) skillhub.ReviewInput {
	value := 3
	input := skillhub.ReviewInput{RequestID: "missing", Scores: &skillhub.ReviewScores{ScenarioValue: &value, ResultEffectiveness: &value, EaseOfUse: &value, ReuseValue: &value}}
	if detail, err := service.GetAdmin(ctx, skillID); err == nil {
		for _, version := range detail.Versions {
			if version.VersionID == versionID && version.LocalApproval != nil {
				input.RequestID = version.LocalApproval.RequestID
			}
		}
	}
	return input
}

func reviewVersionForTest(service *skillhub.Service, ctx context.Context, skillID, versionID, reviewer string, approve bool, comment string) (skillhub.Version, error) {
	return service.ReviewVersion(ctx, skillID, versionID, reviewer, approve, comment, skillReviewInputForTest(ctx, service, skillID, versionID))
}

func skillReviewBodyForTest(t *testing.T, service *skillhub.Service, result skillhub.MutationResult, decision, comment string, responses ...map[string]any) string {
	t.Helper()
	requestID := "missing"
	if service != nil {
		requestID = skillReviewInputForTest(context.Background(), service, result.Skill.SkillID, result.Version.VersionID).RequestID
	}
	if len(responses) == 1 {
		for _, item := range responses[0]["data"].(map[string]any)["versions"].([]any) {
			version := item.(map[string]any)
			if version["version_id"] == result.Version.VersionID {
				requestID = version["local_approval"].(map[string]any)["request_id"].(string)
			}
		}
	}
	body, err := json.Marshal(map[string]any{"skill_id": result.Skill.SkillID, "version_id": result.Version.VersionID, "request_id": requestID, "decision": decision, "comment": comment, "scores": map[string]int{"scenario_value": 3, "result_effectiveness": 3, "ease_of_use": 3, "reuse_value": 3}})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestSkillManualReviewHTTPContractAndResubmit(t *testing.T) {
	ctx := context.Background()
	accountService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	service := skillhub.NewService(skillhub.Config{Store: skillhub.NewMemoryStore(), PackageRoot: t.TempDir()})
	router := newTestRouter(t, server.Options{ProxyGateway: testProxyGateway(mcpgateway.NewMemoryStore()), AccountService: accountService, RBACService: rbacService, SkillHubService: service})
	writer := register(t, router, `{"email":"manual-writer@example.com","password":"passw0rd!"}`)
	reviewer := register(t, router, `{"email":"manual-reviewer@example.com","password":"passw0rd!"}`)
	writerID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", writer, http.StatusOK), "data", "account", "user_id")
	reviewerID := nestedString(t, doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", reviewer, http.StatusOK), "data", "account", "user_id")
	role := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{"code":"manual_reviewer","name":"人工评审","permission_codes":["console:skill:read","console:skill:version_upload"]}`, writer, http.StatusCreated)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+reviewerID+`","role_id":"`+nestedString(t, role, "data", "role_id")+`"}`, writer, http.StatusCreated)
	reviewer = loginCookies(t, router, `{"email":"manual-reviewer@example.com","password":"passw0rd!"}`)
	for _, id := range []string{writerID, reviewerID} {
		if _, err := service.SetSpaceMember(ctx, skillhub.DefaultSpaceID, id, []string{skillhub.SpaceActionRead}, writerID, false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := service.SetSpaceApprovers(ctx, skillhub.DefaultSpaceID, "local", "", []string{reviewerID}, true, writerID); err != nil {
		t.Fatal(err)
	}
	result, err := service.UploadVersion(ctx, skillhub.UploadVersionInput{Version: "1", CreatedBy: writerID, UploadedByUserID: writerID, Origin: "admin_upload", Package: bytes.NewReader(skillPackageNamed(t, "manual-http"))})
	if err != nil {
		t.Fatal(err)
	}
	input := skillReviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
	base := map[string]any{"skill_id": result.Skill.SkillID, "version_id": result.Version.VersionID, "request_id": input.RequestID, "decision": "approved", "scores": map[string]any{"scenario_value": 1, "result_effectiveness": 1, "ease_of_use": 1, "reuse_value": 1}}
	marshal := func(payload map[string]any) string {
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		return string(body)
	}
	for _, name := range []string{"missing_request", "blank_request", "missing_scores", "null_scores", "missing_dimension", "null_dimension", "fraction", "string_score", "zero", "six", "reject_blank", "comment_long", "reviewer_forged", "time_forged", "standard_forged", "summary_forged", "unknown_score"} {
		t.Run(name, func(t *testing.T) {
			var payload map[string]any
			if err := json.Unmarshal([]byte(marshal(base)), &payload); err != nil {
				t.Fatal(err)
			}
			scores := payload["scores"].(map[string]any)
			switch name {
			case "missing_request":
				delete(payload, "request_id")
			case "blank_request":
				payload["request_id"] = " \t"
			case "missing_scores":
				delete(payload, "scores")
			case "null_scores":
				payload["scores"] = nil
			case "missing_dimension":
				delete(scores, "ease_of_use")
			case "null_dimension":
				scores["reuse_value"] = nil
			case "fraction":
				scores["scenario_value"] = 1.5
			case "string_score":
				scores["scenario_value"] = "3"
			case "zero":
				scores["scenario_value"] = 0
			case "six":
				scores["scenario_value"] = 6
			case "reject_blank":
				payload["decision"] = "rejected"
				payload["comment"] = " \n\t"
			case "comment_long":
				payload["comment"] = strings.Repeat("中", 2001)
			case "reviewer_forged":
				payload["reviewer"] = "writer"
			case "time_forged":
				payload["decided_at"] = "2026-10-09"
			case "standard_forged":
				payload["scoring_standard_version"] = "fake"
			case "summary_forged":
				payload["score_summary"] = map[string]int{"total": 20}
			case "unknown_score":
				scores["total"] = 20
			}
			assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", marshal(payload), reviewer), http.StatusBadRequest, "invalid_request")
		})
	}
	wrong := marshal(base)
	wrong = strings.Replace(wrong, input.RequestID, "old-request", 1)
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", wrong, reviewer), http.StatusConflict, "conflict")
	base["decision"] = "rejected"
	base["comment"] = "需要修订"
	base["scores"] = map[string]int{"scenario_value": 5}
	rejected := doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", marshal(base), reviewer, http.StatusOK)["data"].(map[string]any)["local_approval"].(map[string]any)
	if _, exists := rejected["score_summary"]; exists {
		t.Fatal("驳回返回正式汇总")
	}
	resubmit := map[string]any{"skill_id": result.Skill.SkillID, "version_id": result.Version.VersionID, "request_id": input.RequestID}
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/resubmit-review", marshal(resubmit), reviewer), http.StatusForbidden, "skill_review_forbidden")
	newVersion := doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/resubmit-review", marshal(resubmit), writer, http.StatusOK)["data"].(map[string]any)
	newRequest := newVersion["local_approval"].(map[string]any)["request_id"].(string)
	if newRequest == input.RequestID {
		t.Fatal("重提复用旧请求")
	}
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/resubmit-review", marshal(resubmit), writer), http.StatusConflict, "conflict")
	base["decision"] = "approved"
	base["comment"] = ""
	base["scores"] = map[string]int{"scenario_value": 5, "result_effectiveness": 5, "ease_of_use": 5, "reuse_value": 5}
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", marshal(base), reviewer), http.StatusConflict, "conflict")
	base["request_id"] = newRequest
	approved := doJSON(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", marshal(base), reviewer, http.StatusOK)["data"].(map[string]any)["local_approval"].(map[string]any)
	if approved["score_summary"].(map[string]any)["total"] != float64(20) || approved["content_digest"] != result.Version.PackageSHA256 || approved["scoring_standard_version"] != "manual-v1" {
		t.Fatalf("HTTP 汇总字段: %#v", approved)
	}
	assertSkillError(t, sourceJSONRequest(t, router, http.MethodPost, "/api/v1/admin/skills/versions/review", marshal(base), reviewer), http.StatusConflict, "conflict")
}
