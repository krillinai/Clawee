package agentprompt

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct{ pool *pgxpool.Pool }

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore { return &PostgresStore{pool: pool} }

func (s *PostgresStore) Get(ctx context.Context) (Policy, error) {
	var policy Policy
	err := s.pool.QueryRow(ctx, `
SELECT version, server_agent_prompt, clawee_agent_prompt, COALESCE(updated_by_user_id, ''), created_at, updated_at
FROM agent_prompt_policy WHERE id=$1`, DefaultID).Scan(
		&policy.Version, &policy.ServerPrompt, &policy.ClaweePrompt,
		&policy.UpdatedBy, &policy.CreatedAt, &policy.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Policy{}, nil
	}
	return policy, err
}

func (s *PostgresStore) Update(ctx context.Context, input UpdateInput) (Policy, error) {
	var policy Policy
	err := s.pool.QueryRow(ctx, `
INSERT INTO agent_prompt_policy
  (id, version, server_agent_prompt, clawee_agent_prompt, updated_by_user_id, created_at, updated_at)
VALUES ($1, 1, $2, $3, $4, $5, $5)
ON CONFLICT (id) DO UPDATE SET
  version = agent_prompt_policy.version + 1,
  server_agent_prompt = EXCLUDED.server_agent_prompt,
  clawee_agent_prompt = EXCLUDED.clawee_agent_prompt,
  updated_by_user_id = EXCLUDED.updated_by_user_id,
  updated_at = EXCLUDED.updated_at
RETURNING version, server_agent_prompt, clawee_agent_prompt, updated_by_user_id, created_at, updated_at`,
		DefaultID, input.ServerPrompt, input.ClaweePrompt, input.UpdatedBy, input.UpdatedAt,
	).Scan(&policy.Version, &policy.ServerPrompt, &policy.ClaweePrompt,
		&policy.UpdatedBy, &policy.CreatedAt, &policy.UpdatedAt)
	return policy, err
}
