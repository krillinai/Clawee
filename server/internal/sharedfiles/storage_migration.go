package sharedfiles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

const storageMigrationConcurrency = 2

type StorageMigrationStore interface {
	CreateStorageMigration(context.Context, string, string, string, time.Time) (StorageMigration, error)
	GetStorageMigration(context.Context, string) (StorageMigration, error)
	CancelStorageMigration(context.Context, string, time.Time) error
	RetryFailedStorageMigration(context.Context, string) error
	ClaimStorageMigrationItem(context.Context, time.Time) (StorageMigrationItem, string, bool, error)
	HeartbeatStorageMigrationItem(context.Context, StorageMigrationItem, time.Time) error
	CompleteStorageMigrationItem(context.Context, StorageMigrationItem, string, time.Time) (bool, error)
	FailStorageMigrationItem(context.Context, StorageMigrationItem, string, bool, time.Time) error
	EnqueueCleanup(context.Context, ObjectRef, string, string, string, time.Time) error
	ClaimCleanupTask(context.Context, time.Time) (CleanupTask, bool, error)
	FinishCleanupTask(context.Context, CleanupTask, bool, string, time.Time) error
	RecordStorageAudit(context.Context, StorageAudit) error
}

type StorageMigrationService struct {
	store    StorageMigrationStore
	registry StorageRegistry
	logger   *zap.Logger
	clock    func() time.Time
	wake     chan struct{}
	cancel   context.CancelFunc
	wg       sync.WaitGroup
}

func NewStorageMigrationService(store StorageMigrationStore, registry StorageRegistry, logger *zap.Logger) *StorageMigrationService {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &StorageMigrationService{store: store, registry: registry, logger: logger,
		clock: func() time.Time { return time.Now().UTC() }, wake: make(chan struct{}, 1)}
}

func (s *StorageMigrationService) Start(ctx context.Context) {
	if s == nil || s.cancel != nil {
		return
	}
	workerCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	for range storageMigrationConcurrency {
		s.wg.Add(1)
		go s.migrationLoop(workerCtx)
	}
	s.wg.Add(1)
	go s.cleanupLoop(workerCtx)
}

func (s *StorageMigrationService) Close() {
	if s == nil || s.cancel == nil {
		return
	}
	s.cancel()
	s.wg.Wait()
	s.cancel = nil
}

func (s *StorageMigrationService) Create(ctx context.Context, sourceProfileID, targetProfileID, operator, requestID string) (StorageMigration, error) {
	target, err := s.registry.Resolve(ctx, targetProfileID)
	if err == nil {
		err = target.Storage.Probe(ctx)
	}
	if err != nil {
		s.recordAudit(context.WithoutCancel(ctx), operator, requestID, "migration_create", "new_migration", "failure", storageProbeAuditDetails(err))
		return StorageMigration{}, storageProbeError(err)
	}
	item, err := s.store.CreateStorageMigration(ctx, sourceProfileID, targetProfileID, operator, s.clock())
	s.recordAudit(context.WithoutCancel(ctx), operator, requestID, "migration_create", firstNonEmptyString(item.MigrationID, "new_migration"), resultForError(err),
		map[string]any{"source_profile_id": sourceProfileID, "target_profile_id": targetProfileID})
	if err == nil {
		s.auditMigrationFinal(context.WithoutCancel(ctx), item.MigrationID)
		s.Notify()
	}
	return item, err
}

func (s *StorageMigrationService) Get(ctx context.Context, migrationID string) (StorageMigration, error) {
	return s.store.GetStorageMigration(ctx, migrationID)
}

func (s *StorageMigrationService) Cancel(ctx context.Context, migrationID, operator, requestID string) error {
	err := s.store.CancelStorageMigration(ctx, migrationID, s.clock())
	s.recordAudit(context.WithoutCancel(ctx), operator, requestID, "migration_cancel", migrationID, resultForError(err), nil)
	if err == nil {
		s.auditMigrationFinal(context.WithoutCancel(ctx), migrationID)
	}
	return err
}

func (s *StorageMigrationService) RetryFailed(ctx context.Context, migrationID, operator, requestID string) error {
	err := s.store.RetryFailedStorageMigration(ctx, migrationID)
	s.recordAudit(context.WithoutCancel(ctx), operator, requestID, "migration_retry", migrationID, resultForError(err), nil)
	if err == nil {
		s.Notify()
	}
	return err
}

func (s *StorageMigrationService) Notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *StorageMigrationService) migrationLoop(ctx context.Context) {
	defer s.wg.Done()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if worked := s.runMigrationItem(ctx); worked {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-s.wake:
		}
	}
}

func (s *StorageMigrationService) runMigrationItem(ctx context.Context) bool {
	item, targetProfileID, ok, err := s.store.ClaimStorageMigrationItem(ctx, s.clock())
	if err != nil {
		s.logger.Error("领取共享文件迁移项失败")
		return false
	}
	if !ok {
		return false
	}
	done := make(chan struct{})
	go s.heartbeatMigrationItem(ctx, item, done)
	err = s.migrateItem(ctx, item, targetProfileID)
	close(done)
	if err != nil {
		permanent := errors.Is(err, ErrDigestMismatch) || errors.Is(err, ErrInvalidStorageConfiguration)
		code := "storage_unavailable"
		if errors.Is(err, ErrDigestMismatch) {
			code = "digest_mismatch"
		} else if errors.Is(err, ErrInvalidStorageConfiguration) {
			code = "invalid_storage_configuration"
		}
		if storeErr := s.store.FailStorageMigrationItem(context.WithoutCancel(ctx), item, code, permanent, s.clock()); storeErr != nil {
			s.logger.Error("记录共享文件迁移失败状态失败", zap.Bool("critical", true),
				zap.String("migration_id", item.MigrationID), zap.String("file_id", item.FileID))
		}
	}
	s.auditMigrationFinal(context.WithoutCancel(ctx), item.MigrationID)
	return true
}

func (s *StorageMigrationService) heartbeatMigrationItem(ctx context.Context, item StorageMigrationItem, done <-chan struct{}) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case now := <-ticker.C:
			_ = s.store.HeartbeatStorageMigrationItem(ctx, item, now.UTC())
		}
	}
}

func (s *StorageMigrationService) migrateItem(ctx context.Context, item StorageMigrationItem, targetProfileID string) error {
	source, err := s.registry.Resolve(ctx, item.SourceProfileID)
	if err != nil {
		return ErrStorageUnavailable
	}
	target, err := s.registry.Resolve(ctx, targetProfileID)
	if err != nil {
		return ErrStorageUnavailable
	}
	reader, err := source.Storage.Open(ctx, item.SourceStorageKey)
	if err != nil {
		return ErrStorageUnavailable
	}
	defer reader.Close()
	metadata, err := target.Storage.Put(ctx, item.TargetStorageKey, reader, PutOptions{
		DeclaredSize: item.SourceSizeBytes, MaxBytes: MaxFileSizeBytes, ContentType: "application/octet-stream",
		FileID: item.FileID, ProfileID: targetProfileID, SHA256: item.SourceSHA256,
	})
	if err != nil {
		return err
	}
	targetRef := ObjectRef{StorageProfileID: targetProfileID, StorageKey: item.TargetStorageKey}
	if metadata.SizeBytes != item.SourceSizeBytes || metadata.SHA256 != item.SourceSHA256 {
		s.deleteOrEnqueue(context.WithoutCancel(ctx), targetRef, "upload_compensation", item.FileID, item.MigrationID)
		return ErrDigestMismatch
	}
	migrated, err := s.store.CompleteStorageMigrationItem(ctx, item, targetProfileID, s.clock())
	if err != nil {
		s.deleteOrEnqueue(context.WithoutCancel(ctx), targetRef, "upload_compensation", item.FileID, item.MigrationID)
		return err
	}
	if !migrated {
		s.deleteOrEnqueue(context.WithoutCancel(ctx), targetRef, "upload_compensation", item.FileID, item.MigrationID)
		return nil
	}
	s.deleteOrEnqueue(context.WithoutCancel(ctx), ObjectRef{StorageProfileID: item.SourceProfileID, StorageKey: item.SourceStorageKey},
		"migration_source", item.FileID, item.MigrationID)
	return nil
}

func (s *StorageMigrationService) cleanupLoop(ctx context.Context) {
	defer s.wg.Done()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if s.runCleanupTask(ctx) {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-s.wake:
		}
	}
}

func (s *StorageMigrationService) runCleanupTask(ctx context.Context) bool {
	task, ok, err := s.store.ClaimCleanupTask(ctx, s.clock())
	if err != nil || !ok {
		return false
	}
	target, resolveErr := s.registry.Resolve(ctx, task.StorageProfileID)
	if resolveErr == nil {
		resolveErr = target.Storage.Delete(ctx, task.StorageKey)
	}
	success := resolveErr == nil
	code := ""
	if !success {
		code = "storage_unavailable"
	}
	if err := s.store.FinishCleanupTask(context.WithoutCancel(ctx), task, success, code, s.clock()); err != nil {
		s.logger.Error("记录共享文件清理结果失败", zap.Bool("critical", true),
			zap.String("profile_id", task.StorageProfileID), zap.String("file_id", task.FileID), zap.String("migration_id", task.MigrationID))
	} else if !success && task.AttemptCount >= 10 {
		s.logger.Error("共享文件清理任务达到自动重试上限", zap.Bool("critical", true),
			zap.String("profile_id", task.StorageProfileID), zap.String("file_id", task.FileID), zap.String("migration_id", task.MigrationID))
	}
	if task.MigrationID != "" {
		s.auditMigrationFinal(context.WithoutCancel(ctx), task.MigrationID)
	}
	return true
}

func (s *StorageMigrationService) deleteOrEnqueue(ctx context.Context, ref ObjectRef, source, fileID, migrationID string) {
	target, err := s.registry.Resolve(ctx, ref.StorageProfileID)
	if err == nil {
		err = target.Storage.Delete(ctx, ref.StorageKey)
	}
	if err != nil {
		if enqueueErr := s.store.EnqueueCleanup(ctx, ref, source, fileID, migrationID, s.clock()); enqueueErr != nil {
			recordCleanupEnqueueFailure(source)
			s.logger.Error("持久化共享文件清理任务失败", zap.Bool("critical", true),
				zap.String("profile_id", ref.StorageProfileID), zap.String("file_id", fileID), zap.String("migration_id", migrationID))
		}
	}
}

func (s *StorageMigrationService) auditMigrationFinal(ctx context.Context, migrationID string) {
	migration, err := s.store.GetStorageMigration(ctx, migrationID)
	if err != nil || (migration.Status != "completed" && migration.Status != "completed_with_failures" &&
		migration.Status != "completed_with_cleanup_pending" && migration.Status != "cancelled") {
		return
	}
	snapshot := fmt.Sprintf("%s|%s|%s|%d|%d|%d|%d|%d", migration.MigrationID, migration.Status,
		migration.SourceProfileID, migration.TotalCount, migration.SuccessCount, migration.FailedCount, migration.SkippedCount, migration.CleanupPendingCount)
	digest := sha256.Sum256([]byte(snapshot))
	s.recordAuditWithID(ctx, "storage_audit_final_"+hex.EncodeToString(digest[:]), migration.CreatedBy, migrationID,
		"migration_complete", migrationID, "success", map[string]any{
			"status": migration.Status, "source_profile_id": migration.SourceProfileID, "target_profile_id": migration.TargetProfileID,
			"total_count": migration.TotalCount, "success_count": migration.SuccessCount, "failed_count": migration.FailedCount,
			"skipped_count": migration.SkippedCount, "cleanup_pending_count": migration.CleanupPendingCount,
		})
}

func (s *StorageMigrationService) recordAudit(ctx context.Context, operator, requestID, action, objectID, result string, details map[string]any) {
	s.recordAuditWithID(ctx, newID("storage_audit_"), operator, requestID, action, objectID, result, details)
}

func (s *StorageMigrationService) recordAuditWithID(ctx context.Context, auditID, operator, requestID, action, objectID, result string, details map[string]any) {
	if details == nil {
		details = map[string]any{}
	}
	if err := s.store.RecordStorageAudit(ctx, StorageAudit{AuditID: auditID, RequestID: requestID,
		OperatorUserID: operator, Action: action, ObjectID: objectID, Result: result, Details: details, CreatedAt: s.clock()}); err != nil {
		s.logger.Error("记录共享文件存储审计失败", zap.String("action", action), zap.String("request_id", requestID))
	}
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
