package skillhub

import (
	"context"
	"errors"
	"fmt"
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
	skill := Skill{SkillID: "skill-1", SpaceID: DefaultSpaceID, Name: "code-review", CreatedBy: "创建者", CreatedByUserID: "usr-admin", CreatedAt: now, UpdatedAt: now}
	version := Version{VersionID: "version-1", Version: "1.0", Description: "description", Changelog: "changes", PackagePath: "version-1.zip", PackageSHA256: "sha", CreatedAt: now, UploadedByUserID: "usr-admin", UploadedByName: "创建者"}

	mock.ExpectBegin()
	expectSpaceLock(mock, skill.SpaceID)
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO skills (skill_id,space_id,name,current_version_id,created_by,created_at,updated_at,created_by_user_id) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7) ON CONFLICT (name) DO NOTHING`)).
		WithArgs(skill.SkillID, skill.SpaceID, skill.Name, skill.CreatedBy, now, now, skill.CreatedByUserID).WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE name=$1 FOR UPDATE`)).
		WithArgs(skill.Name).WillReturnRows(skillRows().AddRow(skill.SkillID, skill.SpaceID, skill.Name, nil, skill.CreatedBy, now, now))
	mock.ExpectExec(`INSERT INTO skill_versions`).
		WithArgs(version.VersionID, skill.SkillID, version.Version, version.Description, version.Changelog, version.PackagePath, version.PackageSHA256, now, nil, nil, nil, nil, version.UploadedByUserID, nil, version.UploadedByName, skill.Name).
		WillReturnResult(pgxmock.NewResult("INSERT", 1))
	expectLocalInsert(mock, version.VersionID, skill.SpaceID, version.PackageSHA256, now)
	mock.ExpectExec(`INSERT INTO employee_ai_activity_facts`).WithArgs(pgxmock.AnyArg(), "skill.created", "user", version.UploadedByUserID, "admin_upload", skill.SkillID, skill.Name, version.VersionID).WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectCommit()

	gotSkill, gotVersion, err := store.CreateVersion(context.Background(), skill, version, CreateVersionOptions{Publish: true, Resolution: VersionResolutionByName, Origin: "admin_upload"})
	if err != nil {
		t.Fatal(err)
	}
	if gotSkill.Description != version.Description || gotSkill.CurrentVersionID != nil || gotVersion.ApprovalStatus != "pending" || gotVersion.SkillID != skill.SkillID {
		t.Fatalf("result = %#v %#v", gotSkill, gotVersion)
	}
}

func TestPostgresCreateSpaceGrantsCreatorAtomically(t *testing.T) {
	now := time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC)
	space := Space{SpaceID: "skillspace_new", Name: "团队空间", CreatedBy: "creator", UpdatedBy: "creator", CreatedAt: now, UpdatedAt: now}
	for _, failGrant := range []bool{false, true} {
		mock := newPGXMock(t)
		store := NewPostgresStore(mock)
		mock.ExpectBegin()
		mock.ExpectExec(`INSERT INTO skill_spaces`).WithArgs(space.SpaceID, space.Name, space.Description, space.CreatedBy, space.UpdatedBy, now, now).WillReturnResult(pgxmock.NewResult("INSERT", 1))
		mock.ExpectExec(`INSERT INTO data_resource_grants`).WithArgs(pgxmock.AnyArg(), "creator", space.SpaceID, SpaceActionRead, "creator", now).WillReturnResult(pgxmock.NewResult("INSERT", 1))
		write := mock.ExpectExec(`INSERT INTO data_resource_grants`).WithArgs(pgxmock.AnyArg(), "creator", space.SpaceID, SpaceActionWrite, "creator", now)
		if failGrant {
			write.WillReturnError(errors.New("grant failed"))
			mock.ExpectRollback()
		} else {
			write.WillReturnResult(pgxmock.NewResult("INSERT", 1))
			mock.ExpectCommit()
			mock.ExpectQuery(`SELECT sp.space_id`).WithArgs(space.SpaceID).WillReturnRows(pgxmock.NewRows([]string{
				"space_id", "name", "description", "created_by", "updated_by", "created_at", "updated_at",
				"member_count", "skill_count", "published_count", "approvers", "approval_provider", "external_approval_template_id",
			}).AddRow(space.SpaceID, space.Name, space.Description, space.CreatedBy, space.UpdatedBy, now, now, 1, 0, 0, []byte("[]"), "local", ""))
		}
		created, err := store.CreateSpace(context.Background(), space)
		if failGrant {
			if err == nil {
				t.Fatal("CreateSpace() succeeded after grant failure")
			}
		} else if err != nil || created.MemberCount != 1 {
			t.Fatalf("CreateSpace() = %#v, %v", created, err)
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPostgresStoreContributionFactIsAtomic(t *testing.T) {
	for _, tc := range []struct {
		name, resolution, origin, event, actor string
		inserted, failFact                     bool
	}{
		{"new-app", VersionResolutionByName, "app_upload", "skill.created", "user", true, false},
		{"existing-unpublished", VersionResolutionByName, "admin_upload", "skill.version_uploaded", "user", false, false},
		{"new-source", VersionResolutionByName, "source_sync", "skill.created", "system", true, false},
		{"fact-fails", VersionResolutionByName, "app_upload", "skill.created", "user", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mock := newPGXMock(t)
			store := NewPostgresStore(mock)
			now := time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)
			skill := Skill{SkillID: "new", SpaceID: DefaultSpaceID, Name: "report", CreatedBy: "uploader", CreatedByUserID: "user-1", CreatedAt: now, UpdatedAt: now}
			version := Version{VersionID: "ver-1", Version: "1", PackagePath: "ver-1.zip", PackageSHA256: "hash", CreatedAt: now, UploadedByUserID: "user-1"}
			if tc.origin == "source_sync" {
				version.UploadedByUserID = ""
			}
			mock.ExpectBegin()
			expectSpaceLock(mock, skill.SpaceID)
			count := int64(0)
			storedID := "existing"
			if tc.inserted {
				count, storedID = 1, "new"
			}
			mock.ExpectExec(`INSERT INTO skills`).WithArgs(skill.SkillID, skill.SpaceID, skill.Name, skill.CreatedBy, now, now, skill.CreatedByUserID).WillReturnResult(pgxmock.NewResult("INSERT", count))
			mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE name`).WithArgs("report").
				WillReturnRows(skillRows().AddRow(storedID, DefaultSpaceID, "report", nil, "uploader", now, now))
			mock.ExpectExec(`INSERT INTO skill_versions`).WithArgs(version.VersionID, storedID, version.Version, version.Description, version.Changelog, version.PackagePath, version.PackageSHA256, now, nil, nil, nil, nil, nullableText(version.UploadedByUserID), nil, version.UploadedByName, skill.Name).WillReturnResult(pgxmock.NewResult("INSERT", 1))
			expectLocalInsert(mock, version.VersionID, skill.SpaceID, version.PackageSHA256, now)
			actor := any("user-1")
			if tc.actor == "system" {
				actor = nil
			}
			fact := mock.ExpectExec(`INSERT INTO employee_ai_activity_facts`).WithArgs(pgxmock.AnyArg(), tc.event, tc.actor, actor, tc.origin, storedID, "report", "ver-1")
			if tc.failFact {
				fact.WillReturnError(errors.New("fact write failed"))
				mock.ExpectRollback()
			} else {
				fact.WillReturnResult(pgxmock.NewResult("INSERT", 1))
				mock.ExpectCommit()
			}
			_, _, err := store.CreateVersion(context.Background(), skill, version, CreateVersionOptions{Resolution: tc.resolution, Origin: tc.origin})
			if (err != nil) != tc.failFact {
				t.Fatalf("CreateVersion() error = %v", err)
			}
		})
	}
}

func TestPostgresStoreRejectsMissingContributionOrigin(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	_, _, err := store.CreateVersion(context.Background(), Skill{}, Version{}, CreateVersionOptions{Resolution: VersionResolutionByName})
	if !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("CreateVersion() error = %v, want ErrInvalidRequest", err)
	}
}

func TestPostgresStoreReplacementRenameIsTransactional(t *testing.T) {
	for _, conflict := range []bool{false, true} {
		t.Run(fmt.Sprintf("version-conflict-%t", conflict), func(t *testing.T) {
			mock := newPGXMock(t)
			store := NewPostgresStore(mock)
			now := time.Now().UTC()
			mock.ExpectBegin()
			expectSpaceLock(mock, DefaultSpaceID)
			mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE skill_id=\$1 FOR UPDATE`).WithArgs("original").WillReturnRows(skillRows().AddRow("original", DefaultSpaceID, "old-name", "v1", "creator", now, now))
			mock.ExpectQuery(`SELECT EXISTS\(SELECT 1 FROM skills WHERE name`).WithArgs("new-name", "original").WillReturnRows(pgxmock.NewRows([]string{"exists"}).AddRow(false))
			insert := mock.ExpectExec(`INSERT INTO skill_versions`).WithArgs("v2", "original", "2", "", "", "v2.zip", "hash", now, nil, nil, nil, nil, nil, nil, "", "new-name")
			if conflict {
				insert.WillReturnError(&pgconn.PgError{Code: "23505"})
				mock.ExpectRollback()
			} else {
				insert.WillReturnResult(pgxmock.NewResult("INSERT", 1))
				expectLocalInsert(mock, "v2", DefaultSpaceID, "hash", now)
				mock.ExpectExec(`INSERT INTO employee_ai_activity_facts`).WithArgs(pgxmock.AnyArg(), "skill.version_uploaded", "user", "", "admin_upload", "original", "old-name", "v2").WillReturnResult(pgxmock.NewResult("INSERT", 1))
				mock.ExpectCommit()
			}
			skill, _, err := store.CreateVersion(context.Background(), Skill{Name: "new-name", SpaceID: DefaultSpaceID}, Version{VersionID: "v2", Version: "2", PackagePath: "v2.zip", PackageSHA256: "hash", CreatedAt: now}, CreateVersionOptions{Resolution: VersionResolutionReplace, TargetSkillID: "original", Publish: true, Origin: "admin_upload"})
			if conflict {
				if !errors.Is(err, ErrConflict) {
					t.Fatalf("conflict = %v", err)
				}
			} else if err != nil || skill.SkillID != "original" || skill.Name != "old-name" || skill.CreatedBy != "creator" {
				t.Fatalf("result = %#v, %v", skill, err)
			}
		})
	}
}

func TestPostgresStoreDeleteUnpublishedLocksStateAndClearsReferences(t *testing.T) {
	for _, published := range []bool{false, true} {
		t.Run(fmt.Sprintf("published-%t", published), func(t *testing.T) {
			mock := newPGXMock(t)
			store := NewPostgresStore(mock)
			mock.ExpectBegin()
			rows := pgxmock.NewRows([]string{"current_version_id"})
			if published {
				rows.AddRow("v1")
			} else {
				rows.AddRow(nil)
			}
			mock.ExpectQuery(`SELECT current_version_id FROM skills WHERE skill_id=\$1 FOR UPDATE`).WithArgs("original").WillReturnRows(rows)
			if published {
				mock.ExpectRollback()
			} else {
				mock.ExpectExec(`UPDATE skill_source_items SET skill_id=NULL,last_version_id=NULL`).WithArgs("original").WillReturnResult(pgxmock.NewResult("UPDATE", 1))
				mock.ExpectExec(`DELETE FROM approval_requests`).WithArgs("original").WillReturnResult(pgxmock.NewResult("DELETE", 2))
				mock.ExpectQuery(`DELETE FROM skill_versions WHERE skill_id=\$1 RETURNING package_path`).WithArgs("original").WillReturnRows(pgxmock.NewRows([]string{"package_path"}).AddRow("v1.zip").AddRow("v2.zip"))
				mock.ExpectExec(`DELETE FROM skills WHERE skill_id=\$1`).WithArgs("original").WillReturnResult(pgxmock.NewResult("DELETE", 1))
				mock.ExpectCommit()
			}
			versions, err := store.DeleteUnpublished(context.Background(), "original")
			if published {
				if !errors.Is(err, ErrConflict) {
					t.Fatalf("published deletion = %v", err)
				}
			} else if err != nil || len(versions) != 2 {
				t.Fatalf("result = %#v, %v", versions, err)
			}
		})
	}
}

func TestPostgresStoreCreateVersionPreservesCurrentUntilApproval(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)
	current := "version-current"
	proposed := Skill{SkillID: "unused-id", SpaceID: DefaultSpaceID, Name: "code-review", CreatedBy: "new-admin", CreatedAt: now, UpdatedAt: now}
	version := Version{VersionID: "version-new", Version: "2.0", Description: "new description", PackagePath: "version-new.zip", PackageSHA256: "sha-new", CreatedAt: now}

	mock.ExpectBegin()
	expectSpaceLock(mock, proposed.SpaceID)
	mock.ExpectExec(`INSERT INTO skills`).WithArgs(proposed.SkillID, proposed.SpaceID, proposed.Name, proposed.CreatedBy, now, now, nil).WillReturnResult(pgxmock.NewResult("INSERT", 0))
	mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills`).WithArgs(proposed.Name).
		WillReturnRows(skillRows().AddRow("skill-1", proposed.SpaceID, proposed.Name, current, "original-admin", now.Add(-time.Hour), now.Add(-time.Hour)))
	mock.ExpectExec(`INSERT INTO skill_versions`).WithArgs(version.VersionID, "skill-1", version.Version, version.Description, version.Changelog, version.PackagePath, version.PackageSHA256, now, nil, nil, nil, nil, nil, nil, "", proposed.Name).
		WillReturnResult(pgxmock.NewResult("INSERT", 1))
	expectLocalInsert(mock, version.VersionID, proposed.SpaceID, version.PackageSHA256, now)
	mock.ExpectExec(`INSERT INTO employee_ai_activity_facts`).WithArgs(pgxmock.AnyArg(), "skill.version_uploaded", "user", "", "admin_upload", "skill-1", proposed.Name, version.VersionID).WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectCommit()

	skill, _, err := store.CreateVersion(context.Background(), proposed, version, CreateVersionOptions{Publish: true, Resolution: VersionResolutionByName, Origin: "admin_upload"})
	if err != nil {
		t.Fatal(err)
	}
	if skill.CurrentVersionID == nil || *skill.CurrentVersionID != current || skill.CreatedBy != "original-admin" || skill.SkillID != "skill-1" {
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
	expectSpaceLock(mock, proposed.SpaceID)
	mock.ExpectExec(`INSERT INTO skills`).WithArgs(proposed.SkillID, proposed.SpaceID, proposed.Name, proposed.CreatedBy, now, now, nil).WillReturnResult(pgxmock.NewResult("INSERT", 0))
	mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills`).WithArgs(proposed.Name).
		WillReturnRows(skillRows().AddRow("skill-1", proposed.SpaceID, proposed.Name, current, "admin", now.Add(-time.Hour), now.Add(-time.Hour)))
	mock.ExpectExec(`INSERT INTO skill_versions`).WithArgs(version.VersionID, "skill-1", version.Version, version.Description, version.Changelog, version.PackagePath, version.PackageSHA256, now, nil, nil, nil, nil, nil, nil, "", proposed.Name).
		WillReturnError(&pgconn.PgError{Code: "23505"})
	mock.ExpectRollback()

	if _, _, err := store.CreateVersion(context.Background(), proposed, version, CreateVersionOptions{Publish: true, Resolution: VersionResolutionByName, Origin: "admin_upload"}); !errors.Is(err, ErrConflict) {
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
	mock.ExpectQuery(`SELECT space_id FROM skill_spaces`).WithArgs(skill.SpaceID).WillReturnError(pgx.ErrNoRows)
	mock.ExpectRollback()

	if _, _, err := store.CreateVersion(context.Background(), skill, version, CreateVersionOptions{Resolution: VersionResolutionByName, Origin: "admin_upload"}); !errors.Is(err, ErrSpaceNotFound) {
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
	expectSpaceLock(mock, proposed.SpaceID)
	mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE name=\$1 FOR UPDATE`).WithArgs(proposed.Name).WillReturnError(pgx.ErrNoRows)
	mock.ExpectExec(`INSERT INTO skills`).WithArgs(proposed.SkillID, proposed.SpaceID, proposed.Name, proposed.CreatedBy, now, now, nil).WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectExec(`INSERT INTO skill_versions`).
		WithArgs(version.VersionID, proposed.SkillID, version.Version, version.Description, version.Changelog, version.PackagePath, version.PackageSHA256, now, source.SourceID, source.Path, source.CommitSHA, source.ContentSHA256, nil, nil, "", proposed.Name).
		WillReturnResult(pgxmock.NewResult("INSERT", 1))
	expectLocalInsert(mock, version.VersionID, proposed.SpaceID, version.PackageSHA256, now)
	mock.ExpectExec(`INSERT INTO employee_ai_activity_facts`).WithArgs(pgxmock.AnyArg(), "skill.created", "system", nil, "source_sync", proposed.SkillID, proposed.Name, version.VersionID).WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectCommit()

	gotSkill, gotVersion, err := store.CreateVersion(context.Background(), proposed, version, CreateVersionOptions{Publish: false, Resolution: VersionResolutionCreateOnly, Origin: "source_sync"})
	if err != nil {
		t.Fatal(err)
	}
	if gotSkill.CurrentVersionID != nil || gotVersion.Source == nil || *gotVersion.Source != *source {
		t.Fatalf("result = %#v %#v", gotSkill, gotVersion)
	}
}

func TestPostgresStoreCreateVersionTargetDoesNotBypassApproval(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 31, 9, 0, 0, 0, time.UTC)
	current := "version-old"
	proposed := Skill{SkillID: "unused", SpaceID: DefaultSpaceID, Name: "code-review", CreatedBy: "admin", CreatedAt: now, UpdatedAt: now}
	version := Version{VersionID: "version-new", Version: "git-2", Description: "new", PackagePath: "version-new.zip", PackageSHA256: "sha", CreatedAt: now}

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT space_id FROM skills WHERE skill_id`).WithArgs("skill-1").WillReturnRows(pgxmock.NewRows([]string{"space_id"}).AddRow("skillspace-moved"))
	expectSpaceLock(mock, "skillspace-moved")
	mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE skill_id=\$1 FOR UPDATE`).WithArgs("skill-1").
		WillReturnRows(skillRows().AddRow("skill-1", "skillspace-moved", proposed.Name, current, "original", now.Add(-time.Hour), now.Add(-time.Hour)))
	mock.ExpectExec(`INSERT INTO skill_versions`).WithArgs(version.VersionID, "skill-1", version.Version, version.Description, version.Changelog, version.PackagePath, version.PackageSHA256, now, nil, nil, nil, nil, nil, nil, "", proposed.Name).
		WillReturnResult(pgxmock.NewResult("INSERT", 1))
	expectLocalInsert(mock, version.VersionID, "skillspace-moved", version.PackageSHA256, now)
	mock.ExpectExec(`INSERT INTO employee_ai_activity_facts`).WithArgs(pgxmock.AnyArg(), "skill.version_uploaded", "user", "", "admin_upload", "skill-1", proposed.Name, version.VersionID).WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectCommit()

	gotSkill, _, err := store.CreateVersion(context.Background(), proposed, version, CreateVersionOptions{Publish: true, Resolution: VersionResolutionTarget, TargetSkillID: "skill-1", Origin: "admin_upload"})
	if err != nil || gotSkill.SkillID != "skill-1" || gotSkill.SpaceID != "skillspace-moved" || gotSkill.CurrentVersionID == nil || *gotSkill.CurrentVersionID != current {
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
	mock.ExpectQuery(`SELECT EXISTS\(SELECT 1 FROM skill_version_approval_instances`).WithArgs(skillIDs, "skillspace-target").WillReturnRows(pgxmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectExec(`UPDATE skill_version_approval_instances SET status='invalidated'`).WithArgs(skillIDs, "skillspace-target", now).WillReturnResult(pgxmock.NewResult("UPDATE", 0))
	mock.ExpectQuery(`SELECT v.version_id FROM skill_versions`).WithArgs(skillIDs, "skillspace-target").WillReturnRows(pgxmock.NewRows([]string{"version_id"}))
	mock.ExpectExec(`UPDATE skill_versions SET approval_status`).WithArgs(skillIDs, "skillspace-target").WillReturnResult(pgxmock.NewResult("UPDATE", 1))
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
		expectSpaceLock(mock, proposed.SpaceID)
		mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE name=\$1 FOR UPDATE`).WithArgs(proposed.Name).
			WillReturnRows(skillRows().AddRow("skill-1", proposed.SpaceID, proposed.Name, nil, "original", now, now))
		mock.ExpectRollback()
		if _, _, err := store.CreateVersion(context.Background(), proposed, version, CreateVersionOptions{Resolution: VersionResolutionCreateOnly, Origin: "admin_upload"}); !errors.Is(err, ErrConflict) {
			t.Fatalf("CreateVersion() error = %v, want ErrConflict", err)
		}
	})

	t.Run("mismatched target", func(t *testing.T) {
		mock := newPGXMock(t)
		store := NewPostgresStore(mock)
		mock.ExpectBegin()
		mock.ExpectQuery(`SELECT space_id FROM skills WHERE skill_id`).WithArgs("skill-other").WillReturnRows(pgxmock.NewRows([]string{"space_id"}).AddRow(proposed.SpaceID))
		expectSpaceLock(mock, proposed.SpaceID)
		mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills WHERE skill_id=\$1 FOR UPDATE`).WithArgs("skill-other").
			WillReturnRows(skillRows().AddRow("skill-other", proposed.SpaceID, "other", nil, "original", now, now))
		mock.ExpectRollback()
		if _, _, err := store.CreateVersion(context.Background(), proposed, version, CreateVersionOptions{Resolution: VersionResolutionTarget, TargetSkillID: "skill-other", Origin: "admin_upload"}); !errors.Is(err, ErrConflict) {
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
		WillReturnRows(adminSkillRows().AddRow("skill-1", DefaultSpaceID, "默认技能空间", "code-review", "description", current, "admin", now, now, "version-2", "2.0", "pending", "writer-id", "sha").
			AddRow("skill-2", DefaultSpaceID, "默认技能空间", "other-skill", "description", nil, "admin", now, now, "version-3", "1.0", "pending", "writer-id", "other-sha"))
	mock.ExpectQuery(`SELECT r.id,r.business_id,r.scope_id,r.content_digest`).WithArgs([]string{"version-2", "version-3"}).
		WillReturnRows(pgxmock.NewRows([]string{"id", "business_id", "scope_id", "content_digest", "status", "user_id", "name", "status", "comment", "decided_at"}).
			AddRow("old-request", "version-2", "other-space", "sha", "approved", "old-reviewer", "旧审批人", "approved", "", nil).
			AddRow("request-1", "version-2", DefaultSpaceID, "sha", "pending", "reviewer", "审核员", "approved", "同意", nil).
			AddRow("request-1", "version-2", DefaultSpaceID, "sha", "pending", "second", "另一审批人", "pending", "", nil))
	adminItems, err := store.ListAdmin(context.Background())
	if err != nil || len(adminItems) != 2 || adminItems[0].CurrentVersionID == nil {
		t.Fatalf("ListAdmin() = %#v, %v", adminItems, err)
	}
	if adminItems[0].CreatedAt.Location() != time.UTC || adminItems[0].UpdatedAt.Location() != time.UTC {
		t.Fatalf("admin timestamps are not UTC: created=%v updated=%v", adminItems[0].CreatedAt, adminItems[0].UpdatedAt)
	}
	if adminItems[0].LatestVersion == nil || adminItems[0].LatestVersion.VersionID != "version-2" || adminItems[0].LatestVersion.UploadedByUserID != "writer-id" {
		t.Fatalf("latest version summary = %#v", adminItems[0].LatestVersion)
	}
	if progress := adminItems[0].LatestVersion.LocalApproval; progress == nil || progress.Total != 2 || progress.Approved != 1 || progress.Approvers[0].UserID != "reviewer" || adminItems[1].LatestVersion.LocalApproval != nil {
		t.Fatalf("batched approval progress = %#v %#v", adminItems[0].LatestVersion.LocalApproval, adminItems[1].LatestVersion.LocalApproval)
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
		WillReturnRows(adminSkillRows().AddRow("skill-1", DefaultSpaceID, "默认技能空间", "code-review", "description", nil, "admin", now, now, "version-1", "1.0", "pending", "usr-1", "sha"))
	mock.ExpectQuery(`SELECT v.version_id,v.skill_id,v.version,v.description,v.changelog,v.package_path,v.package_sha256,v.created_at`).WithArgs("skill-1").
		WillReturnRows(versionSourceRows().
			AddRow("version-1", "skill-1", "1.0", "description", "changes", "version-1.zip", "sha", now, "source-1", "acme", "skills", "skills/code-review", strings.Repeat("1", 40), strings.Repeat("a", 64), "usr-1", "agent-1", "code-review", "pending", "", "", nil, "").
			AddRow("version-manual", "skill-1", "0.9", "manual", "", "version-manual.zip", "sha-manual", now.Add(-time.Hour), nil, nil, nil, nil, nil, nil, nil, nil, "code-review", "approved", DefaultSpaceID, "reviewer", now, "通过"))
	for _, id := range []string{"version-1", "version-manual"} {
		mock.ExpectQuery(`SELECT id,version_id,space_id`).WithArgs(id).WillReturnError(pgx.ErrNoRows)
		digest := "sha"
		if id == "version-manual" {
			digest = "sha-manual"
		}
		mock.ExpectQuery(`SELECT id,status FROM approval_requests`).WithArgs(id, DefaultSpaceID, digest).WillReturnError(pgx.ErrNoRows)
	}

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

func TestPostgresStoreListsOnlyOwnWritablePendingVersions(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 8, 24, 9, 0, 0, 0, time.UTC)
	mock.ExpectQuery(`FROM skill_versions v JOIN skills s`).WithArgs("writer-id").
		WillReturnRows(pgxmock.NewRows([]string{"skill_id", "space_id", "name", "version_id", "version", "created_at", "approval_provider", "id", "status", "decision", "provider_instance_id"}).AddRow("skill-1", DefaultSpaceID, "code-review", "version-1", "1.0", now, "local", nil, nil, nil, nil))
	items, err := store.ListOwnPendingVersions(context.Background(), "writer-id")
	if err != nil || len(items) != 1 || items[0].VersionID != "version-1" {
		t.Fatalf("own pending versions = %#v, %v", items, err)
	}
}

func TestPostgresStoreSetsAndClearsCurrentVersion(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT space_id FROM skills WHERE skill_id`).WithArgs("skill-1").WillReturnRows(pgxmock.NewRows([]string{"space_id"}).AddRow(DefaultSpaceID))
	mock.ExpectQuery(`SELECT approval_provider,external_approval_template_id FROM skill_spaces`).WithArgs(DefaultSpaceID).WillReturnRows(pgxmock.NewRows([]string{"provider", "template"}).AddRow("local", ""))
	mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills`).WithArgs("skill-1").
		WillReturnRows(skillRows().AddRow("skill-1", DefaultSpaceID, "code-review", nil, "admin", now, now))
	mock.ExpectQuery(`SELECT version_id,skill_id,version,description,changelog,package_path,package_sha256,created_at FROM skill_versions`).
		WithArgs("version-1").WillReturnRows(versionRows().AddRow("version-1", "skill-1", "1.0", "description", "changes", "version-1.zip", "sha", now))
	mock.ExpectQuery(`SELECT EXISTS\(SELECT 1 FROM approval_config_approvers`).WithArgs(DefaultSpaceID).WillReturnRows(pgxmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectQuery(`SELECT skill_name,approval_status`).WithArgs("version-1").WillReturnRows(pgxmock.NewRows([]string{"skill_name", "approval_status", "approved_space_id", "source_id"}).AddRow("code-review", "approved", DefaultSpaceID, nil))
	mock.ExpectQuery(`SELECT EXISTS\(SELECT 1 FROM approval_requests`).WithArgs("version-1", DefaultSpaceID, "sha").WillReturnRows(pgxmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectExec(`UPDATE skills SET current_version_id`).WithArgs("skill-1", "version-1", now).
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()
	skill, version, err := store.SetCurrentVersion(context.Background(), "skill-1", "version-1", now)
	if err != nil || skill.CurrentVersionID == nil || version.VersionID != "version-1" {
		t.Fatalf("SetCurrentVersion() = %#v %#v, %v", skill, version, err)
	}

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT space_id FROM skills WHERE skill_id`).WithArgs("skill-1").WillReturnRows(pgxmock.NewRows([]string{"space_id"}).AddRow(DefaultSpaceID))
	mock.ExpectQuery(`SELECT approval_provider FROM skill_spaces`).WithArgs(DefaultSpaceID).WillReturnRows(pgxmock.NewRows([]string{"provider"}).AddRow("local"))
	mock.ExpectQuery(`SELECT current_version_id,space_id FROM skills`).WithArgs("skill-1").WillReturnRows(pgxmock.NewRows([]string{"current_version_id", "space_id"}).AddRow("version-1", DefaultSpaceID))
	mock.ExpectQuery(`SELECT version_id,skill_id,version,description,changelog,package_path,package_sha256,created_at FROM skill_versions`).
		WithArgs("skill-1", "version-1").WillReturnRows(versionRows().AddRow("version-1", "skill-1", "1.0", "description", "changes", "version-1.zip", "sha", now))
	mock.ExpectExec(`UPDATE skills SET current_version_id=NULL`).WithArgs("skill-1", now).WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectQuery(`SELECT EXISTS\(SELECT 1 FROM approval_config_approvers`).WithArgs(DefaultSpaceID).WillReturnRows(pgxmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectQuery(`SELECT EXISTS\(\s*SELECT 1 FROM approval_requests r`).WithArgs("version-1", DefaultSpaceID, "sha").WillReturnRows(pgxmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectCommit()
	cleared, err := store.ClearCurrentVersion(context.Background(), "skill-1", now)
	if err != nil {
		t.Fatal(err)
	}
	if cleared == nil || cleared.VersionID != "version-1" || cleared.PackageSHA256 != "sha" {
		t.Fatalf("cleared version = %#v", cleared)
	}

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT space_id FROM skills WHERE skill_id`).WithArgs("skill-1").WillReturnRows(pgxmock.NewRows([]string{"space_id"}).AddRow(DefaultSpaceID))
	mock.ExpectQuery(`SELECT approval_provider FROM skill_spaces`).WithArgs(DefaultSpaceID).WillReturnRows(pgxmock.NewRows([]string{"provider"}).AddRow("local"))
	mock.ExpectQuery(`SELECT current_version_id,space_id FROM skills`).WithArgs("skill-1").WillReturnRows(pgxmock.NewRows([]string{"current_version_id", "space_id"}).AddRow(nil, DefaultSpaceID))
	mock.ExpectCommit()
	cleared, err = store.ClearCurrentVersion(context.Background(), "skill-1", now)
	if err != nil {
		t.Fatal(err)
	}
	if cleared != nil {
		t.Fatalf("idempotent clear version = %#v, want nil", cleared)
	}
}

func TestPostgresStoreClearCurrentResubmitsAfterApproverChange(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT space_id FROM skills WHERE skill_id`).WithArgs("skill-1").WillReturnRows(pgxmock.NewRows([]string{"space_id"}).AddRow(DefaultSpaceID))
	mock.ExpectQuery(`SELECT approval_provider FROM skill_spaces`).WithArgs(DefaultSpaceID).WillReturnRows(pgxmock.NewRows([]string{"provider"}).AddRow("local"))
	mock.ExpectQuery(`SELECT current_version_id,space_id FROM skills`).WithArgs("skill-1").WillReturnRows(pgxmock.NewRows([]string{"current_version_id", "space_id"}).AddRow("version-1", DefaultSpaceID))
	mock.ExpectQuery(`SELECT version_id,skill_id,version,description,changelog,package_path,package_sha256,created_at FROM skill_versions`).
		WithArgs("skill-1", "version-1").WillReturnRows(versionRows().AddRow("version-1", "skill-1", "1.0", "description", "changes", "version-1.zip", "sha", now))
	mock.ExpectExec(`UPDATE skills SET current_version_id=NULL`).WithArgs("skill-1", now).WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectQuery(`SELECT EXISTS\(SELECT 1 FROM approval_config_approvers`).WithArgs(DefaultSpaceID).WillReturnRows(pgxmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectQuery(`SELECT EXISTS\(\s*SELECT 1 FROM approval_requests r`).WithArgs("version-1", DefaultSpaceID, "sha").WillReturnRows(pgxmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectExec(`UPDATE approval_requests SET status='invalidated'`).WithArgs([]string{"version-1"}, now).WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectExec(`UPDATE skill_versions SET approval_status='pending'`).WithArgs("version-1").WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectExec(`INSERT INTO approval_requests`).WithArgs(pgxmock.AnyArg(), "version-1", DefaultSpaceID, "sha", now).WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectExec(`INSERT INTO approval_request_approvers`).WithArgs(pgxmock.AnyArg(), DefaultSpaceID).WillReturnResult(pgxmock.NewResult("INSERT", 1))
	mock.ExpectCommit()
	if _, err := store.ClearCurrentVersion(context.Background(), "skill-1", now); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresStorePublishesOwnVersionWithoutApprover(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)
	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT space_id FROM skills WHERE skill_id`).WithArgs("skill-1").WillReturnRows(pgxmock.NewRows([]string{"space_id"}).AddRow(DefaultSpaceID))
	mock.ExpectQuery(`SELECT approval_provider,external_approval_template_id FROM skill_spaces`).WithArgs(DefaultSpaceID).WillReturnRows(pgxmock.NewRows([]string{"provider", "template"}).AddRow("local", ""))
	mock.ExpectQuery(`SELECT skill_id,space_id,name,current_version_id,created_by,created_at,updated_at FROM skills`).WithArgs("skill-1").
		WillReturnRows(skillRows().AddRow("skill-1", DefaultSpaceID, "code-review", nil, "writer", now, now))
	mock.ExpectQuery(`SELECT version_id,skill_id,version,description,changelog,package_path,package_sha256,created_at FROM skill_versions`).
		WithArgs("version-1").WillReturnRows(versionRows().AddRow("version-1", "skill-1", "1.0", "description", "changes", "version-1.zip", "sha", now))
	mock.ExpectQuery(`SELECT EXISTS\(SELECT 1 FROM approval_config_approvers`).WithArgs(DefaultSpaceID).WillReturnRows(pgxmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectQuery(`SELECT skill_name,approval_status`).WithArgs("version-1").WillReturnRows(pgxmock.NewRows([]string{"skill_name", "approval_status", "approved_space_id", "source_id"}).AddRow("code-review", "pending", "", nil))
	mock.ExpectQuery(`SELECT COALESCE\(uploaded_by_user_id`).WithArgs("version-1").WillReturnRows(pgxmock.NewRows([]string{"uploader"}).AddRow("writer-id"))
	mock.ExpectExec(`UPDATE skill_versions SET approval_status='approved'`).WithArgs("version-1", DefaultSpaceID, "writer-id", now).WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectExec(`UPDATE skills SET current_version_id`).WithArgs("skill-1", "version-1", now).WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectCommit()
	skill, version, err := store.PublishOwnVersion(context.Background(), "skill-1", "version-1", "writer-id", now)
	if err != nil || skill.CurrentVersionID == nil || version.ApprovalStatus != "approved" {
		t.Fatalf("PublishOwnVersion() = %#v %#v, %v", skill, version, err)
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

func expectSpaceLock(mock pgxmock.PgxPoolIface, spaceID string) {
	mock.ExpectQuery(`SELECT space_id FROM skill_spaces WHERE space_id=\$1 FOR SHARE`).WithArgs(spaceID).WillReturnRows(pgxmock.NewRows([]string{"space_id"}).AddRow(spaceID))
}

func expectLocalInsert(mock pgxmock.PgxPoolIface, versionID, spaceID, digest string, now time.Time) {
	mock.ExpectExec(`INSERT INTO approval_requests`).WithArgs(pgxmock.AnyArg(), versionID, spaceID, digest, now).WillReturnResult(pgxmock.NewResult("INSERT", 0))
	mock.ExpectExec(`INSERT INTO approval_request_approvers`).WithArgs(pgxmock.AnyArg(), spaceID).WillReturnResult(pgxmock.NewResult("INSERT", 0))
}

func skillRows() *pgxmock.Rows {
	return pgxmock.NewRows([]string{"skill_id", "space_id", "name", "current_version_id", "created_by", "created_at", "updated_at"})
}

func adminSkillRows() *pgxmock.Rows {
	return pgxmock.NewRows([]string{"skill_id", "space_id", "space_name", "name", "description", "current_version_id", "created_by", "created_at", "updated_at", "latest_version_id", "latest_version", "latest_approval_status", "latest_uploaded_by_user_id", "latest_package_sha256"})
}

func versionRows() *pgxmock.Rows {
	return pgxmock.NewRows([]string{"version_id", "skill_id", "version", "description", "changelog", "package_path", "package_sha256", "created_at"})
}

func versionSourceRows() *pgxmock.Rows {
	return pgxmock.NewRows([]string{"version_id", "skill_id", "version", "description", "changelog", "package_path", "package_sha256", "created_at", "source_id", "repository_owner", "repository_name", "source_path", "source_commit_sha", "source_content_sha256", "uploaded_by_user_id", "uploaded_by_agent_id", "skill_name", "approval_status", "approved_space_id", "reviewed_by", "reviewed_at", "review_comment"})
}

func publishedRows() *pgxmock.Rows {
	return pgxmock.NewRows([]string{"skill_id", "space_id", "space_name", "name", "description", "version_id", "version", "package_sha256", "updated_at", "changelog", "package_path"})
}
