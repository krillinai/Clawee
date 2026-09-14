package settings

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct{ pool *pgxpool.Pool }

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore { return &PostgresStore{pool: pool} }

func (s *PostgresStore) Get(ctx context.Context, namespace, key string) (Record, error) {
	var record Record
	var value []byte
	err := s.pool.QueryRow(ctx, `SELECT namespace, config_key, config_value, version, updated_by, created_at, updated_at FROM platform_settings WHERE namespace=$1 AND config_key=$2`, namespace, key).
		Scan(&record.Namespace, &record.Key, &value, &record.Version, &record.UpdatedBy, &record.CreatedAt, &record.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Record{}, nil
	}
	if err != nil {
		return Record{}, err
	}
	record.Value = json.RawMessage(value)
	return record, nil
}

func (s *PostgresStore) Put(ctx context.Context, namespace, key string, value json.RawMessage, updatedBy string, expectedVersion int64, now time.Time) (Record, error) {
	var record Record
	var raw []byte
	if expectedVersion > 0 {
		var exists bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM platform_settings WHERE namespace=$1 AND config_key=$2)`, namespace, key).Scan(&exists); err != nil {
			return Record{}, err
		}
		if !exists {
			return Record{}, ErrVersionConflict
		}
	}
	query := `INSERT INTO platform_settings(namespace,config_key,config_value,version,updated_by,created_at,updated_at) VALUES($1,$2,$3,1,$4,$5,$5)
ON CONFLICT(namespace,config_key) DO UPDATE SET config_value=EXCLUDED.config_value, version=platform_settings.version+1, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at
WHERE ($6=0 OR platform_settings.version=$6)
RETURNING namespace,config_key,config_value,version,updated_by,created_at,updated_at`
	err := s.pool.QueryRow(ctx, query, namespace, key, value, updatedBy, now, expectedVersion).
		Scan(&record.Namespace, &record.Key, &raw, &record.Version, &record.UpdatedBy, &record.CreatedAt, &record.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Record{}, ErrVersionConflict
	}
	if err != nil {
		return Record{}, err
	}
	record.Value = json.RawMessage(raw)
	return record, nil
}
