package sharedfiles

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/krillinai/Clawee/server/internal/dataaccess"
)

func TestPersonalSpaceConcurrentCreationAndIsolation(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	store.SetAccount("employee", "员工", "employee@example.com", "active")
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(store, storage, nil)
	if page, err := service.ListSpaces(ctx, "employee", 10, ""); err != nil || len(page.Items) != 0 {
		t.Fatalf("list created space: %#v %v", page, err)
	}
	var wg sync.WaitGroup
	ids := make(chan string, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			space, err := service.EnsurePersonalSpace(ctx, "employee", "server")
			if err != nil {
				t.Error(err)
				return
			}
			ids <- space.SpaceID
		}()
	}
	wg.Wait()
	close(ids)
	id := ""
	for current := range ids {
		if id != "" && id != current {
			t.Fatal("重复个人空间")
		}
		id = current
	}
	space, err := service.GetSpaceSummary(ctx, id)
	if err != nil || space.Name != "个人网盘-员工" {
		t.Fatalf("personal space name=%q err=%v", space.Name, err)
	}
	store.SetAccount("employee_2", "员工", "employee2@example.com", "active")
	otherPersonal, err := service.EnsurePersonalSpace(ctx, "employee_2", "server")
	if err != nil || !strings.HasPrefix(otherPersonal.Name, "个人网盘-员工-") {
		t.Fatalf("duplicate personal space name=%q err=%v", otherPersonal.Name, err)
	}
	renamed, err := service.UpdateSpace(ctx, id, "个人网盘-员工-手动调整", "", "server")
	if err != nil || renamed.Name != "个人网盘-员工-手动调整" {
		t.Fatalf("rename personal space=%q err=%v", renamed.Name, err)
	}
	for _, mutation := range []func() error{
		func() error { _, err := service.AddMember(ctx, id, "other", "server"); return err },
		func() error {
			_, err := service.UpdateMember(ctx, id, "employee", []string{ActionRead}, "server")
			return err
		},
		func() error { return service.RemoveMember(ctx, id, "employee") },
	} {
		if err := mutation(); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("personal grant mutation: %v", err)
		}
	}
	payload := "report"
	digest := sha256Hex([]byte(payload))
	uploaded, err := service.UploadForUser(ctx, "server", "agent_server", "employee", "", "tasks/run_1/report.txt", "text/plain", int64(len(payload)), digest, nil, strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	if uploaded.SpaceID != id {
		t.Fatal("wrong personal space")
	}
	current, err := service.GetAdminFile(ctx, uploaded.FileID)
	if err != nil || current.CreatedByUserID != "server" || current.CreatedByAgentID != "agent_server" {
		t.Fatalf("actor lost: %#v %v", current, err)
	}
	if _, err := service.GetFile(ctx, "server", uploaded.FileID); !errors.Is(err, ErrSharedFileNotFound) {
		t.Fatalf("actor can read: %v", err)
	}
	repeated, err := service.UploadForUser(ctx, "server", "agent_server", "employee", "", "tasks/run_1/report.txt", "text/plain", int64(len(payload)), digest, nil, strings.NewReader(payload))
	if err != nil || repeated.FileID != uploaded.FileID || repeated.Created || repeated.Revision != 1 {
		t.Fatalf("repeat: %#v %v", repeated, err)
	}
	if _, err := service.UploadForUser(ctx, "server", "agent_server", "employee", "", "tasks/run_1/report.txt", "text/plain", 5, sha256Hex([]byte("other")), nil, strings.NewReader("other")); !errors.Is(err, ErrFileAlreadyExists) {
		t.Fatalf("overwrite: %v", err)
	}
	ordinary, err := service.CreateSpace(ctx, "ordinary", "", "server")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UploadForUser(ctx, "server", "agent_server", "employee", ordinary.SpaceID, "tasks/x/report.txt", "text/plain", int64(len(payload)), digest, nil, strings.NewReader(payload)); !errors.Is(err, ErrSharedSpaceNotFound) {
		t.Fatalf("arbitrary cross upload: %v", err)
	}
	if page, err := service.ListAdminSpacesForOwner(ctx, "", "employee", 10, ""); err != nil || len(page.Items) != 1 || page.Items[0].PersonalOwnerName != "员工" {
		t.Fatalf("owner filter: %#v %v", page, err)
	}
	store.SetAccount("employee", "员工", "employee@example.com", "disabled")
	if _, err := service.EnsurePersonalSpace(ctx, "employee", "server"); !errors.Is(err, ErrMemberNotFound) {
		t.Fatalf("disabled owner: %v", err)
	}
}

func TestPostgresPersonalSpaceAndGenericGrantBoundary(t *testing.T) {
	pool := openSharedFilesTestPool(t)
	ctx := context.Background()
	store := NewPostgresStore(pool)
	for _, user := range []string{"employee", "server", "other"} {
		if _, err := pool.Exec(ctx, `INSERT INTO accounts(user_id,email,name,status) VALUES($1,$1||'@test.local',$1,'active')`, user); err != nil {
			t.Fatal(err)
		}
	}
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(store, storage, nil)
	var wg sync.WaitGroup
	ids := make(chan string, 10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			space, err := service.EnsurePersonalSpace(ctx, "employee", "server")
			if err != nil {
				t.Error(err)
				return
			}
			ids <- space.SpaceID
		}()
	}
	wg.Wait()
	close(ids)
	id := ""
	for value := range ids {
		if id != "" && value != id {
			t.Fatal("并发创建重复空间")
		}
		id = value
	}
	if id == "" {
		t.Fatal("未创建空间")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM shared_spaces WHERE personal_owner_user_id='employee'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("count=%d %v", count, err)
	}
	result, err := service.UploadForUser(ctx, "server", "agent_server", "employee", id, "tasks/run/report.txt", "text/plain", 6, sha256Hex([]byte("report")), nil, strings.NewReader("report"))
	if err != nil {
		t.Fatal(err)
	}
	file, err := service.GetAdminFile(ctx, result.FileID)
	if err != nil || file.CreatedByUserID != "server" || file.CreatedByAgentID != "agent_server" {
		t.Fatalf("operator=%#v %v", file, err)
	}
	for _, user := range []string{"server", "other"} {
		if _, err := service.GetFile(ctx, user, result.FileID); !errors.Is(err, ErrSharedFileNotFound) {
			t.Fatalf("read as %s: %v", user, err)
		}
	}
	// 即使历史错误授权存在，个人空间也不会因此向其他员工开放。
	if _, err := pool.Exec(ctx, `INSERT INTO data_resource_grants(grant_id,user_id,resource_type,resource_id,action,created_by,created_at,updated_at) VALUES('bad-grant','other','shared_space',$1,'read','server',now(),now())`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetFile(ctx, "other", result.FileID); !errors.Is(err, ErrSharedFileNotFound) {
		t.Fatalf("stale grant bypass: %v", err)
	}
	if page, err := service.ListSpaces(ctx, "other", 10, ""); err != nil || len(page.Items) != 0 {
		t.Fatalf("stale space list: %#v %v", page, err)
	}
	grants := dataaccess.NewPostgresStore(pool)
	audit := dataaccess.Audit{ResourceType: dataaccess.ResourceSharedSpace, ResourceID: id, TargetUserID: "employee"}
	for _, mutate := range []func() error{
		func() error { return grants.CreateGrants(ctx, nil, audit) },
		func() error {
			return grants.ReplaceGrants(ctx, "employee", dataaccess.ResourceSharedSpace, id, nil, audit)
		},
		func() error { return grants.DeleteGrants(ctx, "employee", dataaccess.ResourceSharedSpace, id, audit) },
	} {
		if err := mutate(); !errors.Is(err, dataaccess.ErrInvalidRequest) {
			t.Fatalf("generic grant mutation=%v", err)
		}
	}
	// 新建普通空间不会挤走较早创建的个人空间，跨页仍可读取普通空间。
	if _, err := service.CreateSpace(ctx, "later shared", "", "employee"); err != nil {
		t.Fatal(err)
	}
	page, err := service.ListSpaces(ctx, "employee", 1, "")
	if err != nil || !page.HasNext || len(page.Items) != 1 || page.Items[0].SpaceID != id {
		t.Fatalf("personal priority=%#v %v", page, err)
	}
	next, err := service.ListSpaces(ctx, "employee", 1, page.NextCursor)
	if err != nil || len(next.Items) != 1 || next.Items[0].PersonalOwnerUserID != "" {
		t.Fatalf("next page=%#v %v", next, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE user_id='employee'`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.UploadForUser(ctx, "server", "agent_server", "employee", id, "tasks/run/disabled.txt", "text/plain", 6, sha256Hex([]byte("report")), nil, strings.NewReader("report")); !errors.Is(err, ErrSharedSpaceNotFound) {
		t.Fatalf("disabled explicit upload=%v", err)
	}
}
