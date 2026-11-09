package skillhub

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/pashagolub/pgxmock/v4"
)

func TestContributionReadsUseReadOnlyRepeatableRead(t *testing.T) {
	for _, target := range []string{"records", "detail"} {
		for _, failureAt := range []string{"", "begin", "coverage", "uploads", "approvals", "commit"} {
			if target == "detail" && failureAt == "uploads" {
				continue
			}
			t.Run(target+"/"+failureAt, func(t *testing.T) {
				mock := newPGXMock(t)
				store := NewPostgresStore(mock)
				failure := errors.New("contribution read failed")
				stamp := time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
				query := ContributionQuery{StartDate: "2026-10-01", EndDate: "2026-10-31"}
				start, end := contributionBounds(query)
				begin := mock.ExpectBeginTx(pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
				if failureAt == "begin" {
					begin.WillReturnError(failure)
				} else {
					coverage := mock.ExpectQuery(`SELECT started_at,`)
					if failureAt == "coverage" {
						coverage.WillReturnError(failure)
					} else {
						coverage.WillReturnRows(pgxmock.NewRows([]string{"started_at", "uploads_from"}).AddRow(stamp, nil))
						if target == "records" {
							uploads := mock.ExpectQuery(`SELECT f.fact_id,`).WithArgs(start, end, "")
							if failureAt == "uploads" {
								uploads.WillReturnError(failure)
							} else {
								uploads.WillReturnRows(pgxmock.NewRows([]string{"fact_id"})).RowsWillBeClosed()
							}
						}
						if failureAt != "uploads" {
							approvals := mock.ExpectQuery(`SELECT f.snapshot,`)
							if target == "detail" {
								approvals.WithArgs("skill")
							} else {
								approvals.WithArgs(start, end, "")
							}
							if failureAt == "approvals" {
								approvals.WillReturnError(failure)
							} else {
								approvals.WillReturnRows(pgxmock.NewRows([]string{"snapshot", "available"}).AddRow([]byte(`{"id":"skill","skill_id":"skill","version_id":"version"}`), true)).RowsWillBeClosed()
							}
						}
					}
					if failureAt == "" || failureAt == "commit" {
						commit := mock.ExpectCommit()
						if failureAt == "commit" {
							commit.WillReturnError(failure)
						}
					}
					mock.ExpectRollback()
				}
				var err error
				if target == "detail" {
					_, _, err = store.ContributionDetail(context.Background(), "skill", "")
				} else {
					_, _, _, err = store.ContributionData(context.Background(), query)
				}
				if failureAt != "" && !errors.Is(err, failure) || failureAt == "" && err != nil {
					t.Fatalf("read error=%v, failureAt=%q", err, failureAt)
				}
			})
		}
	}
}

func TestContributionDataKeepsSnapshotDuringApproval(t *testing.T) {
	service, _, pool := personalApprovalFixture(t, "postgres")
	ctx := context.Background()
	now := time.Now().UTC().Add(time.Minute)
	service.clock = func() time.Time { return now }
	query, err := NormalizeContributionQuery(ContributionQuery{}, false)
	if err != nil {
		t.Fatal(err)
	}
	wrote := false
	reader := NewPostgresStore(contributionSnapshotPool{postgresPool: pool, afterCoverage: func() {
		wrote = true
		result := personalUpload(t, service, "snapshot-contribution", "1")
		input := reviewInputForTest(ctx, service, result.Skill.SkillID, result.Version.VersionID)
		for _, user := range []string{"alice", "bob"} {
			if _, err := service.ReviewVersion(ctx, result.Skill.SkillID, result.Version.VersionID, user, true, "", input); err != nil {
				t.Fatal(err)
			}
		}
	}})
	uploads, approvals, coverage, err := reader.ContributionData(ctx, query)
	if err != nil || !wrote || len(uploads) != 0 || len(approvals) != 0 || coverage.UploadsFrom != nil {
		t.Fatalf("mixed snapshot: uploads=%#v approvals=%#v coverage=%#v err=%v", uploads, approvals, coverage, err)
	}
	uploads, approvals, coverage, err = service.store.(ContributionStore).ContributionData(ctx, query)
	if err != nil || len(uploads) != 1 || len(approvals) != 1 || coverage.UploadsFrom == nil {
		t.Fatalf("fresh snapshot: uploads=%#v approvals=%#v coverage=%#v err=%v", uploads, approvals, coverage, err)
	}
}

type contributionSnapshotPool struct {
	postgresPool
	afterCoverage func()
}

func (s contributionSnapshotPool) BeginTx(ctx context.Context, options pgx.TxOptions) (pgx.Tx, error) {
	tx, err := s.postgresPool.BeginTx(ctx, options)
	if err != nil {
		return nil, err
	}
	return contributionSnapshotTx{Tx: tx, afterCoverage: s.afterCoverage}, nil
}

type contributionSnapshotTx struct {
	pgx.Tx
	afterCoverage func()
}

func (tx contributionSnapshotTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	row := tx.Tx.QueryRow(ctx, sql, args...)
	if strings.HasPrefix(sql, "SELECT started_at,") {
		return contributionSnapshotRow{Row: row, afterScan: tx.afterCoverage}
	}
	return row
}

type contributionSnapshotRow struct {
	pgx.Row
	afterScan func()
}

func (row contributionSnapshotRow) Scan(dest ...any) error {
	if err := row.Row.Scan(dest...); err != nil {
		return err
	}
	row.afterScan()
	return nil
}
