package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/krillinai/Clawee/server/internal/activity"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

type mcpUsageQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

type MCPUsagePostgresStore struct {
	pool mcpUsageQueryer
}

var _ activity.MCPUsageStore = (*MCPUsagePostgresStore)(nil)

func NewMCPUsagePostgresStore(pool *pgxpool.Pool) *MCPUsagePostgresStore {
	if pool == nil {
		return &MCPUsagePostgresStore{}
	}
	return &MCPUsagePostgresStore{pool: pool}
}

func (s *MCPUsagePostgresStore) MCPUsage(ctx context.Context, start, end time.Time) ([]activity.MCPUsage, error) {
	if s == nil || s.pool == nil {
		return []activity.MCPUsage{}, nil
	}
	rows, err := s.pool.Query(ctx, `
SELECT
	a.upstream_server_id,
	COALESCE(NULLIF(server.name, ''), a.upstream_server_id) AS label,
	COUNT(*) AS invocation_count
FROM mcp_proxy_audit_records a
LEFT JOIN mcp_upstream_servers server ON server.server_id = a.upstream_server_id
WHERE a.created_at >= $1
  AND a.created_at < $2
  AND a.capability_type = $3
  AND a.decision IN ($4, $5)
  AND a.upstream_server_id <> ''
GROUP BY a.upstream_server_id, server.name
ORDER BY invocation_count DESC, a.upstream_server_id
`, start, end, mcpgateway.CapabilityTool, mcpgateway.DecisionAllowed, mcpgateway.DecisionConfirmationCompleted)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []activity.MCPUsage{}
	var totalInvocations int64
	for rows.Next() {
		var item activity.MCPUsage
		if err := rows.Scan(&item.ID, &item.Label, &item.InvocationCount); err != nil {
			return nil, err
		}
		totalInvocations += item.InvocationCount
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if totalInvocations == 0 {
		return items, nil
	}
	for index := range items {
		items[index].Share = float64(items[index].InvocationCount) / float64(totalInvocations)
	}
	return items, nil
}
