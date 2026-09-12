package businessdata

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct{ pool *pgxpool.Pool }

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore { return &PostgresStore{pool: pool} }

func nextScheduledSyncAt(now time.Time) (time.Time, error) {
	location, err := time.LoadLocation(Timezone)
	if err != nil {
		return time.Time{}, err
	}
	localNow := now.In(location)
	next := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 2, 10, 0, 0, location)
	if !next.After(localNow) {
		next = next.AddDate(0, 0, 1)
	}
	return next.UTC(), nil
}

func bilibiliRunDates(now time.Time) (time.Time, time.Time, error) {
	location, err := time.LoadLocation(Timezone)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	localNow := now.In(location)
	today := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location)
	return today.AddDate(0, 0, -6), today, nil
}

func (s *PostgresStore) GetSource(ctx context.Context, sourceID string) (Source, error) {
	var source Source
	err := s.pool.QueryRow(ctx, `SELECT source_id,provider,external_account_id,name,status,next_sync_at,last_attempt_at,last_success_at,last_error_code,last_error_summary,created_at,updated_at
FROM business_data_sources WHERE source_id=$1`, sourceID).Scan(
		&source.SourceID, &source.Provider, &source.ExternalAccountID, &source.Name, &source.Status,
		&source.NextSyncAt, &source.LastAttemptAt, &source.LastSuccessAt, &source.LastErrorCode,
		&source.LastErrorSummary, &source.CreatedAt, &source.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Source{}, ErrNotFound
	}
	return source, err
}

func (s *PostgresStore) ListBilibiliSources(ctx context.Context) ([]BilibiliSourceItem, error) {
	rows, err := s.pool.Query(ctx, `SELECT s.source_id,s.name,s.status,s.last_error_code,s.last_attempt_at,s.last_success_at,s.next_sync_at,
COALESCE(r.status,'') FROM business_data_sources s
LEFT JOIN business_sync_runs r ON r.source_id=s.source_id AND r.status IN ('queued','running')
WHERE s.provider='bilibili'
ORDER BY CASE WHEN s.status='active' THEN 0 ELSE 1 END,lower(s.name),s.source_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []BilibiliSourceItem{}
	for rows.Next() {
		var item BilibiliSourceItem
		if err := rows.Scan(&item.SourceID, &item.Name, &item.Status, &item.StatusReason, &item.LastAttemptAt,
			&item.LastSuccessAt, &item.NextSyncAt, &item.ActiveRunStatus); err != nil {
			return nil, err
		}
		normalizeBilibiliSourceTimes(&item)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) QueueBilibiliSourceRun(ctx context.Context, sourceID string, now time.Time) (SyncRequestResult, error) {
	startDate, endDate, err := bilibiliRunDates(now)
	if err != nil {
		return SyncRequestResult{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return SyncRequestResult{}, err
	}
	defer tx.Rollback(ctx)
	var status string
	err = tx.QueryRow(ctx, `SELECT status FROM business_data_sources WHERE source_id=$1 AND provider='bilibili' FOR UPDATE`, sourceID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return SyncRequestResult{}, ErrNotFound
	}
	if err != nil {
		return SyncRequestResult{}, err
	}
	if status != SourceStatusActive {
		return SyncRequestResult{}, ErrBilibiliSourceDisabled
	}
	tag, err := tx.Exec(ctx, `INSERT INTO business_sync_runs
(run_id,source_id,start_date,end_date,status,created_at,updated_at)
VALUES ($1,$2,$3,$4,'queued',$5,$5)
ON CONFLICT (source_id) WHERE status IN ('queued','running') DO NOTHING`,
		newID("bdrun"), sourceID, startDate, endDate, now.UTC())
	if err != nil {
		return SyncRequestResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SyncRequestResult{}, err
	}
	return SyncRequestResult{SourceCount: 1, QueuedCount: int(tag.RowsAffected())}, nil
}

func (s *PostgresStore) SetBilibiliSourceSyncEnabled(ctx context.Context, sourceID string, enabled bool, now time.Time) (BilibiliSourceChange, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return BilibiliSourceChange{}, err
	}
	defer tx.Rollback(ctx)
	item, err := loadBilibiliSourceForUpdate(ctx, tx, sourceID)
	if err != nil {
		return BilibiliSourceChange{}, err
	}
	queuedCount := 0
	if !enabled {
		if item.Status == SourceStatusActive {
			_, err = tx.Exec(ctx, `UPDATE business_data_sources SET status='disabled',next_sync_at=NULL,
last_error_code=$2,last_error_summary='',updated_at=$3 WHERE source_id=$1`, sourceID, BilibiliSyncDisabledCode, now.UTC())
			if err != nil {
				return BilibiliSourceChange{}, err
			}
			_, err = tx.Exec(ctx, `UPDATE business_sync_runs SET status='failed',error_code=$2,
error_summary='sync disabled by user',finished_at=$3,updated_at=$3 WHERE source_id=$1 AND status='queued'`,
				sourceID, BilibiliSyncDisabledCode, now.UTC())
			if err != nil {
				return BilibiliSourceChange{}, err
			}
			item.Status = SourceStatusDisabled
			item.StatusReason = BilibiliSyncDisabledCode
			item.NextSyncAt = nil
		}
	} else if item.Status == SourceStatusActive {
		// 幂等恢复不改变定时计划，也不重复排队。
	} else {
		if item.StatusReason != BilibiliSyncDisabledCode {
			return BilibiliSourceChange{}, ErrBilibiliSourceAuthorizationRequired
		}
		nextSync, nextErr := nextScheduledSyncAt(now)
		if nextErr != nil {
			return BilibiliSourceChange{}, nextErr
		}
		startDate, endDate, dateErr := bilibiliRunDates(now)
		if dateErr != nil {
			return BilibiliSourceChange{}, dateErr
		}
		_, err = tx.Exec(ctx, `UPDATE business_data_sources SET status='active',next_sync_at=$2,
last_error_code='',last_error_summary='',updated_at=$3 WHERE source_id=$1`, sourceID, nextSync, now.UTC())
		if err != nil {
			return BilibiliSourceChange{}, err
		}
		tag, insertErr := tx.Exec(ctx, `INSERT INTO business_sync_runs
(run_id,source_id,start_date,end_date,status,created_at,updated_at)
VALUES ($1,$2,$3,$4,'queued',$5,$5)
ON CONFLICT (source_id) WHERE status IN ('queued','running') DO NOTHING`,
			newID("bdrun"), sourceID, startDate, endDate, now.UTC())
		if insertErr != nil {
			return BilibiliSourceChange{}, insertErr
		}
		queuedCount = int(tag.RowsAffected())
		item.Status = SourceStatusActive
		item.StatusReason = ""
		item.NextSyncAt = &nextSync
	}
	item.ActiveRunStatus, err = activeRunStatus(ctx, tx, sourceID)
	if err != nil {
		return BilibiliSourceChange{}, err
	}
	normalizeBilibiliSourceTimes(&item)
	if err := tx.Commit(ctx); err != nil {
		return BilibiliSourceChange{}, err
	}
	return BilibiliSourceChange{Source: item, QueuedCount: queuedCount}, nil
}

func (s *PostgresStore) DeleteBilibiliSource(ctx context.Context, sourceID string) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := loadBilibiliSourceForUpdate(ctx, tx, sourceID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM bilibili_content_metric_snapshots WHERE source_id=$1`, sourceID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM bilibili_account_metric_snapshots WHERE source_id=$1`, sourceID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM business_contents WHERE source_id=$1`, sourceID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM business_data_source_credentials WHERE source_id=$1`, sourceID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM business_sync_runs WHERE source_id=$1`, sourceID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM business_data_sources WHERE source_id=$1 AND provider='bilibili'`, sourceID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func loadBilibiliSourceForUpdate(ctx context.Context, tx pgx.Tx, sourceID string) (BilibiliSourceItem, error) {
	var item BilibiliSourceItem
	err := tx.QueryRow(ctx, `SELECT source_id,name,status,last_error_code,last_attempt_at,last_success_at,next_sync_at
FROM business_data_sources WHERE source_id=$1 AND provider='bilibili' FOR UPDATE`, sourceID).Scan(
		&item.SourceID, &item.Name, &item.Status, &item.StatusReason, &item.LastAttemptAt, &item.LastSuccessAt, &item.NextSyncAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return BilibiliSourceItem{}, ErrNotFound
	}
	return item, err
}

func activeRunStatus(ctx context.Context, tx pgx.Tx, sourceID string) (string, error) {
	var status string
	err := tx.QueryRow(ctx, `SELECT status FROM business_sync_runs WHERE source_id=$1 AND status IN ('queued','running')`, sourceID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return status, err
}

func normalizeBilibiliSourceTimes(item *BilibiliSourceItem) {
	for _, value := range []**time.Time{&item.LastAttemptAt, &item.LastSuccessAt, &item.NextSyncAt} {
		if *value != nil {
			utc := (*value).UTC()
			*value = &utc
		}
	}
}

func (s *PostgresStore) QueueDueRuns(ctx context.Context, now time.Time, limit int) (int, error) {
	if limit <= 0 {
		limit = 100
	}
	location, err := time.LoadLocation(Timezone)
	if err != nil {
		return 0, err
	}
	localNow := now.In(location)
	today := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location)
	nextSync, err := nextScheduledSyncAt(now)
	if err != nil {
		return 0, err
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT source_id FROM business_data_sources
WHERE status='active' AND next_sync_at IS NOT NULL AND next_sync_at<=$1
ORDER BY next_sync_at,source_id FOR UPDATE SKIP LOCKED LIMIT $2`, now.UTC(), limit)
	if err != nil {
		return 0, err
	}
	sourceIDs := []string{}
	for rows.Next() {
		var sourceID string
		if err := rows.Scan(&sourceID); err != nil {
			rows.Close()
			return 0, err
		}
		sourceIDs = append(sourceIDs, sourceID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	queued := 0
	for _, sourceID := range sourceIDs {
		tag, err := tx.Exec(ctx, `INSERT INTO business_sync_runs
(run_id,source_id,start_date,end_date,status,created_at,updated_at)
VALUES ($1,$2,$3,$4,'queued',$5,$5)
ON CONFLICT (source_id) WHERE status IN ('queued','running') DO NOTHING`,
			newID("bdrun"), sourceID, today.AddDate(0, 0, -6), today, now.UTC())
		if err != nil {
			return 0, err
		}
		queued += int(tag.RowsAffected())
		if _, err := tx.Exec(ctx, `UPDATE business_data_sources SET next_sync_at=$2,updated_at=$3 WHERE source_id=$1`, sourceID, nextSync, now.UTC()); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return queued, nil
}

func (s *PostgresStore) QueueProviderRuns(ctx context.Context, provider string, now time.Time) (SyncRequestResult, error) {
	if !validProvider(provider) {
		return SyncRequestResult{}, ErrInvalidRequest
	}
	location, err := time.LoadLocation(Timezone)
	if err != nil {
		return SyncRequestResult{}, err
	}
	localNow := now.In(location)
	today := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return SyncRequestResult{}, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT source_id FROM business_data_sources
WHERE provider=$1 AND status='active' ORDER BY source_id FOR UPDATE`, provider)
	if err != nil {
		return SyncRequestResult{}, err
	}
	sourceIDs := []string{}
	for rows.Next() {
		var sourceID string
		if err := rows.Scan(&sourceID); err != nil {
			rows.Close()
			return SyncRequestResult{}, err
		}
		sourceIDs = append(sourceIDs, sourceID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return SyncRequestResult{}, err
	}
	result := SyncRequestResult{SourceCount: len(sourceIDs)}
	for _, sourceID := range sourceIDs {
		tag, err := tx.Exec(ctx, `INSERT INTO business_sync_runs
(run_id,source_id,start_date,end_date,status,created_at,updated_at)
VALUES ($1,$2,$3,$4,'queued',$5,$5)
ON CONFLICT (source_id) WHERE status IN ('queued','running') DO NOTHING`,
			newID("bdrun"), sourceID, today.AddDate(0, 0, -6), today, now.UTC())
		if err != nil {
			return SyncRequestResult{}, err
		}
		result.QueuedCount += int(tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		return SyncRequestResult{}, err
	}
	return result, nil
}

func (s *PostgresStore) ClaimNextRun(ctx context.Context, now time.Time) (SyncRun, bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return SyncRun{}, false, err
	}
	defer tx.Rollback(ctx)
	var run SyncRun
	err = tx.QueryRow(ctx, `SELECT run_id,source_id,start_date,end_date,status,fetched_count,upserted_count,error_code,error_summary,started_at,finished_at,created_at,updated_at
FROM business_sync_runs WHERE status='queued' ORDER BY created_at,run_id FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(
		&run.RunID, &run.SourceID, &run.StartDate, &run.EndDate, &run.Status, &run.FetchedCount,
		&run.UpsertedCount, &run.ErrorCode, &run.ErrorSummary, &run.StartedAt, &run.FinishedAt,
		&run.CreatedAt, &run.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return SyncRun{}, false, err
		}
		return SyncRun{}, false, nil
	}
	if err != nil {
		return SyncRun{}, false, err
	}
	err = tx.QueryRow(ctx, `UPDATE business_sync_runs SET status='running',started_at=$2,updated_at=$2
WHERE run_id=$1 AND status='queued'
RETURNING run_id,source_id,start_date,end_date,status,fetched_count,upserted_count,error_code,error_summary,started_at,finished_at,created_at,updated_at`, run.RunID, now.UTC()).Scan(
		&run.RunID, &run.SourceID, &run.StartDate, &run.EndDate, &run.Status, &run.FetchedCount,
		&run.UpsertedCount, &run.ErrorCode, &run.ErrorSummary, &run.StartedAt, &run.FinishedAt,
		&run.CreatedAt, &run.UpdatedAt,
	)
	if err != nil {
		return SyncRun{}, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE business_data_sources SET last_attempt_at=$2,updated_at=$2 WHERE source_id=$1`, run.SourceID, now.UTC()); err != nil {
		return SyncRun{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SyncRun{}, false, err
	}
	return run, true, nil
}

func (s *PostgresStore) CompleteRun(ctx context.Context, run SyncRun) error {
	if run.Status != SyncRunStatusSuccess && run.Status != SyncRunStatusFailed || run.FinishedAt == nil {
		return ErrInvalidRequest
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE business_sync_runs SET status=$2,fetched_count=$3,upserted_count=$4,error_code=$5,error_summary=$6,finished_at=$7,updated_at=$7
WHERE run_id=$1 AND source_id=$8 AND status='running'`, run.RunID, run.Status, run.FetchedCount, run.UpsertedCount,
		run.ErrorCode, run.ErrorSummary, run.FinishedAt.UTC(), run.SourceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	if run.Status == SyncRunStatusSuccess {
		_, err = tx.Exec(ctx, `UPDATE business_data_sources SET last_success_at=$2,
last_error_code=CASE WHEN status='active' THEN '' ELSE last_error_code END,
last_error_summary=CASE WHEN status='active' THEN '' ELSE last_error_summary END,
updated_at=$2 WHERE source_id=$1`, run.SourceID, run.FinishedAt.UTC())
	} else {
		_, err = tx.Exec(ctx, `UPDATE business_data_sources SET
last_error_code=CASE WHEN status='active' THEN $2 ELSE last_error_code END,
last_error_summary=CASE WHEN status='active' THEN $3 ELSE last_error_summary END,
status=CASE WHEN status='active' AND $2='bilibili_reauth_required' THEN 'disabled' ELSE status END,
next_sync_at=CASE WHEN status='active' AND $2='bilibili_reauth_required' THEN NULL ELSE next_sync_at END,
updated_at=$4 WHERE source_id=$1`,
			run.SourceID, run.ErrorCode, run.ErrorSummary, run.FinishedAt.UTC())
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) RecoverRunningRuns(ctx context.Context, now time.Time) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE business_sync_runs SET status='failed',error_code='run_interrupted',error_summary='sync run interrupted',finished_at=$1,updated_at=$1 WHERE status='running'`, now.UTC()); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE business_data_sources s SET last_error_code='run_interrupted',last_error_summary='sync run interrupted',updated_at=$1
WHERE s.status='active' AND EXISTS (SELECT 1 FROM business_sync_runs r WHERE r.source_id=s.source_id AND r.status='failed' AND r.error_code='run_interrupted' AND r.finished_at=$1)`, now.UTC()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) UpsertBatch(ctx context.Context, sourceID, runID string, batch Batch, now time.Time) (int64, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var provider, sourceStatus string
	var startDate, endDate time.Time
	err = tx.QueryRow(ctx, `SELECT s.provider,s.status,r.start_date,r.end_date FROM business_sync_runs r
JOIN business_data_sources s ON s.source_id=r.source_id
WHERE r.run_id=$1 AND r.source_id=$2 AND r.status='running' FOR UPDATE OF r,s`, runID, sourceID).Scan(&provider, &sourceStatus, &startDate, &endDate)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if sourceStatus != SourceStatusActive {
		if provider == ProviderBilibili {
			return 0, ErrBilibiliSourceDisabled
		}
		return 0, ErrInvalidRequest
	}
	if err := validateBatch(provider, startDate, endDate, &batch); err != nil {
		return 0, err
	}
	if provider == ProviderBilibili && batch.SourceName != "" {
		if _, err := tx.Exec(ctx, `UPDATE business_data_sources SET name=$2,updated_at=$3 WHERE source_id=$1`, sourceID, batch.SourceName, now.UTC()); err != nil {
			return 0, err
		}
	}
	var count int64
	for _, item := range batch.Contents {
		if _, err := tx.Exec(ctx, `INSERT INTO business_contents (source_id,external_content_id,title,content_type,status,published_at,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (source_id,external_content_id) DO UPDATE SET title=EXCLUDED.title,content_type=EXCLUDED.content_type,status=EXCLUDED.status,published_at=EXCLUDED.published_at,updated_at=EXCLUDED.updated_at`,
			sourceID, item.ExternalContentID, item.Title, item.ContentType, item.Status, item.PublishedAt, now.UTC()); err != nil {
			return 0, err
		}
		count++
	}
	for _, item := range batch.Campaigns {
		if _, err := tx.Exec(ctx, `INSERT INTO business_campaigns (source_id,external_campaign_id,name,campaign_type,status,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (source_id,external_campaign_id) DO UPDATE SET name=EXCLUDED.name,campaign_type=EXCLUDED.campaign_type,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at`,
			sourceID, item.ExternalCampaignID, item.Name, item.CampaignType, item.Status, now.UTC()); err != nil {
			return 0, err
		}
		count++
	}
	for _, metric := range batch.ContentDailyMetrics {
		if _, err := tx.Exec(ctx, `INSERT INTO business_content_daily_metrics (source_id,external_content_id,stat_date,exposure_count,like_count,favorite_count,comment_count,share_count,sync_run_id,ingested_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (source_id,external_content_id,stat_date) DO UPDATE SET exposure_count=EXCLUDED.exposure_count,like_count=EXCLUDED.like_count,favorite_count=EXCLUDED.favorite_count,comment_count=EXCLUDED.comment_count,share_count=EXCLUDED.share_count,sync_run_id=EXCLUDED.sync_run_id,ingested_at=EXCLUDED.ingested_at`,
			sourceID, metric.ExternalContentID, metric.StatDate, metric.ExposureCount, metric.LikeCount, metric.FavoriteCount, metric.CommentCount, metric.ShareCount, runID, now.UTC()); err != nil {
			return 0, err
		}
		count++
	}
	for _, metric := range batch.AccountDailyMetrics {
		if _, err := tx.Exec(ctx, `INSERT INTO business_account_daily_metrics (source_id,stat_date,new_follower_count,sync_run_id,ingested_at)
VALUES ($1,$2,$3,$4,$5) ON CONFLICT (source_id,stat_date) DO UPDATE SET new_follower_count=EXCLUDED.new_follower_count,sync_run_id=EXCLUDED.sync_run_id,ingested_at=EXCLUDED.ingested_at`,
			sourceID, metric.StatDate, metric.NewFollowerCount, runID, now.UTC()); err != nil {
			return 0, err
		}
		count++
	}
	for _, metric := range batch.CampaignDailyMetrics {
		if _, err := tx.Exec(ctx, `INSERT INTO business_campaign_daily_metrics (source_id,external_campaign_id,stat_date,spend_minor,impression_count,video_play_count,click_count,sync_run_id,ingested_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (source_id,external_campaign_id,stat_date) DO UPDATE SET spend_minor=EXCLUDED.spend_minor,impression_count=EXCLUDED.impression_count,video_play_count=EXCLUDED.video_play_count,click_count=EXCLUDED.click_count,sync_run_id=EXCLUDED.sync_run_id,ingested_at=EXCLUDED.ingested_at`,
			sourceID, metric.ExternalCampaignID, metric.StatDate, metric.SpendMinor, metric.ImpressionCount, metric.VideoPlayCount, metric.ClickCount, runID, now.UTC()); err != nil {
			return 0, err
		}
		count++
	}
	for _, snapshot := range batch.BilibiliAccountSnapshots {
		if _, err := tx.Exec(ctx, `INSERT INTO bilibili_account_metric_snapshots
(source_id,snapshot_date,captured_at,follower_count,following_count,published_count,sync_run_id)
VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (source_id,snapshot_date) DO UPDATE SET
captured_at=EXCLUDED.captured_at,follower_count=EXCLUDED.follower_count,following_count=EXCLUDED.following_count,
published_count=EXCLUDED.published_count,sync_run_id=EXCLUDED.sync_run_id`, sourceID, snapshot.SnapshotDate,
			snapshot.CapturedAt.UTC(), snapshot.FollowerCount, snapshot.FollowingCount, snapshot.PublishedCount, runID); err != nil {
			return 0, err
		}
		count++
	}
	for _, snapshot := range batch.BilibiliContentSnapshots {
		if _, err := tx.Exec(ctx, `INSERT INTO bilibili_content_metric_snapshots
(source_id,external_content_id,snapshot_date,captured_at,view_count,danmaku_count,reply_count,favorite_count,coin_count,share_count,like_count,sync_run_id)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (source_id,external_content_id,snapshot_date) DO UPDATE SET
captured_at=EXCLUDED.captured_at,view_count=EXCLUDED.view_count,danmaku_count=EXCLUDED.danmaku_count,
reply_count=EXCLUDED.reply_count,favorite_count=EXCLUDED.favorite_count,coin_count=EXCLUDED.coin_count,
share_count=EXCLUDED.share_count,like_count=EXCLUDED.like_count,sync_run_id=EXCLUDED.sync_run_id`, sourceID,
			snapshot.ExternalContentID, snapshot.SnapshotDate, snapshot.CapturedAt.UTC(), snapshot.ViewCount,
			snapshot.DanmakuCount, snapshot.ReplyCount, snapshot.FavoriteCount, snapshot.CoinCount,
			snapshot.ShareCount, snapshot.LikeCount, runID); err != nil {
			return 0, err
		}
		count++
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return count, nil
}

func (s *PostgresStore) SaveBilibiliOAuthState(ctx context.Context, stateHash []byte, createdBy string, expiresAt, createdAt time.Time) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO business_data_oauth_states (state_hash,created_by,expires_at,created_at) VALUES ($1,$2,$3,$4)`, stateHash, createdBy, expiresAt.UTC(), createdAt.UTC())
	return err
}

func (s *PostgresStore) ConsumeBilibiliOAuthState(ctx context.Context, stateHash []byte, now time.Time) (string, error) {
	var createdBy string
	err := s.pool.QueryRow(ctx, `UPDATE business_data_oauth_states SET consumed_at=$2
WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at>$2 RETURNING created_by`, stateHash, now.UTC()).Scan(&createdBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrInvalidRequest
	}
	return createdBy, err
}

func (s *PostgresStore) UpsertBilibiliAuthorization(ctx context.Context, authorization BilibiliAuthorization, now time.Time) (Source, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Source{}, err
	}
	defer tx.Rollback(ctx)
	sourceID := ""
	err = tx.QueryRow(ctx, `SELECT source_id FROM business_data_sources WHERE provider='bilibili' AND external_account_id=$1 FOR UPDATE`, authorization.AccountInfo.OpenID).Scan(&sourceID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Source{}, err
	}
	if sourceID == "" {
		sourceID = newID("bdsrc")
	}
	_, err = tx.Exec(ctx, `INSERT INTO business_data_sources
(source_id,provider,external_account_id,name,status,next_sync_at,last_error_code,last_error_summary,created_at,updated_at)
VALUES ($1,'bilibili',$2,$3,'active',$4,'','',$4,$4)
ON CONFLICT (provider,external_account_id) DO UPDATE SET name=EXCLUDED.name,status='active',next_sync_at=EXCLUDED.next_sync_at,
last_error_code='',last_error_summary='',updated_at=EXCLUDED.updated_at`, sourceID, authorization.AccountInfo.OpenID,
		authorization.AccountInfo.Name, now.UTC())
	if err != nil {
		return Source{}, err
	}
	if err := tx.QueryRow(ctx, `SELECT source_id FROM business_data_sources WHERE provider='bilibili' AND external_account_id=$1`, authorization.AccountInfo.OpenID).Scan(&sourceID); err != nil {
		return Source{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO business_data_source_credentials
(source_id,access_token_ciphertext,refresh_token_ciphertext,token_expires_at,scopes,created_at,updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (source_id) DO UPDATE SET access_token_ciphertext=EXCLUDED.access_token_ciphertext,
refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,token_expires_at=EXCLUDED.token_expires_at,scopes=EXCLUDED.scopes,updated_at=EXCLUDED.updated_at`,
		sourceID, authorization.AccessTokenCiphertext, authorization.RefreshTokenCiphertext, authorization.TokenExpiresAt.UTC(), authorization.Scopes, now.UTC())
	if err != nil {
		return Source{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Source{}, err
	}
	return s.GetSource(ctx, sourceID)
}

func (s *PostgresStore) DisableBilibiliAuthorization(ctx context.Context, openID string, now time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE business_data_sources SET status='disabled',next_sync_at=NULL,
last_error_code='bilibili_deauthorized',last_error_summary='',updated_at=$2
WHERE provider='bilibili' AND external_account_id=$1`, openID, now.UTC())
	return err
}

func (s *PostgresStore) GetBilibiliCredential(ctx context.Context, sourceID string) (BilibiliCredential, error) {
	var credential BilibiliCredential
	err := s.pool.QueryRow(ctx, `SELECT c.source_id,c.access_token_ciphertext,c.refresh_token_ciphertext,c.token_expires_at,c.scopes
FROM business_data_source_credentials c JOIN business_data_sources s USING(source_id)
WHERE c.source_id=$1 AND s.provider='bilibili' AND s.status='active'`, sourceID).Scan(&credential.SourceID,
		&credential.AccessTokenCiphertext, &credential.RefreshTokenCiphertext, &credential.TokenExpiresAt, &credential.Scopes)
	if errors.Is(err, pgx.ErrNoRows) {
		return BilibiliCredential{}, ErrBilibiliReauthRequired
	}
	return credential, err
}

func (s *PostgresStore) CompareAndSwapBilibiliCredential(ctx context.Context, sourceID string, oldRefresh, access, refresh []byte, expiresAt, now time.Time) (bool, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE business_data_source_credentials SET access_token_ciphertext=$3,refresh_token_ciphertext=$4,
token_expires_at=$5,updated_at=$6 WHERE source_id=$1 AND refresh_token_ciphertext=$2`, sourceID, oldRefresh, access, refresh, expiresAt.UTC(), now.UTC())
	return err == nil && tag.RowsAffected() == 1, err
}

func (s *PostgresStore) XiaohongshuDashboard(ctx context.Context, r DashboardRange) (XiaohongshuDashboardData, error) {
	state, err := s.dashboardState(ctx, ProviderXiaohongshu)
	if err != nil || (state.DataStatus != DataStatusAvailable && state.DataStatus != DataStatusPartial) {
		return XiaohongshuDashboardData{State: state, Trend: []XiaohongshuTrendPoint{}, TopItems: []XiaohongshuTopItem{}}, err
	}
	data := XiaohongshuDashboardData{State: state, Trend: []XiaohongshuTrendPoint{}, TopItems: []XiaohongshuTopItem{}}
	err = s.pool.QueryRow(ctx, `WITH active AS (SELECT source_id FROM business_data_sources WHERE provider='xiaohongshu' AND status='active')
SELECT
(SELECT COUNT(*) FROM business_contents c JOIN active a USING(source_id) WHERE (c.published_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $1 AND $2),
(SELECT COALESCE(SUM(exposure_count),0) FROM business_content_daily_metrics m JOIN active a USING(source_id) WHERE stat_date BETWEEN $1 AND $2),
(SELECT COALESCE(SUM(like_count+favorite_count+comment_count+share_count),0) FROM business_content_daily_metrics m JOIN active a USING(source_id) WHERE stat_date BETWEEN $1 AND $2),
(SELECT COALESCE(SUM(new_follower_count),0) FROM business_account_daily_metrics m JOIN active a USING(source_id) WHERE stat_date BETWEEN $1 AND $2),
(SELECT COUNT(*) FROM business_contents c JOIN active a USING(source_id) WHERE (c.published_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $3 AND $4),
(SELECT COALESCE(SUM(exposure_count),0) FROM business_content_daily_metrics m JOIN active a USING(source_id) WHERE stat_date BETWEEN $3 AND $4),
(SELECT COALESCE(SUM(like_count+favorite_count+comment_count+share_count),0) FROM business_content_daily_metrics m JOIN active a USING(source_id) WHERE stat_date BETWEEN $3 AND $4),
(SELECT COALESCE(SUM(new_follower_count),0) FROM business_account_daily_metrics m JOIN active a USING(source_id) WHERE stat_date BETWEEN $3 AND $4)`,
		r.StartDate, r.EndDate, r.PreviousStart, r.PreviousEnd).Scan(
		&data.Summary.PublishedCount, &data.Summary.ExposureCount, &data.Summary.InteractionCount, &data.Summary.NewFollowerCount,
		&data.Previous.PublishedCount, &data.Previous.ExposureCount, &data.Previous.InteractionCount, &data.Previous.NewFollowerCount)
	if err != nil {
		return XiaohongshuDashboardData{}, err
	}
	data.Summary.PublishedCountChangeRate = changeRate(data.Summary.PublishedCount, data.Previous.PublishedCount)
	data.Summary.ExposureCountChangeRate = changeRate(data.Summary.ExposureCount, data.Previous.ExposureCount)
	data.Summary.InteractionCountChangeRate = changeRate(data.Summary.InteractionCount, data.Previous.InteractionCount)
	data.Summary.NewFollowerCountChangeRate = changeRate(data.Summary.NewFollowerCount, data.Previous.NewFollowerCount)

	trend := map[string]XiaohongshuTrendPoint{}
	rows, err := s.pool.Query(ctx, `SELECT stat_date,COALESCE(SUM(exposure_count),0),COALESCE(SUM(like_count+favorite_count+comment_count+share_count),0)
FROM business_content_daily_metrics m JOIN business_data_sources s USING(source_id)
WHERE s.provider='xiaohongshu' AND s.status='active' AND stat_date BETWEEN $1 AND $2 GROUP BY stat_date`, r.StartDate, r.EndDate)
	if err != nil {
		return XiaohongshuDashboardData{}, err
	}
	for rows.Next() {
		var date time.Time
		var point XiaohongshuTrendPoint
		if err := rows.Scan(&date, &point.ExposureCount, &point.InteractionCount); err != nil {
			rows.Close()
			return XiaohongshuDashboardData{}, err
		}
		point.Date = dateKey(date)
		trend[point.Date] = point
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return XiaohongshuDashboardData{}, err
	}
	data.Trend = fillXiaohongshuTrend(r, trend)

	rows, err = s.pool.Query(ctx, `SELECT c.external_content_id,c.title,c.content_type,COALESCE(SUM(m.exposure_count),0),COALESCE(SUM(m.like_count+m.favorite_count+m.comment_count+m.share_count),0)
FROM business_contents c JOIN business_data_sources s USING(source_id)
JOIN business_content_daily_metrics m ON m.source_id=c.source_id AND m.external_content_id=c.external_content_id AND m.stat_date BETWEEN $1 AND $2
WHERE s.provider='xiaohongshu' AND s.status='active'
GROUP BY c.source_id,c.external_content_id,c.title,c.content_type ORDER BY 4 DESC,c.external_content_id ASC,c.source_id ASC LIMIT 20`, r.StartDate, r.EndDate)
	if err != nil {
		return XiaohongshuDashboardData{}, err
	}
	for rows.Next() {
		var item XiaohongshuTopItem
		if err := rows.Scan(&item.ExternalContentID, &item.Title, &item.ContentType, &item.ExposureCount, &item.InteractionCount); err != nil {
			rows.Close()
			return XiaohongshuDashboardData{}, err
		}
		if item.ExposureCount > 0 {
			rate := float64(item.InteractionCount) / float64(item.ExposureCount)
			item.InteractionRate = &rate
		}
		data.TopItems = append(data.TopItems, item)
	}
	rows.Close()
	return data, rows.Err()
}

func (s *PostgresStore) DouyinAdsDashboard(ctx context.Context, r DashboardRange) (DouyinAdsDashboardData, error) {
	state, err := s.dashboardState(ctx, ProviderDouyinAds)
	if err != nil || (state.DataStatus != DataStatusAvailable && state.DataStatus != DataStatusPartial) {
		return DouyinAdsDashboardData{State: state, Trend: []DouyinAdsTrendPoint{}, TopItems: []DouyinAdsTopItem{}}, err
	}
	data := DouyinAdsDashboardData{State: state, Trend: []DouyinAdsTrendPoint{}, TopItems: []DouyinAdsTopItem{}}
	data.Summary.Currency = Currency
	data.Previous.Currency = Currency
	err = s.pool.QueryRow(ctx, `WITH active AS (SELECT source_id FROM business_data_sources WHERE provider='douyin_ads' AND status='active')
SELECT
(SELECT COALESCE(SUM(spend_minor),0) FROM business_campaign_daily_metrics m JOIN active a USING(source_id) WHERE stat_date BETWEEN $1 AND $2),
(SELECT COALESCE(SUM(video_play_count),0) FROM business_campaign_daily_metrics m JOIN active a USING(source_id) WHERE stat_date BETWEEN $1 AND $2),
(SELECT COALESCE(SUM(spend_minor),0) FROM business_campaign_daily_metrics m JOIN active a USING(source_id) WHERE stat_date BETWEEN $3 AND $4),
(SELECT COALESCE(SUM(video_play_count),0) FROM business_campaign_daily_metrics m JOIN active a USING(source_id) WHERE stat_date BETWEEN $3 AND $4)`,
		r.StartDate, r.EndDate, r.PreviousStart, r.PreviousEnd).Scan(&data.Summary.SpendMinor, &data.Summary.VideoPlayCount, &data.Previous.SpendMinor, &data.Previous.VideoPlayCount)
	if err != nil {
		return DouyinAdsDashboardData{}, err
	}
	data.Summary.SpendChangeRate = changeRate(data.Summary.SpendMinor, data.Previous.SpendMinor)
	data.Summary.VideoPlayCountChangeRate = changeRate(data.Summary.VideoPlayCount, data.Previous.VideoPlayCount)
	trend := map[string]DouyinAdsTrendPoint{}
	rows, err := s.pool.Query(ctx, `SELECT stat_date,COALESCE(SUM(spend_minor),0),COALESCE(SUM(video_play_count),0)
FROM business_campaign_daily_metrics m JOIN business_data_sources s USING(source_id)
WHERE s.provider='douyin_ads' AND s.status='active' AND stat_date BETWEEN $1 AND $2 GROUP BY stat_date`, r.StartDate, r.EndDate)
	if err != nil {
		return DouyinAdsDashboardData{}, err
	}
	for rows.Next() {
		var date time.Time
		var point DouyinAdsTrendPoint
		if err := rows.Scan(&date, &point.SpendMinor, &point.VideoPlayCount); err != nil {
			rows.Close()
			return DouyinAdsDashboardData{}, err
		}
		point.Date = dateKey(date)
		trend[point.Date] = point
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return DouyinAdsDashboardData{}, err
	}
	data.Trend = fillDouyinAdsTrend(r, trend)
	rows, err = s.pool.Query(ctx, `SELECT c.external_campaign_id,c.name,c.campaign_type,COALESCE(SUM(m.spend_minor),0),COALESCE(SUM(m.impression_count),0),COALESCE(SUM(m.video_play_count),0),COALESCE(SUM(m.click_count),0)
FROM business_campaigns c JOIN business_data_sources s USING(source_id)
JOIN business_campaign_daily_metrics m ON m.source_id=c.source_id AND m.external_campaign_id=c.external_campaign_id AND m.stat_date BETWEEN $1 AND $2
WHERE s.provider='douyin_ads' AND s.status='active'
GROUP BY c.source_id,c.external_campaign_id,c.name,c.campaign_type ORDER BY 4 DESC,c.external_campaign_id ASC,c.source_id ASC LIMIT 20`, r.StartDate, r.EndDate)
	if err != nil {
		return DouyinAdsDashboardData{}, err
	}
	for rows.Next() {
		var item DouyinAdsTopItem
		if err := rows.Scan(&item.ExternalCampaignID, &item.Name, &item.CampaignType, &item.SpendMinor, &item.ImpressionCount, &item.VideoPlayCount, &item.ClickCount); err != nil {
			rows.Close()
			return DouyinAdsDashboardData{}, err
		}
		item.Currency = Currency
		data.TopItems = append(data.TopItems, item)
	}
	rows.Close()
	return data, rows.Err()
}

func (s *PostgresStore) BilibiliDashboard(ctx context.Context, sourceID string, r DashboardRange) (BilibiliDashboardData, error) {
	state, account, err := s.bilibiliDashboardSourceState(ctx, sourceID)
	data := BilibiliDashboardData{State: state, Account: account, TopContents: []BilibiliTopContent{}}
	if err != nil || state.DataStatus != DataStatusAvailable {
		return data, err
	}
	var capturedAt *time.Time
	err = s.pool.QueryRow(ctx, `SELECT captured_at,follower_count,following_count,published_count
FROM bilibili_account_metric_snapshots WHERE source_id=$1
ORDER BY snapshot_date DESC,captured_at DESC LIMIT 1`, sourceID).Scan(
		&capturedAt, &data.FollowerCount, &data.FollowingCount, &data.PublishedCount)
	if errors.Is(err, pgx.ErrNoRows) {
		data.State.DataStatus = DataStatusUnavailable
		return data, nil
	}
	if err != nil {
		return BilibiliDashboardData{}, err
	}
	data.CapturedAt = capturedAt.UTC()
	err = s.pool.QueryRow(ctx, `WITH latest AS (
	SELECT DISTINCT ON (m.external_content_id) m.*
	FROM bilibili_content_metric_snapshots m WHERE m.source_id=$1
	ORDER BY m.external_content_id,m.snapshot_date DESC,m.captured_at DESC
)
SELECT COUNT(*),COALESCE(SUM(view_count),0),COALESCE(SUM(danmaku_count),0),
COALESCE(SUM(reply_count),0),COALESCE(SUM(favorite_count),0),COALESCE(SUM(coin_count),0),
COALESCE(SUM(share_count),0),COALESCE(SUM(like_count),0),
COALESCE(SUM(like_count+coin_count+favorite_count+reply_count+danmaku_count+share_count),0) FROM latest`, sourceID).Scan(
		&data.CollectedContentCount, &data.ViewCount, &data.DanmakuCount, &data.ReplyCount,
		&data.FavoriteCount, &data.CoinCount, &data.ShareCount, &data.LikeCount, &data.InteractionCount)
	if err != nil {
		return BilibiliDashboardData{}, err
	}
	trend, err := s.bilibiliTrend(ctx, sourceID, r)
	if err != nil {
		return BilibiliDashboardData{}, err
	}
	data.Trend = trend
	rows, err := s.pool.Query(ctx, `WITH latest AS (
	SELECT DISTINCT ON (m.external_content_id) m.*
	FROM bilibili_content_metric_snapshots m WHERE m.source_id=$1
	ORDER BY m.external_content_id,m.snapshot_date DESC,m.captured_at DESC
)
SELECT l.external_content_id,c.title,c.published_at,c.status,l.captured_at,l.view_count,
l.danmaku_count,l.reply_count,l.favorite_count,l.coin_count,l.share_count,l.like_count,
l.like_count+l.coin_count+l.favorite_count+l.reply_count+l.danmaku_count+l.share_count AS interaction_count
FROM latest l JOIN business_contents c USING(source_id,external_content_id)
ORDER BY l.view_count DESC,l.external_content_id ASC LIMIT 20`, sourceID)
	if err != nil {
		return BilibiliDashboardData{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var item BilibiliTopContent
		if err := rows.Scan(&item.ExternalContentID, &item.Title, &item.PublishedAt, &item.Status,
			&item.CapturedAt, &item.ViewCount, &item.DanmakuCount, &item.ReplyCount,
			&item.FavoriteCount, &item.CoinCount, &item.ShareCount, &item.LikeCount,
			&item.InteractionCount); err != nil {
			return BilibiliDashboardData{}, err
		}
		item.SourceID = account.SourceID
		item.AccountName = account.Name
		item.CapturedAt = item.CapturedAt.UTC()
		if item.PublishedAt != nil {
			publishedAt := item.PublishedAt.UTC()
			item.PublishedAt = &publishedAt
		}
		data.TopContents = append(data.TopContents, item)
	}
	return data, rows.Err()
}

func (s *PostgresStore) BilibiliViewSourceIDs(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT source_id FROM business_data_sources
WHERE provider='bilibili' AND status='active' ORDER BY source_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var sourceID string
		if err := rows.Scan(&sourceID); err != nil {
			return nil, err
		}
		result = append(result, sourceID)
	}
	return result, rows.Err()
}

func (s *PostgresStore) bilibiliTrend(ctx context.Context, sourceID string, r DashboardRange) ([]BilibiliTrendPoint, error) {
	accountDaily := map[string]int64{}
	rows, err := s.pool.Query(ctx, `SELECT snapshot_date,COALESCE(SUM(follower_count),0)
FROM bilibili_account_metric_snapshots
WHERE source_id=$1 AND snapshot_date BETWEEN $2 AND $3
GROUP BY snapshot_date`, sourceID, r.StartDate, r.EndDate)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var date time.Time
		var followers int64
		if err := rows.Scan(&date, &followers); err != nil {
			rows.Close()
			return nil, err
		}
		accountDaily[dateKey(date)] = followers
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	contentDaily := map[string]BilibiliTrendPoint{}
	rows, err = s.pool.Query(ctx, `SELECT snapshot_date,COALESCE(SUM(view_count),0),
COALESCE(SUM(like_count+coin_count+favorite_count+reply_count+danmaku_count+share_count),0)
FROM bilibili_content_metric_snapshots
WHERE source_id=$1 AND snapshot_date BETWEEN $2 AND $3
GROUP BY snapshot_date`, sourceID, r.StartDate, r.EndDate)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var date time.Time
		var point BilibiliTrendPoint
		if err := rows.Scan(&date, &point.ViewCount, &point.InteractionCount); err != nil {
			rows.Close()
			return nil, err
		}
		contentDaily[dateKey(date)] = point
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var baseline bilibiliTrendBaseline
	err = s.pool.QueryRow(ctx, `SELECT EXISTS(
	SELECT 1 FROM bilibili_account_metric_snapshots
	WHERE source_id=$1 AND snapshot_date < $2
),COALESCE((
	SELECT follower_count FROM bilibili_account_metric_snapshots
	WHERE source_id=$1 AND snapshot_date < $2
	ORDER BY snapshot_date DESC,captured_at DESC LIMIT 1
),0)`, sourceID, r.StartDate).Scan(&baseline.followerAvailable, &baseline.FollowerCount)
	if err != nil {
		return nil, err
	}
	err = s.pool.QueryRow(ctx, `WITH latest AS (
	SELECT DISTINCT ON (m.external_content_id) m.view_count,
	m.like_count+m.coin_count+m.favorite_count+m.reply_count+m.danmaku_count+m.share_count AS interaction_count
	FROM bilibili_content_metric_snapshots m
	WHERE m.source_id=$1 AND m.snapshot_date < $2
	ORDER BY m.external_content_id,m.snapshot_date DESC,m.captured_at DESC
)
SELECT COUNT(*) > 0,COALESCE(SUM(view_count),0),COALESCE(SUM(interaction_count),0) FROM latest`, sourceID, r.StartDate).Scan(
		&baseline.contentAvailable, &baseline.ViewCount, &baseline.InteractionCount)
	if err != nil {
		return nil, err
	}
	return fillBilibiliTrend(r, baseline, accountDaily, contentDaily), nil
}

type bilibiliTrendBaseline struct {
	BilibiliTrendPoint
	followerAvailable bool
	contentAvailable  bool
}

func fillBilibiliTrend(r DashboardRange, baseline bilibiliTrendBaseline, accountDaily map[string]int64, contentDaily map[string]BilibiliTrendPoint) []BilibiliTrendPoint {
	result := []BilibiliTrendPoint{}
	current := baseline.BilibiliTrendPoint
	followerAvailable := baseline.followerAvailable
	contentAvailable := baseline.contentAvailable
	for date := r.StartDate; !date.After(r.EndDate); date = date.AddDate(0, 0, 1) {
		key := dateKey(date)
		var followerDelta, viewDelta, interactionDelta int64
		if followers, ok := accountDaily[key]; ok {
			if followerAvailable {
				followerDelta = followers - current.FollowerCount
			}
			current.FollowerCount = followers
			followerAvailable = true
		}
		if content, ok := contentDaily[key]; ok {
			if contentAvailable {
				viewDelta = content.ViewCount - current.ViewCount
				interactionDelta = content.InteractionCount - current.InteractionCount
			}
			current.ViewCount = content.ViewCount
			current.InteractionCount = content.InteractionCount
			contentAvailable = true
		}
		result = append(result, BilibiliTrendPoint{
			Date: key, FollowerCount: current.FollowerCount, ViewCount: current.ViewCount,
			InteractionCount:      current.InteractionCount,
			FollowerCountDelta:    followerDelta,
			ViewCountDelta:        viewDelta,
			InteractionCountDelta: interactionDelta,
		})
	}
	return result
}

func (s *PostgresStore) BilibiliDashboardOverview(ctx context.Context) (DashboardState, error) {
	return s.dashboardState(ctx, ProviderBilibili)
}

func (s *PostgresStore) bilibiliDashboardSourceState(ctx context.Context, sourceID string) (DashboardState, BilibiliDashboardAccount, error) {
	var account BilibiliDashboardAccount
	err := s.pool.QueryRow(ctx, `SELECT source_id,name,status,last_error_code,last_success_at
FROM business_data_sources WHERE source_id=$1 AND provider='bilibili'`, sourceID).Scan(
		&account.SourceID, &account.Name, &account.Status, &account.StatusReason, &account.LastSuccessAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return DashboardState{}, BilibiliDashboardAccount{}, ErrNotFound
	}
	if err != nil {
		return DashboardState{}, BilibiliDashboardAccount{}, err
	}
	if account.LastSuccessAt != nil {
		lastSuccess := account.LastSuccessAt.UTC()
		account.LastSuccessAt = &lastSuccess
	}
	state := DashboardState{DataStatus: DataStatusUnavailable, LastSyncedAt: account.LastSuccessAt}
	if account.LastSuccessAt != nil {
		state.DataStatus = DataStatusAvailable
	}
	return state, account, nil
}

func (s *PostgresStore) dashboardState(ctx context.Context, provider string) (DashboardState, error) {
	var totalCount, activeCount, availableCount int64
	var lastSuccess *time.Time
	if err := s.pool.QueryRow(ctx, `SELECT COUNT(*),COUNT(*) FILTER (WHERE status='active'),
COUNT(*) FILTER (WHERE status='active' AND last_success_at IS NOT NULL),
MAX(last_success_at) FILTER (WHERE status='active') FROM business_data_sources WHERE provider=$1`, provider).Scan(&totalCount, &activeCount, &availableCount, &lastSuccess); err != nil {
		return DashboardState{}, err
	}
	state := DashboardState{DataStatus: DataStatusUnconfigured, LastSyncedAt: lastSuccess}
	if totalCount == 0 {
		return state, nil
	}
	state.DataStatus = DataStatusUnavailable
	if availableCount == activeCount && activeCount > 0 {
		state.DataStatus = DataStatusAvailable
		return state, nil
	}
	if availableCount > 0 {
		state.DataStatus = DataStatusPartial
	}
	rows, err := s.pool.Query(ctx, `SELECT COALESCE(NULLIF(name,''),source_id) FROM business_data_sources
WHERE provider=$1 AND (status<>'active' OR last_success_at IS NULL) ORDER BY source_id`, provider)
	if err != nil {
		return DashboardState{}, err
	}
	defer rows.Close()
	state.UnavailableParts = []string{}
	for rows.Next() {
		var part string
		if err := rows.Scan(&part); err != nil {
			return DashboardState{}, err
		}
		state.UnavailableParts = append(state.UnavailableParts, part)
	}
	return state, rows.Err()
}

func fillXiaohongshuTrend(r DashboardRange, values map[string]XiaohongshuTrendPoint) []XiaohongshuTrendPoint {
	result := []XiaohongshuTrendPoint{}
	for date := r.StartDate; !date.After(r.EndDate); date = date.AddDate(0, 0, 1) {
		key := dateKey(date)
		point := values[key]
		point.Date = key
		result = append(result, point)
	}
	return result
}

func fillDouyinAdsTrend(r DashboardRange, values map[string]DouyinAdsTrendPoint) []DouyinAdsTrendPoint {
	result := []DouyinAdsTrendPoint{}
	for date := r.StartDate; !date.After(r.EndDate); date = date.AddDate(0, 0, 1) {
		key := dateKey(date)
		point := values[key]
		point.Date = key
		result = append(result, point)
	}
	return result
}

func changeRate(current, previous int64) *float64 {
	if previous == 0 {
		return nil
	}
	value := float64(current-previous) / float64(previous)
	return &value
}

func newID(prefix string) string {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UTC().UnixNano())
	}
	return prefix + "_" + hex.EncodeToString(raw[:])
}
