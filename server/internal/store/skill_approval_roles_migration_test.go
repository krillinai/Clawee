package store

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/krillinai/Clawee/server/db/migrations"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

func skillRoleTestDatabase(t *testing.T, version int64) (*pgxpool.Pool, *goose.Provider) {
	t.Helper()
	pool := openMCPGatewayPostgresTestPool(t)
	db := stdlib.OpenDB(*pool.Config().ConnConfig)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = provider.UpTo(context.Background(), version); err != nil {
		t.Fatal(err)
	}
	return pool, provider
}

func execSkillRoleSQL(t *testing.T, pool *pgxpool.Pool, query string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), query, args...); err != nil {
		t.Fatal(err)
	}
}

func seedSkillRoleAccounts(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	execSkillRoleSQL(t, pool, `INSERT INTO accounts(user_id,email,name,password_hash,status,created_at,updated_at) VALUES
('writer','writer@example.com','提交人','unused','active',now(),now()),
('alice','alice@example.com','审核人甲','unused','active',now(),now()),
('bob','bob@example.com','审核人乙','unused','active',now(),now()),
('carol','carol@example.com','审核人丙','unused','active',now(),now()),
('disabled','disabled@example.com','停用账户','unused','disabled',now(),now());
INSERT INTO rbac_roles(role_id,code,name,is_system,created_at,updated_at) VALUES
('review-one','review_one','审核一',false,now(),now()),
('review-two','review_two','审核二',false,now(),now()),
('empty','empty','空角色',false,now(),now()),
('vacant','vacant','无成员角色',false,now(),now()),
('access','access','空间读写',false,now(),now()),
('read-only','read_only','空间只读',false,now(),now());
INSERT INTO account_roles(user_id,role_id,created_at) VALUES
('alice','review-one',now()),('bob','review-one',now()),('bob','review-two',now()),
('disabled','empty',now()),('writer','access',now()),('alice','read-only',now()),
('bob','read-only',now()),('carol','read-only',now());`)
}

func grantSkillRole(t *testing.T, pool *pgxpool.Pool, roleID, spaceID, action string) {
	t.Helper()
	execSkillRoleSQL(t, pool, `INSERT INTO data_resource_role_grants(grant_id,role_id,resource_type,resource_id,action,created_by,created_at,updated_at)
VALUES($1,$2,'skill_space',$3,$4,'writer',now(),now())`, roleID+"-"+spaceID+"-"+action, roleID, spaceID, action)
}

func skillRolePackage(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	entry, err := archive.Create("SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.WriteString(entry, "---\nname: role-skill\ndescription: 角色权限测试技能\n---\n# 角色权限测试\n"); err != nil {
		t.Fatal(err)
	}
	if err = archive.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestSkillApprovalRolesMigrationSnapshotsAndRollbackOnPostgres(t *testing.T) {
	ctx := context.Background()
	pool, provider := skillRoleTestDatabase(t, 64)
	seedSkillRoleAccounts(t, pool)
	execSkillRoleSQL(t, pool, `INSERT INTO skills(skill_id,space_id,name,created_by,created_at,updated_at)
VALUES('legacy','skillspace_default','legacy','writer',now(),now());
INSERT INTO skill_versions(version_id,skill_id,version,description,package_path,package_sha256,created_at)
VALUES('legacy-v','legacy','1','旧版本','legacy.zip',repeat('a',64),now());
INSERT INTO approval_config_approvers(scope_type,scope_id,user_id) VALUES('skill_space','skillspace_default','alice');
INSERT INTO approval_requests(id,business_type,business_id,action,scope_type,scope_id,content_digest,status,created_at)
VALUES('legacy-request','skill_version','legacy-v','publish','skill_space','skillspace_default',repeat('a',64),'approved',now());
INSERT INTO approval_request_approvers(request_id,user_id,status) VALUES('legacy-request','alice','approved');`)
	if _, err := provider.UpTo(ctx, 66); err != nil {
		t.Fatal(err)
	}
	var users, roles []string
	if err := pool.QueryRow(ctx, `SELECT approver_user_ids,approver_role_ids FROM approval_requests WHERE id='legacy-request'`).Scan(&users, &roles); err != nil || !reflect.DeepEqual(users, []string{"alice"}) || len(roles) != 0 {
		t.Fatalf("旧请求主体回填: %v %v %v", users, roles, err)
	}
	if _, err := provider.DownTo(ctx, 65); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM approval_requests WHERE id='legacy-request'`).Scan(&status); err != nil || status != "approved" {
		t.Fatalf("回滚破坏历史审批: %s %v", status, err)
	}
	if _, err := provider.UpTo(ctx, 66); err != nil {
		t.Fatal(err)
	}
	execSkillRoleSQL(t, pool, `INSERT INTO approval_config_roles(scope_type,scope_id,role_id) VALUES('skill_space','skillspace_default','review-one')`)
	if _, err := pool.Exec(ctx, `DELETE FROM rbac_roles WHERE role_id='review-one'`); err == nil {
		t.Fatal("已用于审核配置的角色被删除")
	}
}

func TestSkillApprovalRolesLifecycleOnPostgres(t *testing.T) {
	ctx := context.Background()
	pool, _ := skillRoleTestDatabase(t, 66)
	seedSkillRoleAccounts(t, pool)
	service := skillhub.NewService(skillhub.Config{Store: skillhub.NewPostgresStore(pool), PackageRoot: t.TempDir()})
	space, err := service.CreateSpace(ctx, "角色审核", "", "writer")
	if err != nil {
		t.Fatal(err)
	}
	grantSkillRole(t, pool, "read-only", space.SpaceID, "read")
	if _, err = service.SetSpaceApprovalSubjects(ctx, space.SpaceID, "local", "", []string{"alice"}, []string{"review-one", "review-two"}, true, "writer"); err != nil {
		t.Fatal(err)
	}
	upload := func(number string) skillhub.MutationResult {
		t.Helper()
		result, err := service.UploadVersionForUser(ctx, "writer", "", skillhub.UploadVersionInput{SpaceID: space.SpaceID, Version: number, CreatedBy: "writer", Origin: "app_upload", Package: bytes.NewReader(skillRolePackage(t))})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := upload("1")
	configured, err := service.GetSpace(ctx, space.SpaceID)
	if err != nil || len(configured.Approvers) != 1 || len(configured.ApproverRoles) != 2 || len(configured.ApproverRoleIDs) != 2 {
		t.Fatalf("配置主体回显: %#v %v", configured, err)
	}
	var requestID string
	if err = pool.QueryRow(ctx, `SELECT id FROM approval_requests WHERE business_id=$1 AND status='pending'`, first.Version.VersionID).Scan(&requestID); err != nil {
		t.Fatal(err)
	}
	execSkillRoleSQL(t, pool, `DELETE FROM account_roles WHERE user_id='bob' AND role_id IN ('review-one','review-two');
INSERT INTO account_roles(user_id,role_id,created_at) VALUES('carol','review-one',now()),('carol','review-two',now());`)
	if _, err = service.SetSpaceApprovalSubjects(ctx, space.SpaceID, "local", "", []string{"alice"}, []string{"review-two", "review-one"}, false, "writer"); err != nil {
		t.Fatal(err)
	}
	assertProgress := func(versionID string, wantUsers []string, status string) {
		t.Helper()
		detail, err := service.GetApprovalDetailForUser(ctx, "alice", first.Skill.SkillID)
		if err != nil {
			t.Fatal(err)
		}
		for _, version := range detail.Versions {
			if version.VersionID != versionID {
				continue
			}
			if version.LocalApproval == nil {
				t.Fatalf("没有逐人审批进度: %#v", version)
			}
			people := []string{}
			for _, person := range version.LocalApproval.Approvers {
				people = append(people, person.UserID)
			}
			sort.Strings(people)
			if !reflect.DeepEqual(people, wantUsers) || version.LocalApproval.Status != status || version.LocalApproval.Total != len(wantUsers) {
				t.Fatalf("审批快照: %#v，期望 %v %s", version.LocalApproval, wantUsers, status)
			}
			return
		}
		t.Fatal("版本不存在")
	}
	assertProgress(first.Version.VersionID, []string{"alice", "bob"}, "pending")
	if _, err = service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "carol", true, ""); err == nil {
		t.Fatal("新成员可审批旧请求")
	}
	if _, err = service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "alice", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); !errors.Is(err, skillhub.ErrApprovalRequired) {
		t.Fatalf("部分通过允许发布: %v", err)
	}
	execSkillRoleSQL(t, pool, `UPDATE accounts SET status='disabled' WHERE user_id='bob'`)
	if _, err = service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "bob", true, ""); !errors.Is(err, skillhub.ErrReviewForbidden) {
		t.Fatalf("停用账户可以审批: %v", err)
	}
	execSkillRoleSQL(t, pool, `UPDATE accounts SET status='active' WHERE user_id='bob'; DELETE FROM account_roles WHERE user_id='bob' AND role_id='read-only'`)
	if _, err = service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "bob", true, ""); !errors.Is(err, skillhub.ErrReviewForbidden) {
		t.Fatalf("失去当前数据权限仍可审批: %v", err)
	}
	execSkillRoleSQL(t, pool, `INSERT INTO account_roles(user_id,role_id,created_at) VALUES('bob','read-only',now())`)
	if _, err = service.ReviewVersion(ctx, first.Skill.SkillID, first.Version.VersionID, "bob", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.ClearCurrentVersion(ctx, first.Skill.SkillID); err != nil {
		t.Fatal(err)
	}
	assertProgress(first.Version.VersionID, []string{"alice", "bob"}, "approved")
	var currentID string
	if err = pool.QueryRow(ctx, `SELECT id FROM approval_requests WHERE business_id=$1 AND status='approved'`, first.Version.VersionID).Scan(&currentID); err != nil || currentID != requestID {
		t.Fatalf("reset 重建了历史快照: %s %v", currentID, err)
	}
	if _, err = service.SetCurrentVersion(ctx, first.Skill.SkillID, first.Version.VersionID); err != nil {
		t.Fatal(err)
	}
	second := upload("2")
	assertProgress(second.Version.VersionID, []string{"alice", "carol"}, "pending")
	for _, id := range []string{"alice", "carol"} {
		if _, err = service.ReviewVersion(ctx, second.Skill.SkillID, second.Version.VersionID, id, true, ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = service.SetCurrentVersion(ctx, second.Skill.SkillID, second.Version.VersionID); err != nil {
		t.Fatal(err)
	}
	assertProgress(first.Version.VersionID, []string{"alice", "bob"}, "approved")
	if _, err = service.ClearCurrentVersion(ctx, second.Skill.SkillID); err != nil {
		t.Fatal(err)
	}
	count, err := service.SetSpaceApprovalSubjects(ctx, space.SpaceID, "local", "", nil, []string{"review-one"}, false, "writer")
	if err != nil || count != 2 {
		t.Fatalf("配置改变未要求确认: %d %v", count, err)
	}
	assertProgress(first.Version.VersionID, []string{"alice", "bob"}, "approved")
	if _, err = service.SetSpaceApprovalSubjects(ctx, space.SpaceID, "local", "", nil, []string{"review-one"}, true, "writer"); err != nil {
		t.Fatal(err)
	}
	assertProgress(second.Version.VersionID, []string{"alice", "carol"}, "pending")
	configured, err = service.GetSpace(ctx, space.SpaceID)
	if err != nil || len(configured.Approvers) != 0 || !reflect.DeepEqual(configured.ApproverRoleIDs, []string{"review-one"}) {
		t.Fatalf("纯角色配置错误: %#v %v", configured, err)
	}
	var wait sync.WaitGroup
	for _, id := range []string{"alice", "carol"} {
		wait.Add(1)
		go func(userID string) {
			defer wait.Done()
			if _, err := service.ReviewVersion(ctx, second.Skill.SkillID, second.Version.VersionID, userID, true, ""); err != nil {
				t.Error(err)
			}
		}(id)
	}
	wait.Wait()
	assertProgress(second.Version.VersionID, []string{"alice", "carol"}, "approved")
	third := upload("3")
	if _, err := service.PublishOwnVersionForUser(ctx, third.Skill.SkillID, third.Version.VersionID, "writer"); !errors.Is(err, skillhub.ErrApprovalRequired) {
		t.Fatalf("纯角色配置允许绕过审批自行发布: %v", err)
	}
	if pending, err := service.ListOwnPendingVersions(ctx, "writer"); err != nil || len(pending) != 0 {
		t.Fatalf("纯角色审核误入免审核发布列表: %#v %v", pending, err)
	}
	if _, err = service.ReviewVersion(ctx, third.Skill.SkillID, third.Version.VersionID, "carol", false, "驳回"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.ReviewVersion(ctx, third.Skill.SkillID, third.Version.VersionID, "alice", true, ""); !errors.Is(err, skillhub.ErrConflict) {
		t.Fatalf("驳回后仍能批准: %v", err)
	}
	assertProgress(third.Version.VersionID, []string{"alice", "carol"}, "rejected")
}

func TestSkillEmptyRoleBlocksSubmissionOnPostgres(t *testing.T) {
	ctx := context.Background()
	pool, _ := skillRoleTestDatabase(t, 66)
	seedSkillRoleAccounts(t, pool)
	store := skillhub.NewPostgresStore(pool)
	service := skillhub.NewService(skillhub.Config{Store: store, PackageRoot: t.TempDir()})
	if _, err := service.SetSpaceApprovalSubjects(ctx, skillhub.DefaultSpaceID, "local", "", nil, []string{"missing"}, true, "writer"); !errors.Is(err, skillhub.ErrInvalidRequest) {
		t.Fatalf("未知角色: %v", err)
	}
	now := time.Now().UTC()
	for _, roleID := range []string{"vacant", "empty"} {
		if _, err := service.SetSpaceApprovalSubjects(ctx, skillhub.DefaultSpaceID, "local", "", nil, []string{roleID}, true, "writer"); err != nil {
			t.Fatal(err)
		}
		_, _, err := store.CreateVersion(ctx, skillhub.Skill{SkillID: "empty-skill", SpaceID: skillhub.DefaultSpaceID, Name: "empty-skill", CreatedBy: "writer", CreatedAt: now, UpdatedAt: now}, skillhub.Version{VersionID: "empty-version", Version: "1", PackagePath: "empty.zip", PackageSHA256: strings.Repeat("a", 64), UploadedByUserID: "writer", CreatedAt: now}, skillhub.CreateVersionOptions{Resolution: skillhub.VersionResolutionCreateOnly, Origin: "admin_upload"})
		if !errors.Is(err, skillhub.ErrMemberNotFound) {
			t.Fatalf("空角色 %s 被当作免审批: %v", roleID, err)
		}
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM skills)+(SELECT count(*) FROM skill_versions)+(SELECT count(*) FROM approval_requests)`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("失败提交未回滚: %d %v", count, err)
	}
	if _, err := service.SetSpaceApprovalSubjects(ctx, skillhub.DefaultSpaceID, "dingtalk", "template", nil, []string{"empty"}, true, "writer"); !errors.Is(err, skillhub.ErrInvalidRequest) {
		t.Fatalf("外部审批接受角色: %v", err)
	}
}

func TestSkillEffectiveRolePermissionsReadWriteUploadDownloadOnPostgres(t *testing.T) {
	ctx := context.Background()
	pool, _ := skillRoleTestDatabase(t, 66)
	seedSkillRoleAccounts(t, pool)
	store := skillhub.NewPostgresStore(pool)
	service := skillhub.NewService(skillhub.Config{Store: store, PackageRoot: t.TempDir()})
	space, err := service.CreateSpace(ctx, "纯角色访问", "", "writer")
	if err != nil {
		t.Fatal(err)
	}
	if err = service.RemoveSpaceMember(ctx, space.SpaceID, "writer"); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"read", "write"} {
		grantSkillRole(t, pool, "access", space.SpaceID, action)
	}
	grantSkillRole(t, pool, "read-only", space.SpaceID, "read")
	grantSkillRole(t, pool, "review-one", space.SpaceID, "read")
	direct, err := service.ListSpaceMembers(ctx, space.SpaceID)
	if err != nil || len(direct) != 0 {
		t.Fatalf("继承权限写入直接授权配置: %#v %v", direct, err)
	}
	spaces, err := service.ListAuthorizedSpaces(ctx, "alice")
	if err != nil || len(spaces) != 1 || !reflect.DeepEqual(spaces[0].Actions, []string{"read"}) {
		t.Fatalf("重叠角色空间或动作未去重: %#v %v", spaces, err)
	}
	if err := store.CheckSpaceAccess(ctx, "writer", space.SpaceID, "write"); err != nil {
		t.Fatal(err)
	}
	packageBytes := skillRolePackage(t)
	uploadInput := func(number string) skillhub.UploadVersionInput {
		return skillhub.UploadVersionInput{SpaceID: space.SpaceID, Version: number, CreatedBy: "writer", Origin: "app_upload", Package: bytes.NewReader(packageBytes)}
	}
	if _, err := service.UploadVersionForUser(ctx, "alice", "", uploadInput("1")); !errors.Is(err, skillhub.ErrSpaceNotFound) {
		t.Fatalf("只读角色允许上传: %v", err)
	}
	first, err := service.UploadVersionForUser(ctx, "writer", "", uploadInput("1"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CheckSkillAccess(ctx, "writer", first.Skill.SkillID, "write"); err != nil {
		t.Fatal(err)
	}
	pending, err := service.ListOwnPendingVersions(ctx, "writer")
	if err != nil || len(pending) != 1 {
		t.Fatalf("角色写权限自己的待发布版本: %#v %v", pending, err)
	}
	if _, err := service.PublishOwnVersionForUser(ctx, first.Skill.SkillID, first.Version.VersionID, "writer"); err != nil {
		t.Fatal(err)
	}
	assertReadAndDownload := func(userID string) {
		t.Helper()
		if err := service.CheckSpaceRead(ctx, userID, space.SpaceID); err != nil {
			t.Fatal(err)
		}
		if _, err := service.GetPublishedForUser(ctx, userID, first.Skill.SkillID); err != nil {
			t.Fatal(err)
		}
		published, err := service.ListPublishedForUser(ctx, userID, space.SpaceID)
		if err != nil || len(published) != 1 {
			t.Fatalf("纯角色权限技能列表: %#v %v", published, err)
		}
		if _, err := service.GetApprovalDetailForUser(ctx, userID, first.Skill.SkillID); err != nil {
			t.Fatal(err)
		}
		if _, err := service.ListApprovalVersionFilesForUser(ctx, userID, first.Skill.SkillID, first.Version.VersionID); err != nil {
			t.Fatal(err)
		}
		if _, err := service.ReadApprovalVersionFileForUser(ctx, userID, first.Skill.SkillID, first.Version.VersionID, "SKILL.md"); err != nil {
			t.Fatal(err)
		}
		for _, approvalPackage := range []bool{false, true} {
			var download skillhub.PackageDownload
			if approvalPackage {
				download, err = service.OpenApprovalVersionPackageForUser(ctx, userID, first.Skill.SkillID, first.Version.VersionID)
			} else {
				download, err = service.OpenCurrentPackageForUser(ctx, userID, first.Skill.SkillID, first.Version.VersionID)
			}
			if err != nil {
				t.Fatal(err)
			}
			content, readErr := io.ReadAll(download.Reader)
			_ = download.Reader.Close()
			if readErr != nil || fmt.Sprintf("%x", sha256.Sum256(content)) != first.Version.PackageSHA256 {
				t.Fatalf("纯角色授权下载: %v", readErr)
			}
		}
	}
	assertDenied := func(userID string) {
		t.Helper()
		if err := service.CheckSpaceRead(ctx, userID, space.SpaceID); !errors.Is(err, skillhub.ErrSpaceNotFound) {
			t.Fatalf("撤销后空间仍可访问: %v", err)
		}
		if _, err := service.GetPublishedForUser(ctx, userID, first.Skill.SkillID); !errors.Is(err, skillhub.ErrNotFound) {
			t.Fatalf("撤销后技能仍可读取: %v", err)
		}
		if _, err := service.GetApprovalDetailForUser(ctx, userID, first.Skill.SkillID); !errors.Is(err, skillhub.ErrNotFound) {
			t.Fatalf("撤销后审核详情仍可读取: %v", err)
		}
		if _, err := service.OpenCurrentPackageForUser(ctx, userID, first.Skill.SkillID, first.Version.VersionID); !errors.Is(err, skillhub.ErrNotFound) {
			t.Fatalf("撤销后仍可下载: %v", err)
		}
		if _, err := service.OpenApprovalVersionPackageForUser(ctx, userID, first.Skill.SkillID, first.Version.VersionID); !errors.Is(err, skillhub.ErrNotFound) {
			t.Fatalf("撤销后仍可下载审核包: %v", err)
		}
		published, err := service.ListPublishedForUser(ctx, userID, space.SpaceID)
		if err != nil || len(published) != 0 {
			t.Fatalf("撤销后列表仍有技能: %#v %v", published, err)
		}
	}
	assertReadAndDownload("alice")
	execSkillRoleSQL(t, pool, `DELETE FROM data_resource_role_grants WHERE role_id='read-only' AND resource_id=$1`, space.SpaceID)
	assertReadAndDownload("alice")
	if _, err := service.SetSpaceMember(ctx, space.SpaceID, "alice", []string{"read"}, "writer", false); err != nil {
		t.Fatal(err)
	}
	execSkillRoleSQL(t, pool, `DELETE FROM account_roles WHERE user_id='alice' AND role_id='review-one'`)
	assertReadAndDownload("alice")
	if err := service.RemoveSpaceMember(ctx, space.SpaceID, "alice"); err != nil {
		t.Fatal(err)
	}
	assertDenied("alice")
	assertReadAndDownload("writer")
	execSkillRoleSQL(t, pool, `DELETE FROM data_resource_role_grants WHERE role_id='access' AND action='write' AND resource_id=$1`, space.SpaceID)
	if _, err := service.UploadVersionForUser(ctx, "writer", "", uploadInput("2")); !errors.Is(err, skillhub.ErrSpaceNotFound) {
		t.Fatalf("撤销角色写权限仍可上传: %v", err)
	}
	if _, err := service.PublishOwnVersionForUser(ctx, first.Skill.SkillID, first.Version.VersionID, "writer"); !errors.Is(err, skillhub.ErrNotFound) {
		t.Fatalf("撤销角色写权限仍可写技能: %v", err)
	}
	assertReadAndDownload("writer")
	grantSkillRole(t, pool, "access", space.SpaceID, "write")
	execSkillRoleSQL(t, pool, `DELETE FROM account_roles WHERE user_id='writer' AND role_id='access'`)
	assertDenied("writer")
	if _, err := service.UploadVersionForUser(ctx, "writer", "", uploadInput("2")); !errors.Is(err, skillhub.ErrSpaceNotFound) {
		t.Fatalf("移除角色绑定仍可上传: %v", err)
	}
}
