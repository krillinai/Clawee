package settings

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

var ErrVersionConflict = errors.New("settings version conflict")

type Record struct {
	Namespace string
	Key       string
	Value     json.RawMessage
	Version   int64
	UpdatedBy string
	CreatedAt time.Time
	UpdatedAt time.Time
}

type Store interface {
	Get(context.Context, string, string) (Record, error)
	Put(context.Context, string, string, json.RawMessage, string, int64, time.Time) (Record, error)
}

type SettingsStore = Store

type MemoryStore struct {
	mu    sync.RWMutex
	items map[string]Record
}

func NewMemoryStore() *MemoryStore { return &MemoryStore{items: make(map[string]Record)} }

func (s *MemoryStore) Get(ctx context.Context, namespace, key string) (Record, error) {
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.items[namespace+"/"+key]
	if !ok {
		return Record{}, nil
	}
	record.Value = append(json.RawMessage(nil), record.Value...)
	return record, nil
}

func (s *MemoryStore) Put(ctx context.Context, namespace, key string, value json.RawMessage, updatedBy string, expectedVersion int64, now time.Time) (Record, error) {
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id := namespace + "/" + key
	current, exists := s.items[id]
	if !exists && expectedVersion > 0 {
		return Record{}, ErrVersionConflict
	}
	if exists && expectedVersion > 0 && current.Version != expectedVersion {
		return Record{}, ErrVersionConflict
	}
	if !exists {
		current = Record{Namespace: namespace, Key: key, Version: 0, CreatedAt: now}
	}
	current.Version++
	current.Value = append(json.RawMessage(nil), value...)
	current.UpdatedBy, current.UpdatedAt = updatedBy, now
	s.items[id] = current
	return current, nil
}
