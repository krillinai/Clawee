package skillhub

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	pgxmock "github.com/pashagolub/pgxmock/v4"
)

func TestPostgresStoreCreateVersionAndLoadAdminDetail(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)
	skill := Skill{SkillID: "skill-1", SpaceID: DefaultSpaceID, Name: "code-review", CreatedBy: "usr-admin", CreatedAt: now, UpdatedAt: now}
	version := Version{VersionID: "version-1", Version: "1.0", Description: "description", Changelog: "changes", PackagePath: "version-1.zip", PackageSHA256: "sha", CreatedAt: now}

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO skills (skill_id,space_id,name,current_version_id,created_by,created_at,updated_at) VALUES ($1,$2,$3,NULL,$4,$5,$6) ON CONFLICT (name) DO NOTHING`)).
		WithArgs(skill.SkillID, skill.SpaceID, skill.Name, skill.CreatedBy, now, now).WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE name=$1 FOR UPDATE`)).
		WithArgs(skill.Name).WillReturnRows(skillRows().AddRow(skill.SkillID, skill.SpaceID, skill.Name, nil, skill.CreatedBy, now, now))
	mock.ExpectExec(`INSERT INTO skill_versions`).
		WithArgs(version.VersionID, skill.SkillID, version.Version, version.Description, version.Changelog, version.PackagePath, version.PackageSHA256, now, nil, nil, nil, nil, nil, nil).
		WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE skills SET current_version_id=$2,updated_at=$3 WHERE skill_id=$1`)).
		WithArgs(skill.SkillID, version.VersionID, now).WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()

	gotSkill, gotVersion, err := store.CreateVersion(context.Background(), skill, version, CreateVersionOptions{Publish: true, Resolution: VersionResolutionByName})
	if err != nil {
		t.Fatal(err)
	}
	if gotSkill.Description != version.Description || gotSkill.CurrentVersionID == nil || *gotSkill.CurrentVersionID != version.VersionID || gotVersion.SkillID != skill.SkillID {
		t.Fatalf("result = %#v %#v", gotSkill, gotVersion)
	}
}

func TestPostgresStoreCreateVersionPublishesLatestDescription(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)
	current := "version-current"
	proposed := Skill{SkillID: "unused-id", SpaceID: DefaultSpaceID, Name: "code-review", CreatedBy: "new-admin", CreatedAt: now, UpdatedAt: now}
	version := Version{VersionID: "version-new", Version: "2.0", Description: "new description", PackagePath: "version-new.zip", PackageSHA256: "sha-new", CreatedAt: now}

	mock.ExpectBegin()
	mock.ExpectExec(`INSERT INTO skills`).WithArgs(proposed.SkillID, proposed.SpaceID, proposed.Name, proposed.CreatedBy, now, now).WillReturnResult(pgxmock.NewResult("INSERT", 0))
	mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills`).WithArgs(proposed.Name).
		WillReturnRows(skillRows().AddRow("skill-1", proposed.SpaceID, proposed.Name, current, "original-admin", now.Add(-time.Hour), now.Add(-time.Hour)))
	mock.ExpectExec(`INSERT INTO skill_versions`).WithArgs(version.VersionID, "skill-1", version.Version, version.Description, version.Changelog, version.PackagePath, version.PackageSHA256, now, nil, nil, nil, nil, nil, nil).
		WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectExec(`UPDATE skills SET current_version_id`).WithArgs("skill-1", version.VersionID, now).WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()

	skill, _, err := store.CreateVersion(context.Background(), proposed, version, CreateVersionOptions{Publish: true, Resolution: VersionResolutionByName})
	if err != nil {
		t.Fatal(err)
	}
	if skill.Description != version.Description || skill.CurrentVersionID == nil || *skill.CurrentVersionID != version.VersionID || skill.CreatedBy != "original-admin" || skill.SkillID != "skill-1" {
		t.Fatalf("skill = %#v", skill)
	}
}

func TestPostgresStoreCreateVersionConflictRollsBackWithoutChangingCurrent(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)
	current := "version-current"
	proposed := Skill{SkillID: "unused-id", SpaceID: DefaultSpaceID, Name: "code-review", CreatedBy: "admin", CreatedAt: now, UpdatedAt: now}
	version := Version{VersionID: "version-new", Version: "1.0", Description: "duplicate", PackagePath: "version-new.zip", PackageSHA256: "sha", CreatedAt: now}

	mock.ExpectBegin()
	mock.ExpectExec(`INSERT INTO skills`).WithArgs(proposed.SkillID, proposed.SpaceID, proposed.Name, proposed.CreatedBy, now, now).WillReturnResult(pgxmock.NewResult("INSERT", 0))
	mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills`).WithArgs(proposed.Name).
		WillReturnRows(skillRows().AddRow("skill-1", proposed.SpaceID, proposed.Name, current, "admin", now.Add(-time.Hour), now.Add(-time.Hour)))
	mock.ExpectExec(`INSERT INTO skill_versions`).WithArgs(version.VersionID, "skill-1", version.Version, version.Description, version.Changelog, version.PackagePath, version.PackageSHA256, now, nil, nil, nil, nil, nil, nil).
		WillReturnError(&pgconn.PgError{Code: "23505"})
	mock.ExpectRollback()

	if _, _, err := store.CreateVersion(context.Background(), proposed, version, CreateVersionOptions{Publish: true, Resolution: VersionResolutionByName}); !errors.Is(err, ErrConflict) {
		t.Fatalf("CreateVersion() error = %v, want ErrConflict", err)
	}
}

func TestPostgresStoreCreateVersionMapsMissingSpace(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 27, 9, 30, 0, 0, time.UTC)
	skill := Skill{SkillID: "skill-1", SpaceID: "skillspace-missing", Name: "code-review", CreatedBy: "admin", CreatedAt: now, UpdatedAt: now}
	version := Version{VersionID: "version-1", Version: "1.0", CreatedAt: now}

	mock.ExpectBegin()
	mock.ExpectExec(`INSERT INTO skills`).WithArgs(skill.SkillID, skill.SpaceID, skill.Name, skill.CreatedBy, now, now).
		WillReturnError(&pgconn.PgError{Code: "23503", ConstraintName: "skills_space_id_fkey"})
	mock.ExpectRollback()

	if _, _, err := store.CreateVersion(context.Background(), skill, version, CreateVersionOptions{Resolution: VersionResolutionByName}); !errors.Is(err, ErrSpaceNotFound) {
		t.Fatalf("CreateVersion(missing space) error=%v, want ErrSpaceNotFound", err)
	}
}

func TestPostgresStoreCreateVersionCreateOnlyStoresSourceWithoutPublishing(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 31, 9, 0, 0, 0, time.UTC)
	proposed := Skill{SkillID: "skill-1", SpaceID: DefaultSpaceID, Name: "code-review", CreatedBy: "admin", CreatedAt: now, UpdatedAt: now}
	source := &VersionSourceEvidence{SourceID: "source-1", RepositoryOwner: "acme", RepositoryName: "skills", Path: "skills/code-review", CommitSHA: strings.Repeat("1", 40), ContentSHA256: strings.Repeat("a", 64)}
	version := Version{VersionID: "version-1", Version: "git-1", Description: "description", PackagePath: "version-1.zip", PackageSHA256: "sha", Source: source, CreatedAt: now}

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE name=\$1 FOR UPDATE`).WithArgs(proposed.Name).WillReturnError(pgx.ErrNoRows)
	mock.ExpectExec(`INSERT INTO skills`).WithArgs(proposed.SkillID, proposed.SpaceID, proposed.Name, proposed.CreatedBy, now, now).WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectExec(`INSERT INTO skill_versions`).
		WithArgs(version.VersionID, proposed.SkillID, version.Version, version.Description, version.Changelog, version.PackagePath, version.PackageSHA256, now, source.SourceID, source.Path, source.CommitSHA, source.ContentSHA256, nil, nil).
		WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectCommit()

	gotSkill, gotVersion, err := store.CreateVersion(context.Background(), proposed, version, CreateVersionOptions{Publish: false, Resolution: VersionResolutionCreateOnly})
	if err != nil {
		t.Fatal(err)
	}
	if gotSkill.CurrentVersionID != nil || gotVersion.Source == nil || *gotVersion.Source != *source {
		t.Fatalf("result = %#v %#v", gotSkill, gotVersion)
	}
}

func TestPostgresStoreCreateVersionTargetPublishesMatchingSkill(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 31, 9, 0, 0, 0, time.UTC)
	current := "version-old"
	proposed := Skill{SkillID: "unused", SpaceID: DefaultSpaceID, Name: "code-review", CreatedBy: "admin", CreatedAt: now, UpdatedAt: now}
	version := Version{VersionID: "version-new", Version: "git-2", Description: "new", PackagePath: "version-new.zip", PackageSHA256: "sha", CreatedAt: now}

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE skill_id=\$1 FOR UPDATE`).WithArgs("skill-1").
		WillReturnRows(skillRows().AddRow("skill-1", "skillspace-moved", proposed.Name, current, "original", now.Add(-time.Hour), now.Add(-time.Hour)))
	mock.ExpectExec(`INSERT INTO skill_versions`).WithArgs(version.VersionID, "skill-1", version.Version, version.Description, version.Changelog, version.PackagePath, version.PackageSHA256, now, nil, nil, nil, nil, nil, nil).
		WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectExec(`UPDATE skills SET current_version_id`).WithArgs("skill-1", version.VersionID, now).WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()

	gotSkill, _, err := store.CreateVersion(context.Background(), proposed, version, CreateVersionOptions{Publish: true, Resolution: VersionResolutionTarget, TargetSkillID: "skill-1"})
	if err != nil || gotSkill.SkillID != "skill-1" || gotSkill.SpaceID != "skillspace-moved" || gotSkill.CurrentVersionID == nil || *gotSkill.CurrentVersionID != version.VersionID {
		t.Fatalf("CreateVersion() = %#v, %v", gotSkill, err)
	}
}

func TestPostgresStoreMovesSkillsToSpaceAtomically(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 8, 24, 9, 0, 0, 0, time.UTC)
	skillIDs := []string{"skill-1", "skill-2"}

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT space_id FROM skill_spaces`).WithArgs("skillspace-target").
		WillReturnRows(pgxmock.NewRows([]string{"space_id"}).AddRow("skillspace-target"))
	mock.ExpectQuery(`SELECT skill_id FROM skills`).WithArgs(skillIDs).
		WillReturnRows(pgxmock.NewRows([]string{"skill_id"}).AddRow("skill-1").AddRow("skill-2"))
	mock.ExpectExec(`UPDATE skills SET space_id`).WithArgs(skillIDs, "skillspace-target", now).
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()

	result, err := store.MoveSkillsToSpace(context.Background(), skillIDs, "skillspace-target", now)
	if err != nil || result.MovedCount != 1 || result.UnchangedCount != 1 || result.TargetSpaceID != "skillspace-target" {
		t.Fatalf("MoveSkillsToSpace() = %#v, %v", result, err)
	}
}

func TestPostgresStoreMoveSkillsToSpaceRollsBackWhenSkillIsMissing(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	skillIDs := []string{"skill-1", "skill-missing"}

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT space_id FROM skill_spaces`).WithArgs("skillspace-target").
		WillReturnRows(pgxmock.NewRows([]string{"space_id"}).AddRow("skillspace-target"))
	mock.ExpectQuery(`SELECT skill_id FROM skills`).WithArgs(skillIDs).
		WillReturnRows(pgxmock.NewRows([]string{"skill_id"}).AddRow("skill-1"))
	mock.ExpectRollback()

	if _, err := store.MoveSkillsToSpace(context.Background(), skillIDs, "skillspace-target", time.Now()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("MoveSkillsToSpace() error = %v, want ErrNotFound", err)
	}
}

func TestPostgresStoreCreateVersionRejectsCreateOnlyAndMismatchedTarget(t *testing.T) {
	now := time.Date(2026, 7, 31, 9, 0, 0, 0, time.UTC)
	proposed := Skill{SkillID: "unused", SpaceID: DefaultSpaceID, Name: "code-review", CreatedBy: "admin", CreatedAt: now, UpdatedAt: now}
	version := Version{VersionID: "version-new", Version: "git-2", CreatedAt: now}

	t.Run("create only", func(t *testing.T) {
		mock := newPGXMock(t)
		store := NewPostgresStore(mock)
		mock.ExpectBegin()
		mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE name=\$1 FOR UPDATE`).WithArgs(proposed.Name).
			WillReturnRows(skillRows().AddRow("skill-1", proposed.SpaceID, proposed.Name, nil, "original", now, now))
		mock.ExpectRollback()
		if _, _, err := store.CreateVersion(context.Background(), proposed, version, CreateVersionOptions{Resolution: VersionResolutionCreateOnly}); !errors.Is(err, ErrConflict) {
			t.Fatalf("CreateVersion() error = %v, want ErrConflict", err)
		}
	})

	t.Run("mismatched target", func(t *testing.T) {
		mock := newPGXMock(t)
		store := NewPostgresStore(mock)
		mock.ExpectBegin()
		mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE skill_id=\$1 FOR UPDATE`).WithArgs("skill-other").
			WillReturnRows(skillRows().AddRow("skill-other", proposed.SpaceID, "other", nil, "original", now, now))
		mock.ExpectRollback()
		if _, _, err := store.CreateVersion(context.Background(), proposed, version, CreateVersionOptions{Resolution: VersionResolutionTarget, TargetSkillID: "skill-other"}); !errors.Is(err, ErrConflict) {
			t.Fatalf("CreateVersion() error = %v, want ErrConflict", err)
		}
	})
}

func TestPostgresStoreListsAdminAndPublishedSkills(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 27, 17, 0, 0, 0, time.FixedZone("UTC+8", 8*60*60))
	current := "version-1"

	mock.ExpectQuery(regexp.QuoteMeta(adminSkillSelect + ` ORDER BY s.updated_at DESC`)).
		WillReturnRows(adminSkillRows().AddRow("skill-1", DefaultSpaceID, "默认技能空间", "code-review", "description", current, "admin", now, now))
	adminItems, err := store.ListAdmin(context.Background())
	if err != nil || len(adminItems) != 1 || adminItems[0].CurrentVersionID == nil {
		t.Fatalf("ListAdmin() = %#v, %v", adminItems, err)
	}
	if adminItems[0].CreatedAt.Location() != time.UTC || adminItems[0].UpdatedAt.Location() != time.UTC {
		t.Fatalf("admin timestamps are not UTC: created=%v updated=%v", adminItems[0].CreatedAt, adminItems[0].UpdatedAt)
	}

	mock.ExpectQuery(regexp.QuoteMeta(publishedSelect + ` ORDER BY s.updated_at DESC`)).
		WillReturnRows(publishedRows().AddRow("skill-1", DefaultSpaceID, "默认技能空间", "code-review", "description", current, "1.0", "sha", now, "changes", "version-1.zip"))
	publishedItems, err := store.ListPublished(context.Background())
	if err != nil || len(publishedItems) != 1 || publishedItems[0].Version != "1.0" {
		t.Fatalf("ListPublished() = %#v, %v", publishedItems, err)
	}
	if publishedItems[0].UpdatedAt.Location() != time.UTC {
		t.Fatalf("published updated_at is not UTC: %v", publishedItems[0].UpdatedAt)
	}

	mock.ExpectQuery(regexp.QuoteMeta(publishedSelect + ` AND s.skill_id=$1`)).WithArgs("skill-1").
		WillReturnRows(publishedRows().AddRow("skill-1", DefaultSpaceID, "默认技能空间", "code-review", "description", current, "1.0", "sha", now, "changes", "version-1.zip"))
	detail, err := store.GetPublished(context.Background(), "skill-1")
	if err != nil || detail.PackagePath != "version-1.zip" {
		t.Fatalf("GetPublished() = %#v, %v", detail, err)
	}
	if detail.UpdatedAt.Location() != time.UTC {
		t.Fatalf("published detail updated_at is not UTC: %v", detail.UpdatedAt)
	}
}

func TestPostgresStoreAdminDetailNormalizesVersionTimestampsToUTC(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 27, 17, 0, 0, 0, time.FixedZone("UTC+8", 8*60*60))

	mock.ExpectQuery(regexp.QuoteMeta(adminSkillSelect + ` WHERE s.skill_id=$1`)).WithArgs("skill-1").
		WillReturnRows(adminSkillRows().AddRow("skill-1", DefaultSpaceID, "默认技能空间", "code-review", "description", nil, "admin", now, now))
	mock.ExpectQuery(`SELECT v.version_id,v.skill_id,v.version,v.description,v.changelog,v.package_path,v.package_sha256,v.created_at`).WithArgs("skill-1").
		WillReturnRows(versionSourceRows().
			AddRow("version-1", "skill-1", "1.0", "description", "changes", "version-1.zip", "sha", now, "source-1", "acme", "skills", "skills/code-review", strings.Repeat("1", 40), strings.Repeat("a", 64), "usr-1", "agent-1").
			AddRow("version-manual", "skill-1", "0.9", "manual", "", "version-manual.zip", "sha-manual", now.Add(-time.Hour), nil, nil, nil, nil, nil, nil, nil, nil))

	detail, err := store.GetAdmin(context.Background(), "skill-1")
	if err != nil || len(detail.Versions) != 2 {
		t.Fatalf("GetAdmin() = %#v, %v", detail, err)
	}
	if detail.Skill.CreatedAt.Location() != time.UTC || detail.Skill.UpdatedAt.Location() != time.UTC || detail.Versions[0].CreatedAt.Location() != time.UTC {
		t.Fatalf("admin detail timestamps are not UTC: %#v", detail)
	}
	if detail.Versions[0].Source == nil || detail.Versions[0].Source.RepositoryOwner != "acme" || detail.Versions[0].Source.CommitSHA != strings.Repeat("1", 40) {
		t.Fatalf("admin detail source = %#v", detail.Versions[0].Source)
	}
	if detail.Versions[1].Source != nil {
		t.Fatalf("manual version source = %#v, want nil", detail.Versions[1].Source)
	}
}

func TestPostgresStoreSetsAndClearsCurrentVersion(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills`).WithArgs("skill-1").
		WillReturnRows(skillRows().AddRow("skill-1", DefaultSpaceID, "code-review", nil, "admin", now, now))
	mock.ExpectQuery(`SELECT version_id,skill_id,version,description,changelog,package_path,package_sha256,created_at FROM skill_versions`).
		WithArgs("version-1").WillReturnRows(versionRows().AddRow("version-1", "skill-1", "1.0", "description", "changes", "version-1.zip", "sha", now))
	mock.ExpectExec(`UPDATE skills SET current_version_id`).WithArgs("skill-1", "version-1", now).
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()
	skill, version, err := store.SetCurrentVersion(context.Background(), "skill-1", "version-1", now)
	if err != nil || skill.CurrentVersionID == nil || version.VersionID != "version-1" {
		t.Fatalf("SetCurrentVersion() = %#v %#v, %v", skill, version, err)
	}

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT current_version_id FROM skills`).WithArgs("skill-1").WillReturnRows(pgxmock.NewRows([]string{"current_version_id"}).AddRow("version-1"))
	mock.ExpectQuery(`SELECT version_id,skill_id,version,description,changelog,package_path,package_sha256,created_at FROM skill_versions`).
		WithArgs("skill-1", "version-1").WillReturnRows(versionRows().AddRow("version-1", "skill-1", "1.0", "description", "changes", "version-1.zip", "sha", now))
	mock.ExpectExec(`UPDATE skills SET current_version_id=NULL`).WithArgs("skill-1", now).WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()
	cleared, err := store.ClearCurrentVersion(context.Background(), "skill-1", now)
	if err != nil {
		t.Fatal(err)
	}
	if cleared == nil || cleared.VersionID != "version-1" || cleared.PackageSHA256 != "sha" {
		t.Fatalf("cleared version = %#v", cleared)
	}

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT current_version_id FROM skills`).WithArgs("skill-1").WillReturnRows(pgxmock.NewRows([]string{"current_version_id"}).AddRow(nil))
	mock.ExpectCommit()
	cleared, err = store.ClearCurrentVersion(context.Background(), "skill-1", now)
	if err != nil {
		t.Fatal(err)
	}
	if cleared != nil {
		t.Fatalf("idempotent clear version = %#v, want nil", cleared)
	}
}

func TestPostgresStoreMapsNotFoundAndConstraintErrors(t *testing.T) {
	if !errors.Is(mapNotFound(pgx.ErrNoRows), ErrNotFound) {
		t.Fatal("pgx.ErrNoRows should map to ErrNotFound")
	}
	if !errors.Is(mapStoreError(&pgconn.PgError{Code: "23505"}), ErrConflict) {
		t.Fatal("unique violation should map to ErrConflict")
	}
	original := errors.New("boom")
	if mapNotFound(original) != original || mapStoreError(original) != original {
		t.Fatal("unrelated errors should be preserved")
	}
}

func newPGXMock(t *testing.T) pgxmock.PgxPoolIface {
	t.Helper()
	mock, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Error(err)
		}
	})
	return mock
}

func skillRows() *pgxmock.Rows {
	return pgxmock.NewRows([]string{"skill_id", "space_id", "name", "current_version_id", "created_by", "created_at", "updated_at"})
}

func adminSkillRows() *pgxmock.Rows {
	return pgxmock.NewRows([]string{"skill_id", "space_id", "space_name", "name", "description", "current_version_id", "created_by", "created_at", "updated_at"})
}

func versionRows() *pgxmock.Rows {
	return pgxmock.NewRows([]string{"version_id", "skill_id", "version", "description", "changelog", "package_path", "package_sha256", "created_at"})
}

func versionSourceRows() *pgxmock.Rows {
	return pgxmock.NewRows([]string{"version_id", "skill_id", "version", "description", "changelog", "package_path", "package_sha256", "created_at", "source_id", "repository_owner", "repository_name", "source_path", "source_commit_sha", "source_content_sha256", "uploaded_by_user_id", "uploaded_by_agent_id"})
}

func publishedRows() *pgxmock.Rows {
	return pgxmock.NewRows([]string{"skill_id", "space_id", "space_name", "name", "description", "version_id", "version", "package_sha256", "updated_at", "changelog", "package_path"})
}
