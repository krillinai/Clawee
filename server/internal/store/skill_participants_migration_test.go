package store

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/krillinai/Clawee/server/db/migrations"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func TestSkillParticipantsMigrationAndAggregationOnPostgres(t *testing.T) {
	ctx := context.Background()
	pool := openMCPGatewayPostgresTestPool(t)
	db := stdlib.OpenDB(*pool.Config().ConnConfig)
	defer db.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 51); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO accounts (user_id,email,name,password_hash,status,created_at,updated_at) VALUES
		('viewer','viewer@example.com','查看者','unused','active',now(),now()),
		('creator','creator@example.com','原创建者','unused','active',now(),now()),
		('updater-1','updater-1@example.com','原参与者一','unused','active',now(),now()),
		('updater-2','updater-2@example.com','历史参与者二','unused','active',now(),now());
		INSERT INTO skill_spaces (space_id,name,created_by,updated_by,created_at,updated_at) VALUES
		('product','产品空间','system','system',now(),now()),
		('market','市场空间','system','system',now(),now());
		INSERT INTO skills (skill_id,space_id,name,created_by,created_at,updated_at) VALUES
		('tracked','product','tracked','原创建者',now(),now()),
		('legacy','product','legacy','历史创建者',now(),now()),
		('hidden','market','hidden','原创建者',now(),now());
		INSERT INTO data_resource_grants (grant_id,user_id,resource_type,resource_id,action,created_by,created_at,updated_at)
		VALUES ('viewer-read','viewer','skill_space','product','read','system',now(),now());
	`); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC)
	for index, version := range []struct{ skillID, version, userID string }{
		{"tracked", "1", "creator"},
		{"tracked", "2", "updater-1"},
		{"tracked", "3", "updater-2"},
		{"tracked", "4", "updater-1"},
		{"tracked", "5", "creator"},
		{"legacy", "1", ""},
		{"legacy", "2", "updater-1"},
		{"hidden", "1", "creator"},
	} {
		var userID any
		if version.userID != "" {
			userID = version.userID
		}
		versionID := version.skillID + "-" + version.version
		if _, err := pool.Exec(ctx, `INSERT INTO skill_versions
			(version_id,skill_id,version,description,package_path,package_sha256,created_at,uploaded_by_user_id)
			VALUES ($1,$2,$3,'测试技能',$1,$4,$5,$6)`,
			versionID, version.skillID, version.version, strings.Repeat("a", 64), now.Add(time.Duration(index)*time.Minute), userID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE skills SET current_version_id=$2 WHERE skill_id=$1`, version.skillID, versionID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := provider.UpTo(ctx, 52); err != nil {
		t.Fatal(err)
	}
	var creatorID, legacyID sql.NullString
	if err := pool.QueryRow(ctx, `SELECT created_by_user_id FROM skills WHERE skill_id='tracked'`).Scan(&creatorID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT created_by_user_id FROM skills WHERE skill_id='legacy'`).Scan(&legacyID); err != nil {
		t.Fatal(err)
	}
	if creatorID.String != "creator" || !creatorID.Valid || legacyID.Valid {
		t.Fatalf("创建者回填错误：tracked=%#v, legacy=%#v", creatorID, legacyID)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE accounts SET name='当前创建者' WHERE user_id='creator';
		UPDATE accounts SET name='当前参与者一' WHERE user_id='updater-1';
		DELETE FROM accounts WHERE user_id='updater-2';
	`); err != nil {
		t.Fatal(err)
	}
	service := skillhub.NewService(skillhub.Config{Store: skillhub.NewPostgresStore(pool), PackageRoot: t.TempDir()})
	if _, err := provider.UpTo(ctx, 56); err != nil {
		t.Fatal(err)
	}
	for _, spaceID := range []string{"product", "market"} {
		if err := service.SetSpaceApprover(ctx, spaceID, "viewer", "system"); err != nil {
			t.Fatal(err)
		}
	}
	for _, version := range []struct{ skillID, versionID string }{{"tracked", "tracked-5"}, {"legacy", "legacy-2"}, {"hidden", "hidden-1"}} {
		if _, err := service.ReviewVersion(ctx, version.skillID, version.versionID, "viewer", true, "测试发布前审批"); err != nil {
			t.Fatal(err)
		}
		if _, err := service.SetCurrentVersion(ctx, version.skillID, version.versionID); err != nil {
			t.Fatal(err)
		}
	}
	detail, err := service.GetPublished(ctx, "tracked")
	if err != nil {
		t.Fatal(err)
	}
	if detail.Creator == nil || detail.Creator.UserID != "creator" || detail.Creator.Name != "当前创建者" || detail.Creator.AvatarURL == "" {
		t.Fatalf("创建者信息错误：%#v", detail.Creator)
	}
	if len(detail.Contributors) != 2 || detail.Contributors[0].UserID != "updater-1" || detail.Contributors[0].Name != "当前参与者一" ||
		detail.Contributors[1].UserID != "updater-2" || detail.Contributors[1].Name != "历史参与者二" {
		t.Fatalf("参与者去重、排序或姓名回退错误：%#v", detail.Contributors)
	}
	detail, err = service.GetPublished(ctx, "legacy")
	if err != nil || detail.Creator == nil || detail.Creator.UserID != "" || detail.Creator.Name != "历史创建者" ||
		len(detail.Contributors) != 1 || detail.Contributors[0].UserID != "updater-1" {
		t.Fatalf("历史创建者被后续更新者覆盖：%#v, %v", detail, err)
	}
	for _, test := range []struct {
		spaceID string
		count   int
	}{{"", 2}, {"product", 2}, {"market", 0}, {"missing", 0}} {
		items, err := service.ListPublishedForUser(ctx, "viewer", test.spaceID)
		if err != nil || len(items) != test.count {
			t.Fatalf("空间 %q 筛选错误：%#v, %v", test.spaceID, items, err)
		}
		for _, item := range items {
			if item.SpaceID != "product" || item.SpaceName != "产品空间" || item.Creator == nil {
				t.Fatalf("空间权限或元数据错误：%#v", item)
			}
		}
	}
	for version := 56; version >= 52; version-- {
		if _, err := provider.Down(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var remainingColumns int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
		WHERE table_schema=current_schema() AND
		((table_name='skills' AND column_name='created_by_user_id') OR
		 (table_name='skill_versions' AND column_name='uploaded_by_name'))`).Scan(&remainingColumns); err != nil || remainingColumns != 0 {
		t.Fatalf("迁移回滚未删除新增字段：%d, %v", remainingColumns, err)
	}
}
