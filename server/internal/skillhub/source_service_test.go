package skillhub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

const testGitHubToken = "github_pat_secret"

type recordingSourceCipher struct {
	encryptInputs [][]byte
	decryptInputs [][]byte
}

func (c *recordingSourceCipher) Encrypt(value []byte) ([]byte, error) {
	c.encryptInputs = append(c.encryptInputs, append([]byte(nil), value...))
	return append([]byte("cipher:"), value...), nil
}

func (c *recordingSourceCipher) Decrypt(value []byte) ([]byte, error) {
	c.decryptInputs = append(c.decryptInputs, append([]byte(nil), value...))
	return bytes.TrimPrefix(value, []byte("cipher:")), nil
}

func TestGitHubSourceServicePersistsWithoutRemoteAccess(t *testing.T) {
	store := NewMemorySourceStore()
	service := NewGitHubSourceService(GitHubSourceServiceConfig{
		Store: store, TokenCipher: &recordingSourceCipher{},
	})

	explicit, err := service.Create(context.Background(), CreateGitHubSourceInput{
		RepositoryOwner: "acme", RepositoryName: "skills", Branch: "missing", CreatedBy: "admin",
	})
	if err != nil || explicit.Branch != "missing" {
		t.Fatalf("explicit branch source = %#v, error = %v", explicit, err)
	}
	defaulted, err := service.Create(context.Background(), CreateGitHubSourceInput{
		RepositoryOwner: "acme", RepositoryName: "other-skills", CreatedBy: "admin",
	})
	if err != nil || defaulted.Branch != "main" {
		t.Fatalf("default branch source = %#v, error = %v", defaulted, err)
	}
}

func TestGitHubSourceServiceListsCurrentDiscoveredCount(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 4, 9, 0, 0, 0, time.UTC)
	store := NewMemorySourceStore()
	service := NewGitHubSourceService(GitHubSourceServiceConfig{Store: store, TokenCipher: &recordingSourceCipher{}})
	created, err := service.Create(ctx, CreateGitHubSourceInput{RepositoryOwner: "acme", RepositoryName: "skills", CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	for index, status := range []string{SourceItemStatusActive, SourceItemStatusInvalid, SourceItemStatusMissing} {
		_, err := store.UpsertSourceItem(ctx, SourceItem{
			SourceItemID: []string{"item-active", "item-invalid", "item-missing"}[index], SourceID: created.SourceID,
			SkillPath: []string{"skills/active", "skills/invalid", "skills/missing"}[index], Status: status, CreatedAt: now, UpdatedAt: now,
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	summaries, err := service.List(ctx)
	if err != nil || len(summaries) != 1 || summaries[0].DiscoveredCount != 2 {
		t.Fatalf("List() = %#v, %v", summaries, err)
	}
}

func TestGitHubSourceServiceBuildsCompleteManualGitInstructions(t *testing.T) {
	workspace := NewRepositoryWorkspace("/var/lib/claw-mcp/skill-sources", nil)
	service := NewGitHubSourceService(GitHubSourceServiceConfig{Workspace: workspace})
	source := GitHubSource{
		SourceID: "source_123", RepositoryOwner: "acme", RepositoryName: "skills", Branch: "release/2026",
		LastErrorSummary: sourceCloneFailurePrefix + "fatal: repository not found",
	}

	instructions := service.ManualCloneInstructions(source)
	if instructions == nil {
		t.Fatal("ManualCloneInstructions() = nil")
	}
	if instructions.WorkingDirectory != "/var/lib/claw-mcp/skill-sources/source_123" || instructions.RepositoryDirectory != "/var/lib/claw-mcp/skill-sources/source_123/repository" {
		t.Fatalf("manual clone paths = %#v", instructions)
	}
	wantCommand := "git clone --progress --depth=1 --single-branch --no-tags --branch 'release/2026' 'https://github.com/acme/skills.git' 'repository'"
	if instructions.Command != wantCommand {
		t.Fatalf("manual clone command = %q, want %q", instructions.Command, wantCommand)
	}
	if len(instructions.CommandGroups) != 3 {
		t.Fatalf("manual command groups = %#v", instructions.CommandGroups)
	}
	if instructions.CommandGroups[0].Title != "首次同步：Clone" || instructions.CommandGroups[0].Commands[1] != wantCommand {
		t.Fatalf("clone command group = %#v", instructions.CommandGroups[0])
	}
	if instructions.CommandGroups[1].Title != "后续同步：Fetch" || !strings.Contains(strings.Join(instructions.CommandGroups[1].Commands, "\n"), "fetch --progress --prune --depth=1 origin 'release/2026'") {
		t.Fatalf("fetch command group = %#v", instructions.CommandGroups[1])
	}
	if instructions.CommandGroups[2].Title != "Skill 发现阶段" || !strings.Contains(instructions.CommandGroups[2].Commands[0], "ls-files --stage -z") {
		t.Fatalf("discovery command group = %#v", instructions.CommandGroups[2])
	}
}

func TestGitHubSourceServiceEncryptsAndRedactsTokenLifecycle(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 3, 9, 30, 0, 0, time.UTC)
	store := NewMemorySourceStore()
	cipher := &recordingSourceCipher{}
	service := NewGitHubSourceService(GitHubSourceServiceConfig{
		Store: store, TokenCipher: cipher,
		Clock: func() time.Time { return now },
	})

	created, err := service.Create(ctx, CreateGitHubSourceInput{
		RepositoryOwner: "Acme", RepositoryName: "Skills", ScanRoot: "./skills/",
		ExcludePaths: []string{"vendor/", "generated", "vendor"}, Token: testGitHubToken,
		AutoPublish: true, Schedule: SourceScheduleHourly, CreatedBy: "usr-admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.RepositoryOwner != "acme" || created.RepositoryName != "skills" || created.Branch != "main" || created.ScanRoot != "skills" {
		t.Fatalf("created source = %#v", created)
	}
	if !created.HasToken || len(created.TokenCiphertext) != 0 {
		t.Fatalf("created token fields = has:%v ciphertext:%q", created.HasToken, created.TokenCiphertext)
	}
	if len(cipher.encryptInputs) != 1 || string(cipher.encryptInputs[0]) != testGitHubToken {
		t.Fatalf("encrypt inputs = %#v", cipher.encryptInputs)
	}
	raw, err := store.GetSource(ctx, created.SourceID)
	if err != nil || string(raw.TokenCiphertext) != "cipher:"+testGitHubToken || !raw.HasToken {
		t.Fatalf("stored source = %#v, %v", raw, err)
	}
	assertSourceSecretAbsent(t, created, nil)

	commit := strings.Repeat("a", 40)
	raw.LastSyncedCommitSHA = &commit
	if _, err := store.CreateSyncRun(ctx, SourceSyncRun{RunID: "run-cursor", SourceID: raw.SourceID, Trigger: SourceSyncTriggerManual, Status: SourceSyncRunStatusQueued, RequestedBy: "admin", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	claimed, ok, err := store.ClaimNextSyncRun(ctx, now)
	if err != nil || !ok {
		t.Fatalf("ClaimNextSyncRun() = %#v, %v, %v", claimed, ok, err)
	}
	claimed.Status = SourceSyncRunStatusSuccess
	claimed.FinishedAt = &now
	if _, err := store.CompleteSyncRun(ctx, claimed, raw); err != nil {
		t.Fatal(err)
	}
	updated, err := service.Update(ctx, created.SourceID, UpdateGitHubSourceInput{
		RepositoryOwner: "ACME", RepositoryName: "SKILLS", Branch: "main", ScanRoot: "skills",
		ExcludePaths: []string{"generated", "vendor"}, AutoPublish: false, Schedule: SourceScheduleDaily,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !updated.HasToken || updated.LastSyncedCommitSHA == nil || *updated.LastSyncedCommitSHA != commit || len(cipher.encryptInputs) != 1 {
		t.Fatalf("metadata-only update = %#v, encrypt calls=%d", updated, len(cipher.encryptInputs))
	}

	replacement := "github_pat_replacement"
	updated, err = service.Update(ctx, created.SourceID, UpdateGitHubSourceInput{
		Branch: "release/2026.08", ScanRoot: ".", ExcludePaths: []string{"vendor"},
		AutoPublish: false, Schedule: SourceScheduleDaily, Token: &replacement,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.LastSyncedCommitSHA != nil || !updated.HasToken || len(cipher.encryptInputs) != 2 || string(cipher.encryptInputs[1]) != replacement {
		t.Fatalf("replacement update = %#v, encrypt inputs=%#v", updated, cipher.encryptInputs)
	}
	assertSourceSecretAbsent(t, updated, nil)

	emptyToken := ""
	withoutToken, err := service.Update(ctx, created.SourceID, UpdateGitHubSourceInput{
		Branch: "release/2026.08", ScanRoot: ".", ExcludePaths: []string{"vendor"},
		AutoPublish: false, Schedule: SourceScheduleDaily, Token: &emptyToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = store.GetSource(ctx, created.SourceID)
	if withoutToken.HasToken || raw.HasToken || len(raw.TokenCiphertext) != 0 {
		t.Fatalf("empty token update result=%#v stored=%#v", withoutToken, raw)
	}
	assertSourceSecretAbsent(t, withoutToken, nil)
}

func TestGitHubSourceServiceReturnsPlaintextTokenForEditing(t *testing.T) {
	ctx := context.Background()
	store := NewMemorySourceStore()
	service := NewGitHubSourceService(GitHubSourceServiceConfig{Store: store, TokenCipher: &recordingSourceCipher{}})
	created, err := service.Create(ctx, CreateGitHubSourceInput{
		RepositoryOwner: "acme", RepositoryName: "skills", Token: testGitHubToken, CreatedBy: "admin",
	})
	if err != nil {
		t.Fatal(err)
	}

	token, err := service.GetToken(ctx, created.SourceID)
	if err != nil || token != testGitHubToken {
		t.Fatalf("GetToken() = %q, %v", token, err)
	}
}

func TestGitHubSourceServiceRejectsInvalidAndImmutableConfiguration(t *testing.T) {
	ctx := context.Background()
	store := NewMemorySourceStore()
	service := NewGitHubSourceService(GitHubSourceServiceConfig{
		Store: store, TokenCipher: &recordingSourceCipher{},
	})
	if _, err := service.Create(ctx, CreateGitHubSourceInput{RepositoryOwner: "acme/other", RepositoryName: "skills", CreatedBy: "admin"}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("invalid create error = %v", err)
	}
	created, err := service.Create(ctx, CreateGitHubSourceInput{RepositoryOwner: "acme", RepositoryName: "skills", CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Update(ctx, created.SourceID, UpdateGitHubSourceInput{RepositoryOwner: "other", RepositoryName: "skills", Branch: "main", ScanRoot: ".", Schedule: SourceScheduleManual}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("immutable repository update error = %v", err)
	}
}

func TestGitHubSourceServiceChangesStatusBindsItemsAndQueuesSync(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 3, 10, 0, 0, 0, time.UTC)
	skills := NewMemoryStore()
	_, _, err := skills.CreateVersion(ctx,
		Skill{SkillID: "skill-1", Name: "code-review", CreatedBy: "admin", CreatedAt: now, UpdatedAt: now},
		Version{VersionID: "version-1", Version: "1.0", CreatedAt: now},
		CreateVersionOptions{Resolution: VersionResolutionCreateOnly},
	)
	if err != nil {
		t.Fatal(err)
	}
	store := NewMemorySourceStore(skills)
	queuedNotifications := 0
	service := NewGitHubSourceService(GitHubSourceServiceConfig{
		Store: store, TokenCipher: &recordingSourceCipher{},
		Clock: func() time.Time { return now }, OnRunQueued: func() { queuedNotifications++ },
	})
	source, err := service.Create(ctx, CreateGitHubSourceInput{RepositoryOwner: "acme", RepositoryName: "skills", CreatedBy: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	item, err := store.UpsertSourceItem(ctx, SourceItem{SourceItemID: "item-1", SourceID: source.SourceID, SkillPath: "skills/code-review", DiscoveredName: "code-review", Status: SourceItemStatusNameConflict, CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatal(err)
	}
	bound, err := service.BindItem(ctx, item.SourceItemID, "skill-1")
	if err != nil || bound.SkillID == nil || *bound.SkillID != "skill-1" || bound.Status != SourceItemStatusActive {
		t.Fatalf("BindItem() = %#v, %v", bound, err)
	}
	unbound, err := service.UnbindItem(ctx, item.SourceItemID)
	if err != nil || unbound.SkillID != nil || unbound.Status != SourceItemStatusNameConflict {
		t.Fatalf("UnbindItem() = %#v, %v", unbound, err)
	}
	disabled, err := service.Disable(ctx, source.SourceID)
	if err != nil || disabled.Status != SourceStatusDisabled {
		t.Fatalf("Disable() = %#v, %v", disabled, err)
	}
	if _, err := service.QueueSync(ctx, source.SourceID, "admin"); !errors.Is(err, ErrConflict) {
		t.Fatalf("QueueSync(disabled) error = %v, want ErrConflict", err)
	}
	if _, err := service.Enable(ctx, source.SourceID); err != nil {
		t.Fatal(err)
	}
	run, err := service.QueueSync(ctx, source.SourceID, "admin")
	if err != nil || run.Status != SourceSyncRunStatusQueued || run.Trigger != SourceSyncTriggerManual || run.RepositoryMode != SourceRepositoryModeRemote {
		t.Fatalf("QueueSync() = %#v, %v", run, err)
	}
	if queuedNotifications != 1 {
		t.Fatalf("queued notifications = %d, want 1", queuedNotifications)
	}
	claimed, ok, err := store.ClaimNextSyncRun(ctx, now.Add(time.Minute))
	if err != nil || !ok {
		t.Fatalf("ClaimNextSyncRun() = %#v, %v, %v", claimed, ok, err)
	}
	claimed.Status = SourceSyncRunStatusFailed
	claimed.FinishedAt = timePointer(now.Add(2 * time.Minute))
	if _, err := store.CompleteSyncRun(ctx, claimed, source); err != nil {
		t.Fatal(err)
	}
	localRun, err := service.QueueLocalScan(ctx, source.SourceID, "admin")
	if err != nil || localRun.RepositoryMode != SourceRepositoryModeLocal {
		t.Fatalf("QueueLocalScan() = %#v, %v", localRun, err)
	}
	if queuedNotifications != 2 {
		t.Fatalf("queued notifications = %d, want 2", queuedNotifications)
	}
}

func TestMemorySourceStoreRejectsMissingSpaceAndCrossSpaceBinding(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 3, 10, 30, 0, 0, time.UTC)
	skills := NewMemoryStore()
	space, err := skills.CreateSpace(ctx, Space{
		SpaceID: "skillspace-team", Name: "团队技能", CreatedBy: "admin", UpdatedBy: "admin", CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := skills.CreateVersion(ctx,
		Skill{SkillID: "skill-default", SpaceID: DefaultSpaceID, Name: "code-review", CreatedBy: "admin", CreatedAt: now, UpdatedAt: now},
		Version{VersionID: "version-default", Version: "1.0", CreatedAt: now},
		CreateVersionOptions{Resolution: VersionResolutionCreateOnly},
	); err != nil {
		t.Fatal(err)
	}
	store := NewMemorySourceStore(skills)
	if _, err := store.CreateSource(ctx, GitHubSource{
		SourceID: "source-missing", SpaceID: "skillspace-missing", Provider: GitHubSourceProvider,
		RepositoryOwner: "acme", RepositoryName: "missing", Branch: "main", ScanRoot: ".",
		Schedule: SourceScheduleManual, Status: SourceStatusActive, CreatedAt: now, UpdatedAt: now,
	}); !errors.Is(err, ErrSpaceNotFound) {
		t.Fatalf("CreateSource(missing space) error=%v, want ErrSpaceNotFound", err)
	}
	source, err := store.CreateSource(ctx, GitHubSource{
		SourceID: "source-team", SpaceID: space.SpaceID, Provider: GitHubSourceProvider,
		RepositoryOwner: "acme", RepositoryName: "team", Branch: "main", ScanRoot: ".",
		Schedule: SourceScheduleManual, Status: SourceStatusActive, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	item, err := store.UpsertSourceItem(ctx, SourceItem{
		SourceItemID: "item-team", SourceID: source.SourceID, SkillPath: "skills/code-review", DiscoveredName: "code-review",
		Status: SourceItemStatusNameConflict, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.BindSourceItem(ctx, item.SourceItemID, "skill-default", now.Add(time.Minute)); !errors.Is(err, ErrConflict) {
		t.Fatalf("BindSourceItem(cross space) error=%v, want ErrConflict", err)
	}
}

func TestMemorySourceStoreEnforcesSourceAndRunUniqueness(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 3, 11, 0, 0, 0, time.UTC)
	store := NewMemorySourceStore()
	source := GitHubSource{SourceID: "source-1", Provider: GitHubSourceProvider, RepositoryOwner: "acme", RepositoryName: "skills", Branch: "main", ScanRoot: ".", Schedule: SourceScheduleHourly, Status: SourceStatusActive, CreatedAt: now, UpdatedAt: now}
	if _, err := store.CreateSource(ctx, source); err != nil {
		t.Fatal(err)
	}
	duplicate := source
	duplicate.SourceID = "source-2"
	if _, err := store.CreateSource(ctx, duplicate); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate source error = %v, want ErrConflict", err)
	}
	run := SourceSyncRun{RunID: "run-1", SourceID: source.SourceID, Trigger: SourceSyncTriggerManual, Status: SourceSyncRunStatusQueued, RequestedBy: "admin", CreatedAt: now}
	if _, err := store.CreateSyncRun(ctx, run); err != nil {
		t.Fatal(err)
	}
	duplicateRun := run
	duplicateRun.RunID = "run-2"
	if _, err := store.CreateSyncRun(ctx, duplicateRun); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate active run error = %v, want ErrConflict", err)
	}
	claimed, ok, err := store.ClaimNextSyncRun(ctx, now.Add(time.Minute))
	if err != nil || !ok || claimed.Status != SourceSyncRunStatusRunning || claimed.StartedAt == nil {
		t.Fatalf("ClaimNextSyncRun() = %#v, %v, %v", claimed, ok, err)
	}
	storedSource, _ := store.GetSource(ctx, source.SourceID)
	if storedSource.LastAttemptAt == nil || !storedSource.LastAttemptAt.Equal(now.Add(time.Minute)) {
		t.Fatalf("last_attempt_at = %v", storedSource.LastAttemptAt)
	}
	other := source
	other.SourceID = "source-2"
	other.RepositoryName = "other"
	if _, err := store.CreateSource(ctx, other); err != nil {
		t.Fatal(err)
	}
	finished := now.Add(2 * time.Minute)
	claimed.Status = SourceSyncRunStatusSuccess
	claimed.FinishedAt = &finished
	if _, err := store.CompleteSyncRun(ctx, claimed, other); !errors.Is(err, ErrConflict) {
		t.Fatalf("CompleteSyncRun(cross-source) error = %v, want ErrConflict", err)
	}
}

func TestMemorySourceStoreRejectsDuplicateBoundSkillOnUpsert(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 3, 11, 30, 0, 0, time.UTC)
	store := NewMemorySourceStore()
	for _, source := range []GitHubSource{
		{SourceID: "source-1", Provider: GitHubSourceProvider, RepositoryOwner: "acme", RepositoryName: "skills-one", Branch: "main", ScanRoot: ".", Schedule: SourceScheduleManual, Status: SourceStatusActive, CreatedAt: now, UpdatedAt: now},
		{SourceID: "source-2", Provider: GitHubSourceProvider, RepositoryOwner: "acme", RepositoryName: "skills-two", Branch: "main", ScanRoot: ".", Schedule: SourceScheduleManual, Status: SourceStatusActive, CreatedAt: now, UpdatedAt: now},
	} {
		if _, err := store.CreateSource(ctx, source); err != nil {
			t.Fatal(err)
		}
	}
	skillID := "skill-1"
	first := SourceItem{SourceItemID: "item-1", SourceID: "source-1", SkillPath: "skills/one", SkillID: &skillID, Status: SourceItemStatusActive, CreatedAt: now, UpdatedAt: now}
	if _, err := store.UpsertSourceItem(ctx, first); err != nil {
		t.Fatal(err)
	}
	second := SourceItem{SourceItemID: "item-2", SourceID: "source-2", SkillPath: "skills/two", SkillID: &skillID, Status: SourceItemStatusActive, CreatedAt: now, UpdatedAt: now}
	if _, err := store.UpsertSourceItem(ctx, second); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate bound skill error = %v, want ErrConflict", err)
	}
}

func TestMemorySourceStoreRevisionGuardsCompletedRunCursor(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*GitHubSource)
	}{
		{name: "branch", mutate: func(source *GitHubSource) { source.Branch = "next" }},
		{name: "scan root", mutate: func(source *GitHubSource) { source.ScanRoot = "skills" }},
		{name: "exclude paths", mutate: func(source *GitHubSource) { source.ExcludePaths = []string{"vendor"} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
			commit := strings.Repeat("a", 40)
			store := NewMemorySourceStore()
			source, err := store.CreateSource(ctx, GitHubSource{
				SourceID: "source-1", Provider: GitHubSourceProvider, RepositoryOwner: "acme", RepositoryName: "skills",
				Branch: "main", ScanRoot: ".", Schedule: SourceScheduleManual, Status: SourceStatusActive,
				LastSyncedCommitSHA: &commit, CreatedAt: now, UpdatedAt: now,
			})
			if err != nil || source.SyncRevision != 1 {
				t.Fatalf("CreateSource() = %#v, %v", source, err)
			}
			queued, err := store.CreateSyncRun(ctx, SourceSyncRun{RunID: "run-1", SourceID: source.SourceID, Trigger: SourceSyncTriggerManual, Status: SourceSyncRunStatusQueued, RequestedBy: "admin", CreatedAt: now})
			if err != nil || queued.SourceRevision != 0 {
				t.Fatalf("CreateSyncRun() = %#v, %v", queued, err)
			}
			claimed, ok, err := store.ClaimNextSyncRun(ctx, now.Add(time.Minute))
			if err != nil || !ok || claimed.SourceRevision != 1 {
				t.Fatalf("ClaimNextSyncRun() = %#v, %v, %v", claimed, ok, err)
			}

			tc.mutate(&source)
			source.UpdatedAt = now.Add(2 * time.Minute)
			updated, err := store.UpdateSource(ctx, source, TokenKeep)
			if err != nil || updated.SyncRevision != 2 || updated.LastSyncedCommitSHA != nil {
				t.Fatalf("UpdateSource() = %#v, %v", updated, err)
			}

			finished := now.Add(3 * time.Minute)
			claimed.Status = SourceSyncRunStatusSuccess
			claimed.TargetCommitSHA = &commit
			claimed.DiscoveredCount = 3
			claimed.FinishedAt = &finished
			completionSource := updated
			completionSource.LastSuccessAt = &finished
			completionSource.LastSyncedCommitSHA = &commit
			completionSource.UpdatedAt = finished
			completed, err := store.CompleteSyncRun(ctx, claimed, completionSource)
			if err != nil || completed.DiscoveredCount != 3 {
				t.Fatalf("CompleteSyncRun() = %#v, %v", completed, err)
			}
			stored, err := store.GetSource(ctx, source.SourceID)
			if err != nil || stored.SyncRevision != 2 || stored.LastSyncedCommitSHA != nil || stored.LastSuccessAt == nil || !stored.LastSuccessAt.Equal(finished) {
				t.Fatalf("GetSource() after completion = %#v, %v", stored, err)
			}

			if _, err := store.CreateSyncRun(ctx, SourceSyncRun{RunID: "run-2", SourceID: source.SourceID, Trigger: SourceSyncTriggerManual, Status: SourceSyncRunStatusQueued, RequestedBy: "admin", CreatedAt: finished}); err != nil {
				t.Fatal(err)
			}
			followUp, ok, err := store.ClaimNextSyncRun(ctx, finished.Add(time.Minute))
			if err != nil || !ok || followUp.SourceRevision != 2 {
				t.Fatalf("follow-up ClaimNextSyncRun() = %#v, %v, %v", followUp, ok, err)
			}
		})
	}
}

func TestMemorySourceStoreNonConfigurationUpdatePreservesRevisionAndCursor(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 3, 13, 0, 0, 0, time.UTC)
	commit := strings.Repeat("b", 40)
	store := NewMemorySourceStore()
	source, err := store.CreateSource(ctx, GitHubSource{
		SourceID: "source-1", Provider: GitHubSourceProvider, RepositoryOwner: "acme", RepositoryName: "skills",
		Branch: "main", ScanRoot: ".", Schedule: SourceScheduleHourly, Status: SourceStatusActive,
		LastSyncedCommitSHA: &commit, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	source.AutoPublish = true
	source.Schedule = SourceScheduleDaily
	source.Status = SourceStatusDisabled
	source.TokenCiphertext = []byte("encrypted")
	source.LastSyncedCommitSHA = nil
	source.UpdatedAt = now.Add(time.Minute)
	updated, err := store.UpdateSource(ctx, source, TokenReplace)
	if err != nil || updated.SyncRevision != 1 || updated.LastSyncedCommitSHA == nil || *updated.LastSyncedCommitSHA != commit {
		t.Fatalf("UpdateSource() = %#v, %v", updated, err)
	}
}

func TestMemorySourceStoreBindingChangesRevisionAndClearsCursor(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 3, 14, 0, 0, 0, time.UTC)
	commit := strings.Repeat("c", 40)
	skills := NewMemoryStore()
	if _, _, err := skills.CreateVersion(ctx,
		Skill{SkillID: "skill-1", Name: "code-review", CreatedBy: "admin", CreatedAt: now, UpdatedAt: now},
		Version{VersionID: "version-1", Version: "1.0", CreatedAt: now},
		CreateVersionOptions{Resolution: VersionResolutionCreateOnly},
	); err != nil {
		t.Fatal(err)
	}
	store := NewMemorySourceStore(skills)
	source, err := store.CreateSource(ctx, GitHubSource{
		SourceID: "source-1", Provider: GitHubSourceProvider, RepositoryOwner: "acme", RepositoryName: "skills",
		Branch: "main", ScanRoot: ".", Schedule: SourceScheduleManual, Status: SourceStatusActive,
		LastSyncedCommitSHA: &commit, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	item, err := store.UpsertSourceItem(ctx, SourceItem{SourceItemID: "item-1", SourceID: source.SourceID, SkillPath: "skills/code-review", DiscoveredName: "code-review", Status: SourceItemStatusNameConflict, CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.BindSourceItem(ctx, item.SourceItemID, "skill-1", now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	boundSource, err := store.GetSource(ctx, source.SourceID)
	if err != nil || boundSource.SyncRevision != 2 || boundSource.LastSyncedCommitSHA != nil {
		t.Fatalf("source after bind = %#v, %v", boundSource, err)
	}

	if _, err := store.CreateSyncRun(ctx, SourceSyncRun{RunID: "run-1", SourceID: source.SourceID, Trigger: SourceSyncTriggerManual, Status: SourceSyncRunStatusQueued, RequestedBy: "admin", CreatedAt: now.Add(2 * time.Minute)}); err != nil {
		t.Fatal(err)
	}
	claimed, ok, err := store.ClaimNextSyncRun(ctx, now.Add(3*time.Minute))
	if err != nil || !ok || claimed.SourceRevision != 2 {
		t.Fatalf("ClaimNextSyncRun() = %#v, %v, %v", claimed, ok, err)
	}
	finished := now.Add(4 * time.Minute)
	claimed.Status = SourceSyncRunStatusSuccess
	claimed.FinishedAt = &finished
	boundSource.LastSyncedCommitSHA = &commit
	boundSource.UpdatedAt = finished
	if _, err := store.CompleteSyncRun(ctx, claimed, boundSource); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UnbindSourceItem(ctx, item.SourceItemID, now.Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	unboundSource, err := store.GetSource(ctx, source.SourceID)
	if err != nil || unboundSource.SyncRevision != 3 || unboundSource.LastSyncedCommitSHA != nil {
		t.Fatalf("source after unbind = %#v, %v", unboundSource, err)
	}
}

func TestSourceRevisionsAreInternal(t *testing.T) {
	encoded, err := json.Marshal(struct {
		Source GitHubSource  `json:"source"`
		Run    SourceSyncRun `json:"run"`
	}{
		Source: GitHubSource{SyncRevision: 7},
		Run:    SourceSyncRun{SourceRevision: 7},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"sync_revision", "source_revision"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("internal field %q leaked in %s", forbidden, encoded)
		}
	}
}

func assertSourceSecretAbsent(t *testing.T, source GitHubSource, err error) {
	t.Helper()
	encoded, marshalErr := json.Marshal(source)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	combined := string(encoded)
	if err != nil {
		combined += err.Error()
	}
	for _, forbidden := range []string{testGitHubToken, "cipher:" + testGitHubToken} {
		if strings.Contains(combined, forbidden) {
			t.Fatalf("secret %q leaked in %q", forbidden, combined)
		}
	}
}
