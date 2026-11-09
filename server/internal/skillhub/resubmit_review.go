package skillhub

import (
	"context"
	"strings"
)

// 原版本重新送审已关闭，修订必须通过上传新版本发起。
func (s *Service) ResubmitReview(_ context.Context, skillID, versionID, requestID, userID string) (Version, error) {
	if strings.TrimSpace(skillID) == "" || strings.TrimSpace(versionID) == "" || strings.TrimSpace(requestID) == "" || strings.TrimSpace(userID) == "" {
		return Version{}, ErrInvalidRequest
	}
	return Version{}, ErrReviewForbidden
}
