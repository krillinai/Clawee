package store

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
)

func TestMCPGatewayStoreQueriesUseGovernanceTables(t *testing.T) {
	raw, err := os.ReadFile("mcp_gateway_store.go")
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	source := strings.ToLower(string(raw))
	for _, want := range []string{
		"mcp_upstream_servers",
		"mcp_capabilities",
		"mcp_account_grants",
		"mcp_proxy_audit_records",
		"confirm_required",
		"confirm_template",
		"deleted_at",
		"deleted_at is null",
		"update mcp_upstream_servers",
		"audit_id = $2",
	} {
		if !strings.Contains(source, want) {
			t.Fatalf("store source missing %q", want)
		}
	}
}

func TestMCPGatewayStoreNilPoolDoesNotPanic(t *testing.T) {
	ctx := context.Background()
	store := NewMCPGatewayStore(nil)

	assertNoPanic(t, "SaveAgent", func() error {
		return store.SaveAgent(ctx, mcpgateway.AgentRegistration{})
	})
	assertGetNotFound(t, "UpdateAgentName", mcpgateway.ErrAgentNotFound, func() error {
		_, err := store.UpdateAgentName(ctx, "missing", "name")
		return err
	})
	assertGetNotFound(t, "GetAgent", mcpgateway.ErrAgentNotFound, func() error {
		_, err := store.GetAgent(ctx, "missing")
		return err
	})
	assertEmptyList(t, "ListAgents", func() (int, error) {
		got, err := store.ListAgents(ctx, mcpgateway.AgentFilter{})
		return len(got), err
	})
	assertGetNotFound(t, "GetAccountTokenByHash", mcpgateway.ErrAccountTokenNotFound, func() error {
		_, err := store.GetAccountTokenByHash(ctx, "missing")
		return err
	})
	assertGetNotFound(t, "GetActiveAccountToken", mcpgateway.ErrAccountTokenNotFound, func() error {
		_, err := store.GetActiveAccountToken(ctx, "missing")
		return err
	})
	assertGetNotFound(t, "GetLatestAccountToken", mcpgateway.ErrAccountTokenNotFound, func() error {
		_, err := store.GetLatestAccountToken(ctx, "missing")
		return err
	})
	assertGetNotFound(t, "RevokeAccountTokens", mcpgateway.ErrAccountTokenNotFound, func() error {
		_, err := store.RevokeAccountTokens(ctx, "missing", time.Now())
		return err
	})
	assertNoPanic(t, "SaveUpstreamServer", func() error {
		return store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{})
	})
	assertGetNotFound(t, "GetUpstreamServer", mcpgateway.ErrUpstreamServerNotFound, func() error {
		_, err := store.GetUpstreamServer(ctx, "missing")
		return err
	})
	assertEmptyList(t, "ListUpstreamServers", func() (int, error) {
		got, err := store.ListUpstreamServers(ctx)
		return len(got), err
	})
	assertGetNotFound(t, "DeleteUpstreamServer", mcpgateway.ErrUpstreamServerNotFound, func() error {
		return store.DeleteUpstreamServer(ctx, "missing")
	})
	assertGetNotFound(t, "DeleteAgent", mcpgateway.ErrAgentNotFound, func() error {
		return store.DeleteAgent(ctx, "missing")
	})
	assertNoPanic(t, "SaveUpstreamSyncLog", func() error {
		return store.SaveUpstreamSyncLog(ctx, mcpgateway.UpstreamSyncLog{})
	})
	assertGetNotFound(t, "GetLatestUpstreamSyncLog", mcpgateway.ErrUpstreamServerNotFound, func() error {
		_, err := store.GetLatestUpstreamSyncLog(ctx, "missing")
		return err
	})
	assertNoPanic(t, "SaveCapability", func() error {
		return store.SaveCapability(ctx, mcpgateway.Capability{})
	})
	assertGetNotFound(t, "GetCapabilityByExposedName", mcpgateway.ErrCapabilityNotFound, func() error {
		_, err := store.GetCapabilityByExposedName(ctx, "missing")
		return err
	})
	assertEmptyList(t, "ListCapabilities", func() (int, error) {
		got, err := store.ListCapabilities(ctx, mcpgateway.CapabilityFilter{})
		return len(got), err
	})
	assertGetNotFound(t, "DeleteCapability", mcpgateway.ErrCapabilityNotFound, func() error {
		return store.DeleteCapability(ctx, "missing")
	})
	assertNoPanic(t, "SaveGrant", func() error {
		return store.SaveGrant(ctx, mcpgateway.AccountGrant{})
	})
	assertNoPanic(t, "DeleteGrant", func() error {
		return store.DeleteGrant(ctx, "missing")
	})
	assertEmptyList(t, "ListGrants", func() (int, error) {
		got, err := store.ListGrants(ctx, mcpgateway.GrantFilter{})
		return len(got), err
	})
	assertNoPanic(t, "SaveListAuditRecord", func() error {
		return store.SaveListAuditRecord(ctx, mcpgateway.ListAuditRecord{})
	})
	assertNoPanic(t, "SaveProxyAuditRecord", func() error {
		return store.SaveProxyAuditRecord(ctx, mcpgateway.ProxyAuditRecord{})
	})
	assertEmptyList(t, "ListProxyAuditRecords", func() (int, error) {
		got, err := store.ListProxyAuditRecords(ctx, mcpgateway.ProxyAuditFilter{Limit: 10})
		return len(got), err
	})
	assertNoPanic(t, "SaveGateRequest", func() error {
		return store.SaveGateRequest(ctx, mcpgateway.GateRequest{})
	})
	assertGetNotFound(t, "GetGateRequest", mcpgateway.ErrGateNotFound, func() error {
		_, err := store.GetGateRequest(ctx, "missing")
		return err
	})
	assertEmptyList(t, "ListGateRequests", func() (int, error) {
		got, err := store.ListGateRequests(ctx, mcpgateway.GateFilter{})
		return len(got), err
	})
	assertGetNotFound(t, "UpdateGateDecision", mcpgateway.ErrGateNotFound, func() error {
		_, err := store.UpdateGateDecision(ctx, mcpgateway.GateDecisionUpdate{ID: "missing"})
		return err
	})
	assertGetNotFound(t, "UpdateGateExecution", mcpgateway.ErrGateNotFound, func() error {
		_, err := store.UpdateGateExecution(ctx, mcpgateway.GateExecutionUpdate{ID: "missing"})
		return err
	})
}

func TestNormalizeAgentInsertErrorMapsUniqueViolation(t *testing.T) {
	uniqueErr := &pgconn.PgError{Code: "23505"}
	if err := normalizeAgentInsertError(uniqueErr); !errors.Is(err, mcpgateway.ErrAgentAlreadyExists) {
		t.Fatalf("unique violation error = %v, want %v", err, mcpgateway.ErrAgentAlreadyExists)
	}

	otherErr := &pgconn.PgError{Code: "23503"}
	if err := normalizeAgentInsertError(otherErr); !errors.Is(err, otherErr) {
		t.Fatalf("non-unique error = %v, want original error", err)
	}
}

func TestNormalizeGrantInsertErrorMapsUniqueViolation(t *testing.T) {
	uniqueErr := &pgconn.PgError{Code: "23505"}
	if err := normalizeGrantInsertError(uniqueErr); !errors.Is(err, mcpgateway.ErrGrantAlreadyExists) {
		t.Fatalf("unique violation error = %v, want %v", err, mcpgateway.ErrGrantAlreadyExists)
	}

	otherErr := &pgconn.PgError{Code: "23503"}
	if err := normalizeGrantInsertError(otherErr); !errors.Is(err, otherErr) {
		t.Fatalf("non-unique error = %v, want original error", err)
	}
}

func TestMemoryStoreRejectsDuplicateAccountGrantTarget(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	first := mcpgateway.AccountGrant{ID: "grant-a", UserID: "user-a", CapabilityID: "cap-a", GrantType: mcpgateway.GrantTool}
	if err := store.SaveGrant(ctx, first); err != nil {
		t.Fatalf("save first grant: %v", err)
	}
	duplicate := first
	duplicate.ID = "grant-b"
	if err := store.SaveGrant(ctx, duplicate); !errors.Is(err, mcpgateway.ErrGrantAlreadyExists) {
		t.Fatalf("duplicate grant error = %v, want %v", err, mcpgateway.ErrGrantAlreadyExists)
	}
}

func TestMemoryStoreRejectsAccountTokenUserMismatch(t *testing.T) {
	store := mcpgateway.NewMemoryStore()
	err := store.RotateAccountToken(context.Background(), "user-a", mcpgateway.AccountToken{UserID: "user-b"})
	if !errors.Is(err, mcpgateway.ErrAgentOwnerUnavailable) {
		t.Fatalf("mismatched account token error = %v, want %v", err, mcpgateway.ErrAgentOwnerUnavailable)
	}
}

func TestMemoryStoreSoftDeletesUpstreamServers(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()

	server := mcpgateway.UpstreamServer{
		ID:        "crm-main",
		Name:      "CRM Main",
		Transport: mcpgateway.TransportStreamableHTTP,
		Endpoint:  "https://crm.example/mcp",
		Status:    mcpgateway.StatusDisabled,
	}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	if err := store.DeleteUpstreamServer(ctx, "crm-main"); err != nil {
		t.Fatalf("delete server: %v", err)
	}
	if _, err := store.GetUpstreamServer(ctx, "crm-main"); !errors.Is(err, mcpgateway.ErrUpstreamServerNotFound) {
		t.Fatalf("get deleted server error = %v, want ErrUpstreamServerNotFound", err)
	}
	servers, err := store.ListUpstreamServers(ctx)
	if err != nil {
		t.Fatalf("list servers: %v", err)
	}
	if len(servers) != 0 {
		t.Fatalf("servers length = %d, want 0", len(servers))
	}
	if err := store.DeleteUpstreamServer(ctx, "missing"); !errors.Is(err, mcpgateway.ErrUpstreamServerNotFound) {
		t.Fatalf("delete missing error = %v, want ErrUpstreamServerNotFound", err)
	}
}

func TestMemoryStorePersistsGateRequests(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	now := testGateNow()
	gate := testGateRequest(now)

	if err := store.SaveGateRequest(ctx, gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}
	got, err := store.GetGateRequest(ctx, gate.ID)
	if err != nil {
		t.Fatalf("get gate: %v", err)
	}
	if got.ID != gate.ID || got.Type != mcpgateway.GateTypeUserConfirmation || got.Status != mcpgateway.GatePending || got.UserID != gate.UserID || got.EndpointType != mcpgateway.EndpointTypeUpstream || got.EndpointUpstreamServerID != "crm-main" {
		t.Fatalf("gate basics = %#v", got)
	}
	if got.GateSummary.System != "crm" || got.GateSummary.Action != "Update customer" || got.GateSummary.Tool != "crm.customer.update" {
		t.Fatalf("gate summary = %#v", got.GateSummary)
	}
	items, err := store.ListGateRequests(ctx, mcpgateway.GateFilter{
		Status:  string(mcpgateway.GatePending),
		AgentID: "sales_zhang_agent",
		Type:    mcpgateway.GateTypeUserConfirmation,
	})
	if err != nil {
		t.Fatalf("list gates: %v", err)
	}
	if len(items) != 1 || items[0].ID != gate.ID {
		t.Fatalf("items = %#v", items)
	}
}

func TestMemoryStoreGateStateTransitionsAreAtomic(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	now := testGateNow()
	gate := testGateRequest(now)
	gate.ID = "mcp_confirm_atomic"
	gate.TraceID = "trace_atomic"

	if err := store.SaveGateRequest(ctx, gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}
	accepted, err := store.UpdateGateDecision(ctx, mcpgateway.GateDecisionUpdate{
		ID: gate.ID, From: mcpgateway.GatePending, To: mcpgateway.GateAccepted,
		DecidedBy: "sales_zhang", Reason: "accepted", DecidedAt: now.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("accept gate: %v", err)
	}
	if accepted.Status != mcpgateway.GateAccepted {
		t.Fatalf("accepted = %#v", accepted)
	}
	if _, err := store.UpdateGateDecision(ctx, mcpgateway.GateDecisionUpdate{
		ID: gate.ID, From: mcpgateway.GatePending, To: mcpgateway.GateRejected,
		DecidedBy: "sales_zhang", Reason: "late reject", DecidedAt: now.Add(2 * time.Minute),
	}); !errors.Is(err, mcpgateway.ErrGateConflict) {
		t.Fatalf("second transition error = %v, want gate conflict", err)
	}
	completed, err := store.UpdateGateExecution(ctx, mcpgateway.GateExecutionUpdate{
		ID: gate.ID, From: mcpgateway.GateAccepted, To: mcpgateway.GateCompleted,
		ExecutionAuditID: "audit_1", ResponseBody: mcpgateway.JSONMap{"ok": true}, UpdatedAt: now.Add(4 * time.Minute),
	})
	if err != nil {
		t.Fatalf("complete gate: %v", err)
	}
	if completed.Status != mcpgateway.GateCompleted || completed.ExecutionAuditID != "audit_1" {
		t.Fatalf("completed = %#v", completed)
	}
	if completed.CompletedAt == nil {
		t.Fatal("completed_at is nil")
	}
}

func TestMCPGatewayStoreSourcePersistsGateRequests(t *testing.T) {
	source := readStoreSource(t)
	for _, want := range []string{
		"func (s *mcpgatewaystore) savegaterequest",
		"insert into mcp_gate_requests",
		"on conflict (gate_id) do update set",
		"func (s *mcpgatewaystore) getgaterequest",
		"func (s *mcpgatewaystore) listgaterequests",
		"func (s *mcpgatewaystore) updategatedecision",
		"where gate_id = $1 and status = $2",
		"func (s *mcpgatewaystore) updategateexecution",
		"completed_at = $9",
		"func gateselectsql",
		"func scangaterequest",
		"func marshalgatesummary",
		"func unmarshalgatesummary",
		"errgateconflict",
		"errgatenotfound",
	} {
		if !strings.Contains(source, want) {
			t.Fatalf("store source missing gate persistence fragment %q", want)
		}
	}
}

func TestMCPGatewayMigrationAllowsRenewedGrantRows(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00002_mcp_gateway_proxy.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := normalizeSQL(string(raw))
	grantUnique := regexp.MustCompile(`unique[^;]*(agent_id[^;]*capability_id[^;]*grant_type|agent_id[^;]*grant_type[^;]*capability_id|capability_id[^;]*agent_id[^;]*grant_type|capability_id[^;]*grant_type[^;]*agent_id|grant_type[^;]*agent_id[^;]*capability_id|grant_type[^;]*capability_id[^;]*agent_id)`)
	if grantUnique.MatchString(migration) {
		t.Fatal("migration must allow multiple grant rows for the same agent, capability, and grant type")
	}
}

func TestMCPGatewayAdminSeedSQLCoversAdminAPIReferenceTables(t *testing.T) {
	raw, err := os.ReadFile("../../db/seeds/mcp_gateway_admin_test_data.sql")
	if err != nil {
		t.Fatalf("read seed sql: %v", err)
	}
	seed := normalizeSQL(string(raw))
	for _, want := range []string{
		"insert into mcp_upstream_servers",
		"insert into mcp_agents",
		"insert into mcp_account_tokens",
		"insert into mcp_capabilities",
		"insert into mcp_account_grants",
		"insert into mcp_proxy_audit_records",
		"on conflict",
	} {
		if !strings.Contains(seed, want) {
			t.Fatalf("seed sql missing %q", want)
		}
	}
}

func TestMCPGatewayStoreSourceShowsDeterministicCapabilityReplacement(t *testing.T) {
	source := readStoreSource(t)
	for _, want := range []string{
		"begin(ctx)",
		"defer tx.rollback(context.background())",
		"delete from mcp_capabilities",
		"exposed_name = $1",
		"capability_id <> $2",
		"tx.commit(ctx)",
	} {
		if !strings.Contains(source, want) {
			t.Fatalf("store source missing deterministic capability replacement fragment %q", want)
		}
	}
}

func TestMCPGatewayStoreSourceUsesMemoryStoreOrdering(t *testing.T) {
	source := readStoreSource(t)
	for _, want := range []string{
		"order by agent_id asc",
		"order by server_id asc",
		"order by exposed_name asc",
		"order by grant_id asc",
		"order by created_at desc",
	} {
		if !strings.Contains(source, want) {
			t.Fatalf("store source missing stable ordering %q", want)
		}
	}
}

func TestUnmarshalJSONMapRejectsInvalidOrNonObjectJSON(t *testing.T) {
	if _, err := unmarshalJSONMap([]byte(`{"ok":true}`)); err != nil {
		t.Fatalf("decode valid object: %v", err)
	}
	for _, raw := range [][]byte{
		[]byte(`[`),
		[]byte(`[]`),
		[]byte(`null`),
		[]byte(`"text"`),
	} {
		if _, err := unmarshalJSONMap(raw); err == nil {
			t.Fatalf("expected decode error for %s", raw)
		}
	}
}

func readStoreSource(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile("mcp_gateway_store.go")
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	return strings.ToLower(string(raw))
}

func normalizeSQL(sql string) string {
	return regexp.MustCompile(`\s+`).ReplaceAllString(strings.ToLower(sql), " ")
}

func assertNoPanic(t *testing.T, name string, call func() error) {
	t.Helper()
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("%s panicked: %v", name, recovered)
		}
	}()
	if err := call(); err != nil {
		t.Fatalf("%s returned error: %v", name, err)
	}
}

func assertGetNotFound(t *testing.T, name string, want error, call func() error) {
	t.Helper()
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("%s panicked: %v", name, recovered)
		}
	}()
	if err := call(); !errors.Is(err, want) {
		t.Fatalf("%s error = %v, want %v", name, err, want)
	}
}

func assertEmptyList(t *testing.T, name string, call func() (int, error)) {
	t.Helper()
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("%s panicked: %v", name, recovered)
		}
	}()
	n, err := call()
	if err != nil {
		t.Fatalf("%s returned error: %v", name, err)
	}
	if n != 0 {
		t.Fatalf("%s returned %d rows, want 0", name, n)
	}
}

func testGateNow() time.Time {
	return time.Date(2026, 5, 29, 10, 0, 0, 0, time.UTC)
}

func testGateRequest(now time.Time) mcpgateway.GateRequest {
	return mcpgateway.GateRequest{
		ID:                       "mcp_confirm_1",
		Type:                     mcpgateway.GateTypeUserConfirmation,
		Provider:                 mcpgateway.GateProviderInternal,
		TraceID:                  "trace_1",
		TenantID:                 "tenant_crm",
		UserID:                   "usr_sales",
		AgentID:                  "sales_zhang_agent",
		ActorID:                  "sales_zhang",
		EndpointType:             mcpgateway.EndpointTypeUpstream,
		EndpointUpstreamServerID: "crm-main",
		CapabilityID:             "cap_search",
		CapabilityType:           mcpgateway.CapabilityTool,
		UpstreamServerID:         "crm-main",
		InboundSessionID:         "inbound-1",
		ExposedName:              "crm.customer.update",
		UpstreamName:             "customer.update",
		RequestHeaders:           mcpgateway.JSONMap{"Authorization": "******"},
		RequestBody:              mcpgateway.JSONMap{"customer_id": "C1024"},
		ArgumentsHash:            "sha256:abc",
		SchemaHash:               "schema_1",
		GateSummary: mcpgateway.GateSummary{
			System: "crm",
			Action: "Update customer",
			Tool:   "crm.customer.update",
		},
		Status:     mcpgateway.GatePending,
		ConfirmURL: "/admin/mcp/gates/mcp_confirm_1",
		ExpiresAt:  now.Add(30 * time.Minute),
		CreatedAt:  now,
		UpdatedAt:  now,
	}
}
