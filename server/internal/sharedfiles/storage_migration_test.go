package sharedfiles

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

func TestStorageMigrationRecordsFinalStatistics(t *testing.T) {
	store := &storageMigrationTestStore{migration: StorageMigration{MigrationID: "migration-1", SourceProfileID: "source",
		TargetProfileID: "target", Status: "completed", TotalCount: 3, SuccessCount: 2, SkippedCount: 1, CreatedBy: "admin"}}
	storage := newMemoryStorage()
	registry := &switchingStorageRegistry{targets: map[string]Storage{"target": storage}}
	service := NewStorageMigrationService(store, registry, nil)
	if _, err := service.Create(context.Background(), "source", "target", "admin", "request-1"); err != nil {
		t.Fatal(err)
	}
	if len(store.audits) != 2 || store.audits[1].Action != "migration_complete" {
		t.Fatalf("audits = %#v", store.audits)
	}
	details := store.audits[1].Details
	if details["status"] != "completed" || details["success_count"] != int64(2) || details["skipped_count"] != int64(1) {
		t.Fatalf("final details = %#v", details)
	}
}

func TestStorageMigrationPreservesProbeDeleteFailure(t *testing.T) {
	store := &storageMigrationTestStore{}
	storage := &probeErrorStorage{Storage: newMemoryStorage(), err: ErrStorageProbeDeleteFailed}
	service := NewStorageMigrationService(store, &switchingStorageRegistry{targets: map[string]Storage{"target": storage}}, nil)
	if _, err := service.Create(context.Background(), "source", "target", "admin", "request-1"); !errors.Is(err, ErrStorageProbeDeleteFailed) {
		t.Fatalf("error = %v", err)
	}
	if len(store.audits) != 1 || store.audits[0].Details["stage"] != "delete" {
		t.Fatalf("audits = %#v", store.audits)
	}
}

func TestStorageMigrationMovesAndCompensatesObjects(t *testing.T) {
	content := []byte("migration-content")
	digest := sha256Hex(content)
	item := StorageMigrationItem{MigrationID: "migration-1", FileID: "file-1", SourceProfileID: "source",
		SourceStorageKey: "source-key", SourceRevision: 1, SourceSizeBytes: int64(len(content)), SourceSHA256: digest, TargetStorageKey: "target-key", AttemptCount: 1}

	t.Run("successful CAS queues failed source deletion", func(t *testing.T) {
		source, target := newMemoryStorage(), newMemoryStorage()
		source.objects[item.SourceStorageKey] = content
		source.failDelete = true
		store := &storageMigrationTestStore{completeResult: true}
		service := NewStorageMigrationService(store, &switchingStorageRegistry{targets: map[string]Storage{"source": source, "target": target}}, nil)
		if err := service.migrateItem(context.Background(), item, "target"); err != nil {
			t.Fatal(err)
		}
		if target.objectCount() != 1 || len(store.cleanups) != 1 || store.cleanups[0].Source != "migration_source" {
			t.Fatalf("target_count=%d cleanups=%#v", target.objectCount(), store.cleanups)
		}
	})

	t.Run("skipped CAS deletes target object", func(t *testing.T) {
		source, target := newMemoryStorage(), newMemoryStorage()
		source.objects[item.SourceStorageKey] = content
		store := &storageMigrationTestStore{completeResult: false}
		service := NewStorageMigrationService(store, &switchingStorageRegistry{targets: map[string]Storage{"source": source, "target": target}}, nil)
		if err := service.migrateItem(context.Background(), item, "target"); err != nil {
			t.Fatal(err)
		}
		if source.objectCount() != 1 || target.objectCount() != 0 || len(store.cleanups) != 0 {
			t.Fatalf("source_count=%d target_count=%d cleanups=%#v", source.objectCount(), target.objectCount(), store.cleanups)
		}
	})
}

func TestStorageMigrationFinalAuditIDUsesTerminalSnapshot(t *testing.T) {
	store := &storageMigrationTestStore{migration: StorageMigration{MigrationID: "migration-1", SourceProfileID: "source",
		TargetProfileID: "target", Status: "completed", TotalCount: 1, SuccessCount: 1, CreatedBy: "admin"}}
	service := NewStorageMigrationService(store, &switchingStorageRegistry{}, nil)
	service.auditMigrationFinal(context.Background(), store.migration.MigrationID)
	service.auditMigrationFinal(context.Background(), store.migration.MigrationID)
	if len(store.audits) != 2 || store.audits[0].AuditID != store.audits[1].AuditID {
		t.Fatalf("same snapshot audit IDs = %#v", store.audits)
	}
	firstID := store.audits[0].AuditID
	store.migration.Status = "completed_with_cleanup_pending"
	store.migration.CleanupPendingCount = 1
	service.auditMigrationFinal(context.Background(), store.migration.MigrationID)
	if store.audits[2].AuditID == firstID {
		t.Fatalf("changed snapshot reused audit ID %q", firstID)
	}
}

func TestStorageMigrationWarnsWhenCleanupRetriesAreExhausted(t *testing.T) {
	core, logs := observer.New(zap.ErrorLevel)
	store := &storageMigrationTestStore{cleanup: CleanupTask{CleanupID: "cleanup-1", StorageProfileID: "profile-1", FileID: "file-1", AttemptCount: 10}}
	registry := &switchingStorageRegistry{targets: map[string]Storage{}}
	service := NewStorageMigrationService(store, registry, zap.New(core))
	if !service.runCleanupTask(context.Background()) {
		t.Fatal("未执行清理任务")
	}
	if logs.Len() != 1 || logs.All()[0].ContextMap()["critical"] != true {
		t.Fatalf("logs = %#v", logs.All())
	}
}

type storageMigrationTestStore struct {
	migration      StorageMigration
	cleanup        CleanupTask
	completeResult bool
	cleanups       []CleanupTask
	audits         []StorageAudit
}

func (s *storageMigrationTestStore) CreateStorageMigration(context.Context, string, string, string, time.Time) (StorageMigration, error) {
	return s.migration, nil
}
func (s *storageMigrationTestStore) GetStorageMigration(context.Context, string) (StorageMigration, error) {
	return s.migration, nil
}
func (s *storageMigrationTestStore) CancelStorageMigration(context.Context, string, time.Time) error {
	return nil
}
func (s *storageMigrationTestStore) RetryFailedStorageMigration(context.Context, string) error {
	return nil
}
func (s *storageMigrationTestStore) ClaimStorageMigrationItem(context.Context, time.Time) (StorageMigrationItem, string, bool, error) {
	return StorageMigrationItem{}, "", false, nil
}
func (s *storageMigrationTestStore) HeartbeatStorageMigrationItem(context.Context, StorageMigrationItem, time.Time) error {
	return nil
}
func (s *storageMigrationTestStore) CompleteStorageMigrationItem(context.Context, StorageMigrationItem, string, time.Time) (bool, error) {
	return s.completeResult, nil
}
func (s *storageMigrationTestStore) FailStorageMigrationItem(context.Context, StorageMigrationItem, string, bool, time.Time) error {
	return nil
}

func (s *storageMigrationTestStore) EnqueueCleanup(_ context.Context, ref ObjectRef, source, fileID, migrationID string, _ time.Time) error {
	s.cleanups = append(s.cleanups, CleanupTask{StorageProfileID: ref.StorageProfileID, StorageKey: ref.StorageKey,
		Source: source, FileID: fileID, MigrationID: migrationID})
	return nil
}
func (s *storageMigrationTestStore) ClaimCleanupTask(context.Context, time.Time) (CleanupTask, bool, error) {
	if s.cleanup.CleanupID == "" {
		return CleanupTask{}, false, nil
	}
	task := s.cleanup
	s.cleanup = CleanupTask{}
	return task, true, nil
}
func (s *storageMigrationTestStore) FinishCleanupTask(context.Context, CleanupTask, bool, string, time.Time) error {
	return nil
}
func (s *storageMigrationTestStore) RecordStorageAudit(_ context.Context, audit StorageAudit) error {
	s.audits = append(s.audits, audit)
	return nil
}
