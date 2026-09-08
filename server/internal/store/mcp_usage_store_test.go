package store

import (
	"context"
	"math"
	"testing"
	"time"

	pgxmock "github.com/pashagolub/pgxmock/v4"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

func TestMCPUsageAggregatesSuccessfulOrganizationCalls(t *testing.T) {
	mock, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mock.Close() })

	start := time.Date(2026, 8, 8, 0, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	end := time.Date(2026, 8, 15, 0, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	mock.ExpectQuery(`(?s)FROM mcp_proxy_audit_records a.*a\.capability_type = \$3.*a\.decision IN \(\$4, \$5\).*GROUP BY a\.upstream_server_id, server\.name`).
		WithArgs(start, end, mcpgateway.CapabilityTool, mcpgateway.DecisionAllowed, mcpgateway.DecisionConfirmationCompleted).
		WillReturnRows(pgxmock.NewRows([]string{"upstream_server_id", "label", "invocation_count"}).
			AddRow("knowledge-adapter", "企业知识库", int64(3)).
			AddRow("crm-main", "CRM", int64(2)))

	items, err := (&MCPUsagePostgresStore{pool: mock}).MCPUsage(context.Background(), start, end)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].ID != "knowledge-adapter" || items[0].Label != "企业知识库" || items[0].InvocationCount != 3 {
		t.Fatalf("MCP usage = %#v", items)
	}
	if math.Abs(items[0].Share-0.6) > 1e-9 || math.Abs(items[1].Share-0.4) > 1e-9 {
		t.Fatalf("MCP usage shares = %#v", items)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestMCPUsageWithoutDatabaseIsEmpty(t *testing.T) {
	items, err := NewMCPUsagePostgresStore(nil).MCPUsage(context.Background(), time.Time{}, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if items == nil || len(items) != 0 {
		t.Fatalf("MCP usage = %#v, want empty non-nil slice", items)
	}
}
