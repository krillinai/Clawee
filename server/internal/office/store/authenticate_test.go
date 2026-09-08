package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/auth"
)

func TestPostgresStoreAuthenticateReleasesQueryConnectionBeforeUpdating(t *testing.T) {
	state := &authenticateDriverState{
		collectorID:   "collector_1",
		tokenHash:     auth.HashToken("collector-token"),
		userID:        "usr_active",
		accountStatus: "active",
	}
	db := openAuthenticateTestDB(t, state)
	db.SetMaxOpenConns(1)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	identity, ok, err := NewPostgresStore(db).Authenticate(ctx, "collector-token")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || identity.CollectorID != "collector_1" {
		t.Fatalf("identity = %#v, ok = %v", identity, ok)
	}
	if got := state.updateCalls.Load(); got != 1 {
		t.Fatalf("update calls = %d, want 1", got)
	}
	if !state.rowsClosedBeforeUpdate.Load() {
		t.Fatal("token query rows were not closed before last_used_at update")
	}
}

func TestPostgresStoreAuthenticateConcurrentRequestsDoNotExhaustPool(t *testing.T) {
	state := &authenticateDriverState{
		collectorID:   "collector_1",
		tokenHash:     auth.HashToken("collector-token"),
		userID:        "usr_active",
		accountStatus: "active",
	}
	db := openAuthenticateTestDB(t, state)
	db.SetMaxOpenConns(4)
	store := NewPostgresStore(db)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	const requestCount = 8
	errCh := make(chan error, requestCount)
	var wg sync.WaitGroup
	for range requestCount {
		wg.Add(1)
		go func() {
			defer wg.Done()
			identity, ok, err := store.Authenticate(ctx, "collector-token")
			if err != nil {
				errCh <- err
				return
			}
			if !ok || identity.CollectorID != "collector_1" {
				errCh <- fmt.Errorf("identity = %#v, ok = %v", identity, ok)
			}
		}()
	}
	wg.Wait()
	close(errCh)

	for err := range errCh {
		t.Error(err)
	}
	if got := state.updateCalls.Load(); got != requestCount {
		t.Fatalf("update calls = %d, want %d", got, requestCount)
	}
}

func TestPostgresStoreAuthenticateInvalidTokenDoesNotUpdate(t *testing.T) {
	state := &authenticateDriverState{
		collectorID: "collector_1",
		tokenHash:   auth.HashToken("collector-token"),
		userID:      nil,
	}
	db := openAuthenticateTestDB(t, state)

	identity, ok, err := NewPostgresStore(db).Authenticate(context.Background(), "invalid-token")
	if err != nil {
		t.Fatal(err)
	}
	if ok || identity.CollectorID != "" {
		t.Fatalf("identity = %#v, ok = %v", identity, ok)
	}
	if got := state.updateCalls.Load(); got != 0 {
		t.Fatalf("update calls = %d, want 0", got)
	}
}

func TestPostgresStoreAuthenticateRejectsUnownedLegacyTokenWithoutUpdating(t *testing.T) {
	state := &authenticateDriverState{
		collectorID: "collector_legacy",
		tokenHash:   auth.HashToken("legacy-token"),
		userID:      nil,
	}
	db := openAuthenticateTestDB(t, state)

	identity, ok, err := NewPostgresStore(db).Authenticate(context.Background(), "legacy-token")
	if err != nil {
		t.Fatal(err)
	}
	if ok || identity.CollectorID != "" || identity.UserID != "" {
		t.Fatalf("identity = %#v, ok = %v", identity, ok)
	}
	if got := state.updateCalls.Load(); got != 0 {
		t.Fatalf("update calls = %d, want 0", got)
	}
}

func TestPostgresStoreAuthenticateRejectsDisabledOwner(t *testing.T) {
	state := &authenticateDriverState{
		collectorID:   "collector_owned",
		tokenHash:     auth.HashToken("collector-token"),
		userID:        "usr_disabled",
		accountStatus: "disabled",
	}
	db := openAuthenticateTestDB(t, state)

	identity, ok, err := NewPostgresStore(db).Authenticate(context.Background(), "collector-token")
	if err != nil {
		t.Fatal(err)
	}
	if ok || identity.CollectorID != "" {
		t.Fatalf("identity = %#v, ok = %v", identity, ok)
	}
	if got := state.updateCalls.Load(); got != 0 {
		t.Fatalf("update calls = %d, want 0", got)
	}
}

func TestPostgresStoreAuthenticateReturnsOwnedIdentity(t *testing.T) {
	state := &authenticateDriverState{
		collectorID:   "collector_owned",
		tokenHash:     auth.HashToken("collector-token"),
		userID:        "usr_active",
		accountStatus: "active",
	}
	db := openAuthenticateTestDB(t, state)

	identity, ok, err := NewPostgresStore(db).Authenticate(context.Background(), "collector-token")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || identity.CollectorID != "collector_owned" || identity.UserID != "usr_active" {
		t.Fatalf("identity = %#v, ok = %v", identity, ok)
	}
}

func TestPostgresStoreAuthenticateReturnsQueryError(t *testing.T) {
	wantErr := errors.New("query failed")
	state := &authenticateDriverState{queryErr: wantErr}
	db := openAuthenticateTestDB(t, state)

	_, _, err := NewPostgresStore(db).Authenticate(context.Background(), "collector-token")
	if !errors.Is(err, wantErr) {
		t.Fatalf("error = %v, want %v", err, wantErr)
	}
}

func TestPostgresStoreAuthenticateReturnsUpdateErrorAfterReleasingQuery(t *testing.T) {
	wantErr := errors.New("update failed")
	state := &authenticateDriverState{
		collectorID:   "collector_1",
		tokenHash:     auth.HashToken("collector-token"),
		userID:        "usr_active",
		accountStatus: "active",
		updateErr:     wantErr,
	}
	db := openAuthenticateTestDB(t, state)

	_, _, err := NewPostgresStore(db).Authenticate(context.Background(), "collector-token")
	if !errors.Is(err, wantErr) {
		t.Fatalf("error = %v, want %v", err, wantErr)
	}
	if !state.rowsClosedBeforeUpdate.Load() {
		t.Fatal("token query rows were not closed before failed last_used_at update")
	}
}

func openAuthenticateTestDB(t *testing.T, state *authenticateDriverState) *sql.DB {
	t.Helper()
	driverName := fmt.Sprintf("authenticate-test-%d", authenticateDriverSequence.Add(1))
	sql.Register(driverName, &authenticateDriver{state: state})
	db, err := sql.Open(driverName, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

var authenticateDriverSequence atomic.Uint64

type authenticateDriverState struct {
	collectorID            string
	tokenHash              string
	userID                 any
	accountStatus          any
	rowsClosed             atomic.Bool
	rowsClosedBeforeUpdate atomic.Bool
	updateCalls            atomic.Int32
	queryErr               error
	updateErr              error
}

type authenticateDriver struct {
	state *authenticateDriverState
}

func (d *authenticateDriver) Open(string) (driver.Conn, error) {
	return &authenticateConn{state: d.state}, nil
}

type authenticateConn struct {
	state *authenticateDriverState
}

func (c *authenticateConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare is not supported")
}

func (c *authenticateConn) Close() error { return nil }

func (c *authenticateConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions are not supported")
}

func (c *authenticateConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if c.state.queryErr != nil {
		return nil, c.state.queryErr
	}
	c.state.rowsClosed.Store(false)
	matched := true
	if strings.Contains(query, "WHERE t.token_hash") {
		matched = len(args) == 1 && args[0].Value == c.state.tokenHash
	}
	return &authenticateRows{state: c.state, matched: matched}, nil
}

func (c *authenticateConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	c.state.updateCalls.Add(1)
	c.state.rowsClosedBeforeUpdate.Store(c.state.rowsClosed.Load())
	if c.state.updateErr != nil {
		return nil, c.state.updateErr
	}
	return driver.RowsAffected(1), nil
}

type authenticateRows struct {
	state    *authenticateDriverState
	matched  bool
	returned bool
}

func (r *authenticateRows) Columns() []string {
	return []string{"collector_id", "user_id", "revoked_at", "account_status"}
}

func (r *authenticateRows) Close() error {
	r.state.rowsClosed.Store(true)
	return nil
}

func (r *authenticateRows) Next(values []driver.Value) error {
	if r.returned || !r.matched {
		return io.EOF
	}
	r.returned = true
	values[0] = r.state.collectorID
	values[1] = r.state.userID
	values[2] = nil
	values[3] = r.state.accountStatus
	return nil
}

var _ driver.QueryerContext = (*authenticateConn)(nil)
var _ driver.ExecerContext = (*authenticateConn)(nil)
