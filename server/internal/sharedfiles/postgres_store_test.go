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

type blockingStorage struct {
	Storage
	stored  chan struct{}
	release chan struct{}
}

func (s *blockingStorage) Put(ctx context.Context, key string, src io.Reader, maxBytes int64) (int64, string, error) {
	size, digest, err := s.Storage.Put(ctx, key, src, maxBytes)
	close(s.stored)
	<-s.release
	return size, digest, err
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
