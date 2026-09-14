package settings

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestMemoryStoreRejectsNonZeroVersionForMissingRecord(t *testing.T) {
	store := NewMemoryStore()
	if _, err := store.Put(context.Background(), "client_downloads", "default", json.RawMessage(`{}`), "admin", 1, time.Now()); err != ErrVersionConflict {
		t.Fatalf("Put() error = %v, want %v", err, ErrVersionConflict)
	}
}
