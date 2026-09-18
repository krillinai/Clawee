package feedback

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/krillinai/Clawee/server/internal/sharedfiles"
	"github.com/krillinai/Clawee/server/internal/testpostgres"
	"sync"
	"testing"
	"time"
)

func TestPostgresFeedbackReadsDoNotWaitForGlobalWriteLock(t *testing.T) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, testpostgres.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	store := NewPostgresStore(pool)
	storage, err := sharedfiles.NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := NewService(store, storage, func(context.Context, Actor, string) error { return nil }, 0)
	p := createTest(t, s, inputFor([]byte("{}\n")))
	id := p["report_id"].(string)
	locked := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- store.Update(ctx, func(tx Transaction) error {
			if _, err := tx.Get(id); err != nil {
				return err
			}
			close(locked)
			<-release
			return nil
		})
	}()
	defer func() {
		close(release)
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	select {
	case <-locked:
	case <-time.After(5 * time.Second):
		t.Fatal("write lock not acquired")
	}
	readCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if _, err := s.Progress(readCtx, id, p["upload_token"].(string)); err != nil {
		t.Fatal("read waits for global or row write lock", err)
	}
}

func TestPostgresFeedbackOnlyWritesChangedArtifactsAndNewEvents(t *testing.T) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, testpostgres.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	store := NewPostgresStore(pool)
	storage, err := sharedfiles.NewFileSystemStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := NewService(store, storage, func(context.Context, Actor, string) error { return nil }, 0)
	in := inputFor([]byte("{}\n"))
	var manifest Manifest
	_ = json.Unmarshal(in.Manifest, &manifest)
	second := manifest.Artifacts[0]
	second.ID, second.Source = "artifact_second", "second"
	manifest.Artifacts = append(manifest.Artifacts, second)
	in.Manifest, _ = json.Marshal(manifest)
	p := createTest(t, s, in)
	id := p["report_id"].(string)
	// INSERT/UPDATE 触发器记录实际写入，避免测试只检查最终内容。
	_, err = pool.Exec(ctx, `CREATE TABLE feedback_write_probe(kind text);
CREATE FUNCTION feedback_probe_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO feedback_write_probe VALUES(TG_TABLE_NAME); RETURN NEW; END $$;
CREATE TRIGGER probe_artifact AFTER INSERT OR UPDATE ON feedback_report_artifacts FOR EACH ROW EXECUTE FUNCTION feedback_probe_write();
CREATE TRIGGER probe_event AFTER INSERT OR UPDATE ON feedback_report_events FOR EACH ROW EXECUTE FUNCTION feedback_probe_write();`)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Update(ctx, func(tx Transaction) error {
		r, err := tx.Get(id)
		if err != nil {
			return err
		}
		r.Artifacts[0].UploadState = "received"
		r.Events = append(r.Events, Event{ID: "event_test", Operation: "investigate", Actor: Actor{UserID: "admin"}, Input: OperationInput{IdempotencyKey: "key_test"}})
		if err = tx.Save(r); err != nil {
			return err
		}
		return tx.Save(r)
	}); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"feedback_report_artifacts", "feedback_report_events"} {
		var count int
		if err = pool.QueryRow(ctx, "SELECT count(*) FROM feedback_write_probe WHERE kind=$1", kind).Scan(&count); err != nil || count != 1 {
			t.Fatalf("%s writes=%d err=%v", kind, count, err)
		}
	}
}

func TestPostgresFeedbackMigrationAndTransactions(t *testing.T) {
	ctx := context.Background()
	pool, e := pgxpool.New(ctx, testpostgres.New(t))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(pool.Close)
	storage, e := sharedfiles.NewFileSystemStorage(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	store := NewPostgresStore(pool)
	s := NewService(store, storage, func(context.Context, Actor, string) error { return nil }, 0)
	_, deployment, e := s.CreateDeploymentCredential(ctx, "quota_source", time.Now().Add(time.Hour), 3)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.Create(ctx, inputFor([]byte("{}\n")), "quota_ip", deployment); e != nil {
		t.Fatal(e)
	}
	_, _, e = s.Create(ctx, inputFor([]byte("{}\n")), "quota_ip", deployment)
	code, _ := HTTPError(e)
	if code != 429 {
		t.Fatal("postgres source quota not enforced", e)
	}
	data := []byte("{\"message\":\"排障正文\"}\n")
	in := inputFor(data)
	p := createTest(t, s, in)
	submitTest(t, s, in, p, data)
	id := p["report_id"].(string)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.Operate(ctx, Actor{UserID: "admin"}, id, "resolve", OperationInput{ExpectedVersion: 1, IdempotencyKey: "same_operation", ResolutionSummary: "已定位", Verification: "隔离验证通过"})
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	var events int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM feedback_report_events WHERE report_id=$1", id).Scan(&events); e != nil || events != 1 {
		t.Fatalf("event count=%d err=%v", events, e)
	}
	s.clock = func() time.Time { return time.Now().Add(31 * 24 * time.Hour) }
	if e = s.Cleanup(ctx); e != nil {
		t.Fatal(e)
	}
	_, created, e := s.Create(ctx, in, "retry", "")
	code, _ = HTTPError(e)
	if created || code != 410 {
		t.Fatalf("expired replay created=%v err=%v", created, e)
	}
	var artifacts int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM feedback_report_artifacts WHERE report_id=$1", id).Scan(&artifacts); e != nil || artifacts != 0 {
		t.Fatalf("retained artifacts=%d err=%v", artifacts, e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM feedback_report_events WHERE report_id=$1", id).Scan(&events); e != nil || events != 0 {
		t.Fatalf("retained events=%d err=%v", events, e)
	}
	if e = store.Update(ctx, func(tx Transaction) error {
		r, err := tx.Get(id)
		if err != nil {
			return err
		}
		if r.ReservedBytes != 0 || r.Description != "" || (len(r.Manifest) > 0 && string(r.Manifest) != "null") {
			t.Error("expired report retains materials or reservation")
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
}
