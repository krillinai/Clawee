package sharedfiles

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"sync"
	"testing"
	"time"
)

func TestServiceRoutesEachFileToItsStorageProfile(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	store.SetAccount("user_a", "User A", "a@example.com", "active")
	space, err := store.CreateSpace(ctx, Space{SpaceID: "space_a", Name: "A", CreatedBy: "admin", UpdatedBy: "admin", CreatedAt: time.Now(), UpdatedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddMember(ctx, space.SpaceID, "user_a", []string{ActionRead, ActionWrite}, "admin"); err != nil {
		t.Fatal(err)
	}
	local := newMemoryStorage()
	remote := newMemoryStorage()
	registry := &switchingStorageRegistry{
		active: LocalDefaultProfileID,
		targets: map[string]Storage{
			LocalDefaultProfileID: local,
			"storage_profile_oss": remote,
		},
	}
	service := NewServiceWithRegistry(store, registry, nil)
	content := []byte("local version")
	digest := sha256Hex(content)
	created, err := service.Upload(ctx, "user_a", "agent_a", space.SpaceID, "docs/a.txt", "text/plain",
		int64(len(content)), digest, nil, bytes.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	file, reader, err := service.OpenFile(ctx, "user_a", created.FileID)
	if err != nil {
		t.Fatal(err)
	}
	opened, _ := io.ReadAll(reader)
	_ = reader.Close()
	if string(opened) != string(content) || file.StorageProfileID != LocalDefaultProfileID {
		t.Fatalf("local open = %q profile=%q", opened, file.StorageProfileID)
	}

	registry.active = "storage_profile_oss"
	replacement := []byte("oss version")
	revision := created.Revision
	updated, err := service.Upload(ctx, "user_a", "agent_a", space.SpaceID, "docs/a.txt", "text/plain",
		int64(len(replacement)), sha256Hex(replacement), &revision, bytes.NewReader(replacement))
	if err != nil {
		t.Fatal(err)
	}
	file, reader, err = service.OpenFile(ctx, "user_a", updated.FileID)
	if err != nil {
		t.Fatal(err)
	}
	opened, _ = io.ReadAll(reader)
	_ = reader.Close()
	if string(opened) != string(replacement) || file.StorageProfileID != "storage_profile_oss" {
		t.Fatalf("remote open = %q profile=%q", opened, file.StorageProfileID)
	}
	if local.objectCount() != 0 || remote.objectCount() != 1 {
		t.Fatalf("object counts local=%d remote=%d", local.objectCount(), remote.objectCount())
	}
}

func TestServicePersistsFailedReplacementCleanup(t *testing.T) {
	ctx := context.Background()
	store := &cleanupMemoryStore{MemoryStore: NewMemoryStore()}
	store.SetAccount("user_a", "User A", "a@example.com", "active")
	space, _ := store.CreateSpace(ctx, Space{SpaceID: "space_a", Name: "A", CreatedAt: time.Now(), UpdatedAt: time.Now()})
	_, _ = store.AddMember(ctx, space.SpaceID, "user_a", []string{ActionRead, ActionWrite}, "admin")
	local := newMemoryStorage()
	registry := &switchingStorageRegistry{active: LocalDefaultProfileID, targets: map[string]Storage{LocalDefaultProfileID: local}}
	service := NewServiceWithRegistry(store, registry, nil)
	first := []byte("first")
	created, err := service.Upload(ctx, "user_a", "agent_a", space.SpaceID, "a.txt", "text/plain",
		int64(len(first)), sha256Hex(first), nil, bytes.NewReader(first))
	if err != nil {
		t.Fatal(err)
	}
	local.failDelete = true
	revision := created.Revision
	second := []byte("second")
	if _, err := service.Upload(ctx, "user_a", "agent_a", space.SpaceID, "a.txt", "text/plain",
		int64(len(second)), sha256Hex(second), &revision, bytes.NewReader(second)); err != nil {
		t.Fatal(err)
	}
	if len(store.tasks) != 1 || store.tasks[0].Source != "replace_old_object" {
		t.Fatalf("cleanup tasks = %#v", store.tasks)
	}
}

type switchingStorageRegistry struct {
	active  string
	targets map[string]Storage
}

func (r *switchingStorageRegistry) Active(context.Context) (StorageTarget, error) {
	return r.Resolve(context.Background(), r.active)
}

func (r *switchingStorageRegistry) Resolve(_ context.Context, profileID string) (StorageTarget, error) {
	storage := r.targets[profileID]
	if storage == nil {
		return StorageTarget{}, ErrStorageUnavailable
	}
	return StorageTarget{ProfileID: profileID, Storage: storage}, nil
}

type memoryStorage struct {
	mu         sync.Mutex
	objects    map[string][]byte
	failDelete bool
}

func newMemoryStorage() *memoryStorage { return &memoryStorage{objects: map[string][]byte{}} }

func (s *memoryStorage) Put(ctx context.Context, key string, src io.Reader, opts PutOptions) (ObjectMetadata, error) {
	body, err := io.ReadAll(&contextReader{ctx: ctx, reader: src})
	if err != nil {
		return ObjectMetadata{}, err
	}
	if int64(len(body)) != opts.DeclaredSize {
		return ObjectMetadata{}, ErrContentLengthMismatch
	}
	s.mu.Lock()
	s.objects[key] = body
	s.mu.Unlock()
	return ObjectMetadata{SizeBytes: int64(len(body)), SHA256: sha256Hex(body)}, nil
}

func (s *memoryStorage) Open(_ context.Context, key string) (io.ReadCloser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	body, ok := s.objects[key]
	if !ok {
		return nil, ErrStorageUnavailable
	}
	return io.NopCloser(bytes.NewReader(body)), nil
}

func (s *memoryStorage) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failDelete {
		return ErrStorageUnavailable
	}
	delete(s.objects, key)
	return nil
}

func (s *memoryStorage) Probe(context.Context) error { return nil }

func (s *memoryStorage) objectCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.objects)
}

type cleanupMemoryStore struct {
	*MemoryStore
	tasks []CleanupTask
}

func (s *cleanupMemoryStore) EnqueueCleanup(_ context.Context, ref ObjectRef, source, fileID, migrationID string, _ time.Time) error {
	s.tasks = append(s.tasks, CleanupTask{StorageProfileID: ref.StorageProfileID, StorageKey: ref.StorageKey,
		Source: source, FileID: fileID, MigrationID: migrationID})
	return nil
}

func sha256Hex(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
