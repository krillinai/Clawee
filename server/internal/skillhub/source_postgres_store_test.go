package skillhub

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	pgxmock "github.com/pashagolub/pgxmock/v4"
)

func TestPostgresSourceStoreCreatesAndLoadsSource(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	source := GitHubSource{
		SourceID: "source-1", SpaceID: DefaultSpaceID, Provider: GitHubSourceProvider, RepositoryOwner: "acme", RepositoryName: "skills",
		Branch: "main", ScanRoot: "skills", ExcludePaths: []string{"vendor"}, HasToken: true,
		TokenCiphertext: []byte("encrypted"), AutoPublish: true, Schedule: SourceScheduleHourly,
		Status: SourceStatusActive, CreatedBy: "admin", CreatedAt: now, UpdatedAt: now,
	}
	mock.ExpectQuery(`INSERT INTO skill_sources`).
		WithArgs(source.SourceID, source.SpaceID, source.Provider, source.RepositoryOwner, source.RepositoryName, source.Branch, source.ScanRoot, source.ExcludePaths, source.TokenCiphertext, source.AutoPublish, source.Schedule, source.Status, source.CreatedBy, now, now).
		WillReturnRows(sourceRows().AddRow(source.SourceID, source.SpaceID, source.Provider, source.RepositoryOwner, source.RepositoryName, source.Branch, source.ScanRoot, source.ExcludePaths, source.TokenCiphertext, source.AutoPublish, source.Schedule, source.Status, nil, nil, nil, int64(1), "", source.CreatedBy, now, now))

	created, err := store.CreateSource(context.Background(), source)
	if err != nil || !created.HasToken || string(created.TokenCiphertext) != "encrypted" || created.SyncRevision != 1 || created.CreatedAt.Location() != time.UTC {
		t.Fatalf("CreateSource() = %#v, %v", created, err)
	}

	mock.ExpectQuery(regexp.QuoteMeta(sourceSelect + ` WHERE source_id=$1`)).WithArgs(source.SourceID).
		WillReturnRows(sourceRows().AddRow(source.SourceID, source.SpaceID, source.Provider, source.RepositoryOwner, source.RepositoryName, source.Branch, source.ScanRoot, source.ExcludePaths, source.TokenCiphertext, source.AutoPublish, source.Schedule, source.Status, nil, nil, nil, int64(1), "", source.CreatedBy, now, now))
	loaded, err := store.GetSource(context.Background(), source.SourceID)
	if err != nil || loaded.SourceID != source.SourceID || !loaded.HasToken {
		t.Fatalf("GetSource() = %#v, %v", loaded, err)
	}
}

func TestPostgresSourceStoreMapsMissingSpace(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 9, 15, 0, 0, time.UTC)
	source := GitHubSource{
		SourceID: "source-1", SpaceID: "skillspace-missing", Provider: GitHubSourceProvider,
		RepositoryOwner: "acme", RepositoryName: "skills", Branch: "main", ScanRoot: ".",
		Schedule: SourceScheduleManual, Status: SourceStatusActive, CreatedBy: "admin", CreatedAt: now, UpdatedAt: now,
	}
	mock.ExpectQuery(`INSERT INTO skill_sources`).
		WithArgs(source.SourceID, source.SpaceID, source.Provider, source.RepositoryOwner, source.RepositoryName, source.Branch, source.ScanRoot, source.ExcludePaths, nil, source.AutoPublish, source.Schedule, source.Status, source.CreatedBy, now, now).
		WillReturnError(&pgconn.PgError{Code: "23503", ConstraintName: "skill_sources_space_id_fkey"})

	if _, err := store.CreateSource(context.Background(), source); !errors.Is(err, ErrSpaceNotFound) {
		t.Fatalf("CreateSource(missing space) error=%v, want ErrSpaceNotFound", err)
	}
}

func TestPostgresSourceStoreUpdatesConfigurationAndTokenAtomically(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	source := GitHubSource{SourceID: "source-1", SpaceID: DefaultSpaceID, Provider: GitHubSourceProvider, RepositoryOwner: "acme", RepositoryName: "skills", Branch: "next", ScanRoot: "skills", ExcludePaths: []string{"vendor"}, AutoPublish: true, Schedule: SourceScheduleDaily, Status: SourceStatusActive, LastSyncedCommitSHA: nil, UpdatedAt: now}
	mock.ExpectQuery(`UPDATE skill_sources SET branch=\$2,scan_root=\$3,exclude_paths=\$4,auto_publish=\$5,schedule=\$6,status=\$7,sync_revision=sync_revision\+CASE WHEN \(branch,scan_root,exclude_paths\) IS DISTINCT FROM \(\$2,\$3,\$4\) THEN 1 ELSE 0 END,last_synced_commit_sha=CASE WHEN \(branch,scan_root,exclude_paths\) IS DISTINCT FROM \(\$2,\$3,\$4\) THEN NULL ELSE last_synced_commit_sha END,updated_at=\$8,token_ciphertext=token_ciphertext`).
		WithArgs(source.SourceID, source.Branch, source.ScanRoot, source.ExcludePaths, source.AutoPublish, source.Schedule, source.Status, now).
		WillReturnRows(sourceRows().AddRow(source.SourceID, source.SpaceID, source.Provider, source.RepositoryOwner, source.RepositoryName, source.Branch, source.ScanRoot, source.ExcludePaths, []byte("kept"), source.AutoPublish, source.Schedule, source.Status, nil, nil, nil, int64(2), "", "admin", now.Add(-time.Hour), now))
	updated, err := store.UpdateSource(context.Background(), source, TokenKeep)
	if err != nil || string(updated.TokenCiphertext) != "kept" || updated.SyncRevision != 2 || updated.LastSyncedCommitSHA != nil {
		t.Fatalf("UpdateSource(keep) = %#v, %v", updated, err)
	}

	source.TokenCiphertext = []byte("replacement")
	mock.ExpectQuery(`token_ciphertext=\$9`).WithArgs(source.SourceID, source.Branch, source.ScanRoot, source.ExcludePaths, source.AutoPublish, source.Schedule, source.Status, now, source.TokenCiphertext).
		WillReturnRows(sourceRows().AddRow(source.SourceID, source.SpaceID, source.Provider, source.RepositoryOwner, source.RepositoryName, source.Branch, source.ScanRoot, source.ExcludePaths, source.TokenCiphertext, source.AutoPublish, source.Schedule, source.Status, nil, nil, nil, int64(2), "", "admin", now.Add(-time.Hour), now))
	if _, err := store.UpdateSource(context.Background(), source, TokenReplace); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresSourceStoreListsLatestRunWithSourceSummary(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	mock.ExpectQuery(regexp.QuoteMeta(sourceSelect + ` ORDER BY created_at DESC`)).
		WillReturnRows(sourceRows().AddRow("source-1", DefaultSpaceID, GitHubSourceProvider, "acme", "skills", "main", ".", []string{}, nil, false, SourceScheduleManual, SourceStatusActive, nil, nil, nil, int64(1), "", "admin", now, now))
	mock.ExpectQuery(`SELECT source_id,COUNT\(\*\) FROM skill_source_items WHERE status<>\$1 GROUP BY source_id`).WithArgs(SourceItemStatusMissing).
		WillReturnRows(pgxmock.NewRows([]string{"source_id", "count"}).AddRow("source-1", 86))
	mock.ExpectQuery(`FROM skill_source_sync_runs WHERE source_id=\$1 ORDER BY created_at DESC LIMIT 1`).WithArgs("source-1").
		WillReturnRows(sourceSyncRunRows().AddRow("run-1", "source-1", SourceSyncTriggerManual, SourceRepositoryModeRemote, SourceSyncRunStatusSuccess, "admin", int64(1), nil, strings.Repeat("a", 40), 1, 1, 0, 0, 0, "", now, now, now))

	summaries, err := store.ListSources(context.Background())
	if err != nil || len(summaries) != 1 || summaries[0].LatestRun == nil || summaries[0].LatestRun.RunID != "run-1" || summaries[0].DiscoveredCount != 86 {
		t.Fatalf("ListSources() = %#v, %v", summaries, err)
	}
}

func TestPostgresSourceStoreListsDueSourcesWithTimestampParameter(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 4, 10, 0, 0, 0, time.UTC)
	lastAttempt := now.Add(-2 * time.Hour)
	mock.ExpectQuery(`last_attempt_at<=\$1::timestamptz-INTERVAL '1 hour'.*last_attempt_at<=\$1::timestamptz-INTERVAL '24 hours'`).
		WithArgs(now, 10).
		WillReturnRows(sourceRows().AddRow("source-1", DefaultSpaceID, GitHubSourceProvider, "acme", "skills", "main", ".", []string{}, nil, false, SourceScheduleHourly, SourceStatusActive, lastAttempt, nil, nil, int64(1), "", "admin", now.Add(-24*time.Hour), now))

	sources, err := store.ListDueSources(context.Background(), now, 10)
	if err != nil || len(sources) != 1 || sources[0].SourceID != "source-1" || sources[0].LastAttemptAt == nil || !sources[0].LastAttemptAt.Equal(lastAttempt) {
		t.Fatalf("ListDueSources() = %#v, %v", sources, err)
	}
}

func TestPostgresSourceStoreCreatesLocalSyncRun(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 4, 10, 0, 0, 0, time.UTC)
	run := SourceSyncRun{
		RunID: "run-local", SourceID: "source-1", Trigger: SourceSyncTriggerManual,
		RepositoryMode: SourceRepositoryModeLocal, Status: SourceSyncRunStatusQueued,
		RequestedBy: "admin", CreatedAt: now,
	}
	mock.ExpectQuery(`INSERT INTO skill_source_sync_runs \(run_id,source_id,trigger,repository_mode`).
		WithArgs(run.RunID, run.SourceID, run.Trigger, run.RepositoryMode, run.Status, run.RequestedBy, run.BeforeCommitSHA, run.TargetCommitSHA, 0, 0, 0, 0, 0, "", run.StartedAt, run.FinishedAt, now).
		WillReturnRows(sourceSyncRunRows().AddRow(run.RunID, run.SourceID, run.Trigger, run.RepositoryMode, run.Status, run.RequestedBy, int64(0), nil, nil, 0, 0, 0, 0, 0, "", nil, nil, now))

	stored, err := store.CreateSyncRun(context.Background(), run)
	if err != nil || stored.RepositoryMode != SourceRepositoryModeLocal {
		t.Fatalf("CreateSyncRun() = %#v, %v", stored, err)
	}
}

func TestPostgresSourceStoreBindsAndUnbindsWithLocks(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT source_id FROM skill_source_items WHERE source_item_id=\$1`).WithArgs("item-1").
		WillReturnRows(pgxmock.NewRows([]string{"source_id"}).AddRow("source-1"))
	mock.ExpectQuery(`SELECT source_id,space_id FROM skill_sources WHERE source_id=\$1 FOR UPDATE`).WithArgs("source-1").
		WillReturnRows(pgxmock.NewRows([]string{"source_id", "space_id"}).AddRow("source-1", DefaultSpaceID))
	mock.ExpectQuery(`FROM skill_source_items WHERE source_item_id=\$1 FOR UPDATE`).WithArgs("item-1").
		WillReturnRows(sourceItemRows().AddRow("item-1", "source-1", "skills/code-review", "code-review", nil, SourceItemStatusNameConflict, nil, nil, nil, "", nil, now, now))
	mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE skill_id=\$1 FOR UPDATE`).WithArgs("skill-1").
		WillReturnRows(skillRows().AddRow("skill-1", DefaultSpaceID, "code-review", nil, "admin", now, now))
	mock.ExpectQuery(`SELECT source_item_id FROM skill_source_items WHERE skill_id=\$1 AND source_item_id<>\$2 FOR UPDATE`).WithArgs("skill-1", "item-1").
		WillReturnRows(pgxmock.NewRows([]string{"source_item_id"}))
	mock.ExpectQuery(`UPDATE skill_source_items SET skill_id=\$2,status='active',missing_since=NULL,updated_at=\$3`).WithArgs("item-1", "skill-1", now).
		WillReturnRows(sourceItemRows().AddRow("item-1", "source-1", "skills/code-review", "code-review", "skill-1", SourceItemStatusActive, nil, nil, nil, "", nil, now, now))
	mock.ExpectExec(`UPDATE skill_sources SET sync_revision=sync_revision\+1,last_synced_commit_sha=NULL,updated_at=\$2 WHERE source_id=\$1`).WithArgs("source-1", now).
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()
	bound, err := store.BindSourceItem(context.Background(), "item-1", "skill-1", now)
	if err != nil || bound.SkillID == nil || *bound.SkillID != "skill-1" {
		t.Fatalf("BindSourceItem() = %#v, %v", bound, err)
	}

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT source_id FROM skill_source_items WHERE source_item_id=\$1`).WithArgs("item-1").
		WillReturnRows(pgxmock.NewRows([]string{"source_id"}).AddRow("source-1"))
	mock.ExpectQuery(`SELECT source_id FROM skill_sources WHERE source_id=\$1 FOR UPDATE`).WithArgs("source-1").
		WillReturnRows(pgxmock.NewRows([]string{"source_id"}).AddRow("source-1"))
	mock.ExpectQuery(`FROM skill_source_items WHERE source_item_id=\$1 FOR UPDATE`).WithArgs("item-1").
		WillReturnRows(sourceItemRows().AddRow("item-1", "source-1", "skills/code-review", "code-review", "skill-1", SourceItemStatusActive, nil, nil, nil, "", nil, now, now))
	mock.ExpectQuery(`UPDATE skill_source_items SET skill_id=NULL,status='name_conflict',updated_at=\$2`).WithArgs("item-1", now).
		WillReturnRows(sourceItemRows().AddRow("item-1", "source-1", "skills/code-review", "code-review", nil, SourceItemStatusNameConflict, nil, nil, nil, "", nil, now, now))
	mock.ExpectExec(`UPDATE skill_sources SET sync_revision=sync_revision\+1,last_synced_commit_sha=NULL,updated_at=\$2 WHERE source_id=\$1`).WithArgs("source-1", now).
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()
	unbound, err := store.UnbindSourceItem(context.Background(), "item-1", now)
	if err != nil || unbound.SkillID != nil || unbound.Status != SourceItemStatusNameConflict {
		t.Fatalf("UnbindSourceItem() = %#v, %v", unbound, err)
	}
}

func TestPostgresSourceStoreRejectsCrossSpaceBinding(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 9, 30, 0, 0, time.UTC)

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT source_id FROM skill_source_items WHERE source_item_id=\$1`).WithArgs("item-1").
		WillReturnRows(pgxmock.NewRows([]string{"source_id"}).AddRow("source-1"))
	mock.ExpectQuery(`SELECT source_id,space_id FROM skill_sources WHERE source_id=\$1 FOR UPDATE`).WithArgs("source-1").
		WillReturnRows(pgxmock.NewRows([]string{"source_id", "space_id"}).AddRow("source-1", "skillspace-team"))
	mock.ExpectQuery(`FROM skill_source_items WHERE source_item_id=\$1 FOR UPDATE`).WithArgs("item-1").
		WillReturnRows(sourceItemRows().AddRow("item-1", "source-1", "skills/code-review", "code-review", nil, SourceItemStatusNameConflict, nil, nil, nil, "", nil, now, now))
	mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE skill_id=\$1 FOR UPDATE`).WithArgs("skill-1").
		WillReturnRows(skillRows().AddRow("skill-1", DefaultSpaceID, "code-review", nil, "admin", now, now))
	mock.ExpectRollback()

	if _, err := store.BindSourceItem(context.Background(), "item-1", "skill-1", now); !errors.Is(err, ErrConflict) {
		t.Fatalf("BindSourceItem(cross space) error=%v, want ErrConflict", err)
	}
}

func TestPostgresSourceStoreClaimsQueuedRunAndUpdatesAttempt(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	createdAt := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	now := createdAt.Add(time.Minute)
	mock.ExpectBegin()
	mock.ExpectQuery(`FROM skill_source_sync_runs r JOIN skill_sources s ON s.source_id=r.source_id.*FOR UPDATE OF r,s SKIP LOCKED`).
		WillReturnRows(sourceSyncRunRows().AddRow("run-1", "source-1", SourceSyncTriggerManual, SourceRepositoryModeLocal, SourceSyncRunStatusQueued, "admin", int64(7), nil, nil, 0, 0, 0, 0, 0, "", nil, nil, createdAt))
	mock.ExpectQuery(`UPDATE skill_source_sync_runs SET status='running',started_at=\$2,source_revision=\$3 WHERE run_id=\$1`).WithArgs("run-1", now, int64(7)).
		WillReturnRows(sourceSyncRunRows().AddRow("run-1", "source-1", SourceSyncTriggerManual, SourceRepositoryModeLocal, SourceSyncRunStatusRunning, "admin", int64(7), nil, nil, 0, 0, 0, 0, 0, "", now, nil, createdAt))
	mock.ExpectExec(`UPDATE skill_sources SET last_attempt_at=\$2,updated_at=\$2 WHERE source_id=\$1`).WithArgs("source-1", now).
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()
	run, ok, err := store.ClaimNextSyncRun(context.Background(), now)
	if err != nil || !ok || run.RepositoryMode != SourceRepositoryModeLocal || run.Status != SourceSyncRunStatusRunning || run.SourceRevision != 7 || run.StartedAt == nil || !run.StartedAt.Equal(now) {
		t.Fatalf("ClaimNextSyncRun() = %#v, %v, %v", run, ok, err)
	}
}

func TestPostgresSourceStoreCompletesRunForMatchingSourceOnly(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	run := SourceSyncRun{RunID: "run-1", SourceID: "source-1", SourceRevision: 7, Status: SourceSyncRunStatusSuccess, FinishedAt: &now}
	source := GitHubSource{SourceID: "source-1", UpdatedAt: now}
	mock.ExpectBegin()
	mock.ExpectQuery(`WHERE run_id=\$1 AND source_id=\$11 AND status='running'`).
		WithArgs(run.RunID, run.Status, run.TargetCommitSHA, run.DiscoveredCount, run.CreatedVersionCount, run.PublishedCount, run.ConflictCount, run.FailedCount, run.ErrorSummary, run.FinishedAt, source.SourceID).
		WillReturnRows(sourceSyncRunRows().AddRow(run.RunID, source.SourceID, SourceSyncTriggerManual, SourceRepositoryModeRemote, run.Status, "admin", int64(7), nil, nil, 0, 0, 0, 0, 0, "", now.Add(-time.Minute), now, now.Add(-time.Hour)))
	mock.ExpectExec(`UPDATE skill_sources SET last_success_at=\$2,last_synced_commit_sha=CASE WHEN sync_revision=\$6 THEN \$3 ELSE last_synced_commit_sha END,last_error_summary=\$4,updated_at=\$5 WHERE source_id=\$1`).
		WithArgs(source.SourceID, source.LastSuccessAt, source.LastSyncedCommitSHA, source.LastErrorSummary, source.UpdatedAt, run.SourceRevision).
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()
	if _, err := store.CompleteSyncRun(context.Background(), run, source); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresSourceStoreSyncCompletionUsesPersistedRevision(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	commit := strings.Repeat("a", 40)
	run := SourceSyncRun{RunID: "run-1", SourceID: "source-1", SourceRevision: 999, Status: SourceSyncRunStatusSuccess, TargetCommitSHA: &commit, FinishedAt: &now}
	source := GitHubSource{SourceID: "source-1", LastSyncedCommitSHA: &commit, UpdatedAt: now}
	mock.ExpectBegin()
	mock.ExpectQuery(`WHERE run_id=\$1 AND source_id=\$11 AND status='running'`).
		WithArgs(run.RunID, run.Status, run.TargetCommitSHA, run.DiscoveredCount, run.CreatedVersionCount, run.PublishedCount, run.ConflictCount, run.FailedCount, run.ErrorSummary, run.FinishedAt, source.SourceID).
		WillReturnRows(sourceSyncRunRows().AddRow(run.RunID, source.SourceID, SourceSyncTriggerManual, SourceRepositoryModeRemote, run.Status, "admin", int64(7), nil, commit, 0, 0, 0, 0, 0, "", now.Add(-time.Minute), now, now.Add(-time.Hour)))
	mock.ExpectExec(`last_synced_commit_sha=CASE WHEN sync_revision=\$6 THEN \$3 ELSE last_synced_commit_sha END`).
		WithArgs(source.SourceID, source.LastSuccessAt, source.LastSyncedCommitSHA, source.LastErrorSummary, source.UpdatedAt, int64(7)).
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()

	if _, err := store.CompleteSyncRun(context.Background(), run, source); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresSourceStoreFailedCompletionDoesNotUpdateSuccessCursor(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	run := SourceSyncRun{RunID: "run-1", SourceID: "source-1", SourceRevision: 7, Status: SourceSyncRunStatusFailed, FinishedAt: &now}
	source := GitHubSource{SourceID: "source-1", UpdatedAt: now, LastErrorSummary: "同步失败"}
	mock.ExpectBegin()
	mock.ExpectQuery(`WHERE run_id=\$1 AND source_id=\$11 AND status='running'`).
		WithArgs(run.RunID, run.Status, run.TargetCommitSHA, run.DiscoveredCount, run.CreatedVersionCount, run.PublishedCount, run.ConflictCount, run.FailedCount, run.ErrorSummary, run.FinishedAt, source.SourceID).
		WillReturnRows(sourceSyncRunRows().AddRow(run.RunID, source.SourceID, SourceSyncTriggerManual, SourceRepositoryModeRemote, run.Status, "admin", int64(7), nil, nil, 0, 0, 0, 0, 0, run.ErrorSummary, now.Add(-time.Minute), now, now.Add(-time.Hour)))
	mock.ExpectExec(`UPDATE skill_sources SET last_error_summary=\$2,updated_at=\$3 WHERE source_id=\$1`).
		WithArgs(source.SourceID, source.LastErrorSummary, source.UpdatedAt).
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()

	if _, err := store.CompleteSyncRun(context.Background(), run, source); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresStoreFindsVersionBySourceCommit(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	commit := strings.Repeat("b", 40)
	mock.ExpectQuery(`WHERE source_id=\$1 AND source_path=\$2 AND source_commit_sha=\$3`).
		WithArgs("source-1", "skills/code-review", commit).
		WillReturnRows(versionRows().AddRow("version-1", "skill-1", "git-b", "description", "", "version-1.zip", "sha", now))

	version, err := store.FindVersionBySourceCommit(context.Background(), "source-1", "skills/code-review", commit)
	if err != nil || version.VersionID != "version-1" || version.SkillID != "skill-1" {
		t.Fatalf("FindVersionBySourceCommit() = %#v, %v", version, err)
	}
}

func TestPostgresSourceStoreRecoversRunsAndFindsVersionByCommit(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	mock.ExpectExec(`UPDATE skill_source_sync_runs SET status='interrupted',error_summary=CASE`).WithArgs(now).
		WillReturnResult(pgxmock.NewResult("UPDATE", 2))
	if err := store.RecoverRunningSyncRuns(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	commit := strings.Repeat("a", 40)
	mock.ExpectQuery(`SELECT version_id,skill_id,version,description,changelog,package_path,package_sha256,created_at FROM skill_versions WHERE source_id=\$1 AND source_path=\$2 AND source_commit_sha=\$3`).
		WithArgs("source-1", "skills/code-review", commit).
		WillReturnRows(versionRows().AddRow("version-1", "skill-1", "git-a", "description", "", "version-1.zip", "sha", now))
	version, err := store.FindVersionBySourceCommit(context.Background(), "source-1", "skills/code-review", commit)
	if err != nil || version.VersionID != "version-1" {
		t.Fatalf("FindVersionBySourceCommit() = %#v, %v", version, err)
	}
}

func TestPostgresSourceStoreMapsDuplicateBoundSkillOnUpsertToConflict(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 15, 0, 0, 0, time.UTC)
	skillID := "skill-1"
	item := SourceItem{SourceItemID: "item-2", SourceID: "source-2", SkillPath: "skills/two", SkillID: &skillID, Status: SourceItemStatusActive, CreatedAt: now, UpdatedAt: now}
	mock.ExpectQuery(`INSERT INTO skill_source_items`).
		WithArgs(item.SourceItemID, item.SourceID, item.SkillPath, item.DiscoveredName, item.SkillID, item.Status, item.LastSeenCommitSHA, item.LastContentSHA256, item.LastVersionID, item.LastErrorSummary, item.MissingSince, item.CreatedAt, item.UpdatedAt).
		WillReturnError(&pgconn.PgError{Code: "23505", ConstraintName: "uq_skill_source_items_bound_skill"})
	if _, err := store.UpsertSourceItem(context.Background(), item); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate bound skill error = %v, want ErrConflict", err)
	}
}

func TestPostgresSourceStoreUpsertForSyncUsesRevisionAndBindingCAS(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 15, 0, 0, 0, time.UTC)
	skillID := "skill-created"
	item := SourceItem{
		SourceItemID: "item-1", SourceID: "source-1", SkillPath: "skills/one", DiscoveredName: "one",
		SkillID: &skillID, Status: SourceItemStatusActive, CreatedAt: now, UpdatedAt: now,
	}
	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT sync_revision FROM skill_sources WHERE source_id=\$1 FOR UPDATE`).WithArgs(item.SourceID).
		WillReturnRows(pgxmock.NewRows([]string{"sync_revision"}).AddRow(int64(7)))
	mock.ExpectQuery(`INSERT INTO skill_source_items .*ON CONFLICT \(source_id,skill_path\) DO UPDATE SET .*skill_id=COALESCE\(skill_source_items.skill_id,EXCLUDED.skill_id\)`).
		WithArgs(item.SourceItemID, item.SourceID, item.SkillPath, item.DiscoveredName, item.SkillID, item.Status, item.LastSeenCommitSHA, item.LastContentSHA256, item.LastVersionID, item.LastErrorSummary, item.MissingSince, item.CreatedAt, item.UpdatedAt).
		WillReturnRows(sourceItemRows().AddRow(item.SourceItemID, item.SourceID, item.SkillPath, item.DiscoveredName, skillID, item.Status, nil, nil, nil, "", nil, now, now))
	mock.ExpectCommit()

	stored, err := store.UpsertSourceItemForSync(context.Background(), item, 7)
	if err != nil || stored.SkillID == nil || *stored.SkillID != skillID {
		t.Fatalf("UpsertSourceItemForSync() = %#v, %v", stored, err)
	}
	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT sync_revision FROM skill_sources WHERE source_id=\$1 FOR UPDATE`).WithArgs(item.SourceID).
		WillReturnRows(pgxmock.NewRows([]string{"sync_revision"}).AddRow(int64(7)))
	mock.ExpectRollback()
	if _, err := store.UpsertSourceItemForSync(context.Background(), item, 6); !errors.Is(err, errSourceRevisionChanged) {
		t.Fatalf("stale UpsertSourceItemForSync() error = %v, want errSourceRevisionChanged", err)
	}
}

func TestPostgresSourceStoreMarkMissingUsesRevisionLock(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresSourceStore(mock)
	now := time.Date(2026, 8, 3, 16, 0, 0, 0, time.UTC)
	commit := strings.Repeat("a", 40)

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT sync_revision FROM skill_sources WHERE source_id=\$1 FOR UPDATE`).WithArgs("source-1").
		WillReturnRows(pgxmock.NewRows([]string{"sync_revision"}).AddRow(int64(7)))
	mock.ExpectExec(`UPDATE skill_source_items SET status='missing'`).WithArgs("source-1", commit, now).
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()
	if err := store.MarkMissingSourceItems(context.Background(), "source-1", commit, now, 7); err != nil {
		t.Fatal(err)
	}

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT sync_revision FROM skill_sources WHERE source_id=\$1 FOR UPDATE`).WithArgs("source-1").
		WillReturnRows(pgxmock.NewRows([]string{"sync_revision"}).AddRow(int64(8)))
	mock.ExpectRollback()
	if err := store.MarkMissingSourceItems(context.Background(), "source-1", commit, now, 7); !errors.Is(err, errSourceRevisionChanged) {
		t.Fatalf("stale MarkMissingSourceItems() error = %v, want errSourceRevisionChanged", err)
	}
}

func sourceRows() *pgxmock.Rows {
	return pgxmock.NewRows([]string{"source_id", "space_id", "provider", "repository_owner", "repository_name", "branch", "scan_root", "exclude_paths", "token_ciphertext", "auto_publish", "schedule", "status", "last_attempt_at", "last_success_at", "last_synced_commit_sha", "sync_revision", "last_error_summary", "created_by", "created_at", "updated_at"})
}

func sourceItemRows() *pgxmock.Rows {
	return pgxmock.NewRows([]string{"source_item_id", "source_id", "skill_path", "discovered_name", "skill_id", "status", "last_seen_commit_sha", "last_content_sha256", "last_version_id", "last_error_summary", "missing_since", "created_at", "updated_at"})
}

func sourceSyncRunRows() *pgxmock.Rows {
	return pgxmock.NewRows([]string{"run_id", "source_id", "trigger", "repository_mode", "status", "requested_by", "source_revision", "before_commit_sha", "target_commit_sha", "discovered_count", "created_version_count", "published_count", "conflict_count", "failed_count", "error_summary", "started_at", "finished_at", "created_at"})
}
