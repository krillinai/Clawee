package sharedfiles

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *PostgresStore) GetStorageSettings(ctx context.Context) (StorageSettings, error) {
	var item StorageSettings
	err := s.pool.QueryRow(ctx, `SELECT active_profile_id,revision,updated_by,created_at,updated_at
FROM shared_file_storage_settings WHERE id='default'`).Scan(
		&item.ActiveProfileID, &item.Revision, &item.UpdatedBy, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

func (s *PostgresStore) GetStorageProfile(ctx context.Context, profileID string) (StorageProfile, error) {
	var item StorageProfile
	err := s.pool.QueryRow(ctx, storageProfileSelect+` WHERE p.profile_id=$1 GROUP BY p.profile_id`, profileID).Scan(storageProfileDest(&item)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return StorageProfile{}, ErrStorageProfileNotFound
	}
	setStorageProfileDerivedFields(&item)
	return item, err
}

func (s *PostgresStore) GetStorageProfileConfig(ctx context.Context, profileID string) (StorageProfile, error) {
	var item StorageProfile
	err := s.pool.QueryRow(ctx, storageProfileConfigSelect+` WHERE p.profile_id=$1`, profileID).Scan(storageProfileConfigDest(&item)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return StorageProfile{}, ErrStorageProfileNotFound
	}
	setStorageProfileDerivedFields(&item)
	return item, err
}

func (s *PostgresStore) ListStorageProfiles(ctx context.Context) ([]StorageProfile, error) {
	rows, err := s.pool.Query(ctx, storageProfileSelect+` GROUP BY p.profile_id ORDER BY p.created_at,p.profile_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []StorageProfile{}
	for rows.Next() {
		var item StorageProfile
		if err := rows.Scan(storageProfileDest(&item)...); err != nil {
			return nil, err
		}
		item.CredentialsConfigured = item.CredentialMode == "ecs_ram_role" ||
			(len(item.AccessKeyIDCiphertext) > 0 && len(item.AccessKeySecretCiphertext) > 0)
		item.Health = storageHealth(item.LastProbeStatus)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) CreateStorageProfile(ctx context.Context, profile StorageProfile) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO shared_file_storage_profiles
(profile_id,name,provider,endpoint,region,bucket,object_prefix,credential_mode,access_key_id_ciphertext,
 access_key_secret_ciphertext,access_key_id_hint,status,last_probe_status,last_probe_at,created_by,updated_by,created_at,updated_at)
VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),$9,$10,NULLIF($11,''),
 $12,$13,$14,$15,$16,$17,$18)`,
		profile.ProfileID, profile.Name, profile.Provider, profile.Endpoint, profile.Region, profile.Bucket, profile.ObjectPrefix,
		profile.CredentialMode, nullableBytes(profile.AccessKeyIDCiphertext), nullableBytes(profile.AccessKeySecretCiphertext),
		profile.AccessKeyIDHint, profile.Status, profile.LastProbeStatus, profile.LastProbeAt, profile.CreatedBy, profile.UpdatedBy,
		profile.CreatedAt, profile.UpdatedAt)
	if err != nil {
		return mapPostgresError(err, ErrInvalidStorageConfiguration)
	}
	return nil
}

func (s *PostgresStore) UpdateStorageProfile(ctx context.Context, profile StorageProfile) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var current StorageProfile
	err = tx.QueryRow(ctx, `SELECT provider,COALESCE(endpoint,''),COALESCE(region,''),COALESCE(bucket,''),COALESCE(object_prefix,'')
FROM shared_file_storage_profiles WHERE profile_id=$1 FOR UPDATE`, profile.ProfileID).Scan(
		&current.Provider, &current.Endpoint, &current.Region, &current.Bucket, &current.ObjectPrefix)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrStorageProfileNotFound
	}
	if err != nil {
		return err
	}
	if current.Provider != "aliyun_oss" {
		return ErrStorageProfileInUse
	}
	var references int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM shared_files WHERE storage_profile_id=$1`, profile.ProfileID).Scan(&references); err != nil {
		return err
	}
	if references > 0 && (current.Endpoint != profile.Endpoint || current.Region != profile.Region || current.Bucket != profile.Bucket || current.ObjectPrefix != profile.ObjectPrefix) {
		return ErrStorageProfileInUse
	}
	tag, err := tx.Exec(ctx, `UPDATE shared_file_storage_profiles SET
name=$2,endpoint=$3,region=$4,bucket=$5,object_prefix=$6,credential_mode=$7,access_key_id_ciphertext=$8,
access_key_secret_ciphertext=$9,access_key_id_hint=NULLIF($10,''),status=$11,last_probe_status=$12,last_probe_at=$13,
updated_by=$14,updated_at=$15 WHERE profile_id=$1 AND provider='aliyun_oss'`,
		profile.ProfileID, profile.Name, profile.Endpoint, profile.Region, profile.Bucket, profile.ObjectPrefix,
		profile.CredentialMode, nullableBytes(profile.AccessKeyIDCiphertext), nullableBytes(profile.AccessKeySecretCiphertext),
		profile.AccessKeyIDHint, profile.Status, profile.LastProbeStatus, profile.LastProbeAt, profile.UpdatedBy, profile.UpdatedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrStorageProfileNotFound
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) RecordStorageProbe(ctx context.Context, profileID, status string, at time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE shared_file_storage_profiles SET last_probe_status=$2,last_probe_at=$3,updated_at=$3 WHERE profile_id=$1`,
		profileID, status, at)
	return err
}

func (s *PostgresStore) ActivateStorageProfile(ctx context.Context, profileID, operator string, expectedRevision int64, at time.Time) (StorageSettings, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return StorageSettings{}, err
	}
	defer tx.Rollback(ctx)
	var enabled bool
	if err := tx.QueryRow(ctx, `SELECT status='enabled' FROM shared_file_storage_profiles WHERE profile_id=$1 FOR SHARE`, profileID).Scan(&enabled); errors.Is(err, pgx.ErrNoRows) {
		return StorageSettings{}, ErrStorageProfileNotFound
	} else if err != nil {
		return StorageSettings{}, err
	}
	if !enabled {
		return StorageSettings{}, ErrStorageUnavailable
	}
	tag, err := tx.Exec(ctx, `UPDATE shared_file_storage_settings SET active_profile_id=$1,revision=revision+1,updated_by=$2,updated_at=$3
WHERE id='default' AND revision=$4`, profileID, operator, at, expectedRevision)
	if err != nil {
		return StorageSettings{}, err
	}
	if tag.RowsAffected() == 0 {
		return StorageSettings{}, ErrStorageConfigurationConflict
	}
	if err := tx.Commit(ctx); err != nil {
		return StorageSettings{}, err
	}
	return StorageSettings{ActiveProfileID: profileID, Revision: expectedRevision + 1, UpdatedBy: operator, UpdatedAt: at}, nil
}

func (s *PostgresStore) RetireStorageProfile(ctx context.Context, profileID, operator string, at time.Time) error {
	tag, err := s.pool.Exec(ctx, `UPDATE shared_file_storage_profiles p SET status='retired',updated_by=$2,updated_at=$3
WHERE p.profile_id=$1 AND p.provider='aliyun_oss'
AND NOT EXISTS (SELECT 1 FROM shared_file_storage_settings s WHERE s.active_profile_id=p.profile_id)`, profileID, operator, at)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrStorageProfileInUse
	}
	return nil
}

func (s *PostgresStore) RecordStorageAudit(ctx context.Context, audit StorageAudit) error {
	details, err := json.Marshal(audit.Details)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO shared_file_storage_audits
(audit_id,request_id,operator_user_id,action,object_id,result,details,created_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (audit_id) DO NOTHING`, audit.AuditID, audit.RequestID, audit.OperatorUserID, audit.Action,
		audit.ObjectID, audit.Result, details, audit.CreatedAt)
	return err
}

func (s *PostgresStore) EnqueueCleanup(ctx context.Context, ref ObjectRef, source, fileID, migrationID string, at time.Time) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `INSERT INTO shared_file_storage_cleanup_tasks
(cleanup_id,storage_profile_id,storage_key,source,file_id,migration_id,status,attempt_count,next_attempt_at,created_at)
VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),'pending',0,$7,$7) ON CONFLICT DO NOTHING`,
		newID("cleanup_"), ref.StorageProfileID, ref.StorageKey, source, fileID, migrationID, at)
	if err != nil {
		return err
	}
	if migrationID != "" && source == "migration_source" {
		_, err = tx.Exec(ctx, `UPDATE shared_file_storage_migrations SET
cleanup_pending_count=(SELECT count(*) FROM shared_file_storage_cleanup_tasks WHERE migration_id=$1 AND status<>'succeeded'),
status=CASE WHEN status='completed' THEN 'completed_with_cleanup_pending' ELSE status END WHERE migration_id=$1`, migrationID)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) CreateStorageMigration(ctx context.Context, sourceProfileID, targetProfileID, operator string, at time.Time) (StorageMigration, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return StorageMigration{}, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT profile_id,status FROM shared_file_storage_profiles WHERE profile_id IN ($1,$2) FOR SHARE`, sourceProfileID, targetProfileID)
	if err != nil {
		return StorageMigration{}, err
	}
	enabled := map[string]bool{}
	for rows.Next() {
		var id, status string
		if err := rows.Scan(&id, &status); err != nil {
			rows.Close()
			return StorageMigration{}, err
		}
		enabled[id] = status == "enabled"
	}
	rows.Close()
	if sourceProfileID == targetProfileID || !enabled[sourceProfileID] || !enabled[targetProfileID] {
		return StorageMigration{}, ErrInvalidStorageConfiguration
	}
	migration := StorageMigration{MigrationID: newID("migration_"), SourceProfileID: sourceProfileID, TargetProfileID: targetProfileID,
		Status: "pending", CreatedBy: operator, CreatedAt: at}
	_, err = tx.Exec(ctx, `INSERT INTO shared_file_storage_migrations
(migration_id,source_profile_id,target_profile_id,status,created_by,created_at)
VALUES ($1,$2,$3,'pending',$4,$5)`, migration.MigrationID, sourceProfileID, targetProfileID, operator, at)
	if err != nil {
		return StorageMigration{}, mapPostgresError(err, ErrStorageMigrationRunning)
	}
	files, err := tx.Query(ctx, `SELECT file_id,space_id,storage_key,revision,size_bytes,sha256 FROM shared_files
WHERE storage_profile_id=$1 ORDER BY file_id`, sourceProfileID)
	if err != nil {
		return StorageMigration{}, err
	}
	type fileSnapshot struct {
		fileID, spaceID, storageKey, digest string
		revision, size                      int64
	}
	snapshots := []fileSnapshot{}
	for files.Next() {
		var fileID, spaceID, storageKey, digest string
		var revision, size int64
		if err := files.Scan(&fileID, &spaceID, &storageKey, &revision, &size, &digest); err != nil {
			files.Close()
			return StorageMigration{}, err
		}
		snapshots = append(snapshots, fileSnapshot{fileID: fileID, spaceID: spaceID, storageKey: storageKey, digest: digest, revision: revision, size: size})
	}
	if err := files.Err(); err != nil {
		files.Close()
		return StorageMigration{}, err
	}
	files.Close()
	for _, snapshot := range snapshots {
		targetKey := snapshot.spaceID + "/" + snapshot.fileID + "/" + newID("blob_")
		if _, err := tx.Exec(ctx, `INSERT INTO shared_file_storage_migration_items
(migration_id,file_id,source_profile_id,source_storage_key,source_revision,source_size_bytes,source_sha256,target_storage_key,status)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`, migration.MigrationID, snapshot.fileID, sourceProfileID, snapshot.storageKey, snapshot.revision, snapshot.size, snapshot.digest, targetKey); err != nil {
			return StorageMigration{}, err
		}
		migration.TotalCount++
	}
	if migration.TotalCount == 0 {
		migration.Status = "completed"
		finished := at
		migration.FinishedAt = &finished
	}
	_, err = tx.Exec(ctx, `UPDATE shared_file_storage_migrations SET total_count=$2,status=$3,finished_at=$4 WHERE migration_id=$1`,
		migration.MigrationID, migration.TotalCount, migration.Status, migration.FinishedAt)
	if err != nil {
		return StorageMigration{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return StorageMigration{}, err
	}
	return migration, nil
}

func (s *PostgresStore) GetStorageMigration(ctx context.Context, migrationID string) (StorageMigration, error) {
	var item StorageMigration
	err := s.pool.QueryRow(ctx, storageMigrationSelect+` WHERE migration_id=$1`, migrationID).Scan(storageMigrationDest(&item)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return StorageMigration{}, ErrStorageProfileNotFound
	}
	if err != nil {
		return StorageMigration{}, err
	}
	rows, err := s.pool.Query(ctx, `SELECT file_id,attempt_count,COALESCE(error_code,''),COALESCE(error_message,'')
FROM shared_file_storage_migration_items WHERE migration_id=$1 AND status='failed' ORDER BY file_id`, migrationID)
	if err != nil {
		return StorageMigration{}, err
	}
	defer rows.Close()
	item.FailedItems = []StorageMigrationFailure{}
	for rows.Next() {
		var failed StorageMigrationFailure
		if err := rows.Scan(&failed.FileID, &failed.AttemptCount, &failed.ErrorCode, &failed.ErrorMessage); err != nil {
			return StorageMigration{}, err
		}
		item.FailedItems = append(item.FailedItems, failed)
	}
	return item, rows.Err()
}

func (s *PostgresStore) CancelStorageMigration(ctx context.Context, migrationID string, at time.Time) error {
	tag, err := s.pool.Exec(ctx, `UPDATE shared_file_storage_migrations SET status='cancelled',finished_at=$2
WHERE migration_id=$1 AND status IN ('pending','running')`, migrationID, at)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrInvalidRequest
	}
	return nil
}

func (s *PostgresStore) RetryFailedStorageMigration(ctx context.Context, migrationID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	itemsTag, err := tx.Exec(ctx, `UPDATE shared_file_storage_migration_items SET status='pending',error_code=NULL,error_message=NULL,
heartbeat_at=NULL,started_at=NULL,finished_at=NULL WHERE migration_id=$1 AND status='failed'`, migrationID)
	if err != nil {
		return err
	}
	cleanupTag, err := tx.Exec(ctx, `UPDATE shared_file_storage_cleanup_tasks SET status='pending',attempt_count=0,
next_attempt_at=CURRENT_TIMESTAMP,last_error_code=NULL,last_error_message=NULL,finished_at=NULL
WHERE migration_id=$1 AND status='failed' AND attempt_count >= 10`, migrationID)
	if err != nil {
		return err
	}
	if itemsTag.RowsAffected() == 0 && cleanupTag.RowsAffected() == 0 {
		return ErrInvalidRequest
	}
	_, err = tx.Exec(ctx, `UPDATE shared_file_storage_migrations SET
status=CASE WHEN $2 THEN 'pending' ELSE 'completed_with_cleanup_pending' END,
failed_count=CASE WHEN $2 THEN 0 ELSE failed_count END,
finished_at=CASE WHEN $2 THEN NULL ELSE finished_at END WHERE migration_id=$1`, migrationID, itemsTag.RowsAffected() > 0)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) ClaimStorageMigrationItem(ctx context.Context, now time.Time) (StorageMigrationItem, string, bool, error) {
	var item StorageMigrationItem
	var targetProfileID string
	err := s.pool.QueryRow(ctx, `WITH candidate AS (
 SELECT i.migration_id,i.file_id FROM shared_file_storage_migration_items i
 JOIN shared_file_storage_migrations m ON m.migration_id=i.migration_id
 WHERE m.status IN ('pending','running') AND
       ((i.status='pending' AND (i.heartbeat_at IS NULL OR i.heartbeat_at <= $1))
        OR (i.status='running' AND i.heartbeat_at < $1 - interval '2 minutes'))
 ORDER BY m.created_at,i.file_id FOR UPDATE OF i SKIP LOCKED LIMIT 1
), claimed AS (
 UPDATE shared_file_storage_migration_items i SET status='running',attempt_count=attempt_count+1,
	 heartbeat_at=$1,started_at=COALESCE(started_at,$1),target_storage_key=target_storage_key||'-'||(attempt_count+1)::text
 FROM candidate c WHERE i.migration_id=c.migration_id AND i.file_id=c.file_id
 RETURNING i.migration_id,i.file_id,i.source_profile_id,i.source_storage_key,i.source_revision,
 i.source_size_bytes,i.source_sha256,i.target_storage_key,i.attempt_count
)
SELECT c.migration_id,c.file_id,c.source_profile_id,c.source_storage_key,c.source_revision,c.source_size_bytes,
c.source_sha256,c.target_storage_key,c.attempt_count,m.target_profile_id FROM claimed c
JOIN shared_file_storage_migrations m ON m.migration_id=c.migration_id`, now).Scan(
		&item.MigrationID, &item.FileID, &item.SourceProfileID, &item.SourceStorageKey, &item.SourceRevision,
		&item.SourceSizeBytes, &item.SourceSHA256, &item.TargetStorageKey, &item.AttemptCount, &targetProfileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return StorageMigrationItem{}, "", false, nil
	}
	if err != nil {
		return StorageMigrationItem{}, "", false, err
	}
	_, _ = s.pool.Exec(ctx, `UPDATE shared_file_storage_migrations SET status='running',started_at=COALESCE(started_at,$2)
WHERE migration_id=$1 AND status='pending'`, item.MigrationID, now)
	return item, targetProfileID, true, nil
}

func (s *PostgresStore) HeartbeatStorageMigrationItem(ctx context.Context, item StorageMigrationItem, now time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE shared_file_storage_migration_items SET heartbeat_at=$4
WHERE migration_id=$1 AND file_id=$2 AND status='running' AND attempt_count=$3`,
		item.MigrationID, item.FileID, item.AttemptCount, now)
	return err
}

func (s *PostgresStore) CompleteStorageMigrationItem(ctx context.Context, item StorageMigrationItem, targetProfileID string, now time.Time) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var ownsLease bool
	err = tx.QueryRow(ctx, `SELECT true FROM shared_file_storage_migration_items
WHERE migration_id=$1 AND file_id=$2 AND status='running' AND attempt_count=$3 FOR UPDATE`,
		item.MigrationID, item.FileID, item.AttemptCount).Scan(&ownsLease)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx, `UPDATE shared_files SET storage_profile_id=$2,storage_key=$3
WHERE file_id=$1 AND storage_profile_id=$4 AND storage_key=$5 AND revision=$6`,
		item.FileID, targetProfileID, item.TargetStorageKey, item.SourceProfileID, item.SourceStorageKey, item.SourceRevision)
	if err != nil {
		return false, err
	}
	status := "succeeded"
	migrated := tag.RowsAffected() == 1
	if !migrated {
		status = "skipped"
	}
	_, err = tx.Exec(ctx, `UPDATE shared_file_storage_migration_items SET status=$4,heartbeat_at=$5,finished_at=$5,
error_code=NULL,error_message=NULL WHERE migration_id=$1 AND file_id=$2 AND attempt_count=$3`,
		item.MigrationID, item.FileID, item.AttemptCount, status, now)
	if err != nil {
		return false, err
	}
	if err := refreshMigration(ctx, tx, item.MigrationID, now); err != nil {
		return false, err
	}
	return migrated, tx.Commit(ctx)
}

func (s *PostgresStore) FailStorageMigrationItem(ctx context.Context, item StorageMigrationItem, code string, permanent bool, now time.Time) error {
	status := "pending"
	heartbeatAt := now.Add(time.Duration(1<<min(item.AttemptCount, 6)) * time.Second)
	if permanent || item.AttemptCount >= 3 {
		status = "failed"
		heartbeatAt = now
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE shared_file_storage_migration_items SET status=$4,heartbeat_at=$5,
finished_at=CASE WHEN $4='failed' THEN $5 ELSE NULL END,error_code=$6,error_message=$7
WHERE migration_id=$1 AND file_id=$2 AND status='running' AND attempt_count=$3`,
		item.MigrationID, item.FileID, item.AttemptCount, status, heartbeatAt, code, sanitizeStorageError(code))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return tx.Commit(ctx)
	}
	if err := refreshMigration(ctx, tx, item.MigrationID, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) ClaimCleanupTask(ctx context.Context, now time.Time) (CleanupTask, bool, error) {
	var item CleanupTask
	err := s.pool.QueryRow(ctx, `WITH candidate AS (
 SELECT cleanup_id FROM shared_file_storage_cleanup_tasks
 WHERE status IN ('pending','running','failed') AND next_attempt_at <= $1 AND attempt_count < 10
 ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1
)
UPDATE shared_file_storage_cleanup_tasks t SET status='running',attempt_count=attempt_count+1,next_attempt_at=$1 + interval '2 minutes'
FROM candidate c WHERE t.cleanup_id=c.cleanup_id
RETURNING t.cleanup_id,t.storage_profile_id,t.storage_key,t.source,COALESCE(t.file_id,''),COALESCE(t.migration_id,''),t.attempt_count`, now).Scan(
		&item.CleanupID, &item.StorageProfileID, &item.StorageKey, &item.Source, &item.FileID, &item.MigrationID, &item.AttemptCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return CleanupTask{}, false, nil
	}
	return item, err == nil, err
}

func (s *PostgresStore) FinishCleanupTask(ctx context.Context, task CleanupTask, success bool, code string, now time.Time) error {
	status := "failed"
	var finishedAt *time.Time
	if success {
		status = "succeeded"
		finishedAt = &now
	}
	backoff := time.Duration(1<<min(task.AttemptCount, 8)) * time.Second
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE shared_file_storage_cleanup_tasks SET status=$2,next_attempt_at=$3,
last_error_code=NULLIF($4,''),last_error_message=NULLIF($5,''),finished_at=$6
WHERE cleanup_id=$1 AND status='running' AND attempt_count=$7`,
		task.CleanupID, status, now.Add(backoff), code, sanitizeStorageError(code), finishedAt, task.AttemptCount)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return tx.Commit(ctx)
	}
	if task.MigrationID != "" {
		if err := refreshMigration(ctx, tx, task.MigrationID, now); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func refreshMigration(ctx context.Context, tx pgx.Tx, migrationID string, now time.Time) error {
	if _, err := tx.Exec(ctx, `SELECT 1 FROM shared_file_storage_migrations WHERE migration_id=$1 FOR UPDATE`, migrationID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `WITH counts AS (
 SELECT count(*) FILTER (WHERE status='succeeded') success_count,
        count(*) FILTER (WHERE status='failed') failed_count,
        count(*) FILTER (WHERE status='skipped') skipped_count,
        count(*) FILTER (WHERE status IN ('pending','running')) open_count
 FROM shared_file_storage_migration_items WHERE migration_id=$1
), cleanup AS (
 SELECT count(*) cleanup_count FROM shared_file_storage_cleanup_tasks
 WHERE migration_id=$1 AND status <> 'succeeded'
)
UPDATE shared_file_storage_migrations m SET
success_count=c.success_count,failed_count=c.failed_count,skipped_count=c.skipped_count,
cleanup_pending_count=x.cleanup_count,
status=CASE WHEN m.status='cancelled' THEN 'cancelled'
			WHEN c.open_count>0 THEN m.status WHEN c.failed_count>0 THEN 'completed_with_failures'
            WHEN x.cleanup_count>0 THEN 'completed_with_cleanup_pending' ELSE 'completed' END,
	finished_at=CASE WHEN m.status='cancelled' THEN COALESCE(m.finished_at,$2) WHEN c.open_count=0 THEN $2 ELSE NULL END
FROM counts c,cleanup x WHERE m.migration_id=$1`, migrationID, now)
	return err
}

const storageProfileColumns = `p.profile_id,p.name,p.provider,COALESCE(p.endpoint,''),COALESCE(p.region,''),
COALESCE(p.bucket,''),COALESCE(p.object_prefix,''),COALESCE(p.credential_mode,''),p.access_key_id_ciphertext,
p.access_key_secret_ciphertext,COALESCE(p.access_key_id_hint,''),p.status,p.last_probe_status,p.last_probe_at,
p.created_by,p.updated_by,p.created_at,p.updated_at`

const storageProfileConfigSelect = `SELECT ` + storageProfileColumns + ` FROM shared_file_storage_profiles p`

const storageProfileSelect = `SELECT ` + storageProfileColumns + `,count(f.file_id),COALESCE(sum(f.size_bytes),0)
FROM shared_file_storage_profiles p LEFT JOIN shared_files f ON f.storage_profile_id=p.profile_id`

func storageProfileDest(item *StorageProfile) []any {
	return append(storageProfileConfigDest(item), &item.FileCount, &item.SizeBytes)
}

func storageProfileConfigDest(item *StorageProfile) []any {
	return []any{&item.ProfileID, &item.Name, &item.Provider, &item.Endpoint, &item.Region, &item.Bucket, &item.ObjectPrefix,
		&item.CredentialMode, &item.AccessKeyIDCiphertext, &item.AccessKeySecretCiphertext, &item.AccessKeyIDHint,
		&item.Status, &item.LastProbeStatus, &item.LastProbeAt, &item.CreatedBy, &item.UpdatedBy, &item.CreatedAt,
		&item.UpdatedAt}
}

const storageMigrationSelect = `SELECT migration_id,source_profile_id,target_profile_id,status,total_count,success_count,
failed_count,skipped_count,cleanup_pending_count,created_by,created_at,started_at,finished_at
FROM shared_file_storage_migrations`

func storageMigrationDest(item *StorageMigration) []any {
	return []any{&item.MigrationID, &item.SourceProfileID, &item.TargetProfileID, &item.Status, &item.TotalCount,
		&item.SuccessCount, &item.FailedCount, &item.SkippedCount, &item.CleanupPendingCount, &item.CreatedBy,
		&item.CreatedAt, &item.StartedAt, &item.FinishedAt}
}

func nullableBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func sanitizeStorageError(code string) string {
	switch strings.TrimSpace(code) {
	case "digest_mismatch":
		return "文件摘要校验失败"
	case "invalid_storage_configuration":
		return "存储配置无效"
	case "storage_unavailable":
		return "存储暂时不可用"
	default:
		return "存储操作失败"
	}
}

func storageHealth(status string) string {
	if status == "success" {
		return "available"
	}
	if status == "failed" {
		return "unavailable"
	}
	return "unknown"
}
