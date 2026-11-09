package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"sync"

	"github.com/krillinai/Clawee/server/internal/skillhub"
)

var p9FixtureServices sync.Map

func newTestSkillHubService(cfg skillhub.Config) *skillhub.Service {
	cfg.ReviewAgentID = "p9-test-agent"
	service := skillhub.NewService(cfg)
	service.SetAIReviewIdentityLookup(func(context.Context, string, string) error { return nil })
	p9FixtureServices.Store(service, true)
	return service
}

// 既有人工/发布用例显式准备AI通过，P9授权用例使用真实Agent登录和原始构造函数。
func completeFixtureSkillAI(service *skillhub.Service, skillID, versionID string) error {
	ctx := context.Background()
	if service == nil {
		p9FixtureServices.Range(func(key, value any) bool {
			candidate := key.(*skillhub.Service)
			if _, err := candidate.GetAdmin(ctx, skillID); err == nil {
				service = candidate
				return false
			}
			return true
		})
	}
	if service == nil {
		return nil
	}
	detail, err := service.GetAdmin(ctx, skillID)
	if err != nil {
		return err
	}
	for _, version := range detail.Versions {
		if version.VersionID != versionID || version.LocalApproval == nil || version.LocalApproval.AIReview == nil || version.LocalApproval.AIReview.Status != "pending" {
			continue
		}
		review := version.LocalApproval.AIReview
		runner := version.LocalApproval.Approvers[0].UserID
		service.SetAIReviewIdentityLookup(func(context.Context, string, string) error { return nil })
		if _, err = service.ClaimAIReview(ctx, version.LocalApproval.RequestID, runner, "p9-test-agent", skillhub.AIReviewClaimInput{AttemptID: review.AttemptID, ReviewSkillVersion: "test-v1", ReviewSkillSHA256: strings.Repeat("a", 64)}); err != nil {
			return err
		}
		_, err = service.SubmitAIReviewResult(ctx, version.LocalApproval.RequestID, runner, "p9-test-agent", skillhub.AIReviewResultInput{AttemptID: review.AttemptID, PackageSHA256: version.PackageSHA256, Report: json.RawMessage(`{"conclusion":"recommend_approve","summary":"测试静态分析通过","findings":[]}`)})
		return err
	}
	return nil
}
