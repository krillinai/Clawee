package businessdata

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const maxBatchRecords = 10000

func validProvider(provider string) bool {
	return provider == ProviderXiaohongshu || provider == ProviderDouyinAds || provider == ProviderBilibili
}

func validateBatch(provider string, startDate, endDate time.Time, batch *Batch) error {
	if batch == nil || !validProvider(provider) || startDate.After(endDate) || batch.RecordCount() > maxBatchRecords {
		return ErrInvalidBatch
	}
	if (provider != ProviderBilibili && batch.SourceName != "") || utf8.RuneCountInString(batch.SourceName) > 500 {
		return ErrInvalidBatch
	}
	if provider != ProviderXiaohongshu && provider != ProviderBilibili && (len(batch.Contents) > 0 || len(batch.ContentDailyMetrics) > 0 || len(batch.AccountDailyMetrics) > 0) {
		return ErrInvalidBatch
	}
	if provider == ProviderBilibili && (len(batch.ContentDailyMetrics) > 0 || len(batch.AccountDailyMetrics) > 0) {
		return ErrInvalidBatch
	}
	if provider != ProviderDouyinAds && (len(batch.Campaigns) > 0 || len(batch.CampaignDailyMetrics) > 0) {
		return ErrInvalidBatch
	}
	if provider != ProviderBilibili && (len(batch.BilibiliAccountSnapshots) > 0 || len(batch.BilibiliContentSnapshots) > 0) {
		return ErrInvalidBatch
	}
	for i := range batch.Contents {
		batch.Contents[i].ExternalContentID = strings.TrimSpace(batch.Contents[i].ExternalContentID)
		if err := validateID(batch.Contents[i].ExternalContentID); err != nil || utf8.RuneCountInString(batch.Contents[i].Title) > 500 {
			return ErrInvalidBatch
		}
	}
	for i := range batch.ContentDailyMetrics {
		metric := &batch.ContentDailyMetrics[i]
		metric.ExternalContentID = strings.TrimSpace(metric.ExternalContentID)
		if validateID(metric.ExternalContentID) != nil || !dateInRange(metric.StatDate, startDate, endDate) || anyNegative(metric.ExposureCount, metric.LikeCount, metric.FavoriteCount, metric.CommentCount, metric.ShareCount) {
			return ErrInvalidBatch
		}
	}
	for i := range batch.AccountDailyMetrics {
		metric := &batch.AccountDailyMetrics[i]
		if !dateInRange(metric.StatDate, startDate, endDate) || metric.NewFollowerCount < 0 {
			return ErrInvalidBatch
		}
	}
	for i := range batch.Campaigns {
		batch.Campaigns[i].ExternalCampaignID = strings.TrimSpace(batch.Campaigns[i].ExternalCampaignID)
		if validateID(batch.Campaigns[i].ExternalCampaignID) != nil || utf8.RuneCountInString(batch.Campaigns[i].Name) > 500 {
			return ErrInvalidBatch
		}
	}
	for i := range batch.CampaignDailyMetrics {
		metric := &batch.CampaignDailyMetrics[i]
		metric.ExternalCampaignID = strings.TrimSpace(metric.ExternalCampaignID)
		if validateID(metric.ExternalCampaignID) != nil || !dateInRange(metric.StatDate, startDate, endDate) || anyNegative(metric.SpendMinor, metric.ImpressionCount, metric.VideoPlayCount, metric.ClickCount) {
			return ErrInvalidBatch
		}
	}
	for _, snapshot := range batch.BilibiliAccountSnapshots {
		if snapshot.CapturedAt.IsZero() || snapshot.SnapshotDate.IsZero() || anyNegative(snapshot.FollowerCount, snapshot.FollowingCount, snapshot.PublishedCount) || !sameShanghaiDate(snapshot.SnapshotDate, snapshot.CapturedAt) {
			return ErrInvalidBatch
		}
	}
	for i := range batch.BilibiliContentSnapshots {
		snapshot := &batch.BilibiliContentSnapshots[i]
		snapshot.ExternalContentID = strings.TrimSpace(snapshot.ExternalContentID)
		if validateID(snapshot.ExternalContentID) != nil || snapshot.CapturedAt.IsZero() || snapshot.SnapshotDate.IsZero() || !sameShanghaiDate(snapshot.SnapshotDate, snapshot.CapturedAt) || anyNegative(snapshot.ViewCount, snapshot.DanmakuCount, snapshot.ReplyCount, snapshot.FavoriteCount, snapshot.CoinCount, snapshot.ShareCount, snapshot.LikeCount) {
			return ErrInvalidBatch
		}
	}
	return nil
}

func sameShanghaiDate(date, capturedAt time.Time) bool {
	location, err := time.LoadLocation(Timezone)
	if err != nil {
		return false
	}
	return dateKey(date.In(location)) == dateKey(capturedAt.In(location))
}

func validateID(value string) error {
	if value == "" || utf8.RuneCountInString(value) > 256 {
		return fmt.Errorf("invalid external id")
	}
	return nil
}

func dateInRange(value, start, end time.Time) bool {
	date := dateKey(value)
	return date >= dateKey(start) && date <= dateKey(end)
}

func dateKey(value time.Time) string { return value.Format("2006-01-02") }

func anyNegative(values ...int64) bool {
	for _, value := range values {
		if value < 0 {
			return true
		}
	}
	return false
}
