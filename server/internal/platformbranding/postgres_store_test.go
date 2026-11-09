package platformbranding

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/krillinai/Clawee/server/db/migrations"
)

func TestPostgresMenuLabelsPersistenceAndMigration(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("CLAW_GATEWAY_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("未设置 CLAW_GATEWAY_TEST_DATABASE_URL，跳过 PostgreSQL 集成测试")
	}
	parsed, err := url.Parse(dsn)
	if err != nil || !strings.HasSuffix(strings.TrimPrefix(parsed.Path, "/"), "_test") {
		t.Fatal("必须使用名称以 _test 结尾的隔离测试数据库")
	}
	ctx := context.Background()
	base, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(base.Close)
	schema := fmt.Sprintf("branding_test_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := base.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := base.Exec(ctx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	legacyLogo := encodePNG(t, 12, 8)
	for _, name := range []string{"00048_platform_branding.sql", "00053_sidebar_menu_labels.sql", "00055_sidebar_menu_label_length.sql", "00063_platform_branding_admin_url.sql", "00068_platform_branding_accent_color.sql", "00076_platform_branding_dark_logos.sql"} {
		if name == "00076_platform_branding_dark_logos.sql" {
			if _, err := pool.Exec(ctx, `INSERT INTO platform_branding
(id, sidebar_logo, sidebar_logo_content_type, updated_by, created_at, updated_at)
VALUES ('default', $1, 'image/png', 'legacy-admin', NOW(), NOW())`, legacyLogo); err != nil {
				t.Fatal(err)
			}
		}
		raw, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		up := strings.SplitN(string(raw), "-- +goose Down", 2)[0]
		if _, err := pool.Exec(ctx, up); err != nil {
			t.Fatal(err)
		}
	}
	service := NewService(NewPostgresStore(pool))
	legacy, err := service.Get(ctx)
	if err != nil || legacy.SidebarLogo == nil || !bytes.Equal(legacy.SidebarLogo.Content, legacyLogo) || legacy.SidebarLogoDark != nil || legacy.SidebarCompactLogoDark != nil {
		t.Fatalf("migration changed legacy logo: %#v, %v", legacy, err)
	}
	label := "𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷"
	drive := "网盘"
	input := UpdateInput{
		SidebarLogoAction: ActionKeep, SidebarCompactLogoAction: ActionKeep, UpdatedBy: "test-admin",
		SidebarMenuLabels: map[string]*string{"skills": &label, "drive": &drive},
	}
	if _, err := service.Update(ctx, input); err != nil {
		t.Fatal(err)
	}
	// 新建服务实例，确认名称来自数据库而非进程内状态。
	service = NewService(NewPostgresStore(pool))
	current, err := service.Get(ctx)
	if err != nil || current.SidebarMenuLabels.Skills != label || current.SidebarMenuLabels.Drive != drive {
		t.Fatalf("read configuration=%#v error=%v", current, err)
	}
	input.SidebarMenuLabels = nil
	adminURL := "https://gateway.example/admin"
	accentColor := "#f2e9ea"
	input.AdminURL = &adminURL
	input.AccentColor = &accentColor
	current, err = service.Update(ctx, input)
	if err != nil || current.SidebarMenuLabels.Skills != label || current.AdminURL != adminURL {
		t.Fatalf("legacy update configuration=%#v error=%v", current, err)
	}
	input.SidebarMenuLabels = map[string]*string{"skills": nil}
	input.AdminURL = nil
	input.AccentColor = nil
	current, err = service.Update(ctx, input)
	if err != nil || current.SidebarMenuLabels.Skills != "" || current.SidebarMenuLabels.Drive != drive || current.AdminURL != adminURL {
		t.Fatalf("reset configuration=%#v error=%v", current, err)
	}
	var resetIsNull bool
	service = NewService(NewPostgresStore(pool))
	current, err = service.Get(ctx)
	if err != nil || current.AccentColor != accentColor {
		t.Fatalf("品牌高亮色未持久化: %#v, %v", current, err)
	}
	if err := pool.QueryRow(ctx, `SELECT sidebar_skills_label IS NULL FROM platform_branding`).Scan(&resetIsNull); err != nil || !resetIsNull {
		t.Fatalf("reset is null=%v error=%v", resetIsNull, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE platform_branding SET sidebar_drive_label='一二三四五六七八九十一'`); err == nil {
		t.Fatal("数据库未拒绝超长名称")
	}
	raw, _ := migrations.FS.ReadFile("00055_sidebar_menu_label_length.sql")
	if _, err := pool.Exec(ctx, strings.SplitN(string(raw), "-- +goose Down", 2)[1]); err != nil {
		t.Fatalf("回滚迁移失败: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE platform_branding SET sidebar_drive_label='一二三四五'`); err == nil {
		t.Fatal("回滚后数据库未恢复 4 字上限")
	}
	dark := encodeJPEG(t, 8, 12)
	input.SidebarMenuLabels = nil
	input.SidebarLogoDarkAction, input.SidebarLogoDark = ActionReplace, dark
	input.SidebarCompactLogoDarkAction, input.SidebarCompactLogoDark = ActionReplace, dark
	if _, err := service.Update(ctx, input); err != nil {
		t.Fatal(err)
	}
	service = NewService(NewPostgresStore(pool))
	current, err = service.Get(ctx)
	if err != nil || current.SidebarLogoDark == nil || current.SidebarCompactLogoDark == nil ||
		!bytes.Equal(current.SidebarLogoDark.Content, dark) || current.SidebarLogoDark.ContentType != "image/jpeg" ||
		!bytes.Equal(current.SidebarCompactLogoDark.Content, dark) {
		t.Fatalf("dark logos not persisted: %#v, %v", current, err)
	}
	input.SidebarLogoDarkAction, input.SidebarLogoDark = "", nil
	input.SidebarCompactLogoDarkAction, input.SidebarCompactLogoDark = "", nil
	current, err = service.Update(ctx, input)
	if err != nil || current.SidebarLogoDark == nil || current.SidebarCompactLogoDark == nil {
		t.Fatalf("legacy update changed dark logos: %#v, %v", current, err)
	}
	input.SidebarLogoDarkAction = ActionReset
	current, err = service.Update(ctx, input)
	if err != nil || current.SidebarLogoDark != nil || current.SidebarCompactLogoDark == nil || current.SidebarLogo == nil {
		t.Fatalf("dark reset changed other logos: %#v, %v", current, err)
	}
	raw, _ = migrations.FS.ReadFile("00076_platform_branding_dark_logos.sql")
	if _, err := pool.Exec(ctx, strings.SplitN(string(raw), "-- +goose Down", 2)[1]); err != nil {
		t.Fatalf("dark logo migration rollback: %v", err)
	}
	var preservedLogo []byte
	if err := pool.QueryRow(ctx, `SELECT sidebar_logo FROM platform_branding`).Scan(&preservedLogo); err != nil || !bytes.Equal(preservedLogo, legacyLogo) {
		t.Fatalf("rollback changed legacy logo: %v", err)
	}
}
