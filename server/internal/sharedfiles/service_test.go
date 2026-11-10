package sharedfiles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestUploadCreateReplaceConflictAndMemberIsolation(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	store.SetAccount("user_a", "员工 A", "a@example.com", "active")
	store.SetAccount("user_b", "员工 B", "b@example.com", "active")
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(store, storage, nil)
	space, err := service.CreateSpace(ctx, "项目空间", "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.AddMember(ctx, space.SpaceID, "user_a", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AddMember(ctx, space.SpaceID, "user_b", "admin"); err != nil {
		t.Fatal(err)
	}

	created, err := uploadText(ctx, service, "user_a", "agent_a", space.SpaceID, "docs/design.md", "first", nil)
	if err != nil || !created.Created || created.Revision != 1 {
		t.Fatalf("create = %#v, %v", created, err)
	}
	files, err := service.ListFiles(ctx, "user_b", space.SpaceID, "design", "docs/", 50, "")
	if err != nil || len(files.Items) != 1 || files.Items[0].FileID != created.FileID {
		t.Fatalf("ListFiles() = %#v, %v", files, err)
	}
	file, reader, err := service.OpenFile(ctx, "user_b", created.FileID)
	if err != nil {
		t.Fatal(err)
	}
	contents, _ := io.ReadAll(reader)
	_ = reader.Close()
	if string(contents) != "first" || file.Revision != 1 {
		t.Fatalf("download = %q revision %d", contents, file.Revision)
	}

	revision := int64(1)
	updated, err := uploadText(ctx, service, "user_b", "agent_b", space.SpaceID, "docs/design.md", "second", &revision)
	if err != nil || updated.Created || updated.Revision != 2 {
		t.Fatalf("replace = %#v, %v", updated, err)
	}
	if _, err := uploadText(ctx, service, "user_a", "agent_a", space.SpaceID, "docs/design.md", "stale", &revision); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale replace error = %v", err)
	}
	_, reader, err = service.OpenFile(ctx, "user_a", created.FileID)
	if err != nil {
		t.Fatal(err)
	}
	contents, _ = io.ReadAll(reader)
	_ = reader.Close()
	if string(contents) != "second" {
		t.Fatalf("conflict changed current content to %q", contents)
	}

	if err := service.RemoveMember(ctx, space.SpaceID, "user_b"); err != nil {
		t.Fatal(err)
	}
	if page, err := service.ListFiles(ctx, "user_b", "", "", "", 50, ""); err != nil || len(page.Items) != 0 {
		t.Fatalf("removed member list = %#v, %v", page, err)
	}
	if _, err := service.GetFile(ctx, "user_b", created.FileID); !errors.Is(err, ErrSharedFileNotFound) {
		t.Fatalf("removed member detail error = %v", err)
	}
	if _, err := service.ListFiles(ctx, "user_b", space.SpaceID, "", "", 50, ""); !errors.Is(err, ErrSharedSpaceNotFound) {
		t.Fatalf("removed member scoped list error = %v", err)
	}
}

func TestCreateSpaceGrantsCreatorReadWriteDelete(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	store.SetAccount("creator", "创建者", "creator@example.com", "active")
	store.SetAccount("other", "其他人", "other@example.com", "active")
	service := NewService(store, nil, nil)
	space, err := service.CreateSpace(ctx, "团队空间", "", "creator")
	if err != nil || space.MemberCount != 1 {
		t.Fatalf("CreateSpace() = %#v, %v", space, err)
	}
	for _, action := range []string{ActionRead, ActionWrite, ActionDelete} {
		if err := store.CheckSpaceAccess(ctx, "creator", space.SpaceID, action); err != nil {
			t.Fatalf("creator %s access: %v", action, err)
		}
		if action != ActionDelete {
			if err := store.CheckSpaceAccess(ctx, "other", space.SpaceID, action); !errors.Is(err, ErrSharedSpaceNotFound) {
				t.Fatalf("other %s access: %v", action, err)
			}
		}
	}
	if permissions := store.grants[space.SpaceID]["creator"]; !permissions.Read || !permissions.Write || !permissions.Delete {
		t.Fatalf("creator grant = %#v", permissions)
	}
	page, err := service.ListSpaces(ctx, "creator", 50, "")
	if err != nil || len(page.Items) != 1 || page.Items[0].Permissions == nil || !page.Items[0].Permissions.Write || !page.Items[0].Permissions.Delete {
		t.Fatalf("creator spaces = %#v, %v", page.Items, err)
	}
	members, err := service.ListMembers(ctx, space.SpaceID, "", 50, "")
	if err != nil || len(members.Items) != 1 || members.Items[0].UserID != "creator" || members.Items[0].GrantStatus != "complete" || len(members.Items[0].Actions) != 3 {
		t.Fatalf("members = %#v, %v", members, err)
	}
	if _, err := service.CreateSpace(ctx, "团队空间", "", "other"); !errors.Is(err, ErrSpaceNameConflict) {
		t.Fatalf("duplicate CreateSpace() error = %v", err)
	}
}

func TestUploadValidationDoesNotPublishInvalidContent(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	store.SetAccount("user_a", "A", "a@example.com", "active")
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(store, storage, nil)
	space, _ := service.CreateSpace(ctx, "空间", "", "admin")
	_, _ = service.AddMember(ctx, space.SpaceID, "user_a", "admin")
	digest := textDigest("content")
	if _, err := service.Upload(ctx, "user_a", "agent_a", space.SpaceID, "../bad", "text/plain", 7, digest, nil, strings.NewReader("content")); !errors.Is(err, ErrInvalidLogicalPath) {
		t.Fatalf("path error = %v", err)
	}
	if _, err := service.Upload(ctx, "user_a", "agent_a", space.SpaceID, "ok.txt", "text/plain", 8, digest, nil, strings.NewReader("content")); !errors.Is(err, ErrContentLengthMismatch) {
		t.Fatalf("length error = %v", err)
	}
	if _, err := service.Upload(ctx, "user_a", "agent_a", space.SpaceID, "ok.txt", "text/plain", 7, strings.Repeat("0", 64), nil, strings.NewReader("content")); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("digest error = %v", err)
	}
	page, err := service.ListFiles(ctx, "user_a", space.SpaceID, "", "", 50, "")
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("invalid uploads published files: %#v, %v", page, err)
	}
	if _, err := service.ListFiles(ctx, "user_a", "", "", "", 50, "not-base64"); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("cursor error = %v", err)
	}
}

func TestAdminFileManagementDoesNotRequireSpaceMembership(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(store, storage, nil)
	space, err := service.CreateSpace(ctx, "后台管理空间", "", "owner")
	if err != nil {
		t.Fatal(err)
	}

	created, err := service.UploadAdmin(ctx, "admin", space.SpaceID, "docs/admin.txt", "text/plain", 5, nil, strings.NewReader("first"))
	if err != nil || !created.Created || created.Revision != 1 {
		t.Fatalf("admin create = %#v, %v", created, err)
	}
	page, err := service.ListAdminFiles(ctx, space.SpaceID, "admin", "docs/", 50, "")
	if err != nil || len(page.Items) != 1 || page.Items[0].FileID != created.FileID {
		t.Fatalf("admin list = %#v, %v", page, err)
	}
	file, reader, err := service.OpenAdminFile(ctx, created.FileID)
	if err != nil {
		t.Fatal(err)
	}
	contents, _ := io.ReadAll(reader)
	_ = reader.Close()
	if string(contents) != "first" || file.CreatedByUserID != "admin" || file.CreatedByAgentID != "" {
		t.Fatalf("admin file = %#v contents=%q", file, contents)
	}

	revision := created.Revision
	updated, err := service.UploadAdmin(ctx, "admin", space.SpaceID, "docs/admin.txt", "text/plain", 6, &revision, strings.NewReader("second"))
	if err != nil || updated.Created || updated.Revision != 2 {
		t.Fatalf("admin replace = %#v, %v", updated, err)
	}
	if _, err := service.UploadAdmin(ctx, "admin", space.SpaceID, "docs/admin.txt", "text/plain", 5, &revision, strings.NewReader("stale")); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("admin stale replace error = %v", err)
	}
	if page, err := service.ListFiles(ctx, "admin", "", "", "", 50, ""); err != nil || len(page.Items) != 0 {
		t.Fatalf("admin unexpectedly received member access: %#v, %v", page, err)
	}
}

func TestAdminUploadRejectsUnknownSpaceBeforeReadingContent(t *testing.T) {
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(NewMemoryStore(), storage, nil)
	reader := &countingReader{Reader: strings.NewReader("content")}
	_, err = service.UploadAdmin(context.Background(), "admin", "space_missing", "ok.txt", "text/plain", 7, nil, reader)
	if !errors.Is(err, ErrSharedSpaceNotFound) {
		t.Fatalf("admin upload error = %v", err)
	}
	if reader.reads != 0 {
		t.Fatalf("unknown-space upload read body %d times", reader.reads)
	}
}

func TestUnauthorizedCreateDoesNotReadContent(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(store, storage, nil)
	space, err := service.CreateSpace(ctx, "空间", "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	reader := &countingReader{Reader: strings.NewReader("content")}
	_, err = service.Upload(ctx, "user_a", "agent_a", space.SpaceID, "ok.txt", "text/plain", 7, textDigest("content"), nil, reader)
	if !errors.Is(err, ErrSharedSpaceNotFound) {
		t.Fatalf("unauthorized upload error = %v", err)
	}
	if reader.reads != 0 {
		t.Fatalf("unauthorized upload read body %d times", reader.reads)
	}
}

func TestMemberQueriesRejectUnknownSpace(t *testing.T) {
	service := NewService(NewMemoryStore(), nil, nil)
	if _, err := service.ListMembers(context.Background(), "space_missing", "", 50, ""); !errors.Is(err, ErrSharedSpaceNotFound) {
		t.Fatalf("ListMembers() error = %v", err)
	}
	if _, err := service.ListMemberCandidates(context.Background(), "space_missing", "", 50, ""); !errors.Is(err, ErrSharedSpaceNotFound) {
		t.Fatalf("ListMemberCandidates() error = %v", err)
	}
}

func TestMemberActionsAndCandidateEmail(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	store.SetAccount("user_full", "完整邮箱用户", "full.address@example.com", "active")
	service := NewService(store, nil, nil)
	space, err := service.CreateSpace(ctx, "授权空间", "", "admin")
	if err != nil {
		t.Fatal(err)
	}

	candidates, err := service.ListMemberCandidates(ctx, space.SpaceID, "full.address", 50, "")
	if err != nil || len(candidates.Items) != 1 || candidates.Items[0].Email != "full.address@example.com" {
		t.Fatalf("candidates = %#v, %v", candidates.Items, err)
	}
	for _, actions := range [][]string{{ActionWrite}, {ActionRead, "unknown"}} {
		if _, err := service.AddMemberWithActions(ctx, space.SpaceID, "user_full", actions, "admin"); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("AddMemberWithActions(%v) error = %v", actions, err)
		}
	}

	member, err := service.AddMemberWithActions(ctx, space.SpaceID, "user_full", []string{ActionRead}, "admin")
	if err != nil || len(member.Actions) != 1 || member.Actions[0] != ActionRead {
		t.Fatalf("read-only member = %#v, %v", member, err)
	}
	member, err = service.UpdateMember(ctx, space.SpaceID, "user_full", []string{ActionWrite, ActionRead}, "admin")
	if err != nil || len(member.Actions) != 2 || member.Actions[0] != ActionRead || member.Actions[1] != ActionWrite {
		t.Fatalf("read-write member = %#v, %v", member, err)
	}
	if _, err := service.UpdateMember(ctx, space.SpaceID, "user_full", []string{ActionWrite}, "admin"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("UpdateMember without read error = %v", err)
	}
}

func TestConcurrentReplaceAllowsOnlyOneRevision(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	store.SetAccount("user_a", "A", "a@example.com", "active")
	storage, _ := NewFileSystemStorage(t.TempDir())
	service := NewService(store, storage, nil)
	space, _ := service.CreateSpace(ctx, "空间", "", "admin")
	_, _ = service.AddMember(ctx, space.SpaceID, "user_a", "admin")
	created, err := uploadText(ctx, service, "user_a", "agent_a", space.SpaceID, "same.txt", "initial", nil)
	if err != nil {
		t.Fatal(err)
	}
	revision := created.Revision
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, content := range []string{"left", "right"} {
		wg.Add(1)
		go func(value string) {
			defer wg.Done()
			_, err := uploadText(ctx, service, "user_a", "agent_a", space.SpaceID, "same.txt", value, &revision)
			results <- err
		}(content)
	}
	wg.Wait()
	close(results)
	success, conflicts := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrRevisionConflict) {
			conflicts++
		} else {
			t.Fatalf("replace error = %v", err)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatalf("success=%d conflicts=%d", success, conflicts)
	}
	file, err := service.GetFile(ctx, "user_a", created.FileID)
	if err != nil || file.Revision != 2 {
		t.Fatalf("current = %#v, %v", file, err)
	}
}

func TestMemberDeleteActionIsIndependentFromWrite(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	store.SetAccount("member", "成员", "member@example.com", "active")
	service := NewService(store, nil, nil)
	space, err := service.CreateSpace(ctx, "独立删除授权空间", "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.AddMemberWithActions(ctx, space.SpaceID, "member", []string{ActionDelete}, "admin"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("delete without read error = %v", err)
	}
	member, err := service.AddMemberWithActions(ctx, space.SpaceID, "member", []string{ActionRead, ActionDelete}, "admin")
	if err != nil || len(member.Actions) != 2 || member.Actions[0] != ActionRead || member.Actions[1] != ActionDelete || member.GrantStatus != "incomplete" {
		t.Fatalf("read+delete member = %#v, %v", member, err)
	}
	member, err = service.UpdateMember(ctx, space.SpaceID, "member", []string{ActionDelete, ActionRead, ActionWrite}, "admin")
	if err != nil || len(member.Actions) != 3 || member.Actions[0] != ActionRead || member.Actions[1] != ActionWrite || member.Actions[2] != ActionDelete || member.GrantStatus != "complete" {
		t.Fatalf("read+write+delete member = %#v, %v", member, err)
	}
}

func TestDeleteFileAuthorizationAndPersonalSpace(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	for userID := range map[string]bool{"creator": true, "member_rw": true, "member_rwd": true, "member_read": true, "other": true} {
		store.SetAccount(userID, userID, userID+"@example.com", "active")
	}
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(store, storage, nil)
	space, err := service.CreateSpace(ctx, "删除权限空间", "", "creator")
	if err != nil {
		t.Fatal(err)
	}
	for userID, actions := range map[string][]string{
		"member_rw":  {ActionRead, ActionWrite},
		"member_rwd": {ActionRead, ActionWrite, ActionDelete},
		"member_read": {ActionRead},
	} {
		if _, err := service.AddMemberWithActions(ctx, space.SpaceID, userID, actions, "creator"); err != nil {
			t.Fatalf("add %s: %v", userID, err)
		}
	}
	created, err := uploadText(ctx, service, "creator", "agent", space.SpaceID, "docs/remove.txt", "first", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.DeleteFile(ctx, "member_rw", created.FileID, created.Revision); !errors.Is(err, ErrSharedFileNotFound) {
		t.Fatalf("write member delete error = %v", err)
	}
	if _, err := service.DeleteFile(ctx, "member_read", created.FileID, created.Revision); !errors.Is(err, ErrSharedFileNotFound) {
		t.Fatalf("read member delete error = %v", err)
	}
	if _, err := service.DeleteFile(ctx, "other", created.FileID, created.Revision); !errors.Is(err, ErrSharedFileNotFound) {
		t.Fatalf("non-member delete error = %v", err)
	}
	if _, err := service.DeleteFile(ctx, "member_rwd", created.FileID, created.Revision); err != nil {
		t.Fatalf("authorized member delete error = %v", err)
	}
	if _, err := service.GetFile(ctx, "creator", created.FileID); !errors.Is(err, ErrSharedFileNotFound) {
		t.Fatalf("deleted file still readable: %v", err)
	}

	second, err := uploadText(ctx, service, "creator", "agent", space.SpaceID, "docs/second.txt", "second", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.DeleteFile(ctx, "creator", second.FileID, second.Revision+1); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale revision delete error = %v", err)
	}
	if _, err := service.DeleteFile(ctx, "creator", second.FileID, second.Revision); err != nil {
		t.Fatalf("creator delete error = %v", err)
	}
	adminFile, err := uploadText(ctx, service, "creator", "agent", space.SpaceID, "docs/admin.txt", "admin", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.DeleteAdminFile(ctx, "admin", adminFile.FileID, adminFile.Revision); err != nil {
		t.Fatalf("admin delete error = %v", err)
	}
	if got, err := service.GetAdminFile(ctx, adminFile.FileID); !errors.Is(err, ErrSharedFileNotFound) {
		t.Fatalf("admin-deleted file detail = %#v, %v", got, err)
	}
	if _, err := service.DeleteAdminFile(ctx, "admin", "file_missing", 1); !errors.Is(err, ErrSharedFileNotFound) {
		t.Fatalf("admin delete missing error = %v", err)
	}

	for userID, want := range map[string]bool{"creator": true, "member_rwd": true, "member_rw": false, "member_read": false} {
		page, err := service.ListSpaces(ctx, userID, 50, "")
		if err != nil {
			t.Fatalf("%s list spaces: %v", userID, err)
		}
		if len(page.Items) != 1 || page.Items[0].Permissions == nil || page.Items[0].Permissions.Delete != want {
			t.Fatalf("%s space delete permission = %#v, want %v", userID, page.Items, want)
		}
	}

	personal, err := service.EnsurePersonalSpace(ctx, "member_rwd", "member_rwd")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CheckSpaceAccess(ctx, "member_rwd", personal.SpaceID, ActionDelete); err != nil {
		t.Fatalf("personal owner delete access = %v", err)
	}
	personalFile, err := uploadText(ctx, service, "member_rwd", "agent", "", "personal.txt", "mine", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.DeleteFile(ctx, "member_rwd", personalFile.FileID, personalFile.Revision); err != nil {
		t.Fatalf("personal owner delete error = %v", err)
	}
	if _, err := service.GetFile(ctx, "member_rw", personalFile.FileID); !errors.Is(err, ErrSharedFileNotFound) {
		t.Fatalf("other user read personal file error = %v", err)
	}
}

func TestDeleteFileEnqueuesCleanupTaskWhenStorageDeleteFails(t *testing.T) {
	ctx := context.Background()
	store := &cleanupRecordingStore{MemoryStore: NewMemoryStore()}
	store.SetAccount("creator", "创建者", "creator@example.com", "active")
	storage, err := NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(store, deleteFailingStorage{Storage: storage}, nil)
	space, err := service.CreateSpace(ctx, "清理任务空间", "", "creator")
	if err != nil {
		t.Fatal(err)
	}
	created, err := uploadText(ctx, service, "creator", "agent", space.SpaceID, "cleanup.txt", "payload", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.DeleteFile(ctx, "creator", created.FileID, created.Revision); err != nil {
		t.Fatalf("delete error = %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.tasks) != 1 {
		t.Fatalf("cleanup tasks = %#v", store.tasks)
	}
	if task := store.tasks[0]; task.Source != "file_delete" || task.FileID != created.FileID || task.StorageProfileID != LocalDefaultProfileID || !strings.Contains(task.StorageKey, created.FileID) {
		t.Fatalf("cleanup task = %#v", task)
	}
}

type cleanupRecordingStore struct {
	*MemoryStore
	mu    sync.Mutex
	tasks []CleanupTask
}

func (s *cleanupRecordingStore) EnqueueCleanup(_ context.Context, ref ObjectRef, source, fileID, migrationID string, _ time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tasks = append(s.tasks, CleanupTask{StorageProfileID: ref.StorageProfileID, StorageKey: ref.StorageKey, Source: source, FileID: fileID, MigrationID: migrationID})
	return nil
}

type deleteFailingStorage struct{ Storage }

func (deleteFailingStorage) Delete(context.Context, string) error { return errors.New("storage delete failed") }

func uploadText(ctx context.Context, service *Service, userID, agentID, spaceID, logicalPath, contents string, revision *int64) (UploadResult, error) {
	return service.Upload(ctx, userID, agentID, spaceID, logicalPath, "text/plain", int64(len(contents)), textDigest(contents), revision, strings.NewReader(contents))
}

func textDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

type countingReader struct {
	io.Reader
	reads int
}

func (r *countingReader) Read(buffer []byte) (int, error) {
	r.reads++
	return r.Reader.Read(buffer)
}
