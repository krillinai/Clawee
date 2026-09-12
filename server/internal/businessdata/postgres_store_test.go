package businessdata

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresStoreSyncIdempotenceAndDashboard(t *testing.T) {
	pool := openBusinessDataTestPool(t)
	ctx := context.Background()
	location, _ := time.LoadLocation(Timezone)
	now := time.Date(2026, 8, 14, 3, 0, 0, 0, time.UTC)
	today := time.Date(2026, 8, 14, 0, 0, 0, 0, location)
	_, err := pool.Exec(ctx, `INSERT INTO business_data_sources
(source_id,provider,external_account_id,name,status,next_sync_at,created_at,updated_at)
VALUES ('bdsrc_1','xiaohongshu','account_1','测试账号','active',$1,$2,$2)`, now.Add(-time.Minute), now)
	if err != nil {
		t.Fatal(err)
	}
	store := NewPostgresStore(pool)
	queued, err := store.QueueDueRuns(ctx, now, 100)
	if err != nil || queued != 1 {
		t.Fatalf("queued=%d err=%v", queued, err)
	}
	run, ok, err := store.ClaimNextRun(ctx, now)
	if err != nil || !ok || run.Status != SyncRunStatusRunning {
		t.Fatalf("run=%#v ok=%v err=%v", run, ok, err)
	}
	batch := Batch{
		Contents:            []Content{{ExternalContentID: "note_1", Title: "笔记"}},
		ContentDailyMetrics: []ContentDailyMetric{{ExternalContentID: "note_1", StatDate: today, ExposureCount: 10, LikeCount: 2, FavoriteCount: 1, CommentCount: 1}},
		AccountDailyMetrics: []AccountDailyMetric{{StatDate: today, NewFollowerCount: 3}},
	}
	for _, exposure := range []int64{10, 25} {
		batch.ContentDailyMetrics[0].ExposureCount = exposure
		if count, err := store.UpsertBatch(ctx, run.SourceID, run.RunID, batch, now); err != nil || count != 3 {
			t.Fatalf("upsert count=%d err=%v", count, err)
		}
	}
	var rows, exposure int64
	if err := pool.QueryRow(ctx, `SELECT COUNT(*),MAX(exposure_count) FROM business_content_daily_metrics`).Scan(&rows, &exposure); err != nil {
		t.Fatal(err)
	}
	if rows != 1 || exposure != 25 {
		t.Fatalf("rows=%d exposure=%d", rows, exposure)
	}
	finished := now.Add(time.Minute)
	run.Status = SyncRunStatusSuccess
	run.FetchedCount = batch.RecordCount()
	run.UpsertedCount = batch.RecordCount()
	run.FinishedAt = &finished
	if err := store.CompleteRun(ctx, run); err != nil {
		t.Fatal(err)
	}
	secondRun := insertRunningRun(t, pool, "bdrun_2", run.SourceID, today, now.Add(2*time.Minute))
	batch.ContentDailyMetrics[0].ExposureCount = 30
	if _, err := store.UpsertBatch(ctx, secondRun.SourceID, secondRun.RunID, batch, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	var correctedRunID string
	if err := pool.QueryRow(ctx, `SELECT sync_run_id FROM business_content_daily_metrics WHERE source_id='bdsrc_1' AND external_content_id='note_1' AND stat_date=$1`, today).Scan(&correctedRunID); err != nil {
		t.Fatal(err)
	}
	if correctedRunID != secondRun.RunID {
		t.Fatalf("sync_run_id=%q", correctedRunID)
	}
	completeTestRun(t, store, secondRun, batch.RecordCount(), now.Add(3*time.Minute))
	r := DashboardRange{Name: Range7Days, StartDate: today.AddDate(0, 0, -6), EndDate: today, PreviousStart: today.AddDate(0, 0, -13), PreviousEnd: today.AddDate(0, 0, -7)}
	dashboard, err := store.XiaohongshuDashboard(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	if dashboard.State.DataStatus != DataStatusAvailable || dashboard.Summary.ExposureCount != 30 || dashboard.Summary.InteractionCount != 4 || len(dashboard.Trend) != 7 {
		t.Fatalf("dashboard=%#v", dashboard)
	}
}

func TestPostgresStoreConstraintsRollbackAndRecovery(t *testing.T) {
	pool := openBusinessDataTestPool(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 14, 3, 0, 0, 0, time.UTC)
	today := time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC)
	insertTestSource(t, pool, "bdsrc_constraints", ProviderXiaohongshu, "account_constraints", now)
	if _, err := pool.Exec(ctx, `INSERT INTO business_data_sources (source_id,provider,external_account_id,name,status,created_at,updated_at) VALUES ('bdsrc_duplicate','xiaohongshu','account_constraints','重复','active',$1,$1)`, now); err == nil {
		t.Fatal("provider + external_account_id duplicate was accepted")
	}
	run := insertRunningRun(t, pool, "bdrun_constraints", "bdsrc_constraints", today, now)
	if _, err := pool.Exec(ctx, `INSERT INTO business_sync_runs (run_id,source_id,start_date,end_date,status,created_at,updated_at) VALUES ('bdrun_duplicate','bdsrc_constraints',$1,$1,'queued',$2,$2)`, today, now); err == nil {
		t.Fatal("second active run was accepted")
	}
	store := NewPostgresStore(pool)
	invalid := Batch{
		Contents:            []Content{{ExternalContentID: "note_rollback", Title: "应回滚"}},
		ContentDailyMetrics: []ContentDailyMetric{{ExternalContentID: "missing_note", StatDate: today, ExposureCount: 1}},
	}
	if _, err := store.UpsertBatch(ctx, run.SourceID, run.RunID, invalid, now); err == nil {
		t.Fatal("foreign key failure was accepted")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM business_contents WHERE source_id=$1`, run.SourceID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("batch did not roll back: count=%d err=%v", count, err)
	}
	interruptedAt := now.Add(time.Minute)
	if err := store.RecoverRunningRuns(ctx, interruptedAt); err != nil {
		t.Fatal(err)
	}
	var status, code string
	if err := pool.QueryRow(ctx, `SELECT status,error_code FROM business_sync_runs WHERE run_id=$1`, run.RunID).Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	if status != SyncRunStatusFailed || code != "run_interrupted" {
		t.Fatalf("status=%q code=%q", status, code)
	}
}

func TestPostgresStoreSourceScopedTopItemsAndDouyinDashboard(t *testing.T) {
	pool := openBusinessDataTestPool(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 14, 3, 0, 0, 0, time.UTC)
	today := time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC)
	store := NewPostgresStore(pool)
	rangeValue := DashboardRange{Name: RangeToday, StartDate: today, EndDate: today, PreviousStart: today.AddDate(0, 0, -1), PreviousEnd: today.AddDate(0, 0, -1)}

	insertTestSource(t, pool, "bdsrc_d1", ProviderDouyinAds, "douyin_1", now)
	unavailable, err := store.DouyinAdsDashboard(ctx, rangeValue)
	if err != nil || unavailable.State.DataStatus != DataStatusUnavailable || unavailable.State.LastSyncedAt != nil {
		t.Fatalf("unavailable=%#v err=%v", unavailable, err)
	}
	insertTestSource(t, pool, "bdsrc_d2", ProviderDouyinAds, "douyin_2", now)
	for index, sourceID := range []string{"bdsrc_d1", "bdsrc_d2"} {
		run := insertRunningRun(t, pool, fmt.Sprintf("bdrun_d%d", index+1), sourceID, today, now)
		batch := Batch{
			Campaigns:            []Campaign{{ExternalCampaignID: "campaign_same", Name: "同名计划", CampaignType: "video"}},
			CampaignDailyMetrics: []CampaignDailyMetric{{ExternalCampaignID: "campaign_same", StatDate: today, SpendMinor: 100, ImpressionCount: 20, VideoPlayCount: 10, ClickCount: 2}},
		}
		if _, err := store.UpsertBatch(ctx, sourceID, run.RunID, batch, now); err != nil {
			t.Fatal(err)
		}
		completeTestRun(t, store, run, batch.RecordCount(), now.Add(time.Minute))
	}
	douyin, err := store.DouyinAdsDashboard(ctx, rangeValue)
	if err != nil || douyin.State.DataStatus != DataStatusAvailable || douyin.Summary.SpendMinor != 200 || len(douyin.TopItems) != 2 || len(douyin.Trend) != 1 {
		t.Fatalf("douyin=%#v err=%v", douyin, err)
	}

	for index, sourceID := range []string{"bdsrc_x1", "bdsrc_x2"} {
		insertTestSource(t, pool, sourceID, ProviderXiaohongshu, fmt.Sprintf("xhs_%d", index+1), now)
		run := insertRunningRun(t, pool, fmt.Sprintf("bdrun_x%d", index+1), sourceID, today, now)
		batch := Batch{
			Contents:            []Content{{ExternalContentID: "note_same", Title: "同名笔记"}},
			ContentDailyMetrics: []ContentDailyMetric{{ExternalContentID: "note_same", StatDate: today, ExposureCount: 50}},
		}
		if _, err := store.UpsertBatch(ctx, sourceID, run.RunID, batch, now); err != nil {
			t.Fatal(err)
		}
		completeTestRun(t, store, run, batch.RecordCount(), now.Add(time.Minute))
	}
	xiaohongshu, err := store.XiaohongshuDashboard(ctx, rangeValue)
	if err != nil || xiaohongshu.Summary.ExposureCount != 100 || len(xiaohongshu.TopItems) != 2 {
		t.Fatalf("xiaohongshu=%#v err=%v", xiaohongshu, err)
	}
}

func TestPostgresStoreBilibiliSnapshotIdempotenceAndLatestDashboard(t *testing.T) {
	pool := openBusinessDataTestPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)
	now := time.Date(2026, 8, 28, 2, 10, 0, 0, time.UTC)
	location, _ := time.LoadLocation(Timezone)
	dayOne := time.Date(2026, 8, 28, 0, 0, 0, 0, location)
	insertTestSource(t, pool, "bdsrc_bili", ProviderBilibili, "open-1", now)

	write := func(runID string, date, captured time.Time, views int64) {
		run := insertRunningRun(t, pool, runID, "bdsrc_bili", date, captured)
		batch := Batch{
			SourceName:               "B 站账号",
			Contents:                 []Content{{ExternalContentID: "BV1", Title: "稿件", ContentType: "video", Status: "published", PublishedAt: &captured}},
			BilibiliAccountSnapshots: []BilibiliAccountSnapshot{{SnapshotDate: date, CapturedAt: captured, FollowerCount: views / 10, FollowingCount: 9, PublishedCount: 5}},
			BilibiliContentSnapshots: []BilibiliContentSnapshot{{ExternalContentID: "BV1", SnapshotDate: date, CapturedAt: captured, ViewCount: views, DanmakuCount: 3, ReplyCount: 4, FavoriteCount: 5, CoinCount: 1, ShareCount: 6, LikeCount: 2}},
		}
		if count, err := store.UpsertBatch(ctx, run.SourceID, run.RunID, batch, captured); err != nil || count != 3 {
			t.Fatalf("count=%d err=%v", count, err)
		}
		completeTestRun(t, store, run, batch.RecordCount(), captured.Add(time.Minute))
	}
	write("bdrun_bili_1", dayOne, now, 100)
	write("bdrun_bili_2", dayOne, now.Add(time.Hour), 150)
	dayTwo := dayOne.AddDate(0, 0, 1)
	write("bdrun_bili_3", dayTwo, now.Add(24*time.Hour), 220)

	var snapshotRows, dailyRows int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM bilibili_content_metric_snapshots`).Scan(&snapshotRows); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM business_content_daily_metrics WHERE source_id='bdsrc_bili'`).Scan(&dailyRows); err != nil {
		t.Fatal(err)
	}
	if snapshotRows != 2 || dailyRows != 0 {
		t.Fatalf("snapshotRows=%d dailyRows=%d", snapshotRows, dailyRows)
	}
	rangeDays := DashboardRange{StartDate: dayOne, EndDate: dayTwo}
	dashboard, err := store.BilibiliDashboard(ctx, "bdsrc_bili", rangeDays)
	if err != nil || dashboard.State.DataStatus != DataStatusAvailable || dashboard.ViewCount != 220 || dashboard.FollowerCount != 22 || dashboard.FollowingCount != 9 || dashboard.PublishedCount != 5 || dashboard.DanmakuCount != 3 || dashboard.ReplyCount != 4 || dashboard.FavoriteCount != 5 || dashboard.CoinCount != 1 || dashboard.ShareCount != 6 || dashboard.LikeCount != 2 || dashboard.InteractionCount != 21 || len(dashboard.TopContents) != 1 || dashboard.TopContents[0].InteractionCount != 21 {
		t.Fatalf("dashboard=%#v err=%v", dashboard, err)
	}
	top := dashboard.TopContents[0]
	if top.Status != "published" || top.PublishedAt == nil || top.DanmakuCount != 3 || top.ReplyCount != 4 || top.FavoriteCount != 5 || top.CoinCount != 1 || top.ShareCount != 6 || top.LikeCount != 2 {
		t.Fatalf("top content=%#v", top)
	}
	if len(dashboard.Trend) != 2 || dashboard.Trend[0].ViewCount != 150 || dashboard.Trend[1].ViewCountDelta != 70 || dashboard.Trend[1].FollowerCountDelta != 7 {
		t.Fatalf("trend=%#v", dashboard.Trend)
	}

	deauthorizedAt := now.Add(25 * time.Hour)
	for range 2 {
		if err := store.DisableBilibiliAuthorization(ctx, "open-1", deauthorizedAt); err != nil {
			t.Fatal(err)
		}
	}
	var status, errorCode string
	var nextSyncAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT status,next_sync_at,last_error_code FROM business_data_sources WHERE source_id='bdsrc_bili'`).Scan(&status, &nextSyncAt, &errorCode); err != nil {
		t.Fatal(err)
	}
	if status != SourceStatusDisabled || nextSyncAt != nil || errorCode != "bilibili_deauthorized" {
		t.Fatalf("status=%q nextSyncAt=%v errorCode=%q", status, nextSyncAt, errorCode)
	}
}

func TestPostgresStoreQueuesManualProviderRunsIdempotently(t *testing.T) {
	pool := openBusinessDataTestPool(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	insertTestSource(t, pool, "bdsrc_manual_1", ProviderBilibili, "open-manual-1", now)
	insertTestSource(t, pool, "bdsrc_manual_2", ProviderBilibili, "open-manual-2", now)
	insertTestSource(t, pool, "bdsrc_disabled", ProviderBilibili, "open-disabled", now)
	if _, err := pool.Exec(ctx, `UPDATE business_data_sources SET status='disabled' WHERE source_id='bdsrc_disabled'`); err != nil {
		t.Fatal(err)
	}
	store := NewPostgresStore(pool)
	first, err := store.QueueProviderRuns(ctx, ProviderBilibili, now)
	if err != nil || first.SourceCount != 2 || first.QueuedCount != 2 {
		t.Fatalf("first=%#v err=%v", first, err)
	}
	second, err := store.QueueProviderRuns(ctx, ProviderBilibili, now.Add(time.Second))
	if err != nil || second.SourceCount != 2 || second.QueuedCount != 0 {
		t.Fatalf("second=%#v err=%v", second, err)
	}
	var queued int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM business_sync_runs WHERE status='queued'`).Scan(&queued); err != nil || queued != 2 {
		t.Fatalf("queued=%d err=%v", queued, err)
	}
}

func TestPostgresStoreBilibiliSourceManagementLifecycle(t *testing.T) {
	pool := openBusinessDataTestPool(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	store := NewPostgresStore(pool)
	insertTestSource(t, pool, "bdsrc_manage_1", ProviderBilibili, "open-manage-1", now)
	insertTestSource(t, pool, "bdsrc_manage_2", ProviderBilibili, "open-manage-2", now)
	insertTestSource(t, pool, "bdsrc_other", ProviderXiaohongshu, "other-account", now)
	if _, err := pool.Exec(ctx, `UPDATE business_data_sources SET name=CASE source_id WHEN 'bdsrc_manage_1' THEN 'Account A' ELSE 'Account B' END WHERE source_id IN ('bdsrc_manage_1','bdsrc_manage_2')`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO business_data_source_credentials
(source_id,access_token_ciphertext,refresh_token_ciphertext,token_expires_at,scopes,created_at,updated_at)
VALUES ('bdsrc_manage_1',$1,$2,$3,$4,$5,$5)`, []byte("access-ciphertext"), []byte("refresh-ciphertext"), now.Add(time.Hour), []string{"USER_INFO"}, now); err != nil {
		t.Fatal(err)
	}

	first, err := store.QueueBilibiliSourceRun(ctx, "bdsrc_manage_1", now)
	if err != nil || first.SourceCount != 1 || first.QueuedCount != 1 {
		t.Fatalf("first queue=%#v err=%v", first, err)
	}
	second, err := store.QueueBilibiliSourceRun(ctx, "bdsrc_manage_1", now.Add(time.Second))
	if err != nil || second.QueuedCount != 0 {
		t.Fatalf("second queue=%#v err=%v", second, err)
	}
	if _, err := store.QueueBilibiliSourceRun(ctx, "bdsrc_other", now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other provider error=%v", err)
	}
	items, err := store.ListBilibiliSources(ctx)
	if err != nil || len(items) != 2 || items[0].SourceID != "bdsrc_manage_1" || items[0].ActiveRunStatus != SyncRunStatusQueued {
		t.Fatalf("items=%#v err=%v", items, err)
	}

	disabled, err := store.SetBilibiliSourceSyncEnabled(ctx, "bdsrc_manage_1", false, now.Add(time.Minute))
	if err != nil || disabled.Source.Status != SourceStatusDisabled || disabled.Source.StatusReason != BilibiliSyncDisabledCode || disabled.Source.NextSyncAt != nil || disabled.Source.ActiveRunStatus != "" {
		t.Fatalf("disabled=%#v err=%v", disabled, err)
	}
	var credentialCount, failedRunCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM business_data_source_credentials WHERE source_id='bdsrc_manage_1'`).Scan(&credentialCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM business_sync_runs WHERE source_id='bdsrc_manage_1' AND status='failed' AND error_code=$1`, BilibiliSyncDisabledCode).Scan(&failedRunCount); err != nil {
		t.Fatal(err)
	}
	if credentialCount != 1 || failedRunCount != 1 {
		t.Fatalf("credentialCount=%d failedRunCount=%d", credentialCount, failedRunCount)
	}
	if _, err := store.QueueBilibiliSourceRun(ctx, "bdsrc_manage_1", now.Add(2*time.Minute)); !errors.Is(err, ErrBilibiliSourceDisabled) {
		t.Fatalf("disabled queue error=%v", err)
	}

	restored, err := store.SetBilibiliSourceSyncEnabled(ctx, "bdsrc_manage_1", true, now.Add(3*time.Minute))
	if err != nil || restored.Source.Status != SourceStatusActive || restored.QueuedCount != 1 || restored.Source.ActiveRunStatus != SyncRunStatusQueued || restored.Source.NextSyncAt == nil {
		t.Fatalf("restored=%#v err=%v", restored, err)
	}
	if _, err := store.SetBilibiliSourceSyncEnabled(ctx, "bdsrc_manage_1", true, now.Add(4*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE business_data_sources SET status='disabled',last_error_code='bilibili_deauthorized' WHERE source_id='bdsrc_manage_2'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetBilibiliSourceSyncEnabled(ctx, "bdsrc_manage_2", true, now.Add(5*time.Minute)); !errors.Is(err, ErrBilibiliSourceAuthorizationRequired) {
		t.Fatalf("deauthorized restore error=%v", err)
	}
}

func TestPostgresStoreDeletesBilibiliSourceAndCollectedData(t *testing.T) {
	pool := openBusinessDataTestPool(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	today := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC)
	store := NewPostgresStore(pool)
	insertTestSource(t, pool, "bdsrc_delete_active", ProviderBilibili, "open-delete-active", now)
	insertTestSource(t, pool, "bdsrc_delete_disabled", ProviderBilibili, "open-delete-disabled", now)
	insertTestSource(t, pool, "bdsrc_delete_other", ProviderXiaohongshu, "open-delete-other", now)
	if _, err := pool.Exec(ctx, `UPDATE business_data_sources SET status='disabled' WHERE source_id='bdsrc_delete_disabled'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO business_data_source_credentials
(source_id,access_token_ciphertext,refresh_token_ciphertext,token_expires_at,scopes,created_at,updated_at)
VALUES ('bdsrc_delete_active',$1,$2,$3,$4,$5,$5)`, []byte("access"), []byte("refresh"), now.Add(time.Hour), []string{"USER_INFO"}, now); err != nil {
		t.Fatal(err)
	}
	run := insertRunningRun(t, pool, "bdrun_delete", "bdsrc_delete_active", today, now)
	batch := Batch{
		Contents:                 []Content{{ExternalContentID: "BV_DELETE", Title: "待删除稿件", ContentType: "video"}},
		BilibiliAccountSnapshots: []BilibiliAccountSnapshot{{SnapshotDate: today, CapturedAt: now, FollowerCount: 10}},
		BilibiliContentSnapshots: []BilibiliContentSnapshot{{ExternalContentID: "BV_DELETE", SnapshotDate: today, CapturedAt: now, ViewCount: 100}},
	}
	if _, err := store.UpsertBatch(ctx, run.SourceID, run.RunID, batch, now); err != nil {
		t.Fatal(err)
	}
	completeTestRun(t, store, run, batch.RecordCount(), now.Add(time.Minute))

	if err := store.DeleteBilibiliSource(ctx, "bdsrc_delete_active"); err != nil {
		t.Fatal(err)
	}
	if counts := bilibiliStoredRowCounts(t, pool, "bdsrc_delete_active"); counts != [5]int{} {
		t.Fatalf("collected rows remain after delete: %v", counts)
	}
	var sourceCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM business_data_sources WHERE source_id='bdsrc_delete_active'`).Scan(&sourceCount); err != nil || sourceCount != 0 {
		t.Fatalf("sourceCount=%d err=%v", sourceCount, err)
	}
	if err := store.DeleteBilibiliSource(ctx, "bdsrc_delete_disabled"); err != nil {
		t.Fatalf("delete disabled source: %v", err)
	}
	if err := store.DeleteBilibiliSource(ctx, "bdsrc_delete_other"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other provider error=%v", err)
	}
	if err := store.DeleteBilibiliSource(ctx, "bdsrc_missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing source error=%v", err)
	}
}

func TestPostgresStoreDisabledBilibiliSourceRejectsBatchAndPreservesReason(t *testing.T) {
	pool := openBusinessDataTestPool(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	today := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC)
	store := NewPostgresStore(pool)
	insertTestSource(t, pool, "bdsrc_disabled_write", ProviderBilibili, "open-disabled-write", now)
	run := insertRunningRun(t, pool, "bdrun_disabled_write", "bdsrc_disabled_write", today, now)
	if _, err := store.SetBilibiliSourceSyncEnabled(ctx, run.SourceID, false, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	batch := Batch{BilibiliAccountSnapshots: []BilibiliAccountSnapshot{{SnapshotDate: today, CapturedAt: now, FollowerCount: 10}}}
	if _, err := store.UpsertBatch(ctx, run.SourceID, run.RunID, batch, now.Add(2*time.Minute)); !errors.Is(err, ErrBilibiliSourceDisabled) {
		t.Fatalf("UpsertBatch error=%v", err)
	}
	finished := now.Add(3 * time.Minute)
	run.Status = SyncRunStatusFailed
	run.ErrorCode = "store_failed"
	run.ErrorSummary = "business data write failed"
	run.FinishedAt = &finished
	if err := store.CompleteRun(ctx, run); err != nil {
		t.Fatal(err)
	}
	var status, code string
	if err := pool.QueryRow(ctx, `SELECT status,last_error_code FROM business_data_sources WHERE source_id=$1`, run.SourceID).Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	if status != SourceStatusDisabled || code != BilibiliSyncDisabledCode {
		t.Fatalf("status=%q code=%q", status, code)
	}
}

func TestPostgresStoreBilibiliDisableWinsConcurrentBatch(t *testing.T) {
	pool := openBusinessDataTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	now := time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	today := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC)
	store := NewPostgresStore(pool)
	insertTestSource(t, pool, "bdsrc_disable_first", ProviderBilibili, "open-disable-first", now)
	run := insertRunningRun(t, pool, "bdrun_disable_first", "bdsrc_disable_first", today, now)

	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT source_id FROM business_data_sources WHERE source_id=$1 FOR UPDATE`, run.SourceID); err != nil {
		t.Fatal(err)
	}
	type disableResult struct {
		change BilibiliSourceChange
		err    error
	}
	disabled := make(chan disableResult, 1)
	go func() {
		change, err := store.SetBilibiliSourceSyncEnabled(ctx, run.SourceID, false, now.Add(time.Minute))
		disabled <- disableResult{change: change, err: err}
	}()
	waitForPostgresLockWait(t, pool, "SELECT source_id,name,status,last_error_code")

	batchDone := make(chan error, 1)
	go func() {
		_, err := store.UpsertBatch(ctx, run.SourceID, run.RunID, Batch{
			BilibiliAccountSnapshots: []BilibiliAccountSnapshot{{SnapshotDate: today, CapturedAt: now, FollowerCount: 10}},
		}, now.Add(2*time.Minute))
		batchDone <- err
	}()
	waitForPostgresLockWait(t, pool, "SELECT s.provider,s.status,r.start_date")
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	result := <-disabled
	if result.err != nil || result.change.Source.Status != SourceStatusDisabled {
		t.Fatalf("disable=%#v err=%v", result.change, result.err)
	}
	if err := <-batchDone; !errors.Is(err, ErrBilibiliSourceDisabled) {
		t.Fatalf("UpsertBatch error=%v", err)
	}
	var snapshots int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM bilibili_account_metric_snapshots WHERE source_id=$1`, run.SourceID).Scan(&snapshots); err != nil || snapshots != 0 {
		t.Fatalf("snapshots=%d err=%v", snapshots, err)
	}
}

func TestPostgresStoreBilibiliBatchWinsConcurrentDisable(t *testing.T) {
	pool := openBusinessDataTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	now := time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	today := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC)
	store := NewPostgresStore(pool)
	insertTestSource(t, pool, "bdsrc_batch_first", ProviderBilibili, "open-batch-first", now)
	run := insertRunningRun(t, pool, "bdrun_batch_first", "bdsrc_batch_first", today, now)

	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT source_id FROM business_data_sources WHERE source_id=$1 FOR UPDATE`, run.SourceID); err != nil {
		t.Fatal(err)
	}
	batchDone := make(chan error, 1)
	go func() {
		_, err := store.UpsertBatch(ctx, run.SourceID, run.RunID, Batch{
			BilibiliAccountSnapshots: []BilibiliAccountSnapshot{{SnapshotDate: today, CapturedAt: now, FollowerCount: 20}},
		}, now.Add(time.Minute))
		batchDone <- err
	}()
	waitForPostgresLockWait(t, pool, "SELECT s.provider,s.status,r.start_date")

	disableDone := make(chan error, 1)
	go func() {
		_, err := store.SetBilibiliSourceSyncEnabled(ctx, run.SourceID, false, now.Add(2*time.Minute))
		disableDone <- err
	}()
	waitForPostgresLockWait(t, pool, "SELECT source_id,name,status,last_error_code")
	select {
	case err := <-disableDone:
		t.Fatalf("disable returned before the batch lock was released: %v", err)
	default:
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-batchDone; err != nil {
		t.Fatalf("UpsertBatch error=%v", err)
	}
	if err := <-disableDone; err != nil {
		t.Fatalf("disable error=%v", err)
	}
	var snapshots int
	var status string
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM bilibili_account_metric_snapshots WHERE source_id=$1`, run.SourceID).Scan(&snapshots); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT status FROM business_data_sources WHERE source_id=$1`, run.SourceID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if snapshots != 1 || status != SourceStatusDisabled {
		t.Fatalf("snapshots=%d status=%q", snapshots, status)
	}
}

func TestPostgresStoreBilibiliDisablePreservesCollectedData(t *testing.T) {
	pool := openBusinessDataTestPool(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	today := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC)
	store := NewPostgresStore(pool)
	insertTestSource(t, pool, "bdsrc_preserve", ProviderBilibili, "open-preserve", now)
	if _, err := pool.Exec(ctx, `INSERT INTO business_data_source_credentials
(source_id,access_token_ciphertext,refresh_token_ciphertext,token_expires_at,scopes,created_at,updated_at)
VALUES ('bdsrc_preserve',$1,$2,$3,$4,$5,$5)`, []byte("access"), []byte("refresh"), now.Add(time.Hour), []string{"USER_INFO"}, now); err != nil {
		t.Fatal(err)
	}
	run := insertRunningRun(t, pool, "bdrun_preserve", "bdsrc_preserve", today, now)
	batch := Batch{
		Contents:                 []Content{{ExternalContentID: "BV_PRESERVE", Title: "保留稿件", ContentType: "video"}},
		BilibiliAccountSnapshots: []BilibiliAccountSnapshot{{SnapshotDate: today, CapturedAt: now, FollowerCount: 10}},
		BilibiliContentSnapshots: []BilibiliContentSnapshot{{ExternalContentID: "BV_PRESERVE", SnapshotDate: today, CapturedAt: now, ViewCount: 100}},
	}
	if _, err := store.UpsertBatch(ctx, run.SourceID, run.RunID, batch, now); err != nil {
		t.Fatal(err)
	}
	completeTestRun(t, store, run, batch.RecordCount(), now.Add(time.Minute))
	before := bilibiliStoredRowCounts(t, pool, run.SourceID)
	if _, err := store.SetBilibiliSourceSyncEnabled(ctx, run.SourceID, false, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	after := bilibiliStoredRowCounts(t, pool, run.SourceID)
	if before != after {
		t.Fatalf("stored rows changed after disable: before=%v after=%v", before, after)
	}
}

func TestPostgresStoreBilibiliDashboardSeparatesSources(t *testing.T) {
	pool := openBusinessDataTestPool(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	today := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC)
	store := NewPostgresStore(pool)
	rangeToday := DashboardRange{StartDate: today, EndDate: today}

	state, err := store.BilibiliDashboardOverview(ctx)
	if err != nil || state.DataStatus != DataStatusUnconfigured {
		t.Fatalf("no accounts state=%#v err=%v", state, err)
	}
	insertTestSource(t, pool, "bdsrc_aggregate_1", ProviderBilibili, "open-aggregate-1", now)
	if _, err := pool.Exec(ctx, `UPDATE business_data_sources SET name='账号甲',status='disabled' WHERE source_id='bdsrc_aggregate_1'`); err != nil {
		t.Fatal(err)
	}
	dashboard, err := store.BilibiliDashboard(ctx, "bdsrc_aggregate_1", rangeToday)
	if err != nil || dashboard.State.DataStatus != DataStatusUnavailable {
		t.Fatalf("all disabled dashboard=%#v err=%v", dashboard, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE business_data_sources SET status='active' WHERE source_id='bdsrc_aggregate_1'`); err != nil {
		t.Fatal(err)
	}
	dashboard, err = store.BilibiliDashboard(ctx, "bdsrc_aggregate_1", rangeToday)
	if err != nil || dashboard.State.DataStatus != DataStatusUnavailable {
		t.Fatalf("no successful run dashboard=%#v err=%v", dashboard, err)
	}

	insertTestSource(t, pool, "bdsrc_aggregate_2", ProviderBilibili, "open-aggregate-2", now)
	insertTestSource(t, pool, "bdsrc_aggregate_disabled", ProviderBilibili, "open-aggregate-disabled", now)
	if _, err := pool.Exec(ctx, `UPDATE business_data_sources SET name=CASE source_id
WHEN 'bdsrc_aggregate_2' THEN '账号乙' WHEN 'bdsrc_aggregate_disabled' THEN '停用账号' ELSE name END`); err != nil {
		t.Fatal(err)
	}
	writeBilibiliDashboardBatch(t, store, "bdsrc_aggregate_1", "bdrun_aggregate_1", today, now, 100, 1, 10)
	writeBilibiliDashboardBatch(t, store, "bdsrc_aggregate_2", "bdrun_aggregate_2", today, now.Add(time.Minute), 200, 20, 100)
	writeBilibiliDashboardBatch(t, store, "bdsrc_aggregate_disabled", "bdrun_aggregate_disabled", today, now.Add(2*time.Minute), 1000, 1, 1000)
	if _, err := store.SetBilibiliSourceSyncEnabled(ctx, "bdsrc_aggregate_disabled", false, now.Add(3*time.Minute)); err != nil {
		t.Fatal(err)
	}

	dashboard, err = store.BilibiliDashboard(ctx, "bdsrc_aggregate_1", rangeToday)
	if err != nil || dashboard.State.DataStatus != DataStatusAvailable || dashboard.Account.SourceID != "bdsrc_aggregate_1" || dashboard.Account.Name != "账号甲" {
		t.Fatalf("account one dashboard=%#v err=%v", dashboard, err)
	}
	if dashboard.FollowerCount != 100 || dashboard.CollectedContentCount != 1 || dashboard.ViewCount != 10 || len(dashboard.TopContents) != 1 || len(dashboard.Trend) != 1 || dashboard.Trend[0].FollowerCount != 100 || dashboard.Trend[0].ViewCount != 10 {
		t.Fatalf("account one mixed dashboard=%#v", dashboard)
	}

	dashboard, err = store.BilibiliDashboard(ctx, "bdsrc_aggregate_2", rangeToday)
	if err != nil || dashboard.State.DataStatus != DataStatusAvailable || dashboard.Account.SourceID != "bdsrc_aggregate_2" || dashboard.FollowerCount != 200 || dashboard.CollectedContentCount != 20 || dashboard.ViewCount != 2190 || len(dashboard.TopContents) != 20 || dashboard.Trend[0].ViewCount != 2190 {
		t.Fatalf("account two mixed dashboard=%#v err=%v", dashboard, err)
	}
	for _, item := range dashboard.TopContents {
		if item.SourceID != "bdsrc_aggregate_2" || item.AccountName != "账号乙" {
			t.Fatalf("other account included in top contents: %#v", item)
		}
	}

	dashboard, err = store.BilibiliDashboard(ctx, "bdsrc_aggregate_disabled", rangeToday)
	if err != nil || dashboard.State.DataStatus != DataStatusAvailable || dashboard.Account.Status != SourceStatusDisabled || dashboard.FollowerCount != 1000 || dashboard.ViewCount != 1000 {
		t.Fatalf("disabled account history dashboard=%#v err=%v", dashboard, err)
	}
	if _, err := store.BilibiliDashboard(ctx, "bdsrc_missing", rangeToday); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing account error=%v", err)
	}
}

func waitForPostgresLockWait(t *testing.T, pool *pgxpool.Pool, queryFragment string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		err := pool.QueryRow(context.Background(), `SELECT EXISTS (
SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%' || $1 || '%'
)`, queryFragment).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for PostgreSQL lock: query fragment %q", queryFragment)
}

func bilibiliStoredRowCounts(t *testing.T, pool *pgxpool.Pool, sourceID string) [5]int {
	t.Helper()
	tables := []string{"business_data_source_credentials", "business_contents", "bilibili_account_metric_snapshots", "bilibili_content_metric_snapshots", "business_sync_runs"}
	var counts [5]int
	for index, table := range tables {
		if err := pool.QueryRow(context.Background(), "SELECT COUNT(*) FROM "+table+" WHERE source_id=$1", sourceID).Scan(&counts[index]); err != nil {
			t.Fatal(err)
		}
	}
	return counts
}

func writeBilibiliDashboardBatch(t *testing.T, store *PostgresStore, sourceID, runID string, date, capturedAt time.Time, followers int64, contentCount int, baseViews int64) {
	t.Helper()
	run := insertRunningRun(t, store.pool, runID, sourceID, date, capturedAt)
	batch := Batch{BilibiliAccountSnapshots: []BilibiliAccountSnapshot{{SnapshotDate: date, CapturedAt: capturedAt, FollowerCount: followers}}}
	for index := range contentCount {
		externalID := fmt.Sprintf("BV_%s_%02d", sourceID, index)
		batch.Contents = append(batch.Contents, Content{ExternalContentID: externalID, Title: fmt.Sprintf("稿件 %d", index), ContentType: "video"})
		batch.BilibiliContentSnapshots = append(batch.BilibiliContentSnapshots, BilibiliContentSnapshot{
			ExternalContentID: externalID, SnapshotDate: date, CapturedAt: capturedAt, ViewCount: baseViews + int64(index), LikeCount: 1,
		})
	}
	if _, err := store.UpsertBatch(context.Background(), sourceID, runID, batch, capturedAt); err != nil {
		t.Fatal(err)
	}
	completeTestRun(t, store, run, batch.RecordCount(), capturedAt.Add(time.Second))
}

func insertTestSource(t *testing.T, pool *pgxpool.Pool, sourceID, provider, accountID string, now time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `INSERT INTO business_data_sources (source_id,provider,external_account_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,$3,'active',$4,$4)`, sourceID, provider, accountID, now); err != nil {
		t.Fatal(err)
	}
}

func insertRunningRun(t *testing.T, pool *pgxpool.Pool, runID, sourceID string, date, now time.Time) SyncRun {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `INSERT INTO business_sync_runs (run_id,source_id,start_date,end_date,status,started_at,created_at,updated_at) VALUES ($1,$2,$3,$3,'running',$4,$4,$4)`, runID, sourceID, date, now); err != nil {
		t.Fatal(err)
	}
	started := now
	return SyncRun{RunID: runID, SourceID: sourceID, StartDate: date, EndDate: date, Status: SyncRunStatusRunning, StartedAt: &started, CreatedAt: now, UpdatedAt: now}
}

func completeTestRun(t *testing.T, store *PostgresStore, run SyncRun, count int64, finished time.Time) {
	t.Helper()
	run.Status = SyncRunStatusSuccess
	run.FetchedCount = count
	run.UpsertedCount = count
	run.FinishedAt = &finished
	if err := store.CompleteRun(context.Background(), run); err != nil {
		t.Fatal(err)
	}
}

func openBusinessDataTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("CLAW_MCP_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("CLAW_MCP_TEST_DATABASE_URL 未设置，跳过 PostgreSQL 业务数据集成测试")
	}
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme == "" || !strings.HasSuffix(strings.TrimPrefix(parsed.Path, "/"), "_test") {
		t.Fatal("CLAW_MCP_TEST_DATABASE_URL 必须指向名称以 _test 结尾的数据库")
	}
	base, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if err := base.Ping(context.Background()); err != nil {
		base.Close()
		t.Fatalf("测试数据库不可用: %v", err)
	}
	schema := newID("businessdata_test")
	if _, err := base.Exec(context.Background(), "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		base.Close()
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		base.Close()
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		base.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = base.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		base.Close()
	})
	for _, migration := range []string{"../../db/migrations/00040_business_data_collection.sql", "../../db/migrations/00044_bilibili_business_data.sql"} {
		raw, err := os.ReadFile(migration)
		if err != nil {
			t.Fatal(err)
		}
		up := strings.SplitN(string(raw), "\n-- +goose Down", 2)[0]
		up = strings.TrimPrefix(up, "-- +goose Up\n")
		if _, err := pool.Exec(context.Background(), up); err != nil {
			t.Fatalf("应用业务数据迁移 %s: %v", migration, err)
		}
	}
	return pool
}
