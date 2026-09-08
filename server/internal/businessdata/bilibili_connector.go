package businessdata

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const bilibiliArchivePageSize = 50

type CredentialProvider interface {
	AccessToken(context.Context, string) (string, error)
}

type BilibiliConnector struct {
	credentials CredentialProvider
	client      BilibiliClient
	clock       func() time.Time
}

func NewBilibiliConnector(credentials CredentialProvider, client BilibiliClient) *BilibiliConnector {
	return &BilibiliConnector{credentials: credentials, client: client, clock: time.Now}
}

func (c *BilibiliConnector) Provider() string { return ProviderBilibili }

func (c *BilibiliConnector) Pull(ctx context.Context, source Source, _ PullRequest) (Batch, error) {
	if c == nil || c.credentials == nil || c.client == nil || source.SourceID == "" {
		return Batch{}, ErrInvalidRequest
	}
	accessToken, err := c.credentials.AccessToken(ctx, source.SourceID)
	if err != nil {
		return Batch{}, err
	}
	account, err := c.client.AccountInfo(ctx, accessToken)
	if err != nil {
		return Batch{}, err
	}
	if strings.TrimSpace(account.OpenID) == "" || strings.TrimSpace(account.OpenID) != strings.TrimSpace(source.ExternalAccountID) {
		return Batch{}, ErrBilibiliReauthRequired
	}
	stats, err := c.client.UserStat(ctx, accessToken)
	if err != nil {
		return Batch{}, err
	}
	archives := make([]BilibiliArchive, 0)
	for page := 1; ; page++ {
		items, err := c.client.Archives(ctx, accessToken, page, bilibiliArchivePageSize)
		if err != nil {
			return Batch{}, err
		}
		archives = append(archives, items...)
		if len(items) < bilibiliArchivePageSize {
			break
		}
	}
	if 1+int64(len(archives)) > maxBatchRecords {
		return Batch{}, ErrInvalidBatch
	}
	capturedAt := c.clock().UTC()
	snapshotDate, err := shanghaiNaturalDate(capturedAt)
	if err != nil {
		return Batch{}, err
	}
	batch := Batch{
		SourceName: strings.TrimSpace(account.Name),
		Contents:   make([]Content, 0, len(archives)),
		BilibiliAccountSnapshots: []BilibiliAccountSnapshot{{
			SnapshotDate: snapshotDate, CapturedAt: capturedAt, FollowerCount: stats.Follower,
			FollowingCount: stats.Following, PublishedCount: stats.ArcPassedTotal,
		}},
		BilibiliContentSnapshots: make([]BilibiliContentSnapshot, 0, len(archives)),
	}
	for _, archive := range archives {
		resourceID := strings.TrimSpace(archive.ResourceID)
		var publishedAt *time.Time
		if archive.PTime > 0 {
			value := time.Unix(archive.PTime, 0).UTC()
			publishedAt = &value
		}
		batch.Contents = append(batch.Contents, Content{
			ExternalContentID: resourceID, Title: truncateRunes(archive.Title, 500), ContentType: "video",
			Status: strconv.FormatInt(archive.State, 10), PublishedAt: publishedAt,
		})
		metric, err := c.client.ArchiveStat(ctx, accessToken, resourceID)
		if errors.Is(err, ErrBilibiliContentMissing) {
			continue
		}
		if err != nil {
			return Batch{}, err
		}
		batch.BilibiliContentSnapshots = append(batch.BilibiliContentSnapshots, BilibiliContentSnapshot{
			ExternalContentID: resourceID, SnapshotDate: snapshotDate, CapturedAt: capturedAt,
			ViewCount: metric.View, DanmakuCount: metric.Danmaku, ReplyCount: metric.Reply,
			FavoriteCount: metric.Favorite, CoinCount: metric.Coin, ShareCount: metric.Share, LikeCount: metric.Like,
		})
		if batch.RecordCount() > maxBatchRecords {
			return Batch{}, ErrInvalidBatch
		}
	}
	return batch, nil
}

func shanghaiNaturalDate(value time.Time) (time.Time, error) {
	location, err := time.LoadLocation(Timezone)
	if err != nil {
		return time.Time{}, err
	}
	local := value.In(location)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location), nil
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}
