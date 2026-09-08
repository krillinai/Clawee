package skillhub

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

type sourcePostgresPool interface {
	postgresPool
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

type PostgresSourceStore struct {
	pool sourcePostgresPool
}

func NewPostgresSourceStore(pool sourcePostgresPool) *PostgresSourceStore {
	return &PostgresSourceStore{pool: pool}
}

const sourceSelect = `SELECT source_id,space_id,provider,repository_owner,repository_name,branch,scan_root,exclude_paths,token_ciphertext,auto_publish,schedule,status,last_attempt_at,last_success_at,last_synced_commit_sha,sync_revision,last_error_summary,created_by,created_at,updated_at FROM skill_sources`

const sourceItemSelect = `SELECT source_item_id,source_id,skill_path,discovered_name,skill_id,status,last_seen_commit_sha,last_content_sha256,last_version_id,last_error_summary,missing_since,created_at,updated_at FROM skill_source_items`

const sourceSyncRunSelect = `SELECT run_id,source_id,trigger,repository_mode,status,requested_by,source_revision,before_commit_sha,target_commit_sha,discovered_count,created_version_count,published_count,conflict_count,failed_count,error_summary,started_at,finished_at,created_at FROM skill_source_sync_runs`

func (s *PostgresSourceStore) CreateSource(ctx context.Context, source GitHubSource) (GitHubSource, error) {
	if source.SpaceID == "" {
		source.SpaceID = DefaultSpaceID
	}
	err := scanSource(s.pool.QueryRow(ctx, `INSERT INTO skill_sources (source_id,space_id,provider,repository_owner,repository_name,branch,scan_root,exclude_paths,token_ciphertext,auto_publish,schedule,status,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING source_id,space_id,provider,repository_owner,repository_name,branch,scan_root,exclude_paths,token_ciphertext,auto_publish,schedule,status,last_attempt_at,last_success_at,last_synced_commit_sha,sync_revision,last_error_summary,created_by,created_at,updated_at`,
		source.SourceID, source.SpaceID, source.Provider, source.RepositoryOwner, source.RepositoryName, source.Branch, source.ScanRoot, source.ExcludePaths, nullableBytes(source.TokenCiphertext), source.AutoPublish, source.Schedule, source.Status, source.CreatedBy, source.CreatedAt, source.UpdatedAt), &source)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" && pgErr.ConstraintName == "skill_sources_space_id_fkey" {
			return GitHubSource{}, ErrSpaceNotFound
		}
		return GitHubSource{}, mapStoreError(err)
	}
	return source, nil
}

func (s *PostgresSourceStore) UpdateSource(ctx context.Context, source GitHubSource, tokenMode TokenUpdateMode) (GitHubSource, error) {
	query := `UPDATE skill_sources SET branch=$2,scan_root=$3,exclude_paths=$4,auto_publish=$5,schedule=$6,status=$7,sync_revision=sync_revision+CASE WHEN (branch,scan_root,exclude_paths) IS DISTINCT FROM ($2,$3,$4) THEN 1 ELSE 0 END,last_synced_commit_sha=CASE WHEN (branch,scan_root,exclude_paths) IS DISTINCT FROM ($2,$3,$4) THEN NULL ELSE last_synced_commit_sha END,updated_at=$8,token_ciphertext=token_ciphertext WHERE source_id=$1 RETURNING source_id,space_id,provider,repository_owner,repository_name,branch,scan_root,exclude_paths,token_ciphertext,auto_publish,schedule,status,last_attempt_at,last_success_at,last_synced_commit_sha,sync_revision,last_error_summary,created_by,created_at,updated_at`
	args := []any{source.SourceID, source.Branch, source.ScanRoot, source.ExcludePaths, source.AutoPublish, source.Schedule, source.Status, source.UpdatedAt}
	switch tokenMode {
	case TokenKeep:
	case TokenReplace:
		query = `UPDATE skill_sources SET branch=$2,scan_root=$3,exclude_paths=$4,auto_publish=$5,schedule=$6,status=$7,sync_revision=sync_revision+CASE WHEN (branch,scan_root,exclude_paths) IS DISTINCT FROM ($2,$3,$4) THEN 1 ELSE 0 END,last_synced_commit_sha=CASE WHEN (branch,scan_root,exclude_paths) IS DISTINCT FROM ($2,$3,$4) THEN NULL ELSE last_synced_commit_sha END,updated_at=$8,token_ciphertext=$9 WHERE source_id=$1 RETURNING source_id,space_id,provider,repository_owner,repository_name,branch,scan_root,exclude_paths,token_ciphertext,auto_publish,schedule,status,last_attempt_at,last_success_at,last_synced_commit_sha,sync_revision,last_error_summary,created_by,created_at,updated_at`
		args = append(args, source.TokenCiphertext)
	case TokenRemove:
		query = `UPDATE skill_sources SET branch=$2,scan_root=$3,exclude_paths=$4,auto_publish=$5,schedule=$6,status=$7,sync_revision=sync_revision+CASE WHEN (branch,scan_root,exclude_paths) IS DISTINCT FROM ($2,$3,$4) THEN 1 ELSE 0 END,last_synced_commit_sha=CASE WHEN (branch,scan_root,exclude_paths) IS DISTINCT FROM ($2,$3,$4) THEN NULL ELSE last_synced_commit_sha END,updated_at=$8,token_ciphertext=NULL WHERE source_id=$1 RETURNING source_id,space_id,provider,repository_owner,repository_name,branch,scan_root,exclude_paths,token_ciphertext,auto_publish,schedule,status,last_attempt_at,last_success_at,last_synced_commit_sha,sync_revision,last_error_summary,created_by,created_at,updated_at`
	default:
		return GitHubSource{}, ErrInvalidRequest
	}
	var updated GitHubSource
	if err := scanSource(s.pool.QueryRow(ctx, query, args...), &updated); err != nil {
		return GitHubSource{}, mapNotFound(mapStoreError(err))
	}
	return updated, nil
}

func (s *PostgresSourceStore) GetSource(ctx context.Context, sourceID string) (GitHubSource, error) {
	var source GitHubSource
	if err := scanSource(s.pool.QueryRow(ctx, sourceSelect+` WHERE source_id=$1`, sourceID), &source); err != nil {
		return GitHubSource{}, mapNotFound(err)
	}
	return source, nil
}

func (s *PostgresSourceStore) ListSources(ctx context.Context) ([]GitHubSourceSummary, error) {
	rows, err := s.pool.Query(ctx, sourceSelect+` ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	result := []GitHubSourceSummary{}
	for rows.Next() {
		var source GitHubSource
		if err := scanSource(rows, &source); err != nil {
			return nil, err
		}
		result = append(result, GitHubSourceSummary{Source: source})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return result, nil
	}
	countRows, err := s.pool.Query(ctx, `SELECT source_id,COUNT(*) FROM skill_source_items WHERE status<>$1 GROUP BY source_id`, SourceItemStatusMissing)
	if err != nil {
		return nil, err
	}
	discoveredCounts := make(map[string]int, len(result))
	for countRows.Next() {
		var sourceID string
		var count int
		if err := countRows.Scan(&sourceID, &count); err != nil {
			countRows.Close()
			return nil, err
		}
		discoveredCounts[sourceID] = count
	}
	countRows.Close()
	if err := countRows.Err(); err != nil {
		return nil, err
	}
	for index := range result {
		result[index].DiscoveredCount = discoveredCounts[result[index].Source.SourceID]
		var latest SourceSyncRun
		err := scanSourceSyncRun(s.pool.QueryRow(ctx, sourceSyncRunSelect+` WHERE source_id=$1 ORDER BY created_at DESC LIMIT 1`, result[index].Source.SourceID), &latest)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		result[index].LatestRun = &latest
	}
	return result, nil
}

func (s *PostgresSourceStore) UpsertSourceItem(ctx context.Context, item SourceItem) (SourceItem, error) {
	var stored SourceItem
	err := scanSourceItem(s.pool.QueryRow(ctx, `INSERT INTO skill_source_items (source_item_id,source_id,skill_path,discovered_name,skill_id,status,last_seen_commit_sha,last_content_sha256,last_version_id,last_error_summary,missing_since,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (source_id,skill_path) DO UPDATE SET discovered_name=EXCLUDED.discovered_name,status=EXCLUDED.status,last_seen_commit_sha=EXCLUDED.last_seen_commit_sha,last_content_sha256=EXCLUDED.last_content_sha256,last_version_id=EXCLUDED.last_version_id,last_error_summary=EXCLUDED.last_error_summary,missing_since=EXCLUDED.missing_since,updated_at=EXCLUDED.updated_at RETURNING source_item_id,source_id,skill_path,discovered_name,skill_id,status,last_seen_commit_sha,last_content_sha256,last_version_id,last_error_summary,missing_since,created_at,updated_at`,
		item.SourceItemID, item.SourceID, item.SkillPath, item.DiscoveredName, item.SkillID, item.Status, item.LastSeenCommitSHA, item.LastContentSHA256, item.LastVersionID, item.LastErrorSummary, item.MissingSince, item.CreatedAt, item.UpdatedAt), &stored)
	if err != nil {
		return SourceItem{}, mapStoreError(err)
	}
	return stored, nil
}

func (s *PostgresSourceStore) UpsertSourceItemForSync(ctx context.Context, item SourceItem, sourceRevision int64) (SourceItem, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return SourceItem{}, err
	}
	defer tx.Rollback(ctx)
	var currentRevision int64
	if err := tx.QueryRow(ctx, `SELECT sync_revision FROM skill_sources WHERE source_id=$1 FOR UPDATE`, item.SourceID).Scan(&currentRevision); err != nil {
		return SourceItem{}, mapNotFound(err)
	}
	if currentRevision != sourceRevision {
		return SourceItem{}, errSourceRevisionChanged
	}
	var stored SourceItem
	err = scanSourceItem(tx.QueryRow(ctx, `INSERT INTO skill_source_items (source_item_id,source_id,skill_path,discovered_name,skill_id,status,last_seen_commit_sha,last_content_sha256,last_version_id,last_error_summary,missing_since,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (source_id,skill_path) DO UPDATE SET discovered_name=EXCLUDED.discovered_name,skill_id=COALESCE(skill_source_items.skill_id,EXCLUDED.skill_id),status=EXCLUDED.status,last_seen_commit_sha=EXCLUDED.last_seen_commit_sha,last_content_sha256=EXCLUDED.last_content_sha256,last_version_id=EXCLUDED.last_version_id,last_error_summary=EXCLUDED.last_error_summary,missing_since=EXCLUDED.missing_since,updated_at=EXCLUDED.updated_at WHERE skill_source_items.skill_id IS NULL OR EXCLUDED.skill_id IS NULL OR skill_source_items.skill_id=EXCLUDED.skill_id RETURNING source_item_id,source_id,skill_path,discovered_name,skill_id,status,last_seen_commit_sha,last_content_sha256,last_version_id,last_error_summary,missing_since,created_at,updated_at`,
		item.SourceItemID, item.SourceID, item.SkillPath, item.DiscoveredName, item.SkillID, item.Status, item.LastSeenCommitSHA, item.LastContentSHA256, item.LastVersionID, item.LastErrorSummary, item.MissingSince, item.CreatedAt, item.UpdatedAt), &stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return SourceItem{}, ErrConflict
	}
	if err != nil {
		return SourceItem{}, mapStoreError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return SourceItem{}, mapStoreError(err)
	}
	return stored, nil
}

func (s *PostgresSourceStore) GetSourceItem(ctx context.Context, sourceItemID string) (SourceItem, error) {
	var item SourceItem
	if err := scanSourceItem(s.pool.QueryRow(ctx, sourceItemSelect+` WHERE source_item_id=$1`, sourceItemID), &item); err != nil {
		return SourceItem{}, mapNotFound(err)
	}
	return item, nil
}

func (s *PostgresSourceStore) ListSourceItems(ctx context.Context, sourceID string) ([]SourceItem, error) {
	rows, err := s.pool.Query(ctx, sourceItemSelect+` WHERE source_id=$1 ORDER BY skill_path`, sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []SourceItem{}
	for rows.Next() {
		var item SourceItem
		if err := scanSourceItem(rows, &item); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *PostgresSourceStore) BindSourceItem(ctx context.Context, sourceItemID, skillID string, now time.Time) (SourceItem, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return SourceItem{}, err
	}
	defer tx.Rollback(ctx)
	var sourceID string
	if err := tx.QueryRow(ctx, `SELECT source_id FROM skill_source_items WHERE source_item_id=$1`, sourceItemID).Scan(&sourceID); err != nil {
		return SourceItem{}, mapNotFound(err)
	}
	var lockedSourceID, sourceSpaceID string
	if err := tx.QueryRow(ctx, `SELECT source_id,space_id FROM skill_sources WHERE source_id=$1 FOR UPDATE`, sourceID).Scan(&lockedSourceID, &sourceSpaceID); err != nil {
		return SourceItem{}, mapNotFound(err)
	}
	var item SourceItem
	if err := scanSourceItem(tx.QueryRow(ctx, sourceItemSelect+` WHERE source_item_id=$1 FOR UPDATE`, sourceItemID), &item); err != nil {
		return SourceItem{}, mapNotFound(err)
	}
	if item.Status != SourceItemStatusNameConflict {
		return SourceItem{}, ErrConflict
	}
	var skill Skill
	if err := scanSkill(tx.QueryRow(ctx, `SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE skill_id=$1 FOR UPDATE`, skillID), &skill); err != nil {
		return SourceItem{}, mapNotFound(err)
	}
	if skill.Name != item.DiscoveredName || skill.SpaceID != sourceSpaceID {
		return SourceItem{}, ErrConflict
	}
	var existingID string
	err = tx.QueryRow(ctx, `SELECT source_item_id FROM skill_source_items WHERE skill_id=$1 AND source_item_id<>$2 FOR UPDATE`, skillID, sourceItemID).Scan(&existingID)
	if err == nil {
		return SourceItem{}, ErrConflict
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return SourceItem{}, err
	}
	if err := scanSourceItem(tx.QueryRow(ctx, `UPDATE skill_source_items SET skill_id=$2,status='active',missing_since=NULL,updated_at=$3 WHERE source_item_id=$1 RETURNING source_item_id,source_id,skill_path,discovered_name,skill_id,status,last_seen_commit_sha,last_content_sha256,last_version_id,last_error_summary,missing_since,created_at,updated_at`, sourceItemID, skillID, now), &item); err != nil {
		return SourceItem{}, mapStoreError(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE skill_sources SET sync_revision=sync_revision+1,last_synced_commit_sha=NULL,updated_at=$2 WHERE source_id=$1`, item.SourceID, now); err != nil {
		return SourceItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SourceItem{}, mapStoreError(err)
	}
	return item, nil
}

func (s *PostgresSourceStore) UnbindSourceItem(ctx context.Context, sourceItemID string, now time.Time) (SourceItem, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return SourceItem{}, err
	}
	defer tx.Rollback(ctx)
	var sourceID string
	if err := tx.QueryRow(ctx, `SELECT source_id FROM skill_source_items WHERE source_item_id=$1`, sourceItemID).Scan(&sourceID); err != nil {
		return SourceItem{}, mapNotFound(err)
	}
	var lockedSourceID string
	if err := tx.QueryRow(ctx, `SELECT source_id FROM skill_sources WHERE source_id=$1 FOR UPDATE`, sourceID).Scan(&lockedSourceID); err != nil {
		return SourceItem{}, mapNotFound(err)
	}
	var item SourceItem
	if err := scanSourceItem(tx.QueryRow(ctx, sourceItemSelect+` WHERE source_item_id=$1 FOR UPDATE`, sourceItemID), &item); err != nil {
		return SourceItem{}, mapNotFound(err)
	}
	status := SourceItemStatusNameConflict
	if item.DiscoveredName == "" {
		status = SourceItemStatusInvalid
	}
	query := fmt.Sprintf(`UPDATE skill_source_items SET skill_id=NULL,status='%s',updated_at=$2 WHERE source_item_id=$1 RETURNING source_item_id,source_id,skill_path,discovered_name,skill_id,status,last_seen_commit_sha,last_content_sha256,last_version_id,last_error_summary,missing_since,created_at,updated_at`, status)
	if err := scanSourceItem(tx.QueryRow(ctx, query, sourceItemID, now), &item); err != nil {
		return SourceItem{}, mapStoreError(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE skill_sources SET sync_revision=sync_revision+1,last_synced_commit_sha=NULL,updated_at=$2 WHERE source_id=$1`, item.SourceID, now); err != nil {
		return SourceItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SourceItem{}, mapStoreError(err)
	}
	return item, nil
}

func (s *PostgresSourceStore) MarkMissingSourceItems(ctx context.Context, sourceID, commitSHA string, now time.Time, sourceRevision int64) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var currentRevision int64
	if err := tx.QueryRow(ctx, `SELECT sync_revision FROM skill_sources WHERE source_id=$1 FOR UPDATE`, sourceID).Scan(&currentRevision); err != nil {
		return mapNotFound(err)
	}
	if currentRevision != sourceRevision {
		return errSourceRevisionChanged
	}
	if _, err := tx.Exec(ctx, `UPDATE skill_source_items SET status='missing',missing_since=COALESCE(missing_since,$3),updated_at=$3 WHERE source_id=$1 AND (last_seen_commit_sha IS NULL OR last_seen_commit_sha<>$2)`, sourceID, commitSHA, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresSourceStore) CreateSyncRun(ctx context.Context, run SourceSyncRun) (SourceSyncRun, error) {
	if run.RepositoryMode == "" {
		run.RepositoryMode = SourceRepositoryModeRemote
	}
	if run.RepositoryMode != SourceRepositoryModeRemote && run.RepositoryMode != SourceRepositoryModeLocal {
		return SourceSyncRun{}, ErrInvalidRequest
	}
	var stored SourceSyncRun
	err := scanSourceSyncRun(s.pool.QueryRow(ctx, `INSERT INTO skill_source_sync_runs (run_id,source_id,trigger,repository_mode,status,requested_by,before_commit_sha,target_commit_sha,discovered_count,created_version_count,published_count,conflict_count,failed_count,error_summary,started_at,finished_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING run_id,source_id,trigger,repository_mode,status,requested_by,source_revision,before_commit_sha,target_commit_sha,discovered_count,created_version_count,published_count,conflict_count,failed_count,error_summary,started_at,finished_at,created_at`,
		run.RunID, run.SourceID, run.Trigger, run.RepositoryMode, run.Status, run.RequestedBy, run.BeforeCommitSHA, run.TargetCommitSHA, run.DiscoveredCount, run.CreatedVersionCount, run.PublishedCount, run.ConflictCount, run.FailedCount, run.ErrorSummary, run.StartedAt, run.FinishedAt, run.CreatedAt), &stored)
	if err != nil {
		return SourceSyncRun{}, mapStoreError(err)
	}
	return stored, nil
}

func (s *PostgresSourceStore) ClaimNextSyncRun(ctx context.Context, now time.Time) (SourceSyncRun, bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return SourceSyncRun{}, false, err
	}
	defer tx.Rollback(ctx)
	var run SourceSyncRun
	row := tx.QueryRow(ctx, `SELECT r.run_id,r.source_id,r.trigger,r.repository_mode,r.status,r.requested_by,s.sync_revision,r.before_commit_sha,r.target_commit_sha,r.discovered_count,r.created_version_count,r.published_count,r.conflict_count,r.failed_count,r.error_summary,r.started_at,r.finished_at,r.created_at FROM skill_source_sync_runs r JOIN skill_sources s ON s.source_id=r.source_id WHERE r.status='queued' AND s.status='active' ORDER BY r.created_at FOR UPDATE OF r,s SKIP LOCKED LIMIT 1`)
	if err := scanSourceSyncRun(row, &run); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if err := tx.Commit(ctx); err != nil {
				return SourceSyncRun{}, false, err
			}
			return SourceSyncRun{}, false, nil
		}
		return SourceSyncRun{}, false, err
	}
	if err := scanSourceSyncRun(tx.QueryRow(ctx, `UPDATE skill_source_sync_runs SET status='running',started_at=$2,source_revision=$3 WHERE run_id=$1 RETURNING run_id,source_id,trigger,repository_mode,status,requested_by,source_revision,before_commit_sha,target_commit_sha,discovered_count,created_version_count,published_count,conflict_count,failed_count,error_summary,started_at,finished_at,created_at`, run.RunID, now, run.SourceRevision), &run); err != nil {
		return SourceSyncRun{}, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE skill_sources SET last_attempt_at=$2,updated_at=$2 WHERE source_id=$1`, run.SourceID, now); err != nil {
		return SourceSyncRun{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SourceSyncRun{}, false, err
	}
	return run, true, nil
}

func (s *PostgresSourceStore) CompleteSyncRun(ctx context.Context, run SourceSyncRun, source GitHubSource) (SourceSyncRun, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return SourceSyncRun{}, err
	}
	defer tx.Rollback(ctx)
	var stored SourceSyncRun
	err = scanSourceSyncRun(tx.QueryRow(ctx, `UPDATE skill_source_sync_runs SET status=$2,target_commit_sha=$3,discovered_count=$4,created_version_count=$5,published_count=$6,conflict_count=$7,failed_count=$8,error_summary=$9,finished_at=$10 WHERE run_id=$1 AND source_id=$11 AND status='running' RETURNING run_id,source_id,trigger,repository_mode,status,requested_by,source_revision,before_commit_sha,target_commit_sha,discovered_count,created_version_count,published_count,conflict_count,failed_count,error_summary,started_at,finished_at,created_at`,
		run.RunID, run.Status, run.TargetCommitSHA, run.DiscoveredCount, run.CreatedVersionCount, run.PublishedCount, run.ConflictCount, run.FailedCount, run.ErrorSummary, run.FinishedAt, source.SourceID), &stored)
	if err != nil {
		return SourceSyncRun{}, mapNotFound(err)
	}
	if successfulSourceSyncRun(stored.Status) {
		if _, err := tx.Exec(ctx, `UPDATE skill_sources SET last_success_at=$2,last_synced_commit_sha=CASE WHEN sync_revision=$6 THEN $3 ELSE last_synced_commit_sha END,last_error_summary=$4,updated_at=$5 WHERE source_id=$1`, source.SourceID, source.LastSuccessAt, source.LastSyncedCommitSHA, source.LastErrorSummary, source.UpdatedAt, stored.SourceRevision); err != nil {
			return SourceSyncRun{}, err
		}
	} else if _, err := tx.Exec(ctx, `UPDATE skill_sources SET last_error_summary=$2,updated_at=$3 WHERE source_id=$1`, source.SourceID, source.LastErrorSummary, source.UpdatedAt); err != nil {
		return SourceSyncRun{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SourceSyncRun{}, err
	}
	return stored, nil
}

func (s *PostgresSourceStore) RecoverRunningSyncRuns(ctx context.Context, now time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE skill_source_sync_runs SET status='interrupted',error_summary=CASE WHEN error_summary='' THEN '同步进程中断' ELSE error_summary END,finished_at=$1 WHERE status='running'`, now)
	return err
}

func (s *PostgresSourceStore) ListSourceSyncRuns(ctx context.Context, sourceID string, limit int) ([]SourceSyncRun, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.pool.Query(ctx, sourceSyncRunSelect+` WHERE source_id=$1 ORDER BY created_at DESC LIMIT $2`, sourceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []SourceSyncRun{}
	for rows.Next() {
		var run SourceSyncRun
		if err := scanSourceSyncRun(rows, &run); err != nil {
			return nil, err
		}
		result = append(result, run)
	}
	return result, rows.Err()
}

func (s *PostgresSourceStore) ListDueSources(ctx context.Context, now time.Time, limit int) ([]GitHubSource, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, sourceSelect+` s WHERE status='active' AND ((schedule='hourly' AND (last_attempt_at IS NULL OR last_attempt_at<=$1::timestamptz-INTERVAL '1 hour')) OR (schedule='daily' AND (last_attempt_at IS NULL OR last_attempt_at<=$1::timestamptz-INTERVAL '24 hours'))) AND NOT EXISTS (SELECT 1 FROM skill_source_sync_runs r WHERE r.source_id=s.source_id AND r.status IN ('queued','running')) ORDER BY last_attempt_at NULLS FIRST LIMIT $2`, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []GitHubSource{}
	for rows.Next() {
		var source GitHubSource
		if err := scanSource(rows, &source); err != nil {
			return nil, err
		}
		result = append(result, source)
	}
	return result, rows.Err()
}

func (s *PostgresSourceStore) FindVersionBySourceCommit(ctx context.Context, sourceID, sourcePath, commitSHA string) (Version, error) {
	var version Version
	if err := scanVersion(s.pool.QueryRow(ctx, `SELECT version_id,skill_id,version,description,changelog,package_path,package_sha256,created_at FROM skill_versions WHERE source_id=$1 AND source_path=$2 AND source_commit_sha=$3`, sourceID, sourcePath, commitSHA), &version); err != nil {
		return Version{}, mapNotFound(err)
	}
	return version, nil
}

func scanSource(row rowScanner, source *GitHubSource) error {
	var token []byte
	var lastAttempt, lastSuccess pgtype.Timestamptz
	var commit pgtype.Text
	if err := row.Scan(&source.SourceID, &source.SpaceID, &source.Provider, &source.RepositoryOwner, &source.RepositoryName, &source.Branch, &source.ScanRoot, &source.ExcludePaths, &token, &source.AutoPublish, &source.Schedule, &source.Status, &lastAttempt, &lastSuccess, &commit, &source.SyncRevision, &source.LastErrorSummary, &source.CreatedBy, &source.CreatedAt, &source.UpdatedAt); err != nil {
		return err
	}
	source.TokenCiphertext = append([]byte(nil), token...)
	source.HasToken = len(token) > 0
	source.LastAttemptAt = nullableTime(lastAttempt)
	source.LastSuccessAt = nullableTime(lastSuccess)
	source.LastSyncedCommitSHA = nullableString(commit)
	source.CreatedAt = source.CreatedAt.UTC()
	source.UpdatedAt = source.UpdatedAt.UTC()
	return nil
}

func scanSourceItem(row rowScanner, item *SourceItem) error {
	var skillID, seenCommit, contentSHA, versionID pgtype.Text
	var missingSince pgtype.Timestamptz
	if err := row.Scan(&item.SourceItemID, &item.SourceID, &item.SkillPath, &item.DiscoveredName, &skillID, &item.Status, &seenCommit, &contentSHA, &versionID, &item.LastErrorSummary, &missingSince, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return err
	}
	item.SkillID = nullableString(skillID)
	item.LastSeenCommitSHA = nullableString(seenCommit)
	item.LastContentSHA256 = nullableString(contentSHA)
	item.LastVersionID = nullableString(versionID)
	item.MissingSince = nullableTime(missingSince)
	item.CreatedAt = item.CreatedAt.UTC()
	item.UpdatedAt = item.UpdatedAt.UTC()
	return nil
}

func scanSourceSyncRun(row rowScanner, run *SourceSyncRun) error {
	var before, target pgtype.Text
	var started, finished pgtype.Timestamptz
	if err := row.Scan(&run.RunID, &run.SourceID, &run.Trigger, &run.RepositoryMode, &run.Status, &run.RequestedBy, &run.SourceRevision, &before, &target, &run.DiscoveredCount, &run.CreatedVersionCount, &run.PublishedCount, &run.ConflictCount, &run.FailedCount, &run.ErrorSummary, &started, &finished, &run.CreatedAt); err != nil {
		return err
	}
	run.BeforeCommitSHA = nullableString(before)
	run.TargetCommitSHA = nullableString(target)
	run.StartedAt = nullableTime(started)
	run.FinishedAt = nullableTime(finished)
	run.CreatedAt = run.CreatedAt.UTC()
	return nil
}

func nullableTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time.UTC()
	return &result
}

func nullableBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}
