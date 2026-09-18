package feedback

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct{ pool *pgxpool.Pool }

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore { return &PostgresStore{pool} }

type postgresTx struct {
	ctx       context.Context
	tx        pgx.Tx
	readOnly  bool
	originals map[string][]byte
}

func (t *postgresTx) PendingObject(prefix string) (bool, error) {
	var pending bool
	e := t.tx.QueryRow(t.ctx, `SELECT EXISTS(SELECT 1 FROM feedback_cleanup_tasks WHERE left(storage_key,length($1)+1)=$1||'/')`, prefix).Scan(&pending)
	return pending, e
}

func (t *postgresTx) Expired(now time.Time) ([]Report, error) {
	rows, e := t.tx.Query(t.ctx, `SELECT report_data FROM feedback_reports WHERE (expires_at<=$1 AND report_data->>'upload_state'!='expired') OR (reserved_bytes=0 AND (report_data->>'tombstone_expires_at')::timestamptz<=$1) ORDER BY expires_at LIMIT 100`, now)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Report{}
	for rows.Next() {
		var b []byte
		if e = rows.Scan(&b); e != nil {
			return nil, e
		}
		var r Report
		if e = json.Unmarshal(b, &r); e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func (t *postgresTx) PendingCleanup(id string) (bool, error) {
	var b bool
	e := t.tx.QueryRow(t.ctx, `SELECT EXISTS(SELECT 1 FROM feedback_cleanup_tasks WHERE report_id=$1)`, id).Scan(&b)
	return b, e
}
func (t *postgresTx) Delete(id string) error {
	_, e := t.tx.Exec(t.ctx, `DELETE FROM feedback_reports WHERE report_id=$1`, id)
	return e
}
func (t *postgresTx) RevokeCredential(id string) error {
	tag, e := t.tx.Exec(t.ctx, `UPDATE feedback_deployment_credentials SET enabled=false,revoked_at=now() WHERE credential_id=$1`, id)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) Update(ctx context.Context, fn func(Transaction) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// 同一数据库锁覆盖容量预留、状态更新和幂等判断，跨副本一致。
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(434674144)`); err != nil {
		return err
	}
	if err = fn(&postgresTx{ctx: ctx, tx: tx, originals: map[string][]byte{}}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) View(ctx context.Context, fn func(ReadTransaction) error) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = fn(&postgresTx{ctx: ctx, tx: tx, readOnly: true}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (t *postgresTx) get(query string, id string) (Report, error) {
	var b []byte
	err := t.tx.QueryRow(t.ctx, query, id).Scan(&b)
	if errors.Is(err, pgx.ErrNoRows) {
		return Report{}, ErrNotFound
	}
	if err != nil {
		return Report{}, err
	}
	var r Report
	err = json.Unmarshal(b, &r)
	if err == nil && t.originals != nil {
		t.originals[r.ID] = b
	}
	return r, err
}
func (t *postgresTx) Get(id string) (Report, error) {
	if t.readOnly {
		return t.get(`SELECT report_data FROM feedback_reports WHERE report_id=$1`, id)
	}
	return t.get(`SELECT report_data FROM feedback_reports WHERE report_id=$1 FOR UPDATE`, id)
}
func (t *postgresTx) FindClient(id string) (Report, error) {
	var b []byte
	e := t.tx.QueryRow(t.ctx, `SELECT report_data FROM feedback_reports WHERE client_feedback_id=$1 OR (report_data->>'upload_state'='expired' AND client_feedback_id=$2) FOR UPDATE`, id, Hash([]byte(id))).Scan(&b)
	if errors.Is(e, pgx.ErrNoRows) {
		return Report{}, ErrNotFound
	}
	if e != nil {
		return Report{}, e
	}
	var r Report
	e = json.Unmarshal(b, &r)
	if e == nil && t.originals != nil {
		t.originals[r.ID] = b
	}
	return r, e
}
func (t *postgresTx) Save(r Report) error {
	var previous Report
	if raw := t.originals[r.ID]; raw != nil {
		if err := json.Unmarshal(raw, &previous); err != nil {
			return err
		}
	}
	previousArtifacts := map[string][]byte{}
	for _, a := range previous.Artifacts {
		previousArtifacts[a.ID], _ = json.Marshal(a)
	}
	previousEvents := map[string]bool{}
	for _, e := range previous.Events {
		previousEvents[e.ID] = true
	}
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	_, err = t.tx.Exec(t.ctx, `INSERT INTO feedback_reports(report_id,client_feedback_id,report_data,reserved_bytes,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(report_id) DO UPDATE SET client_feedback_id=EXCLUDED.client_feedback_id,report_data=EXCLUDED.report_data,reserved_bytes=EXCLUDED.reserved_bytes,expires_at=EXCLUDED.expires_at`, r.ID, r.ClientID, b, r.ReservedBytes, r.CreatedAt, r.ExpiresAt)
	if err != nil {
		return err
	}
	for _, a := range r.Artifacts {
		b, _ := json.Marshal(a)
		if bytes.Equal(previousArtifacts[a.ID], b) {
			continue
		}
		if _, err = t.tx.Exec(t.ctx, `INSERT INTO feedback_report_artifacts VALUES($1,$2,$3) ON CONFLICT(report_id,artifact_id) DO UPDATE SET artifact_data=EXCLUDED.artifact_data`, r.ID, a.ID, b); err != nil {
			return err
		}
	}
	for _, e := range r.Events {
		if previousEvents[e.ID] {
			continue
		}
		b, _ := json.Marshal(e)
		if _, err = t.tx.Exec(t.ctx, `INSERT INTO feedback_report_events VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_id) DO NOTHING`, e.ID, r.ID, e.Actor.UserID, e.Operation, e.Input.IdempotencyKey, b); err != nil {
			return err
		}
	}
	if r.UploadState == "expired" {
		_, err = t.tx.Exec(t.ctx, `DELETE FROM feedback_report_artifacts WHERE report_id=$1`, r.ID)
		if err != nil {
			return err
		}
		_, err = t.tx.Exec(t.ctx, `DELETE FROM feedback_report_events WHERE report_id=$1`, r.ID)
	}
	if err == nil {
		t.originals[r.ID] = b
	}
	return err
}
func (t *postgresTx) Reserved() (int64, error) {
	var n int64
	err := t.tx.QueryRow(t.ctx, `SELECT COALESCE(SUM(reserved_bytes),0) FROM feedback_reports`).Scan(&n)
	return n, err
}
func (t *postgresTx) SourceReserved(source string) (int64, error) {
	var n int64
	e := t.tx.QueryRow(t.ctx, `SELECT COALESCE(SUM(reserved_bytes),0) FROM feedback_reports WHERE report_data->>'trusted_source'=$1`, source).Scan(&n)
	return n, e
}
func (t *postgresTx) List(f Filter) ([]Report, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = 100
	}
	rows, err := t.tx.Query(t.ctx, `SELECT report_data FROM feedback_reports WHERE
 ($1 OR (report_data->>'upload_state'='ready' AND report_data->>'security_state'='normal' AND expires_at>now()))
 AND ($2='all' OR ($2='' AND report_data->>'processing_status' IN ('open','investigating')) OR report_data->>'processing_status'=$2)
 AND ($3='' OR report_data->>'trusted_source'=$3 OR report_data->'source_claim'->>'customer_label'=$3)
 AND ($4='' OR report_data->'environment'->>'app_version'=$4)
 AND ($5='' OR position(lower($5) in lower((report_data->>'description')||' '||(report_data->>'display_number')))>0)
 AND ($6='' OR created_at>=NULLIF($6,'')::timestamptz) AND ($7='' OR created_at<=NULLIF($7,'')::timestamptz)
 AND ($8='' OR (created_at,report_id)<(NULLIF(split_part($8,'|',1),'')::timestamptz,split_part($8,'|',2)))
 ORDER BY created_at DESC,report_id DESC LIMIT $9`, f.IncludeUnavailable, f.Status, f.Source, f.Version, f.Keyword, f.From, f.To, f.Cursor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Report{}
	for rows.Next() {
		var b []byte
		if err = rows.Scan(&b); err != nil {
			return nil, err
		}
		var r Report
		if err = json.Unmarshal(b, &r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func (t *postgresTx) Rate(key string, now time.Time, limit int) (bool, error) {
	var count int
	err := t.tx.QueryRow(t.ctx, `INSERT INTO feedback_rate_limits VALUES($1,$2,1) ON CONFLICT(bucket_hash) DO UPDATE SET count=CASE WHEN feedback_rate_limits.window_at<=$2-interval '1 hour' THEN 1 ELSE feedback_rate_limits.count+1 END,window_at=CASE WHEN feedback_rate_limits.window_at<=$2-interval '1 hour' THEN $2 ELSE feedback_rate_limits.window_at END RETURNING count`, key, now).Scan(&count)
	return count <= limit, err
}
func (t *postgresTx) AddCleanup(c CleanupTask) error {
	if c.NextAttempt.IsZero() {
		c.NextAttempt = time.Now()
	}
	_, err := t.tx.Exec(t.ctx, `INSERT INTO feedback_cleanup_tasks(storage_key,report_id,reason,next_attempt_at) VALUES($1,$2,$3,$4) ON CONFLICT(storage_key) DO NOTHING`, c.Key, c.ReportID, c.Reason, c.NextAttempt)
	return err
}
func (t *postgresTx) Cleanup(now time.Time) ([]CleanupTask, error) {
	if _, err := t.tx.Exec(t.ctx, `DELETE FROM feedback_rate_limits WHERE window_at<$1::timestamptz-interval '1 day'`, now); err != nil {
		return nil, err
	}
	rows, err := t.tx.Query(t.ctx, `SELECT storage_key,report_id,reason,attempts,next_attempt_at FROM feedback_cleanup_tasks WHERE next_attempt_at<=$1 ORDER BY next_attempt_at LIMIT 100`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CleanupTask{}
	for rows.Next() {
		var c CleanupTask
		if err = rows.Scan(&c.Key, &c.ReportID, &c.Reason, &c.Attempts, &c.NextAttempt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
func (t *postgresTx) FinishCleanup(c CleanupTask, success bool) error {
	if success {
		_, err := t.tx.Exec(t.ctx, `DELETE FROM feedback_cleanup_tasks WHERE storage_key=$1`, c.Key)
		return err
	}
	_, err := t.tx.Exec(t.ctx, `UPDATE feedback_cleanup_tasks SET attempts=attempts+1,next_attempt_at=now()+interval '1 minute' WHERE storage_key=$1`, c.Key)
	return err
}
func (t *postgresTx) Credential(hash string) (DeploymentCredential, error) {
	var c DeploymentCredential
	err := t.tx.QueryRow(t.ctx, `SELECT credential_id,source_id,token_hash,enabled,expires_at,capacity_bytes FROM feedback_deployment_credentials WHERE token_hash=$1`, hash).Scan(&c.ID, &c.SourceID, &c.TokenHash, &c.Enabled, &c.ExpiresAt, &c.CapacityBytes)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}
func (t *postgresTx) SaveCredential(c DeploymentCredential) error {
	_, err := t.tx.Exec(t.ctx, `INSERT INTO feedback_deployment_credentials(credential_id,source_id,token_hash,enabled,expires_at,capacity_bytes) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(credential_id) DO UPDATE SET enabled=EXCLUDED.enabled,revoked_at=CASE WHEN EXCLUDED.enabled THEN NULL ELSE now() END`, c.ID, c.SourceID, c.TokenHash, c.Enabled, c.ExpiresAt, c.CapacityBytes)
	return err
}
