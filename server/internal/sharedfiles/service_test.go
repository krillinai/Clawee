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
	space, err := service.CreateSpace(ctx, "后台管理空间", "", "admin")
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
