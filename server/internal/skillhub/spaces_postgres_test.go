package skillhub

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	pgxmock "github.com/pashagolub/pgxmock/v4"
)

func TestPostgresStoreListsOnlyReadableSkillSpaces(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	now := time.Date(2026, 8, 7, 10, 0, 0, 0, time.UTC)
	mock.ExpectQuery(`SELECT sp.space_id,sp.name,sp.description,sp.updated_at`).WithArgs("user-1").
		WillReturnRows(pgxmock.NewRows([]string{"space_id", "name", "description", "updated_at", "read", "write"}).
			AddRow("skillspace-readable", "可读空间", "", now, true, true).
			AddRow("skillspace-write-only", "异常空间", "", now, false, true))

	spaces, err := store.ListAuthorizedSpaces(context.Background(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(spaces) != 1 || spaces[0].SpaceID != "skillspace-readable" || len(spaces[0].Actions) != 2 || spaces[0].Actions[0] != SpaceActionRead || spaces[0].Actions[1] != SpaceActionWrite {
		t.Fatalf("authorized spaces=%#v", spaces)
	}
}

func TestPostgresStoreHidesUnauthorizedSkillSpaceAndSkill(t *testing.T) {
	mock := newPGXMock(t)
	store := NewPostgresStore(mock)
	mock.ExpectQuery(`SELECT sp.space_id FROM skill_spaces`).WithArgs("user-1", SpaceActionWrite, "skillspace-1").WillReturnError(pgx.ErrNoRows)
	if err := store.CheckSpaceAccess(context.Background(), "user-1", "skillspace-1", SpaceActionWrite); !errors.Is(err, ErrSpaceNotFound) {
		t.Fatalf("CheckSpaceAccess() error=%v, want ErrSpaceNotFound", err)
	}
	mock.ExpectQuery(`SELECT sk.skill_id FROM skills`).WithArgs("user-1", SpaceActionRead, "skill-1").WillReturnError(pgx.ErrNoRows)
	if err := store.CheckSkillAccess(context.Background(), "user-1", "skill-1", SpaceActionRead); !errors.Is(err, ErrNotFound) {
		t.Fatalf("CheckSkillAccess() error=%v, want ErrNotFound", err)
	}
}
