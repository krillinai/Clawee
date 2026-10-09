package skillhub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestManualReviewContractRegression(t *testing.T) {
	for _, operation := range []string{"approve_without_scores", "reject_without_comment", "read_request_binding"} {
		t.Run(operation, func(t *testing.T) {
			ctx := context.Background()
			service := NewService(Config{Store: NewMemoryStore(), PackageRoot: t.TempDir()})
			if _, err := service.SetSpaceApprovers(ctx, DefaultSpaceID, "local", "", []string{"reviewer"}, true, "writer"); err != nil {
				t.Fatal(err)
			}
			result, err := service.UploadVersion(ctx, UploadVersionInput{Version: "1", CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("manual-contract")}}))})
			if err != nil {
				t.Fatal(err)
			}
			if operation != "read_request_binding" {
				if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, "reviewer", operation == "approve_without_scores", " \t"); !errors.Is(err, ErrInvalidRequest) {
					t.Fatalf("无新版审批载荷不能写入: %v", err)
				}
				return
			}
			detail, err := service.GetAdmin(ctx, result.Skill.SkillID)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(detail.Versions[0].LocalApproval)
			if err != nil {
				t.Fatal(err)
			}
			var response map[string]any
			if err := json.Unmarshal(encoded, &response); err != nil {
				t.Fatal(err)
			}
			if response["request_id"] == nil || response["request_id"] == "" || response["content_digest"] != result.Version.PackageSHA256 || response["scoring_standard_version"] != "manual-v1" {
				t.Fatalf("读取缺少轮次、摘要或新请求标准: %s", encoded)
			}
		})
	}
}
