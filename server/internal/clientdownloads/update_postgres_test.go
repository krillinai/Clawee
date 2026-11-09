package clientdownloads

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/krillinai/Clawee/server/internal/settings"
	"github.com/krillinai/Clawee/server/internal/testpostgres"
)

func TestPostgresCustomerUpdateCreateOnlyCAS(t *testing.T) {
	ctx := context.Background()
	dsn := testpostgres.New(t)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	manifest := customerManifest()
	value, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	var successes, conflicts atomic.Int32
	var workers sync.WaitGroup
	start := make(chan struct{})
	for index := 0; index < 20; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			store := settings.NewPostgresStore(pool)
			<-start
			_, err := store.Put(ctx, Namespace, UpdateKey, value, "admin", -1, time.Now().UTC())
			if err == nil {
				successes.Add(1)
			} else if errors.Is(err, ErrVersionConflict) {
				conflicts.Add(1)
			} else {
				t.Errorf("first publish: %v", err)
			}
		}()
	}
	close(start)
	workers.Wait()
	if successes.Load() != 1 || conflicts.Load() != 19 {
		t.Fatalf("DB create-only CAS: successes=%d conflicts=%d", successes.Load(), conflicts.Load())
	}
	services := []*Service{NewService(settings.NewPostgresStore(pool)), NewService(settings.NewPostgresStore(pool))}
	current, err := services[0].GetUpdate(ctx)
	if err != nil || current.Revision != 1 || current.Update.Version != manifest.Version {
		t.Fatalf("snapshot=%+v %v", current, err)
	}
	if _, err := services[1].PublishUpdate(ctx, manifest, manifest.GatewayURL, "other", 0); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("zero overwrote release: %v", err)
	}
	manifest.Version = "1.2.4"
	successes.Store(0)
	conflicts.Store(0)
	start = make(chan struct{})
	for index := 0; index < 20; index++ {
		workers.Add(1)
		go func(index int) {
			defer workers.Done()
			<-start
			_, err := services[index%2].PublishUpdate(ctx, manifest, manifest.GatewayURL, "other", 1)
			if err == nil {
				successes.Add(1)
			} else if errors.Is(err, ErrVersionConflict) {
				conflicts.Add(1)
			} else {
				t.Errorf("update publish: %v", err)
			}
		}(index)
	}
	close(start)
	workers.Wait()
	if successes.Load() != 1 || conflicts.Load() != 19 {
		t.Fatalf("DB update CAS: successes=%d conflicts=%d", successes.Load(), conflicts.Load())
	}
}
