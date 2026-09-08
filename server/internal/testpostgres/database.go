// Package testpostgres creates isolated schemas for PostgreSQL integration tests.
package testpostgres

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/krillinai/Clawee/server/db/migrations"
)

func New(t *testing.T) string {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("CLAW_MCP_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("CLAW_MCP_TEST_DATABASE_URL 未设置")
	}
	u, err := url.Parse(dsn)
	if err != nil || !strings.HasSuffix(u.Path, "_test") {
		t.Fatal("测试数据库名称必须以 _test 结尾")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("clawee_test_%d", time.Now().UnixNano())}.Sanitize()
	if _, err := admin.Exec("CREATE SCHEMA " + schema); err != nil {
		_ = admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, err := admin.Exec("DROP SCHEMA " + schema + " CASCADE")
		if err != nil {
			t.Error(err)
		}
		_ = admin.Close()
	})
	query := u.Query()
	query.Set("search_path", strings.Trim(schema, "\""))
	u.RawQuery = query.Encode()
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Up(context.Background()); err != nil {
		t.Fatal(err)
	}
	return u.String()
}
