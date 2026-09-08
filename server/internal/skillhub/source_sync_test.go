package skillhub

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type sourceSyncCipher struct {
	plaintext []byte
	err       error
	inputs    [][]byte
}

func (c *sourceSyncCipher) Encrypt(value []byte) ([]byte, error) {
	return append([]byte(nil), value...), nil
}

func (c *sourceSyncCipher) Decrypt(value []byte) ([]byte, error) {
	c.inputs = append(c.inputs, append([]byte(nil), value...))
	return append([]byte(nil), c.plaintext...), c.err
}

type sourceSyncFixture struct {
	t              *testing.T
	now            time.Time
	repository     string
	packageRoot    string
	skillStore     *MemoryStore
	sourceStore    *MemorySourceStore
	versionService *Service
	workspace      *RepositoryWorkspace
	git            *GitClient
	cipher         *sourceSyncCipher
	source         GitHubSource
	service        *SourceSyncService
	runNumber      int
}

func TestSourceSyncServiceEndToEndWithLocalGitRepository(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{
		"skills/alpha/SKILL.md":       validSkillMD("alpha"),
		"skills/alpha/scripts/run.sh": "#!/bin/sh\necho alpha\n",
		"skills/beta/SKILL.md":        validSkillMD("beta"),
	}, false)
	firstCommit := fixture.head()
	workspacePath, err := fixture.workspace.WorkspacePath(fixture.source.SourceID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(workspacePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("workspace before first sync error = %v, want not exist", err)
	}

	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatalf("first Run() error = %v", err)
	}
	firstWorkspaceInfo, err := os.Stat(workspacePath)
	if err != nil {
		t.Fatalf("stat cloned workspace: %v", err)
	}
	items, err := fixture.sourceStore.ListSourceItems(context.Background(), fixture.source.SourceID)
	if err != nil || len(items) != 2 || items[0].SkillPath != "skills/alpha" || items[1].SkillPath != "skills/beta" {
		t.Fatalf("first discovery items = %#v, error = %v", items, err)
	}
	firstRun := fixture.latestRun()
	if firstRun.Status != SourceSyncRunStatusSuccess || firstRun.TargetCommitSHA == nil || *firstRun.TargetCommitSHA != firstCommit ||
		firstRun.DiscoveredCount != 2 || firstRun.CreatedVersionCount != 2 || firstRun.PublishedCount != 0 {
		t.Fatalf("first run = %#v", firstRun)
	}

	alpha := fixture.skillDetailByName("alpha")
	beta := fixture.skillDetailByName("beta")
	if len(alpha.Versions) != 1 || alpha.Skill.CurrentVersionID != nil || len(beta.Versions) != 1 || beta.Skill.CurrentVersionID != nil {
		t.Fatalf("default review state: alpha=%#v beta=%#v", alpha, beta)
	}
	alphaVersion := alpha.Versions[0]
	if alphaVersion.Version != "git-"+firstCommit || alphaVersion.Source == nil || alphaVersion.Source.CommitSHA != firstCommit ||
		alphaVersion.Source.Path != "skills/alpha" || alphaVersion.Source.ContentSHA256 == "" {
		t.Fatalf("first alpha version = %#v", alphaVersion)
	}

	var candidate bytes.Buffer
	candidateMetadata, err := fixture.service.packageBuilder.Build(workspacePath, DiscoveredSkill{
		Path: "skills/alpha", AbsolutePath: filepath.Join(workspacePath, "skills", "alpha"),
	}, nil, &candidate)
	if err != nil {
		t.Fatalf("build candidate ZIP: %v", err)
	}
	var normalized bytes.Buffer
	if _, err := NormalizePackage(bytes.NewReader(candidate.Bytes()), int64(candidate.Len()), &normalized); err != nil {
		t.Fatalf("normalize candidate ZIP: %v", err)
	}
	stored, err := os.ReadFile(filepath.Join(fixture.packageRoot, alphaVersion.PackagePath))
	if err != nil {
		t.Fatalf("read stored normalized ZIP: %v", err)
	}
	if candidateMetadata.ContentSHA256 != alphaVersion.Source.ContentSHA256 || !bytes.Equal(stored, normalized.Bytes()) {
		t.Fatalf("stored package did not preserve candidate evidence or shared normalization")
	}
	archive, err := zip.NewReader(bytes.NewReader(stored), int64(len(stored)))
	if err != nil {
		t.Fatalf("open stored normalized ZIP: %v", err)
	}
	wantEntries := []string{"SKILL.md", "scripts/", "scripts/run.sh"}
	if len(archive.File) != len(wantEntries) {
		t.Fatalf("stored normalized ZIP entries = %d, want %d", len(archive.File), len(wantEntries))
	}
	for index, entry := range archive.File {
		if entry.Name != wantEntries[index] {
			t.Fatalf("stored normalized ZIP entry %d = %q, want %q", index, entry.Name, wantEntries[index])
		}
	}

	source, err := fixture.sourceStore.GetSource(context.Background(), fixture.source.SourceID)
	if err != nil {
		t.Fatal(err)
	}
	source.AutoPublish = true
	source.UpdatedAt = fixture.now.Add(time.Minute)
	updatedSource, err := fixture.sourceStore.UpdateSource(context.Background(), source, TokenKeep)
	if err != nil {
		t.Fatalf("enable auto publish: %v", err)
	}
	fixture.source = updatedSource
	fixture.commit(map[string]string{"skills/alpha/CHANGELOG.md": "second version\n"}, "update alpha")
	secondCommit := fixture.head()
	if secondCommit == firstCommit {
		t.Fatal("remote commit did not change")
	}

	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatalf("second Run() error = %v", err)
	}
	secondRun := fixture.latestRun()
	if secondRun.Status != SourceSyncRunStatusSuccess || secondRun.TargetCommitSHA == nil || *secondRun.TargetCommitSHA != secondCommit ||
		secondRun.DiscoveredCount != 2 || secondRun.CreatedVersionCount != 1 || secondRun.PublishedCount != 1 {
		t.Fatalf("second run = %#v", secondRun)
	}
	alpha = fixture.skillDetailByName("alpha")
	beta = fixture.skillDetailByName("beta")
	if len(alpha.Versions) != 2 || alpha.Skill.CurrentVersionID == nil || *alpha.Skill.CurrentVersionID != alpha.Versions[0].VersionID ||
		alpha.Versions[0].Version != "git-"+secondCommit || alpha.Versions[0].Source == nil || alpha.Versions[0].Source.CommitSHA != secondCommit {
		t.Fatalf("auto-published alpha = %#v", alpha)
	}
	if len(beta.Versions) != 1 || beta.Skill.CurrentVersionID != nil {
		t.Fatalf("unchanged beta = %#v", beta)
	}

	secondWorkspaceInfo, err := os.Stat(workspacePath)
	if err != nil || !os.SameFile(firstWorkspaceInfo, secondWorkspaceInfo) {
		t.Fatalf("fixed workspace was not reused: error = %v", err)
	}
	if head := strings.TrimSpace(runSourceSyncGit(t, workspacePath, "rev-parse", "HEAD")); head != secondCommit {
		t.Fatalf("workspace HEAD = %q, want %q", head, secondCommit)
	}
	if branch := strings.TrimSpace(runSourceSyncGit(t, workspacePath, "branch", "--show-current")); branch != "" {
		t.Fatalf("workspace branch = %q, want detached HEAD", branch)
	}
	if merges := strings.TrimSpace(runSourceSyncGit(t, workspacePath, "rev-list", "--min-parents=2", "HEAD")); merges != "" {
		t.Fatalf("workspace contains local merge commits: %s", merges)
	}
	if status := strings.TrimSpace(runSourceSyncGit(t, workspacePath, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching")); status != "" {
		t.Fatalf("workspace is dirty after sync: %s", status)
	}
	for _, root := range []string{fixture.repository, workspacePath} {
		err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if !entry.IsDir() && strings.EqualFold(filepath.Ext(path), ".zip") {
				t.Errorf("repository contains generated ZIP: %s", path)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("scan repository for ZIP files: %v", err)
		}
	}
}

func TestSourceSyncServiceKeepsBoundSkillInItsCurrentSpace(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{"skills/one/SKILL.md": validSkillMD("one")}, false)
	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatal(err)
	}
	initial := fixture.skillDetailByName("one")
	if initial.Skill.SpaceID != DefaultSpaceID {
		t.Fatalf("new skill space=%q, want source space %q", initial.Skill.SpaceID, DefaultSpaceID)
	}
	target, err := fixture.versionService.CreateSpace(context.Background(), "产品技能", "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.versionService.MoveSkillsToSpace(context.Background(), []string{initial.Skill.SkillID}, target.SpaceID); err != nil {
		t.Fatal(err)
	}

	fixture.commit(map[string]string{"skills/one/SKILL.md": validSkillMD("one") + "\n更新说明\n"}, "update moved skill")
	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatal(err)
	}
	detail := fixture.skillDetailByName("one")
	if detail.Skill.SpaceID != target.SpaceID || len(detail.Versions) != 2 || fixture.latestRun().Status != SourceSyncRunStatusSuccess {
		t.Fatalf("synced moved skill=%#v run=%#v", detail, fixture.latestRun())
	}
}

func TestSourceSyncServiceCreatesRootAndMonorepoSkills(t *testing.T) {
	for _, tt := range []struct {
		name  string
		files map[string]string
		want  []string
	}{
		{name: "root", files: map[string]string{"SKILL.md": validSkillMD("root-skill")}, want: []string{"root-skill"}},
		{name: "monorepo", files: map[string]string{
			"skills/alpha/SKILL.md": validSkillMD("alpha"),
			"skills/beta/SKILL.md":  validSkillMD("beta"),
		}, want: []string{"alpha", "beta"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newSourceSyncFixture(t, tt.files, false)
			run := fixture.claimRun()

			if err := fixture.service.Run(context.Background(), run); err != nil {
				t.Fatalf("Run() error = %v", err)
			}

			items, err := fixture.skillStore.ListAdmin(context.Background())
			if err != nil || len(items) != len(tt.want) {
				t.Fatalf("ListAdmin() = %#v, %v", items, err)
			}
			for index, name := range tt.want {
				if items[index].Name != name && !containsSkillName(items, name) {
					t.Fatalf("skills = %#v, missing %q", items, name)
				}
				detail := fixture.skillDetailByName(name)
				if len(detail.Versions) != 1 || detail.Versions[0].Version != "git-"+fixture.head() || detail.Versions[0].Source == nil {
					t.Fatalf("detail for %q = %#v", name, detail)
				}
			}
			completed := fixture.latestRun()
			if completed.Status != SourceSyncRunStatusSuccess || completed.DiscoveredCount != len(tt.want) || completed.CreatedVersionCount != len(tt.want) {
				t.Fatalf("completed run = %#v", completed)
			}
		})
	}
}

func TestSourceSyncServiceSkipsAndOnlyCreatesChangedContent(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{"skills/one/SKILL.md": validSkillMD("one")}, false)
	firstCommit := fixture.head()
	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatal(err)
	}

	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatal(err)
	}
	if completed := fixture.latestRun(); completed.Status != SourceSyncRunStatusSkipped || completed.TargetCommitSHA == nil || *completed.TargetCommitSHA != firstCommit {
		t.Fatalf("same commit run = %#v", completed)
	}

	fixture.commit(map[string]string{"README.md": "documentation only"}, "docs only")
	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatal(err)
	}
	detail := fixture.skillDetailByName("one")
	if len(detail.Versions) != 1 {
		t.Fatalf("unchanged content versions = %#v", detail.Versions)
	}
	item := fixture.sourceItem("skills/one")
	if item.LastSeenCommitSHA == nil || *item.LastSeenCommitSHA != fixture.head() || item.LastVersionID == nil || *item.LastVersionID != detail.Versions[0].VersionID {
		t.Fatalf("unchanged content item = %#v", item)
	}

	fixture.commit(map[string]string{"skills/one/note.txt": "changed"}, "skill change")
	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatal(err)
	}
	detail = fixture.skillDetailByName("one")
	if len(detail.Versions) != 2 || detail.Versions[0].Version != "git-"+fixture.head() {
		t.Fatalf("changed content versions = %#v", detail.Versions)
	}
}

func TestSourceSyncServiceReusesVersionForSamePathAndCommitRetry(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{"skills/one/SKILL.md": validSkillMD("one")}, false)
	commit := fixture.head()
	packageData := buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("one")}})
	created, err := fixture.versionService.CreateVersionFromPackage(context.Background(), CreateVersionInput{
		Version: "git-" + commit, Package: bytes.NewReader(packageData), CreatedBy: "admin", Resolution: VersionResolutionCreateOnly,
		Source: &VersionSourceEvidence{SourceID: fixture.source.SourceID, RepositoryOwner: "acme", RepositoryName: "skills", Path: "skills/one", CommitSHA: commit, ContentSHA256: strings.Repeat("a", 64)},
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatal(err)
	}
	detail := fixture.skillDetailByName("one")
	item := fixture.sourceItem("skills/one")
	if len(detail.Versions) != 1 || item.LastVersionID == nil || *item.LastVersionID != created.Version.VersionID || item.SkillID == nil || *item.SkillID != created.Skill.SkillID {
		t.Fatalf("retry detail = %#v, item = %#v", detail, item)
	}
}

func TestSourceSyncServiceAutoPublishUsesSharedVersionTransaction(t *testing.T) {
	for _, publish := range []bool{false, true} {
		t.Run(map[bool]string{false: "disabled", true: "enabled"}[publish], func(t *testing.T) {
			fixture := newSourceSyncFixture(t, map[string]string{"skills/one/SKILL.md": validSkillMD("one")}, publish)
			initial, err := fixture.versionService.UploadVersion(context.Background(), UploadVersionInput{
				Version: "manual-1", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("one")}})), CreatedBy: "admin",
			})
			if err != nil {
				t.Fatal(err)
			}
			fixture.seedItem(SourceItem{SourceItemID: "item-bound", SourceID: fixture.source.SourceID, SkillPath: "skills/one", DiscoveredName: "one", SkillID: &initial.Skill.SkillID, Status: SourceItemStatusActive})

			if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
				t.Fatal(err)
			}
			detail, err := fixture.skillStore.GetAdmin(context.Background(), initial.Skill.SkillID)
			if err != nil || len(detail.Versions) != 2 || detail.Skill.CurrentVersionID == nil {
				t.Fatalf("detail = %#v, %v", detail, err)
			}
			wantCurrent := initial.Version.VersionID
			if publish {
				wantCurrent = detail.Versions[0].VersionID
			}
			if *detail.Skill.CurrentVersionID != wantCurrent {
				t.Fatalf("current version = %q, want %q", *detail.Skill.CurrentVersionID, wantCurrent)
			}
		})
	}
}

func TestSourceSyncServiceRecordsBusinessConflictsWithoutReplacingCurrent(t *testing.T) {
	t.Run("duplicate names in batch", func(t *testing.T) {
		fixture := newSourceSyncFixture(t, map[string]string{
			"skills/one/SKILL.md": validSkillMD("duplicate"),
			"skills/two/SKILL.md": validSkillMD("duplicate"),
		}, true)
		if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{"skills/one", "skills/two"} {
			if item := fixture.sourceItem(path); item.Status != SourceItemStatusNameConflict || item.LastVersionID != nil {
				t.Fatalf("item %q = %#v", path, item)
			}
		}
		if run := fixture.latestRun(); run.Status != SourceSyncRunStatusSuccess || run.ConflictCount != 2 || run.FailedCount != 0 {
			t.Fatalf("run = %#v", run)
		}
	})

	t.Run("existing name", func(t *testing.T) {
		fixture := newSourceSyncFixture(t, map[string]string{"skills/one/SKILL.md": validSkillMD("one")}, true)
		initial, err := fixture.versionService.UploadVersion(context.Background(), UploadVersionInput{
			Version: "manual-1", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("one")}})), CreatedBy: "admin",
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
			t.Fatal(err)
		}
		if item := fixture.sourceItem("skills/one"); item.Status != SourceItemStatusNameConflict || item.SkillID != nil {
			t.Fatalf("item = %#v", item)
		}
		detail, _ := fixture.skillStore.GetAdmin(context.Background(), initial.Skill.SkillID)
		if len(detail.Versions) != 1 || detail.Skill.CurrentVersionID == nil || *detail.Skill.CurrentVersionID != initial.Version.VersionID {
			t.Fatalf("existing skill overwritten: %#v", detail)
		}
	})

	t.Run("bound path renamed", func(t *testing.T) {
		fixture := newSourceSyncFixture(t, map[string]string{"skills/one/SKILL.md": validSkillMD("renamed")}, true)
		initial, err := fixture.versionService.UploadVersion(context.Background(), UploadVersionInput{
			Version: "manual-1", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("original")}})), CreatedBy: "admin",
		})
		if err != nil {
			t.Fatal(err)
		}
		fixture.seedItem(SourceItem{SourceItemID: "item-bound", SourceID: fixture.source.SourceID, SkillPath: "skills/one", DiscoveredName: "original", SkillID: &initial.Skill.SkillID, Status: SourceItemStatusActive})
		if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
			t.Fatal(err)
		}
		if item := fixture.sourceItem("skills/one"); item.Status != SourceItemStatusNameChanged || item.DiscoveredName != "renamed" || item.LastVersionID != nil {
			t.Fatalf("item = %#v", item)
		}
		detail, _ := fixture.skillStore.GetAdmin(context.Background(), initial.Skill.SkillID)
		if len(detail.Versions) != 1 || detail.Skill.CurrentVersionID == nil || *detail.Skill.CurrentVersionID != initial.Version.VersionID {
			t.Fatalf("renamed skill replaced current: %#v", detail)
		}
	})
}

func TestSourceSyncServiceRetriesResolvedBusinessConflicts(t *testing.T) {
	t.Run("batch name conflict clears", func(t *testing.T) {
		fixture := newSourceSyncFixture(t, map[string]string{
			"skills/one/SKILL.md": validSkillMD("duplicate"),
			"skills/two/SKILL.md": validSkillMD("duplicate"),
		}, false)
		if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
			t.Fatal(err)
		}
		if err := os.RemoveAll(filepath.Join(fixture.repository, "skills", "two")); err != nil {
			t.Fatal(err)
		}
		runSourceSyncGit(t, fixture.repository, "add", "-A")
		runSourceSyncGit(t, fixture.repository, "commit", "-m", "resolve duplicate")

		if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
			t.Fatal(err)
		}
		items, err := fixture.skillStore.ListAdmin(context.Background())
		item := fixture.sourceItem("skills/one")
		if err != nil || len(items) != 1 || item.Status != SourceItemStatusActive || item.SkillID == nil || item.LastVersionID == nil {
			t.Fatalf("resolved conflict skills = %#v, item = %#v, error = %v", items, item, err)
		}
	})

	t.Run("bound name change reverts", func(t *testing.T) {
		fixture := newSourceSyncFixture(t, map[string]string{"skills/one/SKILL.md": validSkillMD("original")}, false)
		if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
			t.Fatal(err)
		}
		fixture.commit(map[string]string{"skills/one/SKILL.md": validSkillMD("renamed")}, "rename")
		if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
			t.Fatal(err)
		}
		if item := fixture.sourceItem("skills/one"); item.Status != SourceItemStatusNameChanged {
			t.Fatalf("renamed item = %#v", item)
		}
		fixture.commit(map[string]string{"skills/one/SKILL.md": validSkillMD("original")}, "restore name")

		if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
			t.Fatal(err)
		}
		detail := fixture.skillDetailByName("original")
		item := fixture.sourceItem("skills/one")
		if len(detail.Versions) != 2 || item.Status != SourceItemStatusActive || item.LastVersionID == nil || *item.LastVersionID != detail.Versions[0].VersionID {
			t.Fatalf("restored detail = %#v, item = %#v", detail, item)
		}
	})
}

func TestSourceSyncServiceDoesNotTreatUnrelatedVersionConflictAsNameChange(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{"skills/one/SKILL.md": validSkillMD("one")}, false)
	initial, err := fixture.versionService.UploadVersion(context.Background(), UploadVersionInput{
		Version: "manual-1", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("one")}})), CreatedBy: "admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.versionService.CreateVersionFromPackage(context.Background(), CreateVersionInput{
		Version: "git-" + fixture.head(), Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("one")}})),
		CreatedBy: "admin", Resolution: VersionResolutionTarget, TargetSkillID: initial.Skill.SkillID,
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.seedItem(SourceItem{SourceItemID: "item-bound", SourceID: fixture.source.SourceID, SkillPath: "skills/one", DiscoveredName: "one", SkillID: &initial.Skill.SkillID, Status: SourceItemStatusActive})

	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatal(err)
	}
	if run := fixture.latestRun(); run.Status != SourceSyncRunStatusPartial || run.ConflictCount != 0 || run.FailedCount != 1 {
		t.Fatalf("run = %#v", run)
	}
	if item := fixture.sourceItem("skills/one"); item.Status != SourceItemStatusActive || item.LastVersionID != nil {
		t.Fatalf("item = %#v", item)
	}
}

func TestSourceSyncServiceCandidateIOFailureIsPartial(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{"skills/one/SKILL.md": validSkillMD("one")}, false)
	brokenPackageRoot := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(brokenPackageRoot, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.service.packageRoot = brokenPackageRoot

	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatal(err)
	}
	if run := fixture.latestRun(); run.Status != SourceSyncRunStatusPartial || run.FailedCount != 1 {
		t.Fatalf("run = %#v", run)
	}
	source, err := fixture.sourceStore.GetSource(context.Background(), fixture.source.SourceID)
	if err != nil || source.LastSyncedCommitSHA != nil {
		t.Fatalf("source = %#v, %v", source, err)
	}
}

func TestSourceSyncServiceRecordsInvalidAndMissingWithoutUnpublishing(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{
		"skills/good/SKILL.md":    validSkillMD("good"),
		"skills/invalid/SKILL.md": "not frontmatter",
	}, true)
	missingSkill, err := fixture.versionService.UploadVersion(context.Background(), UploadVersionInput{
		Version: "manual-1", Package: bytes.NewReader(buildTestZIP(t, []testZIPEntry{{name: "SKILL.md", body: validSkillMD("missing")}})), CreatedBy: "admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	oldCommit := strings.Repeat("f", 40)
	fixture.seedItem(SourceItem{SourceItemID: "item-missing", SourceID: fixture.source.SourceID, SkillPath: "skills/missing", DiscoveredName: "missing", SkillID: &missingSkill.Skill.SkillID, Status: SourceItemStatusActive, LastSeenCommitSHA: &oldCommit, LastVersionID: &missingSkill.Version.VersionID})

	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatal(err)
	}
	invalid := fixture.sourceItem("skills/invalid")
	missing := fixture.sourceItem("skills/missing")
	if invalid.Status != SourceItemStatusInvalid || invalid.LastSeenCommitSHA == nil || missing.Status != SourceItemStatusMissing || missing.MissingSince == nil {
		t.Fatalf("invalid = %#v, missing = %#v", invalid, missing)
	}
	detail, _ := fixture.skillStore.GetAdmin(context.Background(), missingSkill.Skill.SkillID)
	if detail.Skill.CurrentVersionID == nil || *detail.Skill.CurrentVersionID != missingSkill.Version.VersionID || len(detail.Versions) != 1 {
		t.Fatalf("missing skill was unpublished: %#v", detail)
	}
	if run := fixture.latestRun(); run.Status != SourceSyncRunStatusSuccess || run.FailedCount != 1 {
		t.Fatalf("run = %#v", run)
	}
}

func TestSourceSyncServiceInfrastructureFailuresDoNotMarkMissing(t *testing.T) {
	for _, tt := range []struct {
		name      string
		configure func(*sourceSyncFixture)
	}{
		{name: "credential", configure: func(f *sourceSyncFixture) { f.cipher.err = errors.New("secret-token ciphertext-secret") }},
		{name: "git", configure: func(f *sourceSyncFixture) {
			f.git.runner = func(context.Context, gitCommand) (gitCommandResult, error) {
				return gitCommandResult{}, errors.New("git failed with secret-token")
			}
		}},
		{name: "workspace", configure: func(f *sourceSyncFixture) { f.workspace.git = nil }},
		{name: "discovery", configure: func(f *sourceSyncFixture) { f.source.ScanRoot = "missing"; f.replaceSource() }},
		{name: "store", configure: func(f *sourceSyncFixture) {
			f.service.store = &sourceSyncFailingStore{SourceStore: f.sourceStore, listItemsErr: errors.New("database unavailable")}
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newSourceSyncFixture(t, map[string]string{"skills/good/SKILL.md": validSkillMD("good")}, false)
			oldCommit := strings.Repeat("f", 40)
			fixture.seedItem(SourceItem{SourceItemID: "item-old", SourceID: fixture.source.SourceID, SkillPath: "skills/old", DiscoveredName: "old", Status: SourceItemStatusActive, LastSeenCommitSHA: &oldCommit})
			tt.configure(fixture)

			err := fixture.service.Run(context.Background(), fixture.claimRun())
			if err == nil {
				t.Fatal("Run() error = nil, want infrastructure failure")
			}
			if strings.Contains(err.Error(), "secret-token") || strings.Contains(fixture.latestRun().ErrorSummary, "secret-token") || strings.Contains(fixture.latestRun().ErrorSummary, "ciphertext-secret") {
				t.Fatalf("secret leaked: error=%q run=%#v", err, fixture.latestRun())
			}
			if item := fixture.sourceItem("skills/old"); item.Status == SourceItemStatusMissing {
				t.Fatalf("old item marked missing: %#v", item)
			}
			run := fixture.latestRun()
			if run.Status != SourceSyncRunStatusFailed || run.TargetCommitSHA != nil && tt.name != "discovery" && tt.name != "store" {
				t.Fatalf("run = %#v", run)
			}
			source, _ := fixture.sourceStore.GetSource(context.Background(), fixture.source.SourceID)
			if source.LastSyncedCommitSHA != nil || source.LastSuccessAt != nil || source.LastErrorSummary == "" {
				t.Fatalf("source = %#v", source)
			}
		})
	}
}

func TestSourceSyncServiceRecordsFailureAfterRunTimeout(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{"skills/good/SKILL.md": validSkillMD("good")}, false)
	fixture.service.store = &sourceSyncContextStore{SourceStore: fixture.sourceStore}
	fixture.git.runner = func(ctx context.Context, command gitCommand) (gitCommandResult, error) {
		if len(command.args) > 0 && command.args[0] == "check-ref-format" {
			return gitCommandResult{}, nil
		}
		<-ctx.Done()
		return gitCommandResult{}, ctx.Err()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	if err := fixture.service.Run(ctx, fixture.claimRun()); !errors.Is(err, errSourceSyncWorkspace) {
		t.Fatalf("Run() error = %v, want workspace failure", err)
	}
	if run := fixture.latestRun(); run.Status != SourceSyncRunStatusFailed || !strings.HasPrefix(run.ErrorSummary, sourceCloneFailurePrefix) || !strings.Contains(run.ErrorSummary, context.DeadlineExceeded.Error()) {
		t.Fatalf("run = %#v", run)
	}
}

func TestSourceSyncServiceRecordsSpecificGitCloneFailureReason(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{"skills/good/SKILL.md": validSkillMD("good")}, false)
	fixture.git.runner = func(_ context.Context, command gitCommand) (gitCommandResult, error) {
		if len(command.args) > 0 && command.args[0] == "check-ref-format" {
			return gitCommandResult{}, nil
		}
		return gitCommandResult{stderr: "fatal: repository not found"}, errors.New("exit status 128")
	}

	if err := fixture.service.Run(context.Background(), fixture.claimRun()); !errors.Is(err, errSourceSyncWorkspace) {
		t.Fatalf("Run() error = %v, want workspace failure", err)
	}
	if run := fixture.latestRun(); run.Status != SourceSyncRunStatusFailed || run.ErrorSummary != sourceCloneFailurePrefix+"git command failed: fatal: repository not found" {
		t.Fatalf("run = %#v", run)
	}
}

func TestSourceSyncServiceUsesExistingRepositoryWithoutRemoteAccess(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{"skills/good/SKILL.md": validSkillMD("good")}, false)
	if _, err := fixture.workspace.Update(context.Background(), fixture.source, "secret-token"); err != nil {
		t.Fatal(err)
	}
	originalRunner := fixture.git.runner
	fixture.git.runner = func(ctx context.Context, command gitCommand) (gitCommandResult, error) {
		for _, arg := range command.args {
			if arg == "clone" || arg == "fetch" {
				return gitCommandResult{}, errors.New("remote operation must not run")
			}
		}
		return originalRunner(ctx, command)
	}

	if err := fixture.service.Run(context.Background(), fixture.claimRunWithMode(SourceRepositoryModeLocal)); err != nil {
		t.Fatal(err)
	}
	run := fixture.latestRun()
	if run.Status != SourceSyncRunStatusSuccess || run.RepositoryMode != SourceRepositoryModeLocal || run.DiscoveredCount != 1 || len(fixture.cipher.inputs) != 0 {
		t.Fatalf("local run = %#v, decrypt inputs = %#v", run, fixture.cipher.inputs)
	}
}

func TestSourceSyncServiceGetSourceFailurePreservesSuccessState(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{"skills/one/SKILL.md": validSkillMD("one")}, false)
	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatal(err)
	}
	before, err := fixture.sourceStore.GetSource(context.Background(), fixture.source.SourceID)
	if err != nil || before.LastSuccessAt == nil || before.LastSyncedCommitSHA == nil {
		t.Fatalf("before source = %#v, %v", before, err)
	}
	fixture.commit(map[string]string{"README.md": "next"}, "next")
	fixture.service.store = &sourceSyncFailingStore{SourceStore: fixture.sourceStore, getSourceErr: errors.New("database unavailable")}

	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err == nil {
		t.Fatal("Run() error = nil, want source read failure")
	}
	after, err := fixture.sourceStore.GetSource(context.Background(), fixture.source.SourceID)
	if err != nil || after.LastSuccessAt == nil || !after.LastSuccessAt.Equal(*before.LastSuccessAt) || after.LastSyncedCommitSHA == nil || *after.LastSyncedCommitSHA != *before.LastSyncedCommitSHA {
		t.Fatalf("after source = %#v, before = %#v, error = %v", after, before, err)
	}
}

func TestMemorySourceStoreUpsertForSyncUsesRevisionAndBindingCAS(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{"skills/one/SKILL.md": validSkillMD("one")}, false)
	source, err := fixture.sourceStore.GetSource(context.Background(), fixture.source.SourceID)
	if err != nil {
		t.Fatal(err)
	}
	revision := source.SyncRevision
	item := SourceItem{
		SourceItemID: "item-existing", SourceID: fixture.source.SourceID, SkillPath: "skills/one",
		DiscoveredName: "one", Status: SourceItemStatusInvalid, CreatedAt: fixture.now, UpdatedAt: fixture.now,
	}
	fixture.seedItem(item)
	skillID := "skill-created"
	item.SkillID = &skillID
	item.Status = SourceItemStatusActive
	stored, err := fixture.sourceStore.UpsertSourceItemForSync(context.Background(), item, revision)
	if err != nil || stored.SkillID == nil || *stored.SkillID != skillID {
		t.Fatalf("UpsertSourceItemForSync() = %#v, %v", stored, err)
	}

	current, err := fixture.sourceStore.GetSource(context.Background(), fixture.source.SourceID)
	if err != nil {
		t.Fatal(err)
	}
	current.Branch = "next"
	current.UpdatedAt = fixture.now.Add(time.Minute)
	updated, err := fixture.sourceStore.UpdateSource(context.Background(), current, TokenKeep)
	if err != nil || updated.SyncRevision == revision {
		t.Fatalf("UpdateSource() = %#v, %v", updated, err)
	}
	otherSkillID := "skill-stale"
	item.SkillID = &otherSkillID
	if _, err := fixture.sourceStore.UpsertSourceItemForSync(context.Background(), item, revision); !errors.Is(err, errSourceRevisionChanged) {
		t.Fatalf("stale UpsertSourceItemForSync() error = %v, want errSourceRevisionChanged", err)
	}
	stored = fixture.sourceItem("skills/one")
	if stored.SkillID == nil || *stored.SkillID != skillID {
		t.Fatalf("stale write replaced binding: %#v", stored)
	}
}

func TestSourceSyncServiceRevisionChangeCompletesWithoutFailureOrCursor(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{"skills/one/SKILL.md": validSkillMD("one")}, false)
	before, err := fixture.sourceStore.GetSource(context.Background(), fixture.source.SourceID)
	if err != nil {
		t.Fatal(err)
	}
	fixture.service.store = &sourceSyncRevisionChangingStore{SourceStore: fixture.sourceStore, now: fixture.now.Add(time.Minute)}

	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatal(err)
	}
	run := fixture.latestRun()
	if run.Status != SourceSyncRunStatusSuccess || run.FailedCount != 0 || run.ErrorSummary != "" {
		t.Fatalf("run = %#v", run)
	}
	source, err := fixture.sourceStore.GetSource(context.Background(), fixture.source.SourceID)
	if err != nil || source.SyncRevision != before.SyncRevision+1 || source.LastSuccessAt == nil || source.LastSyncedCommitSHA != nil {
		t.Fatalf("source = %#v, error = %v", source, err)
	}
}

func TestSourceSyncServiceRevisionChangeDoesNotMarkMissing(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{"skills/new/SKILL.md": validSkillMD("new")}, false)
	oldCommit := strings.Repeat("a", 40)
	fixture.seedItem(SourceItem{
		SourceItemID: "item-old", SourceID: fixture.source.SourceID, SkillPath: "skills/old", DiscoveredName: "old",
		Status: SourceItemStatusActive, LastSeenCommitSHA: &oldCommit,
	})
	fixture.service.store = &sourceSyncRevisionChangingAtMissingStore{SourceStore: fixture.sourceStore, now: fixture.now.Add(time.Minute)}

	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatal(err)
	}
	if item := fixture.sourceItem("skills/old"); item.Status != SourceItemStatusActive || item.MissingSince != nil {
		t.Fatalf("stale run marked item missing: %#v", item)
	}
	source, err := fixture.sourceStore.GetSource(context.Background(), fixture.source.SourceID)
	if err != nil || source.LastSyncedCommitSHA != nil {
		t.Fatalf("source = %#v, error = %v", source, err)
	}
}

func TestSourceSyncServiceUnexpectedItemFailureContinuesAndIsPartial(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{
		"skills/failing/SKILL.md": validSkillMD("failing"),
		"skills/good/SKILL.md":    validSkillMD("good"),
	}, false)
	fixture.service.store = &sourceSyncFailingStore{SourceStore: fixture.sourceStore, upsertPath: "skills/failing", upsertErr: errors.New("database item write failed")}

	if err := fixture.service.Run(context.Background(), fixture.claimRun()); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if detail := fixture.skillDetailByName("good"); len(detail.Versions) != 1 {
		t.Fatalf("good detail = %#v", detail)
	}
	if run := fixture.latestRun(); run.Status != SourceSyncRunStatusPartial || run.CreatedVersionCount != 2 || run.FailedCount != 1 || run.ErrorSummary == "" {
		t.Fatalf("run = %#v", run)
	}
	source, _ := fixture.sourceStore.GetSource(context.Background(), fixture.source.SourceID)
	if source.LastSyncedCommitSHA != nil || source.LastSuccessAt != nil {
		t.Fatalf("partial source cursor advanced: %#v", source)
	}
}

type sourceSyncFailingStore struct {
	SourceStore
	getSourceErr error
	listItemsErr error
	upsertPath   string
	upsertErr    error
}

type sourceSyncContextStore struct {
	SourceStore
}

func (s *sourceSyncContextStore) CompleteSyncRun(ctx context.Context, run SourceSyncRun, source GitHubSource) (SourceSyncRun, error) {
	if err := ctx.Err(); err != nil {
		return SourceSyncRun{}, err
	}
	return s.SourceStore.CompleteSyncRun(ctx, run, source)
}

type sourceSyncRevisionChangingStore struct {
	SourceStore
	once sync.Once
	now  time.Time
}

type sourceSyncRevisionChangingAtMissingStore struct {
	SourceStore
	now time.Time
}

func (s *sourceSyncRevisionChangingStore) UpsertSourceItemForSync(ctx context.Context, item SourceItem, sourceRevision int64) (SourceItem, error) {
	s.once.Do(func() {
		source, err := s.SourceStore.GetSource(ctx, item.SourceID)
		if err != nil {
			return
		}
		source.Branch = "next"
		source.UpdatedAt = s.now
		_, _ = s.SourceStore.UpdateSource(ctx, source, TokenKeep)
	})
	return s.SourceStore.UpsertSourceItemForSync(ctx, item, sourceRevision)
}

func (s *sourceSyncRevisionChangingAtMissingStore) MarkMissingSourceItems(ctx context.Context, sourceID, commit string, now time.Time, sourceRevision int64) error {
	source, err := s.SourceStore.GetSource(ctx, sourceID)
	if err != nil {
		return err
	}
	source.Branch = "next"
	source.UpdatedAt = s.now
	if _, err := s.SourceStore.UpdateSource(ctx, source, TokenKeep); err != nil {
		return err
	}
	return s.SourceStore.MarkMissingSourceItems(ctx, sourceID, commit, now, sourceRevision)
}

func (s *sourceSyncFailingStore) GetSource(ctx context.Context, sourceID string) (GitHubSource, error) {
	if s.getSourceErr != nil {
		return GitHubSource{}, s.getSourceErr
	}
	return s.SourceStore.GetSource(ctx, sourceID)
}

func (s *sourceSyncFailingStore) ListSourceItems(ctx context.Context, sourceID string) ([]SourceItem, error) {
	if s.listItemsErr != nil {
		return nil, s.listItemsErr
	}
	return s.SourceStore.ListSourceItems(ctx, sourceID)
}

func (s *sourceSyncFailingStore) UpsertSourceItem(ctx context.Context, item SourceItem) (SourceItem, error) {
	if item.SkillPath == s.upsertPath {
		return SourceItem{}, s.upsertErr
	}
	return s.SourceStore.UpsertSourceItem(ctx, item)
}

func (s *sourceSyncFailingStore) UpsertSourceItemForSync(ctx context.Context, item SourceItem, sourceRevision int64) (SourceItem, error) {
	if item.SkillPath == s.upsertPath {
		return SourceItem{}, s.upsertErr
	}
	return s.SourceStore.UpsertSourceItemForSync(ctx, item, sourceRevision)
}

func newSourceSyncFixture(t *testing.T, files map[string]string, autoPublish bool) *sourceSyncFixture {
	t.Helper()
	repository := t.TempDir()
	runSourceSyncGit(t, repository, "init", "-b", "main")
	runSourceSyncGit(t, repository, "config", "user.email", "test@example.com")
	runSourceSyncGit(t, repository, "config", "user.name", "Source Sync Test")
	for name, body := range files {
		writeDiscoveryFile(t, repository, name, body)
	}
	runSourceSyncGit(t, repository, "add", ".")
	runSourceSyncGit(t, repository, "commit", "-m", "initial")

	now := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	packageRoot, err := PreparePackageRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	skillStore := NewMemoryStore()
	sourceStore := NewMemorySourceStore(skillStore)
	source := GitHubSource{
		SourceID: "source_1", Provider: GitHubSourceProvider, RepositoryOwner: "acme", RepositoryName: "skills", Branch: "main", ScanRoot: ".",
		TokenCiphertext: []byte("ciphertext-secret"), AutoPublish: autoPublish, Schedule: SourceScheduleManual, Status: SourceStatusActive,
		CreatedBy: "source-owner", CreatedAt: now, UpdatedAt: now,
	}
	if _, err := sourceStore.CreateSource(context.Background(), source); err != nil {
		t.Fatal(err)
	}
	git := NewGitClient("git", time.Minute, 64*1024, nil)
	workspace := NewRepositoryWorkspace(t.TempDir(), git)
	workspace.repositoryURL = func(string, string) string { return repository }
	cipher := &sourceSyncCipher{plaintext: []byte("secret-token")}
	versionService := NewService(Config{Store: skillStore, PackageRoot: packageRoot, Clock: func() time.Time { return now }})
	service := NewSourceSyncService(SourceSyncServiceConfig{
		Store: sourceStore, TokenCipher: cipher, Workspace: workspace, Git: git, Discovery: &SkillDiscovery{}, PackageBuilder: &SourcePackageBuilder{},
		VersionService: versionService, PackageRoot: packageRoot, Clock: func() time.Time { return now },
	})
	return &sourceSyncFixture{
		t: t, now: now, repository: repository, packageRoot: packageRoot, skillStore: skillStore, sourceStore: sourceStore,
		versionService: versionService, workspace: workspace, git: git, cipher: cipher, source: source, service: service,
	}
}

func (f *sourceSyncFixture) claimRun() SourceSyncRun {
	return f.claimRunWithMode(SourceRepositoryModeRemote)
}

func (f *sourceSyncFixture) claimRunWithMode(repositoryMode string) SourceSyncRun {
	f.t.Helper()
	f.runNumber++
	runAt := f.now.Add(time.Duration(f.runNumber) * time.Second)
	run := SourceSyncRun{RunID: newID("sourcerun"), SourceID: f.source.SourceID, Trigger: SourceSyncTriggerManual, RepositoryMode: repositoryMode, Status: SourceSyncRunStatusQueued, RequestedBy: "admin", CreatedAt: runAt}
	if _, err := f.sourceStore.CreateSyncRun(context.Background(), run); err != nil {
		f.t.Fatal(err)
	}
	claimed, ok, err := f.sourceStore.ClaimNextSyncRun(context.Background(), runAt)
	if err != nil || !ok {
		f.t.Fatalf("ClaimNextSyncRun() = %#v, %v, %v", claimed, ok, err)
	}
	return claimed
}

func (f *sourceSyncFixture) latestRun() SourceSyncRun {
	f.t.Helper()
	runs, err := f.sourceStore.ListSourceSyncRuns(context.Background(), f.source.SourceID, 1)
	if err != nil || len(runs) != 1 {
		f.t.Fatalf("ListSourceSyncRuns() = %#v, %v", runs, err)
	}
	return runs[0]
}

func (f *sourceSyncFixture) head() string {
	f.t.Helper()
	return strings.TrimSpace(runSourceSyncGit(f.t, f.repository, "rev-parse", "HEAD"))
}

func (f *sourceSyncFixture) commit(files map[string]string, message string) {
	f.t.Helper()
	for name, body := range files {
		writeDiscoveryFile(f.t, f.repository, name, body)
	}
	runSourceSyncGit(f.t, f.repository, "add", ".")
	runSourceSyncGit(f.t, f.repository, "commit", "-m", message)
}

func (f *sourceSyncFixture) sourceItem(path string) SourceItem {
	f.t.Helper()
	items, err := f.sourceStore.ListSourceItems(context.Background(), f.source.SourceID)
	if err != nil {
		f.t.Fatal(err)
	}
	for _, item := range items {
		if item.SkillPath == path {
			return item
		}
	}
	f.t.Fatalf("source item %q not found", path)
	return SourceItem{}
}

func (f *sourceSyncFixture) seedItem(item SourceItem) {
	f.t.Helper()
	item.CreatedAt = f.now
	item.UpdatedAt = f.now
	if _, err := f.sourceStore.UpsertSourceItem(context.Background(), item); err != nil {
		f.t.Fatal(err)
	}
}

func (f *sourceSyncFixture) skillDetailByName(name string) AdminDetail {
	f.t.Helper()
	items, err := f.skillStore.ListAdmin(context.Background())
	if err != nil {
		f.t.Fatal(err)
	}
	for _, skill := range items {
		if skill.Name == name {
			detail, err := f.skillStore.GetAdmin(context.Background(), skill.SkillID)
			if err != nil {
				f.t.Fatal(err)
			}
			return detail
		}
	}
	f.t.Fatalf("skill %q not found", name)
	return AdminDetail{}
}

func (f *sourceSyncFixture) replaceSource() {
	f.t.Helper()
	current, err := f.sourceStore.GetSource(context.Background(), f.source.SourceID)
	if err != nil {
		f.t.Fatal(err)
	}
	current.ScanRoot = f.source.ScanRoot
	current.UpdatedAt = f.now
	updated, err := f.sourceStore.UpdateSource(context.Background(), current, TokenKeep)
	if err != nil {
		f.t.Fatal(err)
	}
	f.source = updated
}

func containsSkillName(skills []Skill, name string) bool {
	for _, skill := range skills {
		if skill.Name == name {
			return true
		}
	}
	return false
}

func runSourceSyncGit(t *testing.T, directory string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", directory}, args...)...)
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
	return string(output)
}

func TestSourceSyncServiceLocksWholeSourceRun(t *testing.T) {
	fixture := newSourceSyncFixture(t, map[string]string{"skills/one/SKILL.md": validSkillMD("one")}, false)
	first := fixture.claimRun()
	blocker := &blockingSourceSyncStore{SourceStore: fixture.sourceStore, entered: make(chan struct{}), release: make(chan struct{})}
	fixture.service.store = blocker

	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		_ = fixture.service.Run(context.Background(), first)
	}()
	<-blocker.entered
	secondDone := make(chan struct{})
	go func() {
		defer close(secondDone)
		_ = fixture.service.Run(context.Background(), first)
	}()
	select {
	case <-secondDone:
		t.Fatal("second Run passed source lock before first completed")
	case <-time.After(50 * time.Millisecond):
	}
	close(blocker.release)
	wait.Wait()
	<-secondDone
}

type blockingSourceSyncStore struct {
	SourceStore
	once    sync.Once
	entered chan struct{}
	release chan struct{}
}

func (s *blockingSourceSyncStore) MarkMissingSourceItems(ctx context.Context, sourceID, commit string, now time.Time, sourceRevision int64) error {
	s.once.Do(func() {
		close(s.entered)
		<-s.release
	})
	return s.SourceStore.MarkMissingSourceItems(ctx, sourceID, commit, now, sourceRevision)
}
