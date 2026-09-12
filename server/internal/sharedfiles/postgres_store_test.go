package sharedfiles

import (
	"context"
	"errors"
	"io"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresSharedFilesLifecycleAndUploadAuthorizationRace(t *testing.T) {
	pool := openSharedFilesTestPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)
	for _, userID := range []string{"user_a", "user_b"} {
		if _, err := pool.Exec(ctx, `INSERT INTO accounts (user_id,email,name,status) VALUES ($1,$1||'@test.local',$1,'active')`, userID); err != nil {
			t.Fatal(err)
		}
	}
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(store, storage, nil)
	space, err := service.CreateSpace(ctx, "Postgres 集成空间", "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	for _, userID := range []string{"user_a", "user_b"} {
		if _, err := service.AddMember(ctx, space.SpaceID, userID, "admin"); err != nil {
			t.Fatal(err)
		}
		var grants int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM data_resource_grants WHERE user_id=$1 AND resource_type='shared_space' AND resource_id=$2`, userID, space.SpaceID).Scan(&grants); err != nil || grants != 2 {
			t.Fatalf("%s grants = %d, %v", userID, grants, err)
		}
	}

	created, err := uploadText(ctx, service, "user_a", "agent_a", space.SpaceID, "docs/design.md", "initial", nil)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := service.GetSpaceSummary(ctx, space.SpaceID)
	if err != nil || summary.MemberCount != 2 || summary.FileCount != 1 || summary.SizeBytes != 7 {
		t.Fatalf("summary = %#v, %v", summary, err)
	}
	adminCreated, err := service.UploadAdmin(ctx, "admin", space.SpaceID, "admin/notice.txt", "text/plain", 6, nil, strings.NewReader("notice"))
	if err != nil {
		t.Fatal(err)
	}
	var createdAgentID, updatedAgentID *string
	if err := pool.QueryRow(ctx, `SELECT created_by_agent_id,updated_by_agent_id FROM shared_files WHERE file_id=$1`, adminCreated.FileID).Scan(&createdAgentID, &updatedAgentID); err != nil {
		t.Fatal(err)
	}
	if createdAgentID != nil || updatedAgentID != nil {
		t.Fatalf("admin agent snapshots = %v, %v", createdAgentID, updatedAgentID)
	}
	adminFiles, err := service.ListAdminFiles(ctx, space.SpaceID, "notice", "admin/", 50, "")
	if err != nil || len(adminFiles.Items) != 1 || adminFiles.Items[0].FileID != adminCreated.FileID {
		t.Fatalf("admin files = %#v, %v", adminFiles, err)
	}

	revision := created.Revision
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, value := range []string{"left", "right"} {
		wg.Add(1)
		go func(contents string) {
			defer wg.Done()
			_, err := uploadText(ctx, service, "user_a", "agent_a", space.SpaceID, "docs/design.md", contents, &revision)
			results <- err
		}(value)
	}
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrRevisionConflict):
			conflicts++
		default:
			t.Fatalf("replace error = %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("replace successes=%d conflicts=%d", successes, conflicts)
	}

	blocking := &blockingStorage{Storage: storage, stored: make(chan struct{}), release: make(chan struct{})}
	blockedService := NewService(store, blocking, nil)
	uploadDone := make(chan error, 1)
	go func() {
		_, err := uploadText(ctx, blockedService, "user_b", "agent_b", space.SpaceID, "removed.txt", "blocked", nil)
		uploadDone <- err
	}()
	<-blocking.stored
	if err := service.RemoveMember(ctx, space.SpaceID, "user_b"); err != nil {
		t.Fatal(err)
	}
	close(blocking.release)
	if err := <-uploadDone; !errors.Is(err, ErrSharedSpaceNotFound) {
		t.Fatalf("upload after removal error = %v", err)
	}
	if _, err := service.ListFiles(ctx, "user_b", space.SpaceID, "", "", 50, ""); !errors.Is(err, ErrSharedSpaceNotFound) {
		t.Fatalf("removed member list error = %v", err)
	}
	var grants int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM data_resource_grants WHERE user_id='user_b' AND resource_type='shared_space' AND resource_id=$1`, space.SpaceID).Scan(&grants); err != nil || grants != 0 {
		t.Fatalf("removed grants = %d, %v", grants, err)
	}
}

func TestPostgresStorageMigrationStateTransitions(t *testing.T) {
	pool := openSharedFilesTestPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)
	now := time.Now().UTC()
	target := StorageProfile{ProfileID: "storage_profile_target", Name: "Target", Provider: "aliyun_oss",
		Endpoint: "https://oss-cn-hangzhou.aliyuncs.com", Region: "cn-hangzhou", Bucket: "clawee-test", ObjectPrefix: "shared-files",
		CredentialMode: "access_key", AccessKeyIDCiphertext: []byte("encrypted-id"), AccessKeySecretCiphertext: []byte("encrypted-secret"),
		Status: "enabled", LastProbeStatus: "success", CreatedBy: "admin", UpdatedBy: "admin", CreatedAt: now, UpdatedAt: now}
	if err := store.CreateStorageProfile(ctx, target); err != nil {
		t.Fatal(err)
	}

	empty, err := store.CreateStorageMigration(ctx, LocalDefaultProfileID, target.ProfileID, "admin", now)
	if err != nil {
		t.Fatal(err)
	}
	if empty.Status != "completed" || empty.TotalCount != 0 || empty.FinishedAt == nil {
		t.Fatalf("empty migration = %#v", empty)
	}
	if _, err := store.ActivateStorageProfile(ctx, target.ProfileID, "admin", 99, now); !errors.Is(err, ErrStorageConfigurationConflict) {
		t.Fatalf("activate conflict = %v", err)
	}

	migrationID := "migration_cleanup"
	if _, err := pool.Exec(ctx, `INSERT INTO shared_file_storage_migrations
(migration_id,source_profile_id,target_profile_id,status,total_count,success_count,cleanup_pending_count,created_by,created_at,finished_at)
VALUES ($1,$2,$3,'completed_with_cleanup_pending',1,1,1,'admin',$4,$4)`, migrationID, LocalDefaultProfileID, target.ProfileID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO shared_file_storage_migration_items
(migration_id,file_id,source_profile_id,source_storage_key,source_revision,source_size_bytes,source_sha256,target_storage_key,status)
VALUES ($1,'file_cleanup',$2,'source-key',1,0,$3,'target-key','succeeded')`, migrationID, LocalDefaultProfileID, strings.Repeat("0", 64)); err != nil {
		t.Fatal(err)
	}
	cleanup := CleanupTask{CleanupID: "cleanup_test", StorageProfileID: LocalDefaultProfileID, StorageKey: "source-key",
		Source: "migration_source", FileID: "file_cleanup", MigrationID: migrationID, AttemptCount: 1}
	if _, err := pool.Exec(ctx, `INSERT INTO shared_file_storage_cleanup_tasks
(cleanup_id,storage_profile_id,storage_key,source,file_id,migration_id,status,attempt_count,next_attempt_at,created_at)
VALUES ($1,$2,$3,$4,$5,$6,'running',1,$7,$7)`, cleanup.CleanupID, cleanup.StorageProfileID, cleanup.StorageKey,
		cleanup.Source, cleanup.FileID, cleanup.MigrationID, now); err != nil {
		t.Fatal(err)
	}
	if err := store.FinishCleanupTask(ctx, cleanup, true, "", now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	completed, err := store.GetStorageMigration(ctx, migrationID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != "completed" || completed.CleanupPendingCount != 0 {
		t.Fatalf("completed migration = %#v", completed)
	}

	cancelledID := "migration_cancelled"
	if _, err := pool.Exec(ctx, `INSERT INTO shared_file_storage_migrations
(migration_id,source_profile_id,target_profile_id,status,created_by,created_at,finished_at)
VALUES ($1,$2,$3,'cancelled','admin',$4,$4)`, cancelledID, LocalDefaultProfileID, target.ProfileID, now); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := refreshMigration(ctx, tx, cancelledID, now.Add(time.Second)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	cancelled, err := store.GetStorageMigration(ctx, cancelledID)
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.Status != "cancelled" {
		t.Fatalf("cancelled migration status = %q", cancelled.Status)
	}
}

func TestPostgresStorageWorkersFenceExpiredLeases(t *testing.T) {
	pool := openSharedFilesTestPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)
	now := time.Now().UTC()
	target := StorageProfile{ProfileID: "storage_profile_target", Name: "Target", Provider: "aliyun_oss",
		Endpoint: "https://oss-cn-hangzhou.aliyuncs.com", Region: "cn-hangzhou", Bucket: "clawee-test", ObjectPrefix: "shared-files",
		CredentialMode: "access_key", AccessKeyIDCiphertext: []byte("encrypted-id"), AccessKeySecretCiphertext: []byte("encrypted-secret"),
		Status: "enabled", LastProbeStatus: "success", CreatedBy: "admin", UpdatedBy: "admin", CreatedAt: now, UpdatedAt: now}
	if err := store.CreateStorageProfile(ctx, target); err != nil {
		t.Fatal(err)
	}
	migrationID := "migration_lease"
	if _, err := pool.Exec(ctx, `INSERT INTO shared_file_storage_migrations
(migration_id,source_profile_id,target_profile_id,status,total_count,created_by,created_at)
VALUES ($1,$2,$3,'running',1,'admin',$4)`, migrationID, LocalDefaultProfileID, target.ProfileID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO shared_file_storage_migration_items
(migration_id,file_id,source_profile_id,source_storage_key,source_revision,source_size_bytes,source_sha256,target_storage_key,status)
VALUES ($1,'file_lease',$2,'space_a/file_lease/blob_source',1,0,$3,'space_a/file_lease/blob_target','pending')`,
		migrationID, LocalDefaultProfileID, strings.Repeat("0", 64)); err != nil {
		t.Fatal(err)
	}
	first, _, ok, err := store.ClaimStorageMigrationItem(ctx, now)
	if err != nil || !ok {
		t.Fatalf("first claim = %#v, %v", first, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE shared_file_storage_migration_items SET heartbeat_at=$3
WHERE migration_id=$1 AND file_id=$2`, migrationID, first.FileID, now.Add(-3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	second, _, ok, err := store.ClaimStorageMigrationItem(ctx, now)
	if err != nil || !ok {
		t.Fatalf("second claim = %#v, %v", second, err)
	}
	if first.AttemptCount != 1 || second.AttemptCount != 2 || first.TargetStorageKey == second.TargetStorageKey {
		t.Fatalf("claims first=%#v second=%#v", first, second)
	}
	if migrated, err := store.CompleteStorageMigrationItem(ctx, first, target.ProfileID, now); err != nil || migrated {
		t.Fatalf("expired completion migrated=%v err=%v", migrated, err)
	}
	if err := store.FailStorageMigrationItem(ctx, first, "storage_unavailable", false, now); err != nil {
		t.Fatal(err)
	}
	var status string
	var attempts int
	if err := pool.QueryRow(ctx, `SELECT status,attempt_count FROM shared_file_storage_migration_items
WHERE migration_id=$1 AND file_id=$2`, migrationID, first.FileID).Scan(&status, &attempts); err != nil {
		t.Fatal(err)
	}
	if status != "running" || attempts != 2 {
		t.Fatalf("current lease status=%q attempts=%d", status, attempts)
	}
	if err := store.FailStorageMigrationItem(ctx, second, "digest_mismatch", true, now); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT status,attempt_count FROM shared_file_storage_migration_items
WHERE migration_id=$1 AND file_id=$2`, migrationID, second.FileID).Scan(&status, &attempts); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || attempts != 2 {
		t.Fatalf("permanent failure status=%q attempts=%d", status, attempts)
	}

	cleanupID := "cleanup_lease"
	if _, err := pool.Exec(ctx, `INSERT INTO shared_file_storage_cleanup_tasks
(cleanup_id,storage_profile_id,storage_key,source,status,attempt_count,next_attempt_at,created_at)
VALUES ($1,$2,'space_a/file_a/blob_a','upload_compensation','running',1,$3,$4)`,
		cleanupID, LocalDefaultProfileID, now.Add(-time.Minute), now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	cleanup, ok, err := store.ClaimCleanupTask(ctx, now)
	if err != nil || !ok || cleanup.AttemptCount != 2 {
		t.Fatalf("cleanup claim = %#v ok=%v err=%v", cleanup, ok, err)
	}
	stale := cleanup
	stale.AttemptCount = 1
	if err := store.FinishCleanupTask(ctx, stale, true, "", now); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT status FROM shared_file_storage_cleanup_tasks WHERE cleanup_id=$1`, cleanupID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "running" {
		t.Fatalf("stale cleanup changed status to %q", status)
	}
	if err := store.FinishCleanupTask(ctx, cleanup, true, "", now); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT status FROM shared_file_storage_cleanup_tasks WHERE cleanup_id=$1`, cleanupID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" {
		t.Fatalf("current cleanup status = %q", status)
	}
}

func TestPostgresStorageMigrationConcurrentFinalization(t *testing.T) {
	pool := openSharedFilesTestPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)
	now := time.Now().UTC()
	target := StorageProfile{ProfileID: "storage_profile_target", Name: "Target", Provider: "aliyun_oss",
		Endpoint: "https://oss-cn-hangzhou.aliyuncs.com", Region: "cn-hangzhou", Bucket: "clawee-test", ObjectPrefix: "shared-files",
		CredentialMode: "access_key", AccessKeyIDCiphertext: []byte("encrypted-id"), AccessKeySecretCiphertext: []byte("encrypted-secret"),
		Status: "enabled", LastProbeStatus: "success", CreatedBy: "admin", UpdatedBy: "admin", CreatedAt: now, UpdatedAt: now}
	if err := store.CreateStorageProfile(ctx, target); err != nil {
		t.Fatal(err)
	}
	migrationID := "migration_concurrent"
	if _, err := pool.Exec(ctx, `INSERT INTO shared_file_storage_migrations
(migration_id,source_profile_id,target_profile_id,status,total_count,created_by,created_at)
VALUES ($1,$2,$3,'running',2,'admin',$4)`, migrationID, LocalDefaultProfileID, target.ProfileID, now); err != nil {
		t.Fatal(err)
	}
	items := []StorageMigrationItem{
		{MigrationID: migrationID, FileID: "file_a", SourceProfileID: LocalDefaultProfileID, SourceStorageKey: "space_a/file_a/blob_source", SourceRevision: 1, TargetStorageKey: "space_a/file_a/blob_target-1", AttemptCount: 1},
		{MigrationID: migrationID, FileID: "file_b", SourceProfileID: LocalDefaultProfileID, SourceStorageKey: "space_a/file_b/blob_source", SourceRevision: 1, TargetStorageKey: "space_a/file_b/blob_target-1", AttemptCount: 1},
	}
	for _, item := range items {
		if _, err := pool.Exec(ctx, `INSERT INTO shared_file_storage_migration_items
(migration_id,file_id,source_profile_id,source_storage_key,source_revision,source_size_bytes,source_sha256,target_storage_key,status,attempt_count,heartbeat_at)
VALUES ($1,$2,$3,$4,$5,0,$6,$7,'running',$8,$9)`, item.MigrationID, item.FileID, item.SourceProfileID,
			item.SourceStorageKey, item.SourceRevision, strings.Repeat("0", 64), item.TargetStorageKey, item.AttemptCount, now); err != nil {
			t.Fatal(err)
		}
	}
	start := make(chan struct{})
	errorsOut := make(chan error, len(items))
	var workers sync.WaitGroup
	for _, item := range items {
		item := item
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			_, err := store.CompleteStorageMigrationItem(ctx, item, target.ProfileID, now)
			errorsOut <- err
		}()
	}
	close(start)
	workers.Wait()
	close(errorsOut)
	for err := range errorsOut {
		if err != nil {
			t.Fatal(err)
		}
	}
	result, err := store.GetStorageMigration(ctx, migrationID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "completed" || result.SkippedCount != 2 {
		t.Fatalf("concurrent final migration = %#v", result)
	}
}

func TestPostgresStorageProfileConfigAndMigrationCAS(t *testing.T) {
	pool := openSharedFilesTestPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)
	now := time.Now().UTC().Truncate(time.Microsecond)
	target := StorageProfile{ProfileID: "storage_profile_cas_target", Name: "Target", Provider: "aliyun_oss",
		Endpoint: "https://oss-cn-hangzhou.aliyuncs.com", Region: "cn-hangzhou", Bucket: "clawee-test", ObjectPrefix: "shared-files",
		CredentialMode: "ecs_ram_role", Status: "enabled", LastProbeStatus: "success", CreatedBy: "admin", UpdatedBy: "admin", CreatedAt: now, UpdatedAt: now}
	if err := store.CreateStorageProfile(ctx, target); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO shared_spaces
(space_id,name,description,created_by,updated_by,created_at,updated_at)
VALUES ('space_cas','CAS','','admin','admin',$1,$1)`, now); err != nil {
		t.Fatal(err)
	}
	sourceKey := "space_cas/file_cas/blob_source"
	targetKey := "space_cas/file_cas/blob_target"
	digest := strings.Repeat("a", 64)
	if _, err := pool.Exec(ctx, `INSERT INTO shared_files
(file_id,space_id,logical_path,file_name,storage_key,size_bytes,sha256,content_type,revision,
created_by_user_id,created_by_agent_id,updated_by_user_id,updated_by_agent_id,created_at,updated_at,storage_profile_id)
VALUES ('file_cas','space_cas','file.txt','file.txt',$1,4,$2,'text/plain',7,'creator','agent_creator','updater','agent_updater',$3,$3,$4)`,
		sourceKey, digest, now, LocalDefaultProfileID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO shared_file_storage_migrations
(migration_id,source_profile_id,target_profile_id,status,total_count,created_by,created_at,started_at)
VALUES ('migration_cas',$1,$2,'running',1,'admin',$3,$3)`, LocalDefaultProfileID, target.ProfileID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO shared_file_storage_migration_items
(migration_id,file_id,source_profile_id,source_storage_key,source_revision,source_size_bytes,source_sha256,target_storage_key,status,attempt_count,heartbeat_at)
VALUES ('migration_cas','file_cas',$1,$2,7,4,$3,$4,'running',1,$5)`, LocalDefaultProfileID, sourceKey, digest, targetKey, now); err != nil {
		t.Fatal(err)
	}

	config, err := store.GetStorageProfileConfig(ctx, LocalDefaultProfileID)
	if err != nil || config.FileCount != 0 || config.SizeBytes != 0 {
		t.Fatalf("profile config = %#v, %v", config, err)
	}
	aggregated, err := store.GetStorageProfile(ctx, LocalDefaultProfileID)
	if err != nil || aggregated.FileCount != 1 || aggregated.SizeBytes != 4 {
		t.Fatalf("aggregated profile = %#v, %v", aggregated, err)
	}

	item := StorageMigrationItem{MigrationID: "migration_cas", FileID: "file_cas", SourceProfileID: LocalDefaultProfileID,
		SourceStorageKey: sourceKey, SourceRevision: 7, SourceSizeBytes: 4, SourceSHA256: digest, TargetStorageKey: targetKey, AttemptCount: 1}
	migrated, err := store.CompleteStorageMigrationItem(ctx, item, target.ProfileID, now.Add(time.Second))
	if err != nil || !migrated {
		t.Fatalf("complete migration migrated=%v err=%v", migrated, err)
	}
	var profileID, storageKey, updatedByUser, updatedByAgent string
	var revision int64
	var updatedAt time.Time
	if err := pool.QueryRow(ctx, `SELECT storage_profile_id,storage_key,revision,updated_by_user_id,updated_by_agent_id,updated_at
FROM shared_files WHERE file_id='file_cas'`).Scan(&profileID, &storageKey, &revision, &updatedByUser, &updatedByAgent, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if profileID != target.ProfileID || storageKey != targetKey || revision != 7 || updatedByUser != "updater" || updatedByAgent != "agent_updater" || !updatedAt.Equal(now) {
		t.Fatalf("migrated file profile=%q key=%q revision=%d updater=%q/%q updated_at=%v", profileID, storageKey, revision, updatedByUser, updatedByAgent, updatedAt)
	}
}

func TestPostgresStorageAuditIsIdempotentByAuditID(t *testing.T) {
	pool := openSharedFilesTestPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)
	audit := StorageAudit{AuditID: "storage_audit_stable", RequestID: "migration-1", OperatorUserID: "admin",
		Action: "migration_complete", ObjectID: "migration-1", Result: "success", Details: map[string]any{"status": "completed"}, CreatedAt: time.Now().UTC()}
	if err := store.RecordStorageAudit(ctx, audit); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordStorageAudit(ctx, audit); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM shared_file_storage_audits WHERE audit_id=$1`, audit.AuditID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("audit count = %d", count)
	}
}

type blockingStorage struct {
	Storage
	stored  chan struct{}
	release chan struct{}
}

func (s *blockingStorage) Put(ctx context.Context, key string, src io.Reader, opts PutOptions) (ObjectMetadata, error) {
	metadata, err := s.Storage.Put(ctx, key, src, opts)
	close(s.stored)
	<-s.release
	return metadata, err
}

func openSharedFilesTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("CLAW_MCP_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("CLAW_MCP_TEST_DATABASE_URL 未设置，跳过 PostgreSQL 共享文件集成测试")
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
	schema := newID("sharedfiles_test_")
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
	if _, err := pool.Exec(context.Background(), `CREATE TABLE accounts (user_id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	applySharedFilesMigration(t, pool, "../../db/migrations/00026_data_resource_grants.sql")
	applySharedFilesMigration(t, pool, "../../db/migrations/00029_shared_files.sql")
	applySharedFilesMigration(t, pool, "../../db/migrations/00030_shared_file_admin_actor.sql")
	applySharedFilesMigration(t, pool, "../../db/migrations/00049_shared_file_storage_profiles.sql")
	return pool
}

func applySharedFilesMigration(t *testing.T, pool *pgxpool.Pool, path string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	up := strings.SplitN(string(raw), "\n-- +goose Down", 2)[0]
	up = strings.TrimPrefix(up, "-- +goose Up\n")
	if _, err := pool.Exec(context.Background(), up); err != nil {
		t.Fatalf("应用迁移 %s: %v", path, err)
	}
}
