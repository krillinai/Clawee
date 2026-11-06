package skillhub

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAIReviewRulePublishedSelection(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(map[bool]string{false: "memory", true: "postgres"}[postgres], func(t *testing.T) {
			ctx := context.Background()
			service, _, _ := aiTestService(t, postgres)
			active := true
			service.SetAIReviewIdentityLookup(func(_ context.Context, user, agent string) error {
				if !active || agent != "" && (user != "runner" || agent != "agent-review") {
					return ErrReviewForbidden
				}
				return nil
			})
			checkMissing := func() {
				t.Helper()
				if rule, err := service.GetAIReviewRule(ctx, "runner", "agent-review"); err != nil || rule != nil {
					t.Fatalf("无已发布规则应明确允许本地回退: %+v %v", rule, err)
				}
			}
			checkMissing()
			for _, actor := range [][2]string{{"runner", "other-agent"}, {"other", "agent-review"}} {
				if _, err := service.GetAIReviewRule(ctx, actor[0], actor[1]); !errors.Is(err, ErrReviewForbidden) {
					t.Fatalf("非指定身份不得读取规则或触发回退: %v", err)
				}
			}
			active = false
			if _, err := service.GetAIReviewRule(ctx, "runner", "agent-review"); !errors.Is(err, ErrReviewForbidden) {
				t.Fatalf("失活身份不得触发回退: %v", err)
			}
			active = true
			upload := func(number string) MutationResult {
				t.Helper()
				result, err := service.UploadVersion(ctx, UploadVersionInput{Version: number, CreatedBy: "writer", UploadedByUserID: "writer", Origin: "admin_upload", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("skill-review") + "\n规则版本" + number}}))})
				if err != nil {
					t.Fatal(err)
				}
				return result
			}
			publish := func(result MutationResult) {
				t.Helper()
				input := reviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
				for _, user := range []string{"alice", "bob"} {
					if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, user, true, "规则发布", input); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := service.SetCurrentVersion(ctx, result.Skill.SkillID, result.Version.VersionID); err != nil {
					t.Fatal(err)
				}
			}
			first := upload("hub-1")
			checkMissing()
			publish(first)
			rule, err := service.GetAIReviewRule(ctx, "runner", "agent-review")
			if err != nil || rule == nil || rule.Version != "hub-1" || rule.Text != validSkillMD("skill-review")+"\n规则版本hub-1" {
				t.Fatalf("必须读取已发布正文与发布版本: %+v %v", rule, err)
			}
			second := upload("hub-2")
			rule, err = service.GetAIReviewRule(ctx, "runner", "agent-review")
			if err != nil || rule == nil || rule.Version != "hub-1" {
				t.Fatalf("待审新版本不能影响规则: %+v %v", rule, err)
			}
			publish(second)
			rule, err = service.GetAIReviewRule(ctx, "runner", "agent-review")
			if err != nil || rule == nil || rule.Version != "hub-2" {
				t.Fatalf("发布后新任务读取新规则: %+v %v", rule, err)
			}
			if err := service.RemoveSpaceMember(ctx, DefaultSpaceID, "runner"); err != nil {
				t.Fatal(err)
			}
			if _, err := service.GetAIReviewRule(ctx, "runner", "agent-review"); err == nil {
				t.Fatal("无规则空间权限不能误判为规则缺失")
			}
			if _, err := service.SetSpaceMember(ctx, DefaultSpaceID, "runner", []string{SpaceActionRead}, "writer", false); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(service.packageRoot, second.Version.PackagePath), []byte("损坏的规则包"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := service.GetAIReviewRule(ctx, "runner", "agent-review"); err == nil {
				t.Fatal("包损坏不能触发本地回退")
			}
			if _, err := service.ClearCurrentVersion(ctx, first.Skill.SkillID); err != nil {
				t.Fatal(err)
			}
			checkMissing()
		})
	}
}
