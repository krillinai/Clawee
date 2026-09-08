package mcpgateway

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

type fakeUpstreamClient struct {
	tools []UpstreamTool
}

func newTestService(cfg Config) *Service {
	service := NewService(cfg)
	var mu sync.Mutex
	currentUserID := ""
	service.SetIdentityResolvers(
		func(context.Context, string) (string, error) {
			defer mu.Unlock()
			return currentUserID, nil
		},
		func(_ context.Context, userID string) error {
			mu.Lock()
			currentUserID = userID
			return nil
		},
	)
	return service
}

func (f fakeUpstreamClient) ListTools(ctx context.Context, server UpstreamServer, bearerToken string) ([]UpstreamTool, error) {
	return f.tools, nil
}

func (f fakeUpstreamClient) CallTool(ctx context.Context, req UpstreamCallRequest) (UpstreamCallResult, error) {
	return UpstreamCallResult{}, nil
}

func TestServiceIdentityResolversFailClosed(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "agent-1", Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name  string
		setup func(*Service)
	}{
		{name: "both missing", setup: func(*Service) {}},
		{name: "owner missing", setup: func(service *Service) {
			service.SetIdentityResolvers(nil, func(context.Context, string) error { return nil })
		}},
		{name: "account validator missing", setup: func(service *Service) {
			service.SetIdentityResolvers(func(context.Context, string) (string, error) { return "user-1", nil }, nil)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := NewService(Config{Store: store})
			test.setup(service)
			_, err := service.ToolCatalog(ctx, AgentIdentity{UserID: "user-1", AgentID: "agent-1"})
			if !errors.Is(err, ErrAgentOwnerUnavailable) {
				t.Fatalf("ToolCatalog() error = %v, want %v", err, ErrAgentOwnerUnavailable)
			}
		})
	}
}

func TestServiceRejectsMismatchedAgentOwner(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "agent-1", Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	service := NewService(Config{Store: store})
	service.SetIdentityResolvers(
		func(context.Context, string) (string, error) { return "other-user", nil },
		func(context.Context, string) error { return nil },
	)
	_, err := service.ToolCatalog(ctx, AgentIdentity{UserID: "user-1", AgentID: "agent-1"})
	if !errors.Is(err, ErrAgentOwnerUnavailable) {
		t.Fatalf("ToolCatalog() error = %v, want %v", err, ErrAgentOwnerUnavailable)
	}
}

type recordingUpstreamClient struct {
	tools         []UpstreamTool
	lastListToken string
	lastCall      UpstreamCallRequest
	result        UpstreamCallResult
	err           error
	calls         int
}

type knowledgeResolverFunc func(context.Context, string) (KnowledgeBinding, error)

func (f knowledgeResolverFunc) ResolveKnowledgeBinding(ctx context.Context, id string) (KnowledgeBinding, error) {
	return f(ctx, id)
}

type knowledgeMCPAccessResolverFunc func(context.Context, string) ([]string, error)

func (f knowledgeMCPAccessResolverFunc) ResolveMCPKnowledgeBaseIDs(ctx context.Context, userID string) ([]string, error) {
	return f(ctx, userID)
}

func fixedKnowledgeMCPAccess(ids ...string) knowledgeMCPAccessResolverFunc {
	return func(context.Context, string) ([]string, error) { return append([]string(nil), ids...), nil }
}

func (c *recordingUpstreamClient) ListTools(ctx context.Context, server UpstreamServer, bearerToken string) ([]UpstreamTool, error) {
	c.lastListToken = bearerToken
	return c.tools, c.err
}

func (c *recordingUpstreamClient) CallTool(ctx context.Context, req UpstreamCallRequest) (UpstreamCallResult, error) {
	c.calls++
	c.lastCall = req
	if c.err != nil {
		return c.result, c.err
	}
	return c.result, nil
}

type fakeConfirmationElicitor struct {
	supports bool
	decision SyncConfirmationDecision
	err      error
	inputs   []SyncConfirmationInput
}

func (f *fakeConfirmationElicitor) SupportsUserConfirmation() bool {
	return f.supports
}

func (f *fakeConfirmationElicitor) ElicitUserConfirmation(ctx context.Context, input SyncConfirmationInput) (SyncConfirmationDecision, error) {
	f.inputs = append(f.inputs, input)
	if f.err != nil {
		return SyncConfirmationDecision{}, f.err
	}
	return f.decision, nil
}

type failingCapabilityLookupStore struct {
	*MemoryStore
	lookupErr         error
	savedCapabilities []Capability
}

func (s *failingCapabilityLookupStore) GetCapabilityByExposedName(ctx context.Context, exposedName string) (Capability, error) {
	return Capability{}, s.lookupErr
}

func (s *failingCapabilityLookupStore) SaveCapability(ctx context.Context, capability Capability) error {
	s.savedCapabilities = append(s.savedCapabilities, capability)
	return s.MemoryStore.SaveCapability(ctx, capability)
}

type failingGrantListStore struct {
	*MemoryStore
	err error
}

func (s *failingGrantListStore) ListGrants(ctx context.Context, filter GrantFilter) ([]AccountGrant, error) {
	return nil, s.err
}

type failingCapabilityListStore struct {
	*MemoryStore
	err error
}

func (s *failingCapabilityListStore) GetAgent(ctx context.Context, agentID string) (AgentRegistration, error) {
	return s.MemoryStore.GetAgent(context.Background(), agentID)
}

func (s *failingCapabilityListStore) ListCapabilities(ctx context.Context, filter CapabilityFilter) ([]Capability, error) {
	return nil, s.err
}

type failingVisibleToolsGrantListStore struct {
	*MemoryStore
	err error
}

func (s *failingVisibleToolsGrantListStore) GetAgent(ctx context.Context, agentID string) (AgentRegistration, error) {
	return s.MemoryStore.GetAgent(context.Background(), agentID)
}

func (s *failingVisibleToolsGrantListStore) ListCapabilities(ctx context.Context, filter CapabilityFilter) ([]Capability, error) {
	return s.MemoryStore.ListCapabilities(context.Background(), filter)
}

func (s *failingVisibleToolsGrantListStore) ListGrants(ctx context.Context, filter GrantFilter) ([]AccountGrant, error) {
	return nil, s.err
}

type failingConfirmationAuditStore struct {
	*MemoryStore
	err error
}

func (s *failingConfirmationAuditStore) SaveProxyAuditRecord(ctx context.Context, record ProxyAuditRecord) error {
	if record.Decision == DecisionConfirmationCompleted {
		return s.err
	}
	return s.MemoryStore.SaveProxyAuditRecord(ctx, record)
}

type uniqueProxyAuditIDStore struct {
	*MemoryStore
	seen map[string]bool
}

func (s *uniqueProxyAuditIDStore) SaveProxyAuditRecord(ctx context.Context, record ProxyAuditRecord) error {
	if s.seen == nil {
		s.seen = map[string]bool{}
	}
	if s.seen[record.ID] {
		return errors.New("duplicate audit id")
	}
	s.seen[record.ID] = true
	return s.MemoryStore.SaveProxyAuditRecord(ctx, record)
}

type failingProxyAuditSaveStore struct {
	*MemoryStore
	err error
}

func (s failingProxyAuditSaveStore) SaveProxyAuditRecord(ctx context.Context, record ProxyAuditRecord) error {
	return s.err
}

func TestCallToolLogsProxyAuditSaveFailure(t *testing.T) {
	ctx := context.Background()
	core, logs := observer.New(zapcore.ErrorLevel)
	store := failingProxyAuditSaveStore{MemoryStore: NewMemoryStore(), err: errors.New("audit database down")}
	seedGrantedAndUngrantedTools(t, ctx, store.MemoryStore)

	service := newTestService(Config{
		Store:          store,
		UpstreamClient: fakeUpstreamClient{},
		Logger:         zap.New(core),
	})

	_, err := service.CallTool(ctx, ToolCallRequest{
		RequestID:      "req_audit_fail",
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "demo-token",
		InboundSession: "session_1",
	})
	if err == nil {
		t.Fatal("CallTool() error = nil, want audit save error")
	}
	if logs.Len() != 1 {
		t.Fatalf("log count = %d, want 1", logs.Len())
	}
	entry := logs.All()[0]
	if entry.Message != "mcp proxy audit save failed" {
		t.Fatalf("message = %q, want mcp proxy audit save failed", entry.Message)
	}
	fields := entry.ContextMap()
	if fields["request_id"] != "req_audit_fail" {
		t.Fatalf("request_id = %#v, want req_audit_fail", fields["request_id"])
	}
}

func TestSyncToolsStoresNewCapabilitiesAsPending(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	server := UpstreamServer{
		ID:        "crm-main",
		Name:      "CRM Main",
		Domain:    "crm",
		Transport: TransportStreamableHTTP,
		Endpoint:  "http://crm.example/mcp",
		Namespace: "crm",
		Status:    StatusActive,
	}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}

	service := newTestService(Config{
		Store: store,
		UpstreamClient: fakeUpstreamClient{tools: []UpstreamTool{{
			Name:        "customer.search",
			Title:       "Search customers",
			Description: "Search customers by keyword",
			InputSchema: JSONMap{"type": "object"},
		}}},
	})

	if err := service.SyncTools(ctx, "crm-main", "demo-token"); err != nil {
		t.Fatalf("sync tools: %v", err)
	}
	got, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	if got.UpstreamName != "customer.search" {
		t.Fatalf("upstream name = %q, want customer.search", got.UpstreamName)
	}
	if got.Status != StatusPending {
		t.Fatalf("status = %q, want pending", got.Status)
	}
	if got.SchemaHash == "" {
		t.Fatal("schema hash is empty")
	}
}

func TestSyncToolsRejectsExposedNameOwnedByAnotherUpstream(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	for _, server := range []UpstreamServer{
		{ID: "crm-main", Namespace: "shared", Status: StatusActive},
		{ID: "erp-main", Namespace: "shared", Status: StatusActive},
	} {
		if err := store.SaveUpstreamServer(ctx, server); err != nil {
			t.Fatal(err)
		}
	}
	service := newTestService(Config{
		Store: store,
		UpstreamClient: fakeUpstreamClient{tools: []UpstreamTool{{
			Name: "customer.search", InputSchema: JSONMap{"type": "object"},
		}}},
	})
	if err := service.SyncTools(ctx, "crm-main", ""); err != nil {
		t.Fatalf("sync crm tools: %v", err)
	}
	capability, err := store.GetCapabilityByExposedName(ctx, "shared.customer.search")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, AccountGrant{
		ID: "grant_crm", UserID: "agent-1", CapabilityID: capability.ID, GrantType: GrantTool,
	}); err != nil {
		t.Fatal(err)
	}

	err = service.SyncTools(ctx, "erp-main", "")
	if !errors.Is(err, ErrCapabilityExposedNameConflict) {
		t.Fatalf("sync erp error = %v, want ErrCapabilityExposedNameConflict", err)
	}
	capability, err = store.GetCapabilityByExposedName(ctx, "shared.customer.search")
	if err != nil {
		t.Fatal(err)
	}
	if capability.UpstreamServerID != "crm-main" {
		t.Fatalf("capability upstream = %q, want crm-main", capability.UpstreamServerID)
	}
	grants, err := store.ListGrants(ctx, GrantFilter{CapabilityID: capability.ID})
	if err != nil || len(grants) != 1 || grants[0].ID != "grant_crm" {
		t.Fatalf("grants = %#v error = %v, want retained crm grant", grants, err)
	}
	log, err := store.GetLatestUpstreamSyncLog(ctx, "erp-main")
	if err != nil {
		t.Fatal(err)
	}
	if log.Status != StatusSyncFailed {
		t.Fatalf("sync log = %#v, want sync_failed", log)
	}
}

func TestSyncToolsUsesEncryptedUpstreamBearerToken(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	upstream := &recordingUpstreamClient{tools: []UpstreamTool{{
		Name:        "customer.search",
		InputSchema: JSONMap{"type": "object"},
	}}}
	service := newTestService(Config{
		Store:          store,
		UpstreamClient: upstream,
		TokenCipher:    testTokenCipher(),
	})
	server := UpstreamServer{
		ID:        "crm-main",
		Transport: TransportStreamableHTTP,
		Endpoint:  "http://crm.example/mcp",
		Namespace: "crm",
		Status:    StatusActive,
	}
	if err := service.SetUpstreamBearerToken(&server, "configured-token"); err != nil {
		t.Fatalf("set upstream bearer token: %v", err)
	}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}

	if err := service.SyncTools(ctx, server.ID, "delegated-token"); err != nil {
		t.Fatalf("sync tools: %v", err)
	}
	if upstream.lastListToken != "configured-token" {
		t.Fatalf("list token = %q, want configured token", upstream.lastListToken)
	}
}

func TestCollectorPullTransportNeverUsesInboundAgentBearerToken(t *testing.T) {
	service := newTestService(Config{Store: NewMemoryStore()})
	token, err := service.resolveUpstreamBearer(UpstreamServer{Transport: TransportCollectorPull}, "agent-secret")
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		t.Fatalf("resolved token = %q, want empty", token)
	}
}

func TestSyncToolsInitializesGovernanceHintsOnlyForNewCapability(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	server := UpstreamServer{ID: "knowledge-adapter", Transport: TransportStreamableHTTP, Endpoint: "http://knowledge.example/mcp", Namespace: "knowledge", Status: StatusActive}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatal(err)
	}
	upstream := fakeUpstreamClient{tools: []UpstreamTool{{
		Name:        "search",
		Annotations: JSONMap{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true},
		InputSchema: JSONMap{"type": "object"},
	}}}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})
	if err := service.SyncTools(ctx, server.ID, ""); err != nil {
		t.Fatal(err)
	}
	capability, err := store.GetCapabilityByExposedName(ctx, KnowledgeSearchExposedName)
	if err != nil {
		t.Fatal(err)
	}
	if capability.RiskLevel != "low" || !capability.ReadOnly || capability.Destructive || !capability.Idempotent || capability.ApprovalRequired || capability.ConfirmRequired {
		t.Fatalf("initial governance = %#v", capability)
	}
	capability.ReadOnly = false
	capability.Destructive = true
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	if err := service.SyncTools(ctx, server.ID, ""); err != nil {
		t.Fatal(err)
	}
	capability, err = store.GetCapabilityByExposedName(ctx, KnowledgeSearchExposedName)
	if err != nil {
		t.Fatal(err)
	}
	if capability.ReadOnly || !capability.Destructive {
		t.Fatalf("resync overwrote governance fields: %#v", capability)
	}
}

func TestKnowledgeCallUsesBuiltinBindingAndRedactedAudit(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "agent-1", Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUpstreamServer(ctx, UpstreamServer{ID: "knowledge-adapter", Transport: TransportBuiltin, Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	capability := Capability{
		ID: "cap-knowledge", UpstreamServerID: "knowledge-adapter", Type: CapabilityTool, UpstreamName: "search", ExposedName: "enterprise.policy.search", Status: StatusActive,
		InputSchema: JSONMap{"type": "object", "additionalProperties": false, "required": []any{"query"}, "properties": JSONMap{"query": JSONMap{"type": "string", "minLength": 1}, "top_k": JSONMap{"type": "integer", "minimum": 1, "maximum": 20}}},
	}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, AccountGrant{ID: "grant-knowledge", UserID: "agent-1", CapabilityID: capability.ID, GrantType: GrantTool}); err != nil {
		t.Fatal(err)
	}
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{StructuredContent: JSONMap{"chunks": []any{map[string]any{"text": "secret chunk", "document_name": "guide.md", "source_id": "source-1"}}}}}
	service := newTestService(Config{
		Store: store, UpstreamClient: upstream,
		KnowledgeMCPAccessResolver: fixedKnowledgeMCPAccess("kb-1"),
		KnowledgeResolver: knowledgeResolverFunc(func(_ context.Context, id string) (KnowledgeBinding, error) {
			if id != "kb-1" {
				t.Fatalf("knowledge id = %q", id)
			}
			return KnowledgeBinding{KnowledgeBaseID: id, KnowledgeBaseName: "制度库", ProviderType: "bailian", ExternalKnowledgeBaseID: "provider-kb"}, nil
		}),
	})
	identity := AgentIdentity{UserID: "agent-1", AgentID: "agent-1", Subject: "account-user"}
	result, err := service.CallTool(ctx, ToolCallRequest{Identity: identity, ExposedName: capability.ExposedName, Arguments: JSONMap{"query": " policy "}, BearerToken: "agent-token"})
	if err != nil {
		t.Fatal(err)
	}
	if result.StructuredContent == nil || upstream.lastCall.BearerToken != "" || upstream.lastCall.Arguments["query"] != "policy" || upstream.lastCall.Arguments["top_k"] != 5 {
		t.Fatalf("upstream call = %#v", upstream.lastCall)
	}
	if len(upstream.lastCall.KnowledgeBindings) != 1 || upstream.lastCall.KnowledgeBindings[0].ExternalKnowledgeBaseID != "provider-kb" {
		t.Fatalf("knowledge bindings = %#v", upstream.lastCall.KnowledgeBindings)
	}
	if upstream.lastCall.Caller.UserID != identity.UserID || upstream.lastCall.Caller.AgentID != identity.AgentID || upstream.lastCall.Caller.Subject != identity.Subject {
		t.Fatalf("caller = %#v, want %#v", upstream.lastCall.Caller, identity)
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil || len(audits) != 1 {
		t.Fatalf("audits = %#v, %v", audits, err)
	}
	audit := audits[0]
	if audit.ResolvedDataScope["knowledge_base_ids"] == nil || audit.RequestBody["query_redacted"] != true || audit.RequestBody["query"] != nil || audit.ResponseBody["result_count"] != 1 || audit.ResponseBody["chunks"] != nil {
		t.Fatalf("audit = %#v", audit)
	}
}

func TestKnowledgeCallUsesAccountMCPPermissionsInsteadOfAgentDataScope(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "agent-1", Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUpstreamServer(ctx, UpstreamServer{ID: KnowledgeAdapterServerID, Transport: TransportBuiltin, Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	capability := Capability{ID: "cap-knowledge", UpstreamServerID: KnowledgeAdapterServerID, Type: CapabilityTool, UpstreamName: KnowledgeSearchUpstreamName, ExposedName: KnowledgeSearchExposedName, Status: StatusActive, InputSchema: JSONMap{"type": "object", "required": []any{"query"}, "properties": JSONMap{"query": JSONMap{"type": "string"}}}}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, AccountGrant{ID: "grant-knowledge", UserID: "user-1", CapabilityID: capability.ID, GrantType: GrantTool}); err != nil {
		t.Fatal(err)
	}
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{StructuredContent: JSONMap{"chunks": []any{}}}}
	service := newTestService(Config{
		Store: store, UpstreamClient: upstream,
		KnowledgeMCPAccessResolver: knowledgeMCPAccessResolverFunc(func(_ context.Context, userID string) ([]string, error) {
			if userID != "user-1" {
				t.Fatalf("scope user = %q", userID)
			}
			return []string{"kb-account"}, nil
		}),
		KnowledgeResolver: knowledgeResolverFunc(func(_ context.Context, id string) (KnowledgeBinding, error) {
			return KnowledgeBinding{KnowledgeBaseID: id, KnowledgeBaseName: "产品库", ProviderType: "bailian", ExternalKnowledgeBaseID: "provider-" + id}, nil
		}),
	})
	_, err := service.CallTool(ctx, ToolCallRequest{Identity: AgentIdentity{UserID: "user-1", AgentID: "agent-1"}, ExposedName: capability.ExposedName, Arguments: JSONMap{"query": "policy"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(upstream.lastCall.KnowledgeBindings) != 1 || upstream.lastCall.KnowledgeBindings[0].KnowledgeBaseID != "kb-account" {
		t.Fatalf("knowledge bindings = %#v", upstream.lastCall.KnowledgeBindings)
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil || len(audits) != 1 {
		t.Fatalf("audits = %#v, %v", audits, err)
	}
	resolved := knowledgeBaseIDsFromResolvedScope(audits[0].ResolvedDataScope)
	if len(resolved) != 1 || resolved[0] != "kb-account" {
		t.Fatalf("resolved scope = %#v", resolved)
	}
}

func TestKnowledgeCallSharesAccountMCPPermissionsAcrossAgents(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	for _, agentID := range []string{"agent-1", "agent-2"} {
		if err := store.SaveAgent(ctx, AgentRegistration{AgentID: agentID, Status: StatusActive}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.SaveUpstreamServer(ctx, UpstreamServer{ID: KnowledgeAdapterServerID, Transport: TransportBuiltin, Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	capability := Capability{ID: "cap-knowledge", UpstreamServerID: KnowledgeAdapterServerID, Type: CapabilityTool, UpstreamName: KnowledgeSearchUpstreamName, ExposedName: KnowledgeSearchExposedName, Status: StatusActive, InputSchema: JSONMap{"type": "object", "required": []any{"query"}, "properties": JSONMap{"query": JSONMap{"type": "string"}}}}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, AccountGrant{ID: "grant-user-1", UserID: "user-1", CapabilityID: capability.ID, GrantType: GrantTool}); err != nil {
		t.Fatal(err)
	}
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{StructuredContent: JSONMap{"chunks": []any{}}}}
	service := newTestService(Config{
		Store: store, UpstreamClient: upstream,
		KnowledgeMCPAccessResolver: knowledgeMCPAccessResolverFunc(func(_ context.Context, userID string) ([]string, error) {
			if userID != "user-1" {
				t.Fatalf("access user = %q", userID)
			}
			return []string{"kb-account"}, nil
		}),
		KnowledgeResolver: knowledgeResolverFunc(func(_ context.Context, id string) (KnowledgeBinding, error) {
			return KnowledgeBinding{KnowledgeBaseID: id, ProviderType: "bailian", ExternalKnowledgeBaseID: "provider-" + id}, nil
		}),
	})
	for _, agentID := range []string{"agent-1", "agent-2"} {
		_, err := service.CallTool(ctx, ToolCallRequest{Identity: AgentIdentity{UserID: "user-1", AgentID: agentID}, ExposedName: capability.ExposedName, Arguments: JSONMap{"query": "policy"}})
		if err != nil {
			t.Fatalf("call as %s: %v", agentID, err)
		}
		if len(upstream.lastCall.KnowledgeBindings) != 1 || upstream.lastCall.KnowledgeBindings[0].KnowledgeBaseID != "kb-account" {
			t.Fatalf("knowledge bindings for %s = %#v", agentID, upstream.lastCall.KnowledgeBindings)
		}
	}
	if upstream.calls != 2 {
		t.Fatalf("upstream calls = %d, want 2", upstream.calls)
	}
}

func TestKnowledgeCallRejectsToolGrantWithoutAccountMCPPermission(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "agent-1", Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUpstreamServer(ctx, UpstreamServer{ID: KnowledgeAdapterServerID, Transport: TransportBuiltin, Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	capability := Capability{ID: "cap-knowledge", UpstreamServerID: KnowledgeAdapterServerID, Type: CapabilityTool, UpstreamName: KnowledgeSearchUpstreamName, ExposedName: KnowledgeSearchExposedName, Status: StatusActive, InputSchema: JSONMap{"type": "object", "required": []any{"query"}, "properties": JSONMap{"query": JSONMap{"type": "string"}}}}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, AccountGrant{ID: "grant-knowledge", UserID: "user-1", CapabilityID: capability.ID, GrantType: GrantTool}); err != nil {
		t.Fatal(err)
	}
	upstream := &recordingUpstreamClient{}
	service := newTestService(Config{
		Store: store, UpstreamClient: upstream,
		KnowledgeMCPAccessResolver: fixedKnowledgeMCPAccess(),
	})
	_, err := service.CallTool(ctx, ToolCallRequest{Identity: AgentIdentity{UserID: "user-1", AgentID: "agent-1"}, ExposedName: capability.ExposedName, Arguments: JSONMap{"query": "policy"}})
	if err == nil || err.Error() != DecisionNoMatchingKnowledgeScope {
		t.Fatalf("error = %v, want %s", err, DecisionNoMatchingKnowledgeScope)
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
	audits, listErr := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if listErr != nil || len(audits) != 1 || audits[0].Decision != DecisionNoMatchingKnowledgeScope {
		t.Fatalf("audits = %#v, error = %v", audits, listErr)
	}
}

func TestKnowledgeCallContinuesWhenOneBindingIsUnavailable(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "agent-1", Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUpstreamServer(ctx, UpstreamServer{ID: KnowledgeAdapterServerID, Transport: TransportBuiltin, Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	capability := Capability{ID: "cap-knowledge", UpstreamServerID: KnowledgeAdapterServerID, Type: CapabilityTool, UpstreamName: KnowledgeSearchUpstreamName, ExposedName: KnowledgeSearchExposedName, Status: StatusActive, InputSchema: JSONMap{"type": "object", "required": []any{"query"}, "properties": JSONMap{"query": JSONMap{"type": "string"}}}}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, AccountGrant{ID: "grant-knowledge", UserID: "agent-1", CapabilityID: capability.ID, GrantType: GrantTool}); err != nil {
		t.Fatal(err)
	}
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{StructuredContent: JSONMap{"chunks": []any{}}}}
	service := newTestService(Config{
		Store: store, UpstreamClient: upstream,
		KnowledgeMCPAccessResolver: fixedKnowledgeMCPAccess("kb-unavailable", "kb-ready"),
		KnowledgeResolver: knowledgeResolverFunc(func(_ context.Context, id string) (KnowledgeBinding, error) {
			if id == "kb-unavailable" {
				return KnowledgeBinding{}, errors.New("knowledge_base_unavailable")
			}
			return KnowledgeBinding{KnowledgeBaseID: id, ProviderType: "bailian", ExternalKnowledgeBaseID: "provider-ready"}, nil
		}),
	})
	if _, err := service.CallTool(ctx, ToolCallRequest{Identity: AgentIdentity{UserID: "agent-1", AgentID: "agent-1"}, ExposedName: capability.ExposedName, Arguments: JSONMap{"query": "policy"}}); err != nil {
		t.Fatal(err)
	}
	bindings := upstream.lastCall.KnowledgeBindings
	if len(bindings) != 2 || bindings[0].KnowledgeBaseID != "kb-unavailable" || bindings[0].ErrorCode != "not_found" || bindings[1].KnowledgeBaseID != "kb-ready" {
		t.Fatalf("knowledge bindings = %#v", bindings)
	}
}

func TestKnowledgeCallTreatsMCPErrorResultAsProviderFailure(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "agent-1", Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUpstreamServer(ctx, UpstreamServer{ID: "knowledge-adapter", Transport: TransportBuiltin, Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	capability := Capability{ID: "cap-knowledge", UpstreamServerID: "knowledge-adapter", Type: CapabilityTool, UpstreamName: "search", ExposedName: KnowledgeSearchExposedName, Status: StatusActive, InputSchema: JSONMap{"type": "object", "required": []any{"query"}, "properties": JSONMap{"query": JSONMap{"type": "string"}}}}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, AccountGrant{ID: "grant-knowledge", UserID: "agent-1", CapabilityID: capability.ID, GrantType: GrantTool}); err != nil {
		t.Fatal(err)
	}
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{IsError: true}}
	service := newTestService(Config{
		Store: store, UpstreamClient: upstream,
		KnowledgeMCPAccessResolver: fixedKnowledgeMCPAccess("kb-1"),
		KnowledgeResolver: knowledgeResolverFunc(func(context.Context, string) (KnowledgeBinding, error) {
			return KnowledgeBinding{ProviderType: "bailian", ExternalKnowledgeBaseID: "provider-kb"}, nil
		}),
	})
	result, err := service.CallTool(ctx, ToolCallRequest{Identity: AgentIdentity{UserID: "agent-1", AgentID: "agent-1"}, ExposedName: KnowledgeSearchExposedName, Arguments: JSONMap{"query": "secret"}})
	if err != nil || !result.IsError {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil || len(audits) != 1 {
		t.Fatalf("audits = %#v, error = %v", audits, err)
	}
	if audits[0].Decision != DecisionUpstreamError || audits[0].ResponseBody["code"] != "knowledge_provider_error" || audits[0].RequestBody["query"] != nil {
		t.Fatalf("audit = %#v", audits[0])
	}
}

func TestKnowledgeConfirmationEncryptsQueryAndRedactsStoredResult(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "agent-1", Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUpstreamServer(ctx, UpstreamServer{ID: "knowledge-adapter", Transport: TransportBuiltin, Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	capability := Capability{ID: "cap-knowledge", UpstreamServerID: "knowledge-adapter", Type: CapabilityTool, UpstreamName: "search", ExposedName: "enterprise.policy.search", Status: StatusActive, ConfirmRequired: true, InputSchema: JSONMap{"type": "object", "required": []any{"query"}, "properties": JSONMap{"query": JSONMap{"type": "string"}}}}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, AccountGrant{ID: "grant-knowledge", UserID: "agent-1", CapabilityID: capability.ID, GrantType: GrantTool}); err != nil {
		t.Fatal(err)
	}
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{StructuredContent: JSONMap{"chunks": []any{map[string]any{"text": "secret chunk", "document_name": "guide.md", "source_id": "source-1"}}}}}
	service := newTestService(Config{
		Store: store, UpstreamClient: upstream, TokenCipher: NewStaticTokenCipherForTest([]byte("0123456789abcdef0123456789abcdef")),
		KnowledgeMCPAccessResolver: fixedKnowledgeMCPAccess("kb-1"),
		KnowledgeResolver: knowledgeResolverFunc(func(context.Context, string) (KnowledgeBinding, error) {
			return KnowledgeBinding{ProviderType: "bailian", ExternalKnowledgeBaseID: "provider-kb"}, nil
		}),
	})
	result, err := service.CallTool(ctx, ToolCallRequest{Identity: AgentIdentity{UserID: "agent-1", AgentID: "agent-1"}, ExposedName: capability.ExposedName, Arguments: JSONMap{"query": "private policy"}})
	if err != nil {
		t.Fatal(err)
	}
	body := result.StructuredContent.(JSONMap)
	gate, err := store.GetGateRequest(ctx, body["gate_id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	storedQuery, _ := gate.RequestBody["query"].(string)
	if !strings.HasPrefix(storedQuery, encryptedKnowledgeQueryPrefix) || strings.Contains(storedQuery, "private policy") {
		t.Fatalf("stored query = %q", storedQuery)
	}
	for _, parameter := range gate.GateSummary.Parameters {
		if strings.Contains(parameter.Value, "private policy") {
			t.Fatalf("gate summary leaked query: %#v", gate.GateSummary)
		}
	}
	completed, err := service.AcceptConfirmation(ctx, gate.ID)
	if err != nil {
		t.Fatal(err)
	}
	if upstream.lastCall.Arguments["query"] != "private policy" {
		t.Fatalf("upstream arguments = %#v", upstream.lastCall.Arguments)
	}
	if completed.ResponseBody["result_count"] != 1 || completed.ResponseBody["chunks"] != nil {
		t.Fatalf("stored gate response = %#v", completed.ResponseBody)
	}
}

func TestKnowledgeCallRejectsWhitespaceQueryBeforeUpstream(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "agent-1", Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUpstreamServer(ctx, UpstreamServer{ID: "knowledge-adapter", Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	capability := Capability{ID: "cap-knowledge", UpstreamServerID: "knowledge-adapter", Type: CapabilityTool, UpstreamName: "search", ExposedName: KnowledgeSearchExposedName, Status: StatusActive, InputSchema: JSONMap{"type": "object", "required": []any{"query"}, "properties": JSONMap{"query": JSONMap{"type": "string"}}}}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, AccountGrant{ID: "grant-knowledge", UserID: "agent-1", CapabilityID: capability.ID, GrantType: GrantTool}); err != nil {
		t.Fatal(err)
	}
	upstream := &recordingUpstreamClient{}
	service := newTestService(Config{Store: store, UpstreamClient: upstream, KnowledgeMCPAccessResolver: fixedKnowledgeMCPAccess("kb-1")})
	if _, err := service.CallTool(ctx, ToolCallRequest{Identity: AgentIdentity{UserID: "agent-1", AgentID: "agent-1"}, ExposedName: KnowledgeSearchExposedName, Arguments: JSONMap{"query": "   "}}); err == nil {
		t.Fatal("whitespace query should fail")
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d", upstream.calls)
	}
}

func TestSyncToolsReturnsCapabilityLookupError(t *testing.T) {
	ctx := context.Background()
	lookupErr := errors.New("capability lookup failed")
	store := &failingCapabilityLookupStore{
		MemoryStore: NewMemoryStore(),
		lookupErr:   lookupErr,
	}
	server := UpstreamServer{
		ID:        "crm-main",
		Name:      "CRM Main",
		Domain:    "crm",
		Transport: TransportStreamableHTTP,
		Endpoint:  "http://crm.example/mcp",
		Namespace: "crm",
		Status:    StatusActive,
	}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}

	service := newTestService(Config{
		Store: store,
		UpstreamClient: fakeUpstreamClient{tools: []UpstreamTool{{
			Name:        "customer.search",
			InputSchema: JSONMap{"type": "object"},
		}}},
	})

	if err := service.SyncTools(ctx, "crm-main", "demo-token"); !errors.Is(err, lookupErr) {
		t.Fatalf("sync error = %v, want %v", err, lookupErr)
	}
	if len(store.savedCapabilities) != 0 {
		t.Fatalf("saved capabilities length = %d, want 0", len(store.savedCapabilities))
	}
	if _, err := store.MemoryStore.GetCapabilityByExposedName(ctx, "crm.customer.search"); !errors.Is(err, ErrCapabilityNotFound) {
		t.Fatalf("stored capability error = %v, want not found", err)
	}
}

func TestSyncToolsPreservesGatewayOwnedCapabilityFields(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	server := UpstreamServer{
		ID:        "crm-main",
		Name:      "CRM Main",
		Domain:    "crm",
		Transport: TransportStreamableHTTP,
		Endpoint:  "http://crm.example/mcp",
		Namespace: "crm",
		Status:    StatusActive,
	}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	createdAt := time.Date(2026, 5, 26, 8, 30, 0, 0, time.UTC)
	oldHash, err := SchemaHash(JSONMap{"type": "object", "properties": JSONMap{"old": JSONMap{"type": "string"}}})
	if err != nil {
		t.Fatalf("old schema hash: %v", err)
	}
	if err := store.SaveCapability(ctx, Capability{
		ID:               "cap_existing",
		UpstreamServerID: "crm-main",
		Type:             CapabilityTool,
		UpstreamName:     "customer.search",
		ExposedName:      "crm.customer.search",
		Title:            "Old title",
		Description:      "Old description",
		InputSchema:      JSONMap{"type": "object", "properties": JSONMap{"old": JSONMap{"type": "string"}}},
		Status:           StatusActive,
		SchemaHash:       oldHash,
		RiskLevel:        "high",
		ReadOnly:         true,
		Destructive:      true,
		Idempotent:       true,
		ApprovalRequired: true,
		ConfirmRequired:  true,
		ConfirmTemplate:  "请确认更新客户 {{customer_id}}",
		CreatedAt:        createdAt,
	}); err != nil {
		t.Fatalf("save capability: %v", err)
	}

	service := newTestService(Config{
		Store: store,
		UpstreamClient: fakeUpstreamClient{tools: []UpstreamTool{{
			Name:        "customer.search",
			Title:       "New title",
			Description: "New description",
			InputSchema: JSONMap{"type": "object", "properties": JSONMap{"keyword": JSONMap{"type": "string"}}},
		}}},
	})

	if err := service.SyncTools(ctx, "crm-main", "demo-token"); err != nil {
		t.Fatalf("sync tools: %v", err)
	}
	got, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	if got.ID != "cap_existing" {
		t.Fatalf("id = %q, want cap_existing", got.ID)
	}
	if got.Status != StatusActive {
		t.Fatalf("status = %q, want active", got.Status)
	}
	if got.RiskLevel != "high" || !got.ReadOnly || !got.Destructive || !got.Idempotent || !got.ApprovalRequired {
		t.Fatalf("governance fields = risk:%q readOnly:%t destructive:%t idempotent:%t approval:%t; want preserved", got.RiskLevel, got.ReadOnly, got.Destructive, got.Idempotent, got.ApprovalRequired)
	}
	if !got.ConfirmRequired || got.ConfirmTemplate != "请确认更新客户 {{customer_id}}" {
		t.Fatalf("confirmation fields = required:%t template:%q; want preserved", got.ConfirmRequired, got.ConfirmTemplate)
	}
	if !got.CreatedAt.Equal(createdAt) {
		t.Fatalf("created at = %v, want %v", got.CreatedAt, createdAt)
	}
	if got.Title != "New title" || got.Description != "New description" {
		t.Fatalf("title/description = %q/%q, want new upstream values", got.Title, got.Description)
	}
	if got.InputSchema["properties"].(JSONMap)["keyword"].(JSONMap)["type"] != "string" {
		t.Fatalf("input schema = %#v, want updated keyword string schema", got.InputSchema)
	}
	if got.SchemaHash == "" || got.SchemaHash == oldHash {
		t.Fatalf("schema hash = %q, want non-empty hash different from %q", got.SchemaHash, oldHash)
	}
}

func TestSyncToolsPreservesDisabledAndPendingStatuses(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	server := UpstreamServer{ID: "crm-main", Name: "CRM Main", Domain: "crm", Transport: TransportStreamableHTTP, Endpoint: "http://crm.example/mcp", Namespace: "crm", Status: StatusActive}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	for _, capability := range []Capability{
		{ID: "cap_disabled", UpstreamServerID: "crm-main", Type: CapabilityTool, UpstreamName: "customer.disabled", ExposedName: "crm.customer.disabled", Status: StatusDisabled},
		{ID: "cap_pending", UpstreamServerID: "crm-main", Type: CapabilityTool, UpstreamName: "customer.pending", ExposedName: "crm.customer.pending", Status: StatusPending},
	} {
		if err := store.SaveCapability(ctx, capability); err != nil {
			t.Fatalf("save capability %s: %v", capability.ID, err)
		}
	}

	service := newTestService(Config{Store: store, UpstreamClient: fakeUpstreamClient{tools: []UpstreamTool{
		{Name: "customer.disabled", InputSchema: JSONMap{"type": "object"}},
		{Name: "customer.pending", InputSchema: JSONMap{"type": "object"}},
	}}})
	if err := service.SyncTools(ctx, "crm-main", "demo-token"); err != nil {
		t.Fatalf("sync tools: %v", err)
	}

	disabled, err := store.GetCapabilityByExposedName(ctx, "crm.customer.disabled")
	if err != nil {
		t.Fatalf("get disabled capability: %v", err)
	}
	if disabled.Status != StatusDisabled {
		t.Fatalf("disabled status = %q, want disabled", disabled.Status)
	}
	pending, err := store.GetCapabilityByExposedName(ctx, "crm.customer.pending")
	if err != nil {
		t.Fatalf("get pending capability: %v", err)
	}
	if pending.Status != StatusPending {
		t.Fatalf("pending status = %q, want pending", pending.Status)
	}
}

func TestSyncToolsMarksReturningMissingCapabilityPending(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	server := UpstreamServer{ID: "crm-main", Name: "CRM Main", Domain: "crm", Transport: TransportStreamableHTTP, Endpoint: "http://crm.example/mcp", Namespace: "crm", Status: StatusActive}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	if err := store.SaveCapability(ctx, Capability{
		ID:               "cap_returning",
		UpstreamServerID: "crm-main",
		Type:             CapabilityTool,
		UpstreamName:     "customer.search",
		ExposedName:      "crm.customer.search",
		Status:           StatusMissing,
	}); err != nil {
		t.Fatalf("save capability: %v", err)
	}

	service := newTestService(Config{Store: store, UpstreamClient: fakeUpstreamClient{tools: []UpstreamTool{{
		Name: "customer.search", InputSchema: JSONMap{"type": "object"},
	}}}})
	if err := service.SyncTools(ctx, "crm-main", "demo-token"); err != nil {
		t.Fatalf("sync tools: %v", err)
	}
	got, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	if got.Status != StatusPending {
		t.Fatalf("status = %q, want pending", got.Status)
	}
}

func TestSyncToolsUpdatesUpstreamOwnedCapabilityFields(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	server := UpstreamServer{ID: "crm-main", Name: "CRM Main", Domain: "crm", Transport: TransportStreamableHTTP, Endpoint: "http://crm.example/mcp", Namespace: "crm", Status: StatusActive}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	if err := store.SaveCapability(ctx, Capability{
		ID:               "cap_existing",
		UpstreamServerID: "crm-main",
		Type:             CapabilityTool,
		UpstreamName:     "customer.old",
		ExposedName:      "crm.customer.search",
		OutputSchema:     JSONMap{"type": "string"},
		Annotations:      JSONMap{"old": true},
		Version:          "old",
	}); err != nil {
		t.Fatalf("save capability: %v", err)
	}

	syncedAt := time.Date(2026, 5, 26, 9, 45, 0, 0, time.UTC)
	service := newTestService(Config{
		Store: store,
		UpstreamClient: fakeUpstreamClient{tools: []UpstreamTool{{
			Name:         "customer.search",
			InputSchema:  JSONMap{"type": "object"},
			OutputSchema: JSONMap{"type": "object"},
			Annotations:  JSONMap{"readOnlyHint": true},
		}}},
		Clock: func() time.Time { return syncedAt },
	})
	if err := service.SyncTools(ctx, "crm-main", "demo-token"); err != nil {
		t.Fatalf("sync tools: %v", err)
	}
	got, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	if got.UpstreamName != "customer.search" {
		t.Fatalf("upstream name = %q, want customer.search", got.UpstreamName)
	}
	if got.OutputSchema["type"] != "object" {
		t.Fatalf("output schema type = %v, want object", got.OutputSchema["type"])
	}
	if got.Annotations["readOnlyHint"] != true {
		t.Fatalf("annotations = %#v, want readOnlyHint true", got.Annotations)
	}
	if !got.LastSyncedAt.Equal(syncedAt) {
		t.Fatalf("last synced at = %v, want %v", got.LastSyncedAt, syncedAt)
	}
	if got.Version != "v1" {
		t.Fatalf("version = %q, want v1", got.Version)
	}
}

func TestSyncToolsMarksMissingCapabilities(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	server := UpstreamServer{ID: "crm-main", Name: "CRM Main", Domain: "crm", Transport: TransportStreamableHTTP, Endpoint: "http://crm.example/mcp", Namespace: "crm", Status: StatusActive}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	if err := store.SaveCapability(ctx, Capability{
		ID: "cap_old", UpstreamServerID: "crm-main", Type: CapabilityTool,
		UpstreamName: "customer.old", ExposedName: "crm.customer.old",
		InputSchema: JSONMap{"type": "object"}, Status: StatusActive,
	}); err != nil {
		t.Fatalf("save old capability: %v", err)
	}

	service := newTestService(Config{Store: store, UpstreamClient: fakeUpstreamClient{tools: []UpstreamTool{{
		Name: "customer.search", InputSchema: JSONMap{"type": "object"},
	}}}})
	if err := service.SyncTools(ctx, "crm-main", "demo-token"); err != nil {
		t.Fatalf("sync tools: %v", err)
	}
	old, err := store.GetCapabilityByExposedName(ctx, "crm.customer.old")
	if err != nil {
		t.Fatalf("get old capability: %v", err)
	}
	if old.Status != StatusMissing {
		t.Fatalf("old status = %q, want missing", old.Status)
	}
}

func TestVisibleToolsReturnsOnlyGrantedActiveTools(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)

	service := newTestService(Config{Store: store})
	tools, err := service.VisibleTools(ctx, AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"})
	if err != nil {
		t.Fatalf("visible tools: %v", err)
	}
	if len(tools) != 1 {
		t.Fatalf("tools length = %d, want 1", len(tools))
	}
	if tools[0].Name != "crm.customer.search" {
		t.Fatalf("tool name = %q, want crm.customer.search", tools[0].Name)
	}
	audits := store.ListAuditRecordsForTest()
	if len(audits) != 1 {
		t.Fatalf("list audit length = %d, want 1", len(audits))
	}
	if audits[0].Decision != DecisionAllowed || audits[0].ReturnedCount != 1 || audits[0].FilteredCount != 1 {
		t.Fatalf("list audit = %#v, want allowed with returned=1 filtered=1", audits[0])
	}
	if audits[0].UserID != "usr_sales" || audits[0].AgentID != "sales_zhang_agent" {
		t.Fatalf("list audit owner snapshot = %#v", audits[0])
	}
}

func TestVisibleToolsUsesUpstreamRoutingDescriptionForCodexAskOnly(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)

	server, err := store.GetUpstreamServer(ctx, "crm-main")
	if err != nil {
		t.Fatal(err)
	}
	server.Name = "研发 Codex B"
	server.RoutingDescription = "负责代码分析、架构设计、功能实现、测试和故障定位。"
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatal(err)
	}
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatal(err)
	}
	capability.UpstreamName = "codex.ask"
	capability.Title = "Ask Codex"
	capability.Description = "向本机 Codex 提问并返回最终回答"
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}

	service := newTestService(Config{Store: store})
	tools, err := service.VisibleTools(ctx, AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"})
	if err != nil {
		t.Fatalf("visible tools: %v", err)
	}
	if len(tools) != 1 {
		t.Fatalf("tools length = %d, want 1", len(tools))
	}
	tool := tools[0]
	if tool.Title != "委派给研发 Codex B" {
		t.Fatalf("title = %q, want routed title", tool.Title)
	}
	if tool.Description != "将任务委派给研发 Codex B。负责代码分析、架构设计、功能实现、测试和故障定位。" {
		t.Fatalf("description = %q, want routed description", tool.Description)
	}
	if tool.ID != capability.ID || tool.Name != capability.ExposedName || tool.ExposedName != capability.ExposedName || tool.UpstreamServerID != capability.UpstreamServerID {
		t.Fatalf("tool identity changed: %#v", tool)
	}
	stored, err := store.GetCapabilityByExposedName(ctx, capability.ExposedName)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Title != "Ask Codex" || stored.Description != "向本机 Codex 提问并返回最终回答" {
		t.Fatalf("stored capability metadata changed: %#v", stored)
	}
}

func TestVisibleToolsKeepsNonCodexMetadataWithRoutingDescription(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)

	server, err := store.GetUpstreamServer(ctx, "crm-main")
	if err != nil {
		t.Fatal(err)
	}
	server.Name = "研发 Codex B"
	server.RoutingDescription = "负责研发任务"
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatal(err)
	}
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatal(err)
	}
	capability.Title = "Search customers"
	capability.Description = "Search CRM customers"
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}

	service := newTestService(Config{Store: store})
	tools, err := service.VisibleTools(ctx, AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"})
	if err != nil {
		t.Fatalf("visible tools: %v", err)
	}
	if len(tools) != 1 || tools[0].Title != capability.Title || tools[0].Description != capability.Description {
		t.Fatalf("non-codex metadata changed: %#v", tools)
	}
}

func TestVisibleToolsForUpstreamFiltersServerAndStripsNamespace(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatal(err)
	}
	capability.UpstreamName = "contacts.find"
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUpstreamServer(ctx, UpstreamServer{
		ID: "erp-main", Name: "ERP", Namespace: "erp", Status: StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveCapability(ctx, Capability{
		ID: "cap_inventory", UpstreamServerID: "erp-main", Type: CapabilityTool,
		UpstreamName: "inventory.query", ExposedName: "erp.inventory.query",
		InputSchema: JSONMap{"type": "object"}, Status: StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, AccountGrant{
		ID: "grant_inventory", UserID: "usr_sales", CapabilityID: "cap_inventory", GrantType: GrantTool,
	}); err != nil {
		t.Fatal(err)
	}

	service := newTestService(Config{Store: store})
	tools, err := service.VisibleToolsForUpstream(ctx, AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"}, "crm-main")
	if err != nil {
		t.Fatalf("visible upstream tools: %v", err)
	}
	if len(tools) != 1 {
		t.Fatalf("tools length = %d, want 1: %#v", len(tools), tools)
	}
	if tools[0].Name != "customer.search" || tools[0].ExposedName != "crm.customer.search" {
		t.Fatalf("tool names = %#v, want local customer.search and exposed crm.customer.search", tools[0])
	}
	audits := store.ListAuditRecordsForTest()
	if len(audits) != 1 || audits[0].EndpointType != EndpointTypeUpstream || audits[0].EndpointUpstreamServerID != "crm-main" {
		t.Fatalf("list audits = %#v, want crm upstream endpoint", audits)
	}
}

func TestVisibleToolsForUpstreamRejectsDuplicateLocalNames(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	if err := store.SaveCapability(ctx, Capability{
		ID: "cap_duplicate", UpstreamServerID: "crm-main", Type: CapabilityTool,
		UpstreamName: "customer.lookup", ExposedName: "customer.search",
		InputSchema: JSONMap{"type": "object"}, Status: StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, AccountGrant{
		ID: "grant_duplicate", UserID: "usr_sales", CapabilityID: "cap_duplicate", GrantType: GrantTool,
	}); err != nil {
		t.Fatal(err)
	}

	service := newTestService(Config{Store: store})
	_, err := service.VisibleToolsForUpstream(ctx, AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"}, "crm-main")
	if !errors.Is(err, ErrEndpointToolNameConflict) {
		t.Fatalf("visible tools error = %v, want ErrEndpointToolNameConflict", err)
	}
	audits := store.ListAuditRecordsForTest()
	if len(audits) != 1 || audits[0].Decision != DecisionInternalError {
		t.Fatalf("list audits = %#v, want internal error", audits)
	}
}

func TestToolCatalogListsAllUpstreamsAndMarksEffectiveGrants(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	expiredAt := now.Add(-time.Minute)

	if err := store.SaveGrant(ctx, AccountGrant{
		ID: "grant_delete_expired", UserID: "usr_sales", CapabilityID: "cap_delete", GrantType: GrantTool,
		ExpiresAt: &expiredAt,
	}); err != nil {
		t.Fatalf("save expired grant: %v", err)
	}
	if err := store.SaveUpstreamServer(ctx, UpstreamServer{
		ID: "finance-main", Name: "财务系统", Domain: "finance", Transport: TransportStreamableHTTP,
		Endpoint: "http://finance.example/mcp", Namespace: "finance", Status: StatusActive,
	}); err != nil {
		t.Fatalf("save finance server: %v", err)
	}
	if err := store.SaveUpstreamServer(ctx, UpstreamServer{
		ID: "disabled-main", Name: "停用系统", Domain: "disabled", Transport: TransportStreamableHTTP,
		Endpoint: "http://disabled.example/mcp", Namespace: "disabled", Status: StatusDisabled,
	}); err != nil {
		t.Fatalf("save disabled server: %v", err)
	}
	if err := store.SaveCapability(ctx, Capability{
		ID: "cap_disabled", UpstreamServerID: "disabled-main", Type: CapabilityTool,
		ExposedName: "disabled.lookup", Title: "停用查询", Status: StatusActive,
	}); err != nil {
		t.Fatalf("save disabled server capability: %v", err)
	}

	service := newTestService(Config{Store: store, Clock: func() time.Time { return now }})
	upstreams, err := service.ToolCatalog(ctx, AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"})
	if err != nil {
		t.Fatalf("tool catalog: %v", err)
	}
	if len(upstreams) != 3 {
		t.Fatalf("upstreams length = %d, want 3: %#v", len(upstreams), upstreams)
	}
	if upstreams[0].ID != "crm-main" || upstreams[0].Name != "CRM" || upstreams[0].Transport != TransportStreamableHTTP || upstreams[0].Namespace != "crm" || upstreams[0].Status != StatusActive {
		t.Fatalf("upstreams[0] = %#v, want active CRM upstream", upstreams[0])
	}
	if len(upstreams[0].Tools) != 2 {
		t.Fatalf("CRM tools length = %d, want 2", len(upstreams[0].Tools))
	}
	if upstreams[0].Tools[0].Name != "customer.delete" || upstreams[0].Tools[0].ExposedName != "crm.customer.delete" || upstreams[0].Tools[0].UpstreamName != "customer.delete" || upstreams[0].Tools[0].Authorized {
		t.Fatalf("delete tool = %#v, want expired authorization", upstreams[0].Tools[0])
	}
	if upstreams[0].Tools[0].AuthorizationExpiresAt != nil {
		t.Fatalf("expired tool authorization expiry = %v, want nil", upstreams[0].Tools[0].AuthorizationExpiresAt)
	}
	if upstreams[0].Tools[1].Name != "customer.search" || !upstreams[0].Tools[1].Authorized || upstreams[0].Tools[1].Status != StatusActive {
		t.Fatalf("search tool = %#v, want authorized", upstreams[0].Tools[1])
	}
	if upstreams[1].ID != "disabled-main" || upstreams[1].Status != StatusDisabled || len(upstreams[1].Tools) != 1 || upstreams[1].Tools[0].Authorized {
		t.Fatalf("upstreams[1] = %#v, want disabled upstream with unauthorized tool", upstreams[1])
	}
	if upstreams[2].ID != "finance-main" || len(upstreams[2].Tools) != 0 {
		t.Fatalf("upstreams[2] = %#v, want empty finance upstream", upstreams[2])
	}
}

func TestAuthorizedToolCatalogOnlyListsEffectiveGrants(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	if err := store.SaveUpstreamServer(ctx, UpstreamServer{
		ID: "empty-main", Name: "无授权服务", Transport: TransportStreamableHTTP,
		Endpoint: "http://empty.example/mcp", Namespace: "empty", Status: StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveCapability(ctx, Capability{
		ID: "cap_empty", UpstreamServerID: "empty-main", Type: CapabilityTool,
		ExposedName: "empty.lookup", Status: StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	expiredAt := now.Add(-time.Minute)
	if err := store.SaveGrant(ctx, AccountGrant{
		ID: "grant_empty_expired", UserID: "usr_sales", CapabilityID: "cap_empty", GrantType: GrantTool,
		ExpiresAt: &expiredAt,
	}); err != nil {
		t.Fatal(err)
	}

	service := newTestService(Config{Store: store, Clock: func() time.Time { return now }})
	upstreams, err := service.AuthorizedToolCatalog(ctx, AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"})
	if err != nil {
		t.Fatalf("authorized tool catalog: %v", err)
	}
	if len(upstreams) != 1 || upstreams[0].ID != "crm-main" {
		t.Fatalf("authorized upstreams = %#v, want CRM only", upstreams)
	}
	if len(upstreams[0].Tools) != 1 || upstreams[0].Tools[0].ID != "cap_search" || !upstreams[0].Tools[0].Authorized {
		t.Fatalf("authorized tools = %#v, want granted search only", upstreams[0].Tools)
	}
}

func TestVisibleToolsSkipsSoftDeletedUpstreamServers(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	if err := store.DeleteUpstreamServer(ctx, "crm-main"); err != nil {
		t.Fatalf("delete upstream server: %v", err)
	}

	service := newTestService(Config{Store: store})
	tools, err := service.VisibleTools(ctx, AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"})
	if err != nil {
		t.Fatalf("visible tools: %v", err)
	}
	if len(tools) != 0 {
		t.Fatalf("tools length = %d, want 0", len(tools))
	}
}

func TestVisibleToolsSkipsDisabledUpstreamServers(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	server, err := store.GetUpstreamServer(ctx, "crm-main")
	if err != nil {
		t.Fatal(err)
	}
	server.Status = StatusDisabled
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatal(err)
	}

	service := newTestService(Config{Store: store})
	tools, err := service.VisibleTools(ctx, AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"})
	if err != nil {
		t.Fatalf("visible tools: %v", err)
	}
	if len(tools) != 0 {
		t.Fatalf("tools length = %d, want 0", len(tools))
	}
}

func TestVisibleToolsRejectsDisabledAgent(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "sales_zhang_agent", Status: StatusDisabled}); err != nil {
		t.Fatalf("save disabled agent: %v", err)
	}
	service := newTestService(Config{Store: store})

	_, err := service.VisibleTools(ctx, AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"})
	if err == nil {
		t.Fatal("disabled agent listed tools")
	}
}

func TestVisibleToolsRejectsMissingAgent(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := newTestService(Config{Store: store})

	_, err := service.VisibleTools(ctx, AgentIdentity{UserID: "missing_agent", AgentID: "missing_agent"})
	if err == nil {
		t.Fatal("missing agent listed tools")
	}
	audits := store.ListAuditRecordsForTest()
	if len(audits) != 1 {
		t.Fatalf("list audit length = %d, want 1", len(audits))
	}
	if audits[0].Decision != DecisionAgentDisabled {
		t.Fatalf("list audit decision = %q, want agent_disabled", audits[0].Decision)
	}
}

func TestVisibleToolsListCapabilitiesErrorAuditsInternalError(t *testing.T) {
	setupCtx := context.Background()
	ctx, cancel := context.WithCancel(setupCtx)
	cancel()
	listErr := context.Canceled
	store := &failingCapabilityListStore{MemoryStore: NewMemoryStore(), err: listErr}
	if err := store.SaveAgent(setupCtx, AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	service := newTestService(Config{Store: store})

	_, err := service.VisibleTools(ctx, AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"})
	if !errors.Is(err, listErr) {
		t.Fatalf("visible tools error = %v, want %v", err, listErr)
	}
	audits := store.ListAuditRecordsForTest()
	if len(audits) != 1 {
		t.Fatalf("list audit length = %d, want 1", len(audits))
	}
	if audits[0].Decision != DecisionInternalError || audits[0].DecisionReason != listErr.Error() {
		t.Fatalf("list audit = %#v, want internal_error with capability error reason", audits[0])
	}
}

func TestVisibleToolsListGrantsErrorAuditsInternalError(t *testing.T) {
	setupCtx := context.Background()
	ctx, cancel := context.WithCancel(setupCtx)
	cancel()
	grantErr := context.Canceled
	store := &failingVisibleToolsGrantListStore{MemoryStore: NewMemoryStore(), err: grantErr}
	if err := store.SaveAgent(setupCtx, AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	service := newTestService(Config{Store: store})

	_, err := service.VisibleTools(ctx, AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"})
	if !errors.Is(err, grantErr) {
		t.Fatalf("visible tools error = %v, want %v", err, grantErr)
	}
	audits := store.ListAuditRecordsForTest()
	if len(audits) != 1 {
		t.Fatalf("list audit length = %d, want 1", len(audits))
	}
	if audits[0].Decision != DecisionInternalError || audits[0].DecisionReason != grantErr.Error() {
		t.Fatalf("list audit = %#v, want internal_error with grant error reason", audits[0])
	}
}

func TestCallToolRejectsUngrantedToolWithoutUpstreamCall(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	upstream := &recordingUpstreamClient{}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	_, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent"},
		ExposedName:    "crm.customer.delete",
		Arguments:      JSONMap{"customer_id": "cust_1"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if err == nil {
		t.Fatal("ungranted tool call succeeded")
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if len(audits) != 1 {
		t.Fatalf("audit length = %d, want 1", len(audits))
	}
	if audits[0].Decision != DecisionNoMatchingGrant {
		t.Fatalf("audit decision = %q, want no_matching_grant", audits[0].Decision)
	}
}

func TestCallToolRejectsCapabilityFromDifferentUpstreamEndpoint(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	upstream := &recordingUpstreamClient{}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	_, err := service.CallTool(ctx, ToolCallRequest{
		Identity:                 AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"},
		ExposedName:              "crm.customer.search",
		EndpointUpstreamServerID: "erp-main",
		Arguments:                JSONMap{"keyword": "acme"},
	})
	if !errors.Is(err, ErrCapabilityNotAvailableOnEndpoint) {
		t.Fatalf("call error = %v, want ErrCapabilityNotAvailableOnEndpoint", err)
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
	audits, listErr := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if listErr != nil {
		t.Fatal(listErr)
	}
	if len(audits) != 1 || audits[0].Decision != DecisionCapabilityNotAvailableOnEndpoint {
		t.Fatalf("audits = %#v, want endpoint rejection", audits)
	}
	if audits[0].EndpointType != EndpointTypeUpstream || audits[0].EndpointUpstreamServerID != "erp-main" {
		t.Fatalf("audit endpoint = %#v, want erp upstream endpoint", audits[0])
	}
}

func TestCallToolRejectsInvalidInputWithoutUpstreamCall(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	upstream := &recordingUpstreamClient{}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	_, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if err == nil {
		t.Fatal("invalid input tool call succeeded")
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if len(audits) != 1 {
		t.Fatalf("audit length = %d, want 1", len(audits))
	}
	if audits[0].Decision != DecisionInvalidInput {
		t.Fatalf("audit decision = %q, want invalid_input", audits[0].Decision)
	}
}

func TestCallToolNilUpstreamClientAuditsInternalError(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	service := newTestService(Config{Store: store})

	_, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if err == nil {
		t.Fatal("nil upstream client call succeeded")
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if len(audits) != 1 {
		t.Fatalf("audit length = %d, want 1", len(audits))
	}
	if audits[0].Decision != DecisionInternalError {
		t.Fatalf("audit decision = %q, want internal_error", audits[0].Decision)
	}
}

func TestCallToolListGrantsErrorAuditsInternalError(t *testing.T) {
	ctx := context.Background()
	grantErr := errors.New("grant store unavailable")
	store := &failingGrantListStore{MemoryStore: NewMemoryStore(), err: grantErr}
	seedGrantedAndUngrantedTools(t, ctx, store)
	service := newTestService(Config{Store: store, UpstreamClient: &recordingUpstreamClient{}})

	_, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if !errors.Is(err, grantErr) {
		t.Fatalf("call error = %v, want %v", err, grantErr)
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if len(audits) != 1 {
		t.Fatalf("audit length = %d, want 1", len(audits))
	}
	if audits[0].Decision != DecisionInternalError || audits[0].DecisionReason != grantErr.Error() {
		t.Fatalf("audit = %#v, want internal_error with grant error reason", audits[0])
	}
}

func TestCallToolCanceledContextStillAuditsInternalError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store := NewMemoryStore()
	service := newTestService(Config{Store: store, UpstreamClient: &recordingUpstreamClient{}})

	_, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("call error = %v, want context canceled", err)
	}
	audits, err := store.ListProxyAuditRecords(context.Background(), ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if len(audits) != 1 {
		t.Fatalf("audit length = %d, want 1", len(audits))
	}
	if audits[0].Decision != DecisionInternalError || audits[0].DecisionReason != context.Canceled.Error() {
		t.Fatalf("audit = %#v, want internal_error with context canceled reason", audits[0])
	}
}

func TestCallToolForwardsDelegatedAuthorizationAndAuditsBodies(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{
		SessionID:         "upstream-session-1",
		StructuredContent: JSONMap{"items": []any{"acme"}},
		ResponseHeaders:   JSONMap{"Authorization": "Bearer upstream-token", "Cookie": "sid=upstream", "Set-Cookie": "sid=upstream; HttpOnly", "x-upstream": "crm"},
	}}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
		RequestHeaders: JSONMap{"Authorization": "Bearer delegated-token"},
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if upstream.lastCall.BearerToken != "delegated-token" {
		t.Fatalf("bearer token = %q, want delegated-token", upstream.lastCall.BearerToken)
	}
	if upstream.lastCall.SessionKey.TokenHash == "" || upstream.lastCall.SessionKey.TokenHash == "delegated-token" {
		t.Fatalf("token hash = %q, want non-empty hash", upstream.lastCall.SessionKey.TokenHash)
	}
	if upstream.lastCall.SessionKey.TenantID != "tenant_crm" {
		t.Fatalf("session tenant = %q, want tenant_crm", upstream.lastCall.SessionKey.TenantID)
	}
	if result.StructuredContent.(JSONMap)["items"].([]any)[0] != "acme" {
		t.Fatalf("structured content = %#v", result.StructuredContent)
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if len(audits) != 1 {
		t.Fatalf("audit length = %d, want 1", len(audits))
	}
	if audits[0].Decision != DecisionAllowed {
		t.Fatalf("audit decision = %q, want allowed", audits[0].Decision)
	}
	if audits[0].UserID != "usr_sales" || audits[0].AgentID != "sales_zhang_agent" || audits[0].TokenID != "token_1" {
		t.Fatalf("proxy audit identity snapshot = %#v", audits[0])
	}
	if audits[0].RequestHeaders["Authorization"] != "[redacted]" {
		t.Fatalf("authorization audit header = %v, want [redacted]", audits[0].RequestHeaders["Authorization"])
	}
	if audits[0].ResponseHeaders["Authorization"] != "[redacted]" {
		t.Fatalf("response authorization audit header = %v, want [redacted]", audits[0].ResponseHeaders["Authorization"])
	}
	if audits[0].ResponseHeaders["Cookie"] != "[redacted]" {
		t.Fatalf("response cookie audit header = %v, want [redacted]", audits[0].ResponseHeaders["Cookie"])
	}
	if audits[0].ResponseHeaders["Set-Cookie"] != "[redacted]" {
		t.Fatalf("response set-cookie audit header = %v, want [redacted]", audits[0].ResponseHeaders["Set-Cookie"])
	}
	if audits[0].TokenHash == "" || audits[0].TokenHash == "delegated-token" {
		t.Fatalf("audit token hash = %q, want non-empty hash", audits[0].TokenHash)
	}
	if audits[0].TenantID != "tenant_crm" {
		t.Fatalf("audit tenant = %q, want tenant_crm", audits[0].TenantID)
	}
	if audits[0].RequestBody["keyword"] != "acme" {
		t.Fatalf("request body = %#v, want keyword", audits[0].RequestBody)
	}
	if audits[0].ResponseBody["items"] == nil {
		t.Fatalf("response body missing items: %#v", audits[0].ResponseBody)
	}
}

func TestCallToolCopiesRequestIDToProxyAudit(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	service := newTestService(Config{
		Store:          store,
		UpstreamClient: fakeUpstreamClient{},
		Clock:          func() time.Time { return now },
	})

	seedGrantedAndUngrantedTools(t, ctx, store)

	_, err := service.CallTool(ctx, ToolCallRequest{
		RequestID:      "req_proxy_123",
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "demo-token",
		InboundSession: "session_1",
		RequestHeaders: JSONMap{"x-request-id": "req_proxy_123"},
	})
	if err != nil {
		t.Fatalf("CallTool() error = %v", err)
	}

	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("ListProxyAuditRecords() error = %v", err)
	}
	if len(audits) != 1 {
		t.Fatalf("audit count = %d, want 1", len(audits))
	}
	if audits[0].RequestID != "req_proxy_123" {
		t.Fatalf("RequestID = %q, want req_proxy_123", audits[0].RequestID)
	}
}

func TestCallToolAuditsContentOnlyResponseBody(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{
		SessionID: "upstream-session-1",
		Content:   []mcp.Content{&mcp.TextContent{Text: "search complete"}},
	}}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	_, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if len(audits) != 1 {
		t.Fatalf("audit length = %d, want 1", len(audits))
	}
	content, ok := audits[0].ResponseBody["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("response content audit = %#v, want one content item", audits[0].ResponseBody["content"])
	}
	first, ok := content[0].(JSONMap)
	if !ok {
		t.Fatalf("response content item = %#v, want map", content[0])
	}
	if first["type"] != "text" || first["text"] != "search complete" {
		t.Fatalf("response content item = %#v, want text content", first)
	}
}

func TestCallToolCreatesUserConfirmationGateWithoutUpstreamCall(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	capability.Title = "Search customers with confirmation"
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{}
	now := time.Date(2026, 5, 29, 10, 0, 0, 0, time.UTC)
	service := newTestService(Config{Store: store, UpstreamClient: upstream, Clock: func() time.Time { return now }})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
		RequestHeaders: JSONMap{"Authorization": "Bearer delegated-token"},
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
	body, ok := result.StructuredContent.(JSONMap)
	if !ok {
		t.Fatalf("structured content = %T, want JSONMap", result.StructuredContent)
	}
	if body["gate_required"] != true || body["gate_id"] == "" {
		t.Fatalf("structured content = %#v", body)
	}
	gateID := body["gate_id"].(string)
	wantConfirmURL := "/admin/mcp/gates/detail?gate_id=" + gateID
	if body["confirm_url"] != wantConfirmURL {
		t.Fatalf("confirm_url = %q, want %q", body["confirm_url"], wantConfirmURL)
	}
	gate, err := store.GetGateRequest(ctx, gateID)
	if err != nil {
		t.Fatalf("get gate: %v", err)
	}
	if gate.UserID != "usr_sales" {
		t.Fatalf("gate user_id = %q, want usr_sales", gate.UserID)
	}
	if gate.Type != GateTypeUserConfirmation || gate.Provider != GateProviderInternal || gate.Status != GatePending {
		t.Fatalf("gate = %#v", gate)
	}
	if gate.RequestBody["keyword"] != "acme" || gate.ArgumentsHash == "" || gate.ConfirmURL == "" {
		t.Fatalf("gate snapshot = %#v", gate)
	}
	if gate.RequestHeaders["Authorization"] != "[redacted]" {
		t.Fatalf("gate request headers = %#v, want redacted authorization", gate.RequestHeaders)
	}
	if gate.ConfirmURL != body["confirm_url"] || gate.ResponseBody["gate_id"] != gateID {
		t.Fatalf("gate response snapshot = %#v, body = %#v", gate.ResponseBody, body)
	}
	if !gate.ExpiresAt.Equal(now.Add(30 * time.Minute)) {
		t.Fatalf("expires at = %v, want %v", gate.ExpiresAt, now.Add(30*time.Minute))
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if len(audits) != 1 {
		t.Fatalf("audit length = %d, want 1", len(audits))
	}
	if audits[0].Decision != DecisionGateRequired || audits[0].DecisionReason != gateID {
		t.Fatalf("audit = %#v, want gate_required with gate id", audits[0])
	}
	if audits[0].ResponseBody["gate_id"] != gateID || audits[0].TokenHash == "" || audits[0].TokenHash == "delegated-token" {
		t.Fatalf("audit response/token = %#v hash:%q", audits[0].ResponseBody, audits[0].TokenHash)
	}
}

func TestCallToolCreatesAdminApprovalGateWithoutUpstreamCall(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ApprovalRequired = true
	capability.ConfirmRequired = true
	capability.Title = "Search customers with admin approval"
	capability.SchemaHash, err = SchemaHash(capability.InputSchema)
	if err != nil {
		t.Fatalf("schema hash: %v", err)
	}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{}
	now := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	service := newTestService(Config{Store: store, UpstreamClient: upstream, Clock: func() time.Time { return now }})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
		RequestHeaders: JSONMap{"Authorization": "Bearer delegated-token"},
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
	body, ok := result.StructuredContent.(JSONMap)
	if !ok {
		t.Fatalf("structured content = %T, want JSONMap", result.StructuredContent)
	}
	if body["gate_required"] != true || body["gate_type"] != GateTypeAdminApproval || body["gate_id"] == "" {
		t.Fatalf("structured content = %#v, want admin approval gate_required", body)
	}
	gateID := body["gate_id"].(string)
	gate, err := store.GetGateRequest(ctx, gateID)
	if err != nil {
		t.Fatalf("get gate: %v", err)
	}
	if gate.Type != GateTypeAdminApproval || gate.Provider != GateProviderInternal || gate.Status != GatePending {
		t.Fatalf("gate = %#v, want pending admin approval", gate)
	}
	if gate.RequestBody["keyword"] != "acme" || gate.ArgumentsHash == "" || gate.SchemaHash == "" {
		t.Fatalf("gate snapshot = %#v", gate)
	}
	if gate.RequestHeaders["Authorization"] != "[redacted]" {
		t.Fatalf("gate request headers = %#v, want redacted authorization", gate.RequestHeaders)
	}
	if gate.ConfirmURL != body["confirm_url"] || gate.ResponseBody["gate_type"] != GateTypeAdminApproval {
		t.Fatalf("gate response snapshot = %#v, body = %#v", gate.ResponseBody, body)
	}
	if !gate.ExpiresAt.Equal(now.Add(30 * time.Minute)) {
		t.Fatalf("expires at = %v, want %v", gate.ExpiresAt, now.Add(30*time.Minute))
	}
	gates, err := store.ListGateRequests(ctx, GateFilter{Status: string(GatePending)})
	if err != nil {
		t.Fatalf("list gates: %v", err)
	}
	if len(gates) != 1 || gates[0].Type != GateTypeAdminApproval {
		t.Fatalf("pending gates = %#v, want one admin approval gate", gates)
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if len(audits) != 1 || audits[0].Decision != DecisionGateRequired || audits[0].DecisionReason != gateID {
		t.Fatalf("audit = %#v, want gate_required with gate id", audits)
	}
	if audits[0].ResponseBody["gate_type"] != GateTypeAdminApproval || audits[0].ResponseBody["gate_id"] != gateID {
		t.Fatalf("audit response body = %#v, want admin approval gate", audits[0].ResponseBody)
	}
}

func TestCallToolWithSyncConfirmationAcceptsAndExecutes(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	capability.SchemaHash, err = SchemaHash(capability.InputSchema)
	if err != nil {
		t.Fatalf("schema hash: %v", err)
	}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{StructuredContent: JSONMap{"ok": true}}}
	elicitor := &fakeConfirmationElicitor{supports: true, decision: SyncConfirmationDecision{Action: SyncConfirmationAccepted, Reason: "accepted_in_client"}}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:             AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:          "crm.customer.search",
		Arguments:            JSONMap{"keyword": "acme"},
		BearerToken:          "delegated-token",
		InboundSession:       "inbound-1",
		ConfirmationMode:     ConfirmationModeSync,
		ConfirmationElicitor: elicitor,
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if result.StructuredContent.(JSONMap)["ok"] != true {
		t.Fatalf("structured content = %#v, want ok true", result.StructuredContent)
	}
	if upstream.calls != 1 {
		t.Fatalf("upstream calls = %d, want 1", upstream.calls)
	}
	if len(elicitor.inputs) != 1 {
		t.Fatalf("elicitor inputs length = %d, want 1", len(elicitor.inputs))
	}
	if elicitor.inputs[0].Gate.Status != GatePending || elicitor.inputs[0].Gate.RequestBody["keyword"] != "acme" {
		t.Fatalf("elicitor gate = %#v", elicitor.inputs[0].Gate)
	}
	gates, err := store.ListGateRequests(ctx, GateFilter{Status: string(GateCompleted)})
	if err != nil {
		t.Fatalf("list gates: %v", err)
	}
	if len(gates) != 1 || gates[0].DecisionReason != "accepted_in_client" {
		t.Fatalf("completed gates = %#v, want one accepted sync gate", gates)
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	var requestAuditFound bool
	for _, audit := range audits {
		if audit.ID == gates[0].RequestAuditID && audit.Decision == DecisionGateRequired {
			requestAuditFound = true
			break
		}
	}
	if !requestAuditFound {
		t.Fatalf("request audit %q not found in audits %#v", gates[0].RequestAuditID, audits)
	}
}

func TestCallToolWithSyncConfirmationPreservesUpstreamToolResult(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{
		Content: []mcp.Content{
			&mcp.TextContent{Text: "tool-level error"},
		},
		IsError: true,
	}}
	elicitor := &fakeConfirmationElicitor{supports: true, decision: SyncConfirmationDecision{Action: SyncConfirmationAccepted}}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:             AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:          "crm.customer.search",
		Arguments:            JSONMap{"keyword": "acme"},
		BearerToken:          "delegated-token",
		InboundSession:       "inbound-1",
		ConfirmationMode:     ConfirmationModeSync,
		ConfirmationElicitor: elicitor,
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if !result.IsError {
		t.Fatal("sync accepted result IsError = false, want upstream IsError true")
	}
	content, ok := result.Content.([]mcp.Content)
	if !ok || len(content) != 1 {
		t.Fatalf("content = %#v, want one mcp content item", result.Content)
	}
	text, ok := content[0].(*mcp.TextContent)
	if !ok || text.Text != "tool-level error" {
		t.Fatalf("content[0] = %#v, want text content", content[0])
	}
	if result.StructuredContent != nil {
		t.Fatalf("structured content = %#v, want nil", result.StructuredContent)
	}
	gates, err := store.ListGateRequests(ctx, GateFilter{Status: string(GateCompleted)})
	if err != nil {
		t.Fatalf("list gates: %v", err)
	}
	if len(gates) != 1 {
		t.Fatalf("completed gates length = %d, want 1", len(gates))
	}
	if _, ok := gates[0].ResponseBody["content"]; !ok {
		t.Fatalf("gate response body = %#v, want audited content", gates[0].ResponseBody)
	}
}

func TestCallToolWithSyncConfirmationPropagatesUpstreamError(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstreamErr := errors.New("upstream unavailable")
	upstream := &recordingUpstreamClient{err: upstreamErr}
	elicitor := &fakeConfirmationElicitor{supports: true, decision: SyncConfirmationDecision{Action: SyncConfirmationAccepted}}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:             AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:          "crm.customer.search",
		Arguments:            JSONMap{"keyword": "acme"},
		BearerToken:          "delegated-token",
		InboundSession:       "inbound-1",
		ConfirmationMode:     ConfirmationModeSync,
		ConfirmationElicitor: elicitor,
	})
	if !errors.Is(err, upstreamErr) {
		t.Fatalf("call tool error = %v, want upstream error", err)
	}
	if result != (ToolCallResult{}) {
		t.Fatalf("result = %#v, want zero result on upstream error", result)
	}
	gates, listErr := store.ListGateRequests(ctx, GateFilter{Status: string(GateFailed)})
	if listErr != nil {
		t.Fatalf("list gates: %v", listErr)
	}
	if len(gates) != 1 || gates[0].Error != upstreamErr.Error() {
		t.Fatalf("failed gates = %#v, want upstream error", gates)
	}
}

func TestCallToolWithSyncConfirmationDeclineRejectsGate(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	capability.SchemaHash, err = SchemaHash(capability.InputSchema)
	if err != nil {
		t.Fatalf("schema hash: %v", err)
	}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{}
	elicitor := &fakeConfirmationElicitor{supports: true, decision: SyncConfirmationDecision{Action: SyncConfirmationDeclined, Reason: "user_declined"}}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:             AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:          "crm.customer.search",
		Arguments:            JSONMap{"keyword": "acme"},
		BearerToken:          "delegated-token",
		InboundSession:       "inbound-1",
		ConfirmationMode:     ConfirmationModeSync,
		ConfirmationElicitor: elicitor,
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if !result.IsError {
		t.Fatal("sync decline result IsError = false, want true")
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
	body := result.StructuredContent.(JSONMap)
	if body["status"] != string(GateRejected) || body["reason"] != "user_declined" {
		t.Fatalf("structured content = %#v, want rejected user_declined", body)
	}
	gates, err := store.ListGateRequests(ctx, GateFilter{Status: string(GateRejected)})
	if err != nil {
		t.Fatalf("list gates: %v", err)
	}
	if len(gates) != 1 || gates[0].DecisionReason != "user_declined" {
		t.Fatalf("rejected gates = %#v", gates)
	}
}

func TestCallToolWithSyncConfirmationCancelRejectsGateWithoutUpstreamCall(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{}
	elicitor := &fakeConfirmationElicitor{supports: true, decision: SyncConfirmationDecision{Action: SyncConfirmationCancelled}}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:             AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:          "crm.customer.search",
		Arguments:            JSONMap{"keyword": "acme"},
		BearerToken:          "delegated-token",
		InboundSession:       "inbound-1",
		ConfirmationMode:     ConfirmationModeSync,
		ConfirmationElicitor: elicitor,
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if !result.IsError {
		t.Fatal("sync cancel result IsError = false, want true")
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
	body := result.StructuredContent.(JSONMap)
	if body["status"] != string(GateRejected) || body["reason"] != "cancelled_by_user" {
		t.Fatalf("structured content = %#v, want cancelled rejection", body)
	}
}

func TestCallToolSyncConfirmationErrorFallsBackToAsyncGate(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{}
	elicitor := &fakeConfirmationElicitor{supports: true, err: errors.New("client does not support elicitation")}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:             AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:          "crm.customer.search",
		Arguments:            JSONMap{"keyword": "acme"},
		BearerToken:          "delegated-token",
		InboundSession:       "inbound-1",
		ConfirmationMode:     ConfirmationModeSync,
		ConfirmationElicitor: elicitor,
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
	body := result.StructuredContent.(JSONMap)
	if body["gate_required"] != true || body["gate_id"] == "" || body["status"] != string(GatePending) {
		t.Fatalf("structured content = %#v, want async gate_required", body)
	}
	gates, err := store.ListGateRequests(ctx, GateFilter{Status: string(GatePending)})
	if err != nil {
		t.Fatalf("list gates: %v", err)
	}
	if len(gates) != 1 {
		t.Fatalf("pending gates length = %d, want 1", len(gates))
	}
}

func TestCallToolSyncConfirmationUnsupportedElicitorFallsBackToAsyncGate(t *testing.T) {
	tests := []struct {
		name             string
		confirmationMode string
	}{
		{name: "auto", confirmationMode: ConfirmationModeAuto},
		{name: "sync", confirmationMode: ConfirmationModeSync},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			store := NewMemoryStore()
			seedGrantedAndUngrantedTools(t, ctx, store)
			capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
			if err != nil {
				t.Fatalf("get capability: %v", err)
			}
			capability.ConfirmRequired = true
			if err := store.SaveCapability(ctx, capability); err != nil {
				t.Fatalf("save capability: %v", err)
			}
			upstream := &recordingUpstreamClient{}
			elicitor := &fakeConfirmationElicitor{
				supports: false,
				decision: SyncConfirmationDecision{
					Action: SyncConfirmationDeclined,
					Reason: "declined_in_mcp_client",
				},
			}
			service := newTestService(Config{Store: store, UpstreamClient: upstream})

			result, err := service.CallTool(ctx, ToolCallRequest{
				Identity:             AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
				ExposedName:          "crm.customer.search",
				Arguments:            JSONMap{"keyword": "acme"},
				BearerToken:          "delegated-token",
				InboundSession:       "inbound-1",
				ConfirmationMode:     tt.confirmationMode,
				ConfirmationElicitor: elicitor,
			})
			if err != nil {
				t.Fatalf("call tool: %v", err)
			}
			if upstream.calls != 0 {
				t.Fatalf("upstream calls = %d, want 0", upstream.calls)
			}
			if len(elicitor.inputs) != 0 {
				t.Fatalf("elicitor inputs length = %d, want 0", len(elicitor.inputs))
			}
			body := result.StructuredContent.(JSONMap)
			if body["gate_required"] != true || body["gate_id"] == "" || body["status"] != string(GatePending) {
				t.Fatalf("structured content = %#v, want async gate_required", body)
			}
			gates, err := store.ListGateRequests(ctx, GateFilter{Status: string(GatePending)})
			if err != nil {
				t.Fatalf("list gates: %v", err)
			}
			if len(gates) != 1 || gates[0].Status != GatePending {
				t.Fatalf("pending gates = %#v, want one pending gate", gates)
			}
		})
	}
}

func TestCallToolConfirmationModeAsyncSkipsElicitor(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{}
	elicitor := &fakeConfirmationElicitor{supports: true, decision: SyncConfirmationDecision{Action: SyncConfirmationAccepted}}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:             AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:          "crm.customer.search",
		Arguments:            JSONMap{"keyword": "acme"},
		BearerToken:          "delegated-token",
		InboundSession:       "inbound-1",
		ConfirmationMode:     ConfirmationModeAsync,
		ConfirmationElicitor: elicitor,
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
	if len(elicitor.inputs) != 0 {
		t.Fatalf("elicitor inputs length = %d, want 0", len(elicitor.inputs))
	}
	body := result.StructuredContent.(JSONMap)
	if body["gate_required"] != true || body["status"] != string(GatePending) {
		t.Fatalf("structured content = %#v, want async gate", body)
	}
}

func TestCallToolSyncConfirmationErrorFallbackSavesDistinctAudits(t *testing.T) {
	ctx := context.Background()
	store := &uniqueProxyAuditIDStore{MemoryStore: NewMemoryStore()}
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{}
	elicitor := &fakeConfirmationElicitor{supports: true, err: errors.New("elicitor unavailable")}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:             AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:          "crm.customer.search",
		Arguments:            JSONMap{"keyword": "acme"},
		BearerToken:          "delegated-token",
		InboundSession:       "inbound-1",
		ConfirmationMode:     ConfirmationModeSync,
		ConfirmationElicitor: elicitor,
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	body, ok := result.StructuredContent.(JSONMap)
	if !ok {
		t.Fatalf("structured content = %T, want JSONMap", result.StructuredContent)
	}
	if body["gate_required"] != true || body["status"] != string(GatePending) {
		t.Fatalf("structured content = %#v, want pending gate_required", body)
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}

	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	var syncAudit, gateAudit *ProxyAuditRecord
	for i := range audits {
		switch audits[i].Decision {
		case DecisionConfirmationSyncRequested:
			syncAudit = &audits[i]
		case DecisionGateRequired:
			gateAudit = &audits[i]
		}
	}
	if syncAudit == nil || gateAudit == nil {
		t.Fatalf("audits = %#v, want sync requested and gate required", audits)
	}
	if syncAudit.ID == gateAudit.ID {
		t.Fatalf("audit IDs are equal: %q", syncAudit.ID)
	}
}

func TestCallToolCreatesDistinctConfirmationGatesWithFixedClock(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	now := time.Date(2026, 5, 29, 10, 0, 0, 0, time.UTC)
	service := newTestService(Config{Store: store, UpstreamClient: &recordingUpstreamClient{}, Clock: func() time.Time { return now }})

	first, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	second, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "globex"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	firstID := first.StructuredContent.(JSONMap)["gate_id"].(string)
	secondID := second.StructuredContent.(JSONMap)["gate_id"].(string)
	if firstID == secondID {
		t.Fatalf("gate IDs are equal: %q", firstID)
	}
	if _, err := store.GetGateRequest(ctx, firstID); err != nil {
		t.Fatalf("get first gate: %v", err)
	}
	if _, err := store.GetGateRequest(ctx, secondID); err != nil {
		t.Fatalf("get second gate: %v", err)
	}
}

func TestCallToolBypassesGateWhenConfirmNotRequired(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{StructuredContent: JSONMap{"items": []any{"acme"}}}}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if upstream.calls != 1 {
		t.Fatalf("upstream calls = %d, want 1", upstream.calls)
	}
	if result.StructuredContent.(JSONMap)["items"] == nil {
		t.Fatalf("structured content = %#v", result.StructuredContent)
	}
}

func TestAcceptConfirmationExecutesStoredSnapshot(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	capability.SchemaHash, err = SchemaHash(capability.InputSchema)
	if err != nil {
		t.Fatalf("schema hash: %v", err)
	}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{StructuredContent: JSONMap{"ok": true}}}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:                 AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:              "crm.customer.search",
		Arguments:                JSONMap{"keyword": "acme"},
		BearerToken:              "delegated-token",
		InboundSession:           "inbound-1",
		RequestHeaders:           JSONMap{"x-request-id": "req_gate_123"},
		EndpointUpstreamServerID: "crm-main",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	gateID := result.StructuredContent.(JSONMap)["gate_id"].(string)
	gate, err := store.GetGateRequest(ctx, gateID)
	if err != nil {
		t.Fatalf("get gate: %v", err)
	}
	if gate.EndpointType != EndpointTypeUpstream || gate.EndpointUpstreamServerID != "crm-main" {
		t.Fatalf("gate endpoint = %#v, want crm upstream endpoint", gate)
	}
	gate.RequestBody["keyword"] = "frozen"
	if err := store.SaveGateRequest(ctx, gate); err != nil {
		t.Fatalf("save modified gate: %v", err)
	}

	completed, err := service.AcceptConfirmation(ctx, gateID)
	if err != nil {
		t.Fatalf("accept confirmation: %v", err)
	}
	if completed.Status != GateCompleted {
		t.Fatalf("status = %q, want completed", completed.Status)
	}
	if upstream.calls != 1 {
		t.Fatalf("upstream calls = %d, want 1", upstream.calls)
	}
	if upstream.lastCall.Arguments["keyword"] != "frozen" {
		t.Fatalf("upstream arguments = %#v, want frozen snapshot", upstream.lastCall.Arguments)
	}
	if upstream.lastCall.BearerToken != "" {
		t.Fatalf("upstream bearer token = %q, want empty restored bearer", upstream.lastCall.BearerToken)
	}
	if completed.ExecutionAuditID == "" || completed.ResponseBody["ok"] != true {
		t.Fatalf("completed gate = %#v", completed)
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if audits[0].Decision != DecisionConfirmationCompleted {
		t.Fatalf("latest audit decision = %q, want confirmation_completed", audits[0].Decision)
	}
	if audits[0].RequestID != "req_gate_123" {
		t.Fatalf("latest audit request_id = %q, want req_gate_123", audits[0].RequestID)
	}
	if audits[0].UserID != "usr_sales" {
		t.Fatalf("latest audit user_id = %q, want usr_sales", audits[0].UserID)
	}
	for _, audit := range audits {
		if audit.EndpointType != EndpointTypeUpstream || audit.EndpointUpstreamServerID != "crm-main" {
			t.Fatalf("audit endpoint = %#v, want crm upstream endpoint", audit)
		}
	}
}

func TestAcceptConfirmationRejectsCapabilityMovedToAnotherUpstream(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatal(err)
	}
	capability.ConfirmRequired = true
	capability.SchemaHash, err = SchemaHash(capability.InputSchema)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	upstream := &recordingUpstreamClient{}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})
	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity: AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"}, ExposedName: capability.ExposedName,
		Arguments: JSONMap{"keyword": "acme"}, EndpointUpstreamServerID: "crm-main",
	})
	if err != nil {
		t.Fatalf("create gate: %v", err)
	}
	gateID := result.StructuredContent.(JSONMap)["gate_id"].(string)

	capability.UpstreamServerID = "erp-main"
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	gate, err := service.AcceptConfirmation(ctx, gateID)
	if !errors.Is(err, ErrCapabilityNotAvailableOnEndpoint) {
		t.Fatalf("accept error = %v, want ErrCapabilityNotAvailableOnEndpoint", err)
	}
	if gate.Status != GateFailed {
		t.Fatalf("gate status = %q, want failed", gate.Status)
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
}

func TestAcceptAdminApprovalExecutesStoredSnapshot(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ApprovalRequired = true
	capability.SchemaHash, err = SchemaHash(capability.InputSchema)
	if err != nil {
		t.Fatalf("schema hash: %v", err)
	}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{StructuredContent: JSONMap{"ok": true}}}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	gateID := result.StructuredContent.(JSONMap)["gate_id"].(string)
	gate, err := store.GetGateRequest(ctx, gateID)
	if err != nil {
		t.Fatalf("get gate: %v", err)
	}
	if gate.Type != GateTypeAdminApproval {
		t.Fatalf("gate type = %q, want admin_approval", gate.Type)
	}
	gate.RequestBody["keyword"] = "frozen"
	if err := store.SaveGateRequest(ctx, gate); err != nil {
		t.Fatalf("save modified gate: %v", err)
	}

	completed, err := service.AcceptConfirmation(ctx, gateID)
	if err != nil {
		t.Fatalf("accept admin approval: %v", err)
	}
	if completed.Status != GateCompleted {
		t.Fatalf("status = %q, want completed", completed.Status)
	}
	if completed.Type != GateTypeAdminApproval {
		t.Fatalf("completed gate type = %q, want admin_approval", completed.Type)
	}
	if upstream.calls != 1 {
		t.Fatalf("upstream calls = %d, want 1", upstream.calls)
	}
	if upstream.lastCall.Arguments["keyword"] != "frozen" {
		t.Fatalf("upstream arguments = %#v, want frozen snapshot", upstream.lastCall.Arguments)
	}
	if completed.ExecutionAuditID == "" || completed.ResponseBody["ok"] != true {
		t.Fatalf("completed gate = %#v", completed)
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if audits[0].Decision != DecisionConfirmationCompleted {
		t.Fatalf("latest audit decision = %q, want confirmation_completed", audits[0].Decision)
	}
}

func TestRejectConfirmationDoesNotCallUpstream(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	gateID := result.StructuredContent.(JSONMap)["gate_id"].(string)

	rejected, err := service.DeclineConfirmation(ctx, gateID, "wrong customer")
	if err != nil {
		t.Fatalf("decline confirmation: %v", err)
	}
	if rejected.Status != GateRejected || rejected.DecisionReason != "wrong customer" {
		t.Fatalf("rejected gate = %#v", rejected)
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
}

func TestRejectAdminApprovalDoesNotCallUpstream(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ApprovalRequired = true
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	gateID := result.StructuredContent.(JSONMap)["gate_id"].(string)

	rejected, err := service.DeclineConfirmation(ctx, gateID, "missing approval evidence")
	if err != nil {
		t.Fatalf("decline admin approval: %v", err)
	}
	if rejected.Type != GateTypeAdminApproval || rejected.Status != GateRejected || rejected.DecisionReason != "missing approval evidence" {
		t.Fatalf("rejected gate = %#v, want rejected admin approval", rejected)
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
}

func TestAdminApprovalDecisionRejectsNonPendingGate(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	now := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	gate := GateRequest{
		ID:        "mcp_approval_completed",
		Type:      GateTypeAdminApproval,
		Provider:  GateProviderInternal,
		Status:    GateCompleted,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := store.SaveGateRequest(ctx, gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}
	service := newTestService(Config{Store: store, UpstreamClient: &recordingUpstreamClient{}})

	current, err := service.AcceptConfirmation(ctx, gate.ID)
	if !errors.Is(err, ErrGateConflict) {
		t.Fatalf("accept error = %v, want ErrGateConflict", err)
	}
	if current.ID != gate.ID || current.Status != GateCompleted {
		t.Fatalf("accept current gate = %#v, want completed gate", current)
	}

	current, err = service.DeclineConfirmation(ctx, gate.ID, "late rejection")
	if !errors.Is(err, ErrGateConflict) {
		t.Fatalf("decline error = %v, want ErrGateConflict", err)
	}
	if current.ID != gate.ID || current.Status != GateCompleted {
		t.Fatalf("decline current gate = %#v, want completed gate", current)
	}
}

func TestAcceptConfirmationRejectsExpiredGate(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	now := time.Date(2026, 5, 29, 10, 0, 0, 0, time.UTC)
	service := newTestService(Config{Store: store, UpstreamClient: &recordingUpstreamClient{}, Clock: func() time.Time { return now }})
	gate := GateRequest{
		ID:        "mcp_confirm_expired",
		Type:      GateTypeUserConfirmation,
		Provider:  GateProviderInternal,
		Status:    GatePending,
		ActorID:   "sales_zhang",
		ExpiresAt: now.Add(-time.Minute),
		CreatedAt: now.Add(-time.Hour),
		UpdatedAt: now.Add(-time.Hour),
	}
	if err := store.SaveGateRequest(ctx, gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}

	expired, err := service.AcceptConfirmation(ctx, gate.ID)
	if !errors.Is(err, ErrGateConflict) {
		t.Fatalf("accept error = %v, want gate conflict", err)
	}
	if expired.Status != GateExpired {
		t.Fatalf("expired status = %q, want expired", expired.Status)
	}
}

func TestAcceptConfirmationFailsWhenGrantRevokedAfterGateCreated(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	capability.SchemaHash, err = SchemaHash(capability.InputSchema)
	if err != nil {
		t.Fatalf("schema hash: %v", err)
	}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
		RequestHeaders: JSONMap{"X-Request-ID": "req_gate_failed_123"},
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	gateID := result.StructuredContent.(JSONMap)["gate_id"].(string)
	if err := store.DeleteGrant(ctx, "grant_search"); err != nil {
		t.Fatalf("delete grant: %v", err)
	}

	failed, err := service.AcceptConfirmation(ctx, gateID)
	if err == nil {
		t.Fatal("accept confirmation succeeded after grant revoked")
	}
	if failed.Status != GateFailed {
		t.Fatalf("failed status = %q, want failed", failed.Status)
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if audits[0].Decision != DecisionConfirmationExecutionFailed {
		t.Fatalf("latest audit decision = %q, want confirmation_execution_failed", audits[0].Decision)
	}
	if audits[0].RequestID != "req_gate_failed_123" {
		t.Fatalf("latest audit request_id = %q, want req_gate_failed_123", audits[0].RequestID)
	}
	if audits[0].UserID != "usr_sales" {
		t.Fatalf("latest audit user_id = %q, want usr_sales", audits[0].UserID)
	}
}

func TestAcceptConfirmationFailsWhenSchemaChangedAfterGateCreated(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	capability.SchemaHash, err = SchemaHash(capability.InputSchema)
	if err != nil {
		t.Fatalf("schema hash: %v", err)
	}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	service := newTestService(Config{Store: store, UpstreamClient: &recordingUpstreamClient{}})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	gateID := result.StructuredContent.(JSONMap)["gate_id"].(string)
	capability.SchemaHash = "schema_changed"
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save changed capability: %v", err)
	}

	failed, err := service.AcceptConfirmation(ctx, gateID)
	if err == nil {
		t.Fatal("accept confirmation succeeded after schema changed")
	}
	if failed.Status != GateFailed || failed.Error != "schema_changed_after_confirmation" {
		t.Fatalf("failed gate = %#v", failed)
	}
}

func TestAcceptConfirmationCompletesWhenUpstreamSucceedsButAuditSaveFails(t *testing.T) {
	ctx := context.Background()
	auditErr := errors.New("audit store unavailable")
	store := &failingConfirmationAuditStore{MemoryStore: NewMemoryStore(), err: auditErr}
	seedGrantedAndUngrantedTools(t, ctx, store)
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	capability.ConfirmRequired = true
	capability.SchemaHash, err = SchemaHash(capability.InputSchema)
	if err != nil {
		t.Fatalf("schema hash: %v", err)
	}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	upstream := &recordingUpstreamClient{result: UpstreamCallResult{StructuredContent: JSONMap{"ok": true}}}
	service := newTestService(Config{Store: store, UpstreamClient: upstream})

	result, err := service.CallTool(ctx, ToolCallRequest{
		Identity:       AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"},
		ExposedName:    "crm.customer.search",
		Arguments:      JSONMap{"keyword": "acme"},
		BearerToken:    "delegated-token",
		InboundSession: "inbound-1",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	gateID := result.StructuredContent.(JSONMap)["gate_id"].(string)

	completed, err := service.AcceptConfirmation(ctx, gateID)
	if !errors.Is(err, auditErr) {
		t.Fatalf("accept error = %v, want audit error", err)
	}
	if completed.Status != GateCompleted || completed.ResponseBody["ok"] != true {
		t.Fatalf("completed gate = %#v", completed)
	}
	if upstream.calls != 1 {
		t.Fatalf("upstream calls = %d, want 1", upstream.calls)
	}
}

func seedGrantedAndUngrantedTools(t *testing.T, ctx context.Context, store Store) {
	t.Helper()
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	server := UpstreamServer{ID: "crm-main", Name: "CRM", Transport: TransportStreamableHTTP, Endpoint: "http://crm.example/mcp", Namespace: "crm", Status: StatusActive}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	search := Capability{ID: "cap_search", UpstreamServerID: "crm-main", Type: CapabilityTool, UpstreamName: "customer.search", ExposedName: "crm.customer.search", InputSchema: JSONMap{"type": "object", "required": []any{"keyword"}, "properties": JSONMap{"keyword": JSONMap{"type": "string"}}}, Status: StatusActive}
	delete := Capability{ID: "cap_delete", UpstreamServerID: "crm-main", Type: CapabilityTool, UpstreamName: "customer.delete", ExposedName: "crm.customer.delete", InputSchema: JSONMap{"type": "object"}, Status: StatusActive}
	if err := store.SaveCapability(ctx, search); err != nil {
		t.Fatalf("save search: %v", err)
	}
	if err := store.SaveCapability(ctx, delete); err != nil {
		t.Fatalf("save delete: %v", err)
	}
	grant := AccountGrant{ID: "grant_search", UserID: "usr_sales", CapabilityID: "cap_search", GrantType: GrantTool}
	if err := store.SaveGrant(ctx, grant); err != nil {
		t.Fatalf("save grant: %v", err)
	}
}

func TestMemoryStoreSavesAndListsActiveToolCapabilities(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()

	server := UpstreamServer{
		ID:        "crm-main",
		Name:      "CRM Main",
		Domain:    "crm",
		Transport: TransportStreamableHTTP,
		Endpoint:  "http://crm.example/mcp",
		Namespace: "crm",
		Status:    StatusActive,
	}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}

	capability := Capability{
		ID:               "cap_crm_customer_search",
		UpstreamServerID: "crm-main",
		Type:             CapabilityTool,
		UpstreamName:     "customer.search",
		ExposedName:      "crm.customer.search",
		Title:            "Search CRM customers",
		Description:      "Search CRM customers by keyword",
		InputSchema:      JSONMap{"type": "object", "properties": JSONMap{"keyword": JSONMap{"type": "string"}}},
		Status:           StatusActive,
		Version:          "v1",
	}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}

	got, err := store.ListCapabilities(ctx, CapabilityFilter{Type: CapabilityTool, Status: StatusActive})
	if err != nil {
		t.Fatalf("list capabilities: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("capabilities length = %d, want 1", len(got))
	}
	if got[0].ExposedName != "crm.customer.search" {
		t.Fatalf("exposed name = %q, want crm.customer.search", got[0].ExposedName)
	}
	if got[0].InputSchema["type"] != "object" {
		t.Fatalf("input schema type = %v, want object", got[0].InputSchema["type"])
	}
}

func TestMemoryStoreCopiesCapabilityJSONMaps(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	inputSchema := JSONMap{
		"properties": JSONMap{"keyword": JSONMap{"type": "string"}},
		"required":   []JSONMap{{"name": "keyword"}},
	}

	if err := store.SaveCapability(ctx, Capability{
		ID:          "cap_search",
		Type:        CapabilityTool,
		ExposedName: "crm.search",
		InputSchema: inputSchema,
		Status:      StatusActive,
	}); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	inputSchema["properties"].(JSONMap)["keyword"].(JSONMap)["type"] = "number"

	got, err := store.GetCapabilityByExposedName(ctx, "crm.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	got.InputSchema["properties"].(JSONMap)["keyword"].(JSONMap)["type"] = "boolean"

	gotAgain, err := store.GetCapabilityByExposedName(ctx, "crm.search")
	if err != nil {
		t.Fatalf("get capability again: %v", err)
	}
	if gotAgain.InputSchema["properties"].(JSONMap)["keyword"].(JSONMap)["type"] != "string" {
		t.Fatalf("stored input schema type = %v, want string", gotAgain.InputSchema["properties"].(JSONMap)["keyword"].(JSONMap)["type"])
	}
	gotAgain.InputSchema["required"].([]JSONMap)[0]["name"] = "account"

	gotThird, err := store.GetCapabilityByExposedName(ctx, "crm.search")
	if err != nil {
		t.Fatalf("get capability third time: %v", err)
	}
	if gotThird.InputSchema["required"].([]JSONMap)[0]["name"] != "keyword" {
		t.Fatalf("stored required name = %v, want keyword", gotThird.InputSchema["required"].([]JSONMap)[0]["name"])
	}
}

func TestMemoryStoreCopiesGrantDataScope(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	dataScope := JSONMap{"regions": []map[string]any{{"id": "north"}}}

	if err := store.SaveGrant(ctx, AccountGrant{
		ID:        "grant_search",
		UserID:    "agent_crm",
		GrantType: GrantTool,
		DataScope: dataScope,
	}); err != nil {
		t.Fatalf("save grant: %v", err)
	}
	dataScope["regions"].([]map[string]any)[0]["id"] = "south"

	grants, err := store.ListGrants(ctx, GrantFilter{UserID: "agent_crm"})
	if err != nil {
		t.Fatalf("list grants: %v", err)
	}
	grants[0].DataScope["regions"].([]map[string]any)[0]["id"] = "east"

	grantsAgain, err := store.ListGrants(ctx, GrantFilter{UserID: "agent_crm"})
	if err != nil {
		t.Fatalf("list grants again: %v", err)
	}
	if grantsAgain[0].DataScope["regions"].([]map[string]any)[0]["id"] != "north" {
		t.Fatalf("stored region id = %v, want north", grantsAgain[0].DataScope["regions"].([]map[string]any)[0]["id"])
	}
}

func TestMemoryStoreDeleteGrantRemovesOnlyMatchingGrant(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	for _, grant := range []AccountGrant{
		{ID: "grant_search", UserID: "agent_crm", CapabilityID: "cap_search", GrantType: GrantTool},
		{ID: "grant_delete", UserID: "agent_crm", CapabilityID: "cap_delete", GrantType: GrantTool},
	} {
		if err := store.SaveGrant(ctx, grant); err != nil {
			t.Fatalf("save grant %s: %v", grant.ID, err)
		}
	}

	if err := store.DeleteGrant(ctx, "grant_search"); err != nil {
		t.Fatalf("delete grant: %v", err)
	}
	grants, err := store.ListGrants(ctx, GrantFilter{UserID: "agent_crm"})
	if err != nil {
		t.Fatalf("list grants: %v", err)
	}
	if len(grants) != 1 || grants[0].ID != "grant_delete" {
		t.Fatalf("remaining grants = %#v, want only grant_delete", grants)
	}
	if err := store.DeleteGrant(ctx, "grant_missing"); !errors.Is(err, ErrGrantNotFound) {
		t.Fatalf("delete missing grant error = %v, want %v", err, ErrGrantNotFound)
	}
}

func TestMemoryStoreDeleteAgentPreservesAccountCredentialsAndGrants(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	for _, agent := range []AgentRegistration{
		{AgentID: "agent_delete", Status: StatusActive},
		{AgentID: "agent_keep", Status: StatusActive},
	} {
		if err := store.SaveAgent(ctx, agent); err != nil {
			t.Fatalf("save agent %s: %v", agent.AgentID, err)
		}
	}
	token := AccountToken{ID: "token_account", UserID: "user_shared", TokenHash: "hash_account", Status: StatusActive}
	if err := store.RotateAccountToken(ctx, token.UserID, token); err != nil {
		t.Fatalf("save token: %v", err)
	}
	for _, grant := range []AccountGrant{
		{ID: "grant_delete", UserID: "user_shared", CapabilityID: "cap_delete", GrantType: GrantTool},
		{ID: "grant_keep", UserID: "user_shared", CapabilityID: "cap_keep", GrantType: GrantTool},
	} {
		if err := store.SaveGrant(ctx, grant); err != nil {
			t.Fatalf("save grant %s: %v", grant.ID, err)
		}
	}

	if err := store.DeleteAgent(ctx, "agent_delete"); err != nil {
		t.Fatalf("delete agent: %v", err)
	}
	if _, err := store.GetAgent(ctx, "agent_delete"); !errors.Is(err, ErrAgentNotFound) {
		t.Fatalf("deleted agent error = %v, want %v", err, ErrAgentNotFound)
	}
	if _, err := store.GetAccountTokenByHash(ctx, "hash_account"); err != nil {
		t.Fatalf("account token was removed: %v", err)
	}
	grants, err := store.ListGrants(ctx, GrantFilter{UserID: "user_shared"})
	if err != nil || len(grants) != 2 {
		t.Fatalf("account grants = %#v, error = %v", grants, err)
	}
	if _, err := store.GetAgent(ctx, "agent_keep"); err != nil {
		t.Fatalf("get retained agent: %v", err)
	}
	if err := store.DeleteAgent(ctx, "agent_delete"); !errors.Is(err, ErrAgentNotFound) {
		t.Fatalf("delete missing agent error = %v, want %v", err, ErrAgentNotFound)
	}
}

func TestIssueRotateAndRevokeAccountToken(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := newTestService(Config{Store: store, TokenCipher: testTokenCipher()})
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "agent_crm", ClientID: "client_crm", ActorID: "actor_crm", Status: StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}

	issued, err := service.RotateAccountToken(ctx, AccountTokenIssueRequest{UserID: "agent_crm", Scopes: []string{"mcp:call"}})
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	if issued.Plaintext == "" || issued.Token.TokenHash == "" || issued.Token.Fingerprint == "" {
		t.Fatalf("issued token = %#v", issued)
	}
	if issued.Token.Scopes[0] != "mcp:call" {
		t.Fatalf("scopes = %#v, want mcp:call", issued.Token.Scopes)
	}
	stored, err := store.GetAccountTokenByHash(ctx, HashToken(issued.Plaintext))
	if err != nil {
		t.Fatalf("get token by hash: %v", err)
	}
	if stored.ID != issued.Token.ID {
		t.Fatalf("stored token id = %q, want %q", stored.ID, issued.Token.ID)
	}

	rotated, err := service.RotateAccountToken(ctx, AccountTokenIssueRequest{UserID: "agent_crm"})
	if err != nil {
		t.Fatalf("rotate token: %v", err)
	}
	oldToken, err := store.GetAccountTokenByHash(ctx, HashToken(issued.Plaintext))
	if err != nil {
		t.Fatalf("get old token: %v", err)
	}
	if oldToken.Status != StatusRevoked {
		t.Fatalf("old token status = %q, want revoked", oldToken.Status)
	}
	if rotated.Plaintext == issued.Plaintext {
		t.Fatal("rotated token reused plaintext")
	}

	revoked, err := service.RevokeAccountToken(ctx, "agent_crm")
	if err != nil {
		t.Fatalf("revoke token: %v", err)
	}
	if revoked != 1 {
		t.Fatalf("revoked token count = %d, want 1", revoked)
	}
}

func TestRotateAccountTokenRequiresTokenCipher(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := newTestService(Config{Store: store})
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "agent_crm", Status: StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	if _, err := service.RotateAccountToken(ctx, AccountTokenIssueRequest{UserID: "agent_crm"}); !errors.Is(err, ErrTokenCipherNotConfigured) {
		t.Fatalf("issue token error = %v, want %v", err, ErrTokenCipherNotConfigured)
	}
}

func TestConcurrentAgentTokenRotationLeavesOnlyLastTokenActive(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	fixedNow := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	service := newTestService(Config{Store: store, TokenCipher: testTokenCipher(), Clock: func() time.Time { return fixedNow }})
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "agent_concurrent", Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	initial, err := service.RotateAccountToken(ctx, AccountTokenIssueRequest{UserID: "agent_concurrent"})
	if err != nil {
		t.Fatal(err)
	}

	const rotations = 8
	results := make(chan AccountTokenIssueResult, rotations)
	errs := make(chan error, rotations)
	var wg sync.WaitGroup
	for range rotations {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rotated, rotateErr := service.RotateAccountToken(ctx, AccountTokenIssueRequest{UserID: "agent_concurrent"})
			if rotateErr != nil {
				errs <- rotateErr
				return
			}
			results <- rotated
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for rotateErr := range errs {
		t.Error(rotateErr)
	}

	activeCount := 0
	all := []AccountTokenIssueResult{initial}
	tokenIDs := map[string]bool{initial.Token.ID: true}
	for result := range results {
		if tokenIDs[result.Token.ID] {
			t.Fatalf("duplicate token ID %q", result.Token.ID)
		}
		tokenIDs[result.Token.ID] = true
		all = append(all, result)
	}
	for _, result := range all {
		token, getErr := store.GetAccountTokenByHash(ctx, HashToken(result.Plaintext))
		if getErr != nil {
			t.Fatal(getErr)
		}
		if token.Status == StatusActive {
			activeCount++
		}
	}
	if activeCount != 1 {
		t.Fatalf("active token count = %d, want 1", activeCount)
	}
}

func TestCanIssueAccountTokenRequiresTokenCipher(t *testing.T) {
	service := newTestService(Config{Store: NewMemoryStore()})
	if err := service.CanIssueAccountToken(); !errors.Is(err, ErrTokenCipherNotConfigured) {
		t.Fatalf("can issue token error = %v, want %v", err, ErrTokenCipherNotConfigured)
	}

	service = newTestService(Config{Store: NewMemoryStore(), TokenCipher: testTokenCipher()})
	if err := service.CanIssueAccountToken(); err != nil {
		t.Fatalf("can issue token with cipher: %v", err)
	}
}

func TestRotateAccountTokenWithoutCipherDoesNotRevokeExistingToken(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "agent_crm", Status: StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	issuer := newTestService(Config{Store: store, TokenCipher: testTokenCipher()})
	issued, err := issuer.RotateAccountToken(ctx, AccountTokenIssueRequest{UserID: "agent_crm"})
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	rotator := newTestService(Config{Store: store})
	if _, err := rotator.RotateAccountToken(ctx, AccountTokenIssueRequest{UserID: "agent_crm"}); !errors.Is(err, ErrTokenCipherNotConfigured) {
		t.Fatalf("rotate token error = %v, want %v", err, ErrTokenCipherNotConfigured)
	}
	stored, err := store.GetAccountTokenByHash(ctx, HashToken(issued.Plaintext))
	if err != nil {
		t.Fatalf("get existing token: %v", err)
	}
	if stored.Status != StatusActive {
		t.Fatalf("existing token status = %q, want active", stored.Status)
	}
}

func TestRotateAccountTokenUsesFixedPrefixAndMaskedPlaintext(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	if err := store.SaveAgent(ctx, AgentRegistration{AgentID: "claw_mcp", Status: StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	svc := newTestService(Config{
		Store:       store,
		TokenCipher: NewStaticTokenCipherForTest([]byte("0123456789abcdef0123456789abcdef")),
	})
	issued, err := svc.RotateAccountToken(ctx, AccountTokenIssueRequest{UserID: "claw_mcp", Scopes: []string{"mcp:call"}})
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	if len(issued.Plaintext) != 32 || !strings.HasPrefix(issued.Plaintext, "agt_") {
		t.Fatalf("plaintext = %q, want 32-character agt_ token", issued.Plaintext)
	}
	copied, err := svc.CopyActiveAccountToken(ctx, "claw_mcp")
	if err != nil {
		t.Fatalf("copy token: %v", err)
	}
	if copied.Plaintext != issued.Plaintext {
		t.Fatalf("copied token mismatch")
	}
}

func testTokenCipher() TokenCipher {
	return NewStaticTokenCipherForTest([]byte("0123456789abcdef0123456789abcdef"))
}

func TestMemoryStoreCopiesProxyAuditRecordJSONMaps(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	record := ProxyAuditRecord{
		ID:              "audit_1",
		RequestHeaders:  JSONMap{"authorization": JSONMap{"scheme": "Bearer"}},
		RequestBody:     JSONMap{"filters": []JSONMap{{"field": "name"}}},
		ResponseHeaders: JSONMap{"content": []map[string]any{{"type": "application/json"}}},
		ResponseBody:    JSONMap{"results": []any{JSONMap{"id": "customer_1"}}},
	}

	if err := store.SaveProxyAuditRecord(ctx, record); err != nil {
		t.Fatalf("save audit: %v", err)
	}
	record.RequestHeaders["authorization"].(JSONMap)["scheme"] = "Basic"
	record.RequestBody["filters"].([]JSONMap)[0]["field"] = "email"
	record.ResponseHeaders["content"].([]map[string]any)[0]["type"] = "text/plain"
	record.ResponseBody["results"].([]any)[0].(JSONMap)["id"] = "customer_2"

	audits, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	audits[0].RequestHeaders["authorization"].(JSONMap)["scheme"] = "Digest"
	audits[0].RequestBody["filters"].([]JSONMap)[0]["field"] = "phone"
	audits[0].ResponseHeaders["content"].([]map[string]any)[0]["type"] = "application/xml"
	audits[0].ResponseBody["results"].([]any)[0].(JSONMap)["id"] = "customer_3"

	auditsAgain, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits again: %v", err)
	}
	if auditsAgain[0].RequestHeaders["authorization"].(JSONMap)["scheme"] != "Bearer" {
		t.Fatalf("stored request header scheme = %v, want Bearer", auditsAgain[0].RequestHeaders["authorization"].(JSONMap)["scheme"])
	}
	if auditsAgain[0].RequestBody["filters"].([]JSONMap)[0]["field"] != "name" {
		t.Fatalf("stored request body field = %v, want name", auditsAgain[0].RequestBody["filters"].([]JSONMap)[0]["field"])
	}
	if auditsAgain[0].ResponseHeaders["content"].([]map[string]any)[0]["type"] != "application/json" {
		t.Fatalf("stored response header type = %v, want application/json", auditsAgain[0].ResponseHeaders["content"].([]map[string]any)[0]["type"])
	}
	if auditsAgain[0].ResponseBody["results"].([]any)[0].(JSONMap)["id"] != "customer_1" {
		t.Fatalf("stored response body id = %v, want customer_1", auditsAgain[0].ResponseBody["results"].([]any)[0].(JSONMap)["id"])
	}
}

func TestMemoryStoreFiltersProxyAuditRecords(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	now := time.Date(2026, 5, 27, 12, 0, 0, 0, time.UTC)
	for _, record := range []ProxyAuditRecord{
		{ID: "audit_old", AgentID: "agent_a", UpstreamServerID: "crm-main", CapabilityID: "cap_search", ExposedName: "crm.customer.search", Decision: DecisionAllowed, CreatedAt: now.Add(-2 * time.Hour)},
		{ID: "audit_match", AgentID: "agent_a", UpstreamServerID: "crm-main", CapabilityID: "cap_search", ExposedName: "crm.customer.search", Decision: DecisionAllowed, CreatedAt: now, Error: "upstream failed"},
		{ID: "audit_other", AgentID: "agent_b", UpstreamServerID: "erp-main", CapabilityID: "cap_inventory", ExposedName: "erp.inventory.query", Decision: DecisionNoMatchingGrant, CreatedAt: now},
	} {
		if err := store.SaveProxyAuditRecord(ctx, record); err != nil {
			t.Fatalf("save audit %s: %v", record.ID, err)
		}
	}

	got, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{
		Limit:            10,
		Decision:         DecisionAllowed,
		AgentID:          "agent_a",
		UpstreamServerID: "crm-main",
		Tool:             "crm.customer.search",
		CreatedFrom:      now.Add(-time.Hour),
		CreatedTo:        now.Add(time.Hour),
		ErrorOnly:        true,
	})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if len(got) != 1 || got[0].ID != "audit_match" {
		t.Fatalf("filtered audits = %#v, want audit_match", got)
	}
}

func TestMemoryStoreFiltersProxyAuditRecordsByID(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	for index := 0; index < 201; index++ {
		id := fmt.Sprintf("audit_%03d", index)
		if err := store.SaveProxyAuditRecord(ctx, ProxyAuditRecord{ID: id, CreatedAt: time.Unix(int64(index), 0)}); err != nil {
			t.Fatalf("save audit %s: %v", id, err)
		}
	}

	got, err := store.ListProxyAuditRecords(ctx, ProxyAuditFilter{ID: "audit_000", Limit: 1})
	if err != nil {
		t.Fatalf("list audit by id: %v", err)
	}
	if len(got) != 1 || got[0].ID != "audit_000" {
		t.Fatalf("audit by id = %#v, want audit_000", got)
	}
}

func TestMemoryStoreReplacesDuplicateCapabilityExposedName(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()

	if err := store.SaveCapability(ctx, Capability{
		ID:          "cap_old",
		Type:        CapabilityTool,
		ExposedName: "crm.search",
		Status:      StatusActive,
	}); err != nil {
		t.Fatalf("save old capability: %v", err)
	}
	if err := store.SaveCapability(ctx, Capability{
		ID:          "cap_new",
		Type:        CapabilityTool,
		ExposedName: "crm.search",
		Status:      StatusActive,
	}); err != nil {
		t.Fatalf("save new capability: %v", err)
	}

	got, err := store.GetCapabilityByExposedName(ctx, "crm.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	if got.ID != "cap_new" {
		t.Fatalf("capability ID = %q, want cap_new", got.ID)
	}
	capabilities, err := store.ListCapabilities(ctx, CapabilityFilter{Type: CapabilityTool})
	if err != nil {
		t.Fatalf("list capabilities: %v", err)
	}
	if len(capabilities) != 1 {
		t.Fatalf("capabilities length = %d, want 1", len(capabilities))
	}
}

func TestMemoryStoreFiltersCapabilitiesByUpstreamServer(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()

	for _, capability := range []Capability{
		{ID: "cap_crm", UpstreamServerID: "crm-main", Type: CapabilityTool, ExposedName: "crm.customer.search", Status: StatusActive},
		{ID: "cap_erp", UpstreamServerID: "erp-main", Type: CapabilityTool, ExposedName: "erp.inventory.query", Status: StatusActive},
	} {
		if err := store.SaveCapability(ctx, capability); err != nil {
			t.Fatalf("save capability %s: %v", capability.ID, err)
		}
	}

	got, err := store.ListCapabilities(ctx, CapabilityFilter{UpstreamServerID: "crm-main"})
	if err != nil {
		t.Fatalf("list capabilities: %v", err)
	}
	if len(got) != 1 || got[0].ID != "cap_crm" {
		t.Fatalf("filtered capabilities = %#v, want cap_crm", got)
	}
}

func TestMemoryStoreListsInStableOrder(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()

	for _, agentID := range []string{"agent-b", "agent-a"} {
		if err := store.SaveAgent(ctx, AgentRegistration{AgentID: agentID}); err != nil {
			t.Fatalf("save agent %s: %v", agentID, err)
		}
	}
	for _, id := range []string{"server-b", "server-a"} {
		if err := store.SaveUpstreamServer(ctx, UpstreamServer{ID: id}); err != nil {
			t.Fatalf("save server %s: %v", id, err)
		}
	}
	for _, capability := range []Capability{
		{ID: "cap-b", ExposedName: "crm.z"},
		{ID: "cap-a", ExposedName: "crm.a"},
	} {
		if err := store.SaveCapability(ctx, capability); err != nil {
			t.Fatalf("save capability %s: %v", capability.ID, err)
		}
	}
	for _, id := range []string{"grant-b", "grant-a"} {
		if err := store.SaveGrant(ctx, AccountGrant{ID: id, UserID: "user-a", CapabilityID: id, GrantType: GrantTool}); err != nil {
			t.Fatalf("save grant %s: %v", id, err)
		}
	}

	agents, err := store.ListAgents(ctx, AgentFilter{})
	if err != nil {
		t.Fatalf("list agents: %v", err)
	}
	if agents[0].AgentID != "agent-a" || agents[1].AgentID != "agent-b" {
		t.Fatalf("agents order = %q, %q; want agent-a, agent-b", agents[0].AgentID, agents[1].AgentID)
	}
	servers, err := store.ListUpstreamServers(ctx)
	if err != nil {
		t.Fatalf("list servers: %v", err)
	}
	if servers[0].ID != "server-a" || servers[1].ID != "server-b" {
		t.Fatalf("servers order = %q, %q; want server-a, server-b", servers[0].ID, servers[1].ID)
	}
	capabilities, err := store.ListCapabilities(ctx, CapabilityFilter{})
	if err != nil {
		t.Fatalf("list capabilities: %v", err)
	}
	if capabilities[0].ExposedName != "crm.a" || capabilities[1].ExposedName != "crm.z" {
		t.Fatalf("capabilities order = %q, %q; want crm.a, crm.z", capabilities[0].ExposedName, capabilities[1].ExposedName)
	}
	grants, err := store.ListGrants(ctx, GrantFilter{})
	if err != nil {
		t.Fatalf("list grants: %v", err)
	}
	if grants[0].ID != "grant-a" || grants[1].ID != "grant-b" {
		t.Fatalf("grants order = %q, %q; want grant-a, grant-b", grants[0].ID, grants[1].ID)
	}
}

func TestDecideGrantAllowsOnlyActiveMatchingGrant(t *testing.T) {
	now := time.Now().UTC()
	future := now.Add(time.Hour)
	past := now.Add(-time.Hour)

	allowed := DecideGrant(now, []AccountGrant{{
		ID:           "grant_1",
		UserID:       "sales_zhang_agent",
		CapabilityID: "cap_crm_customer_search",
		GrantType:    GrantTool,
		ExpiresAt:    &future,
	}}, "sales_zhang_agent", "cap_crm_customer_search", GrantTool)
	if !allowed.Allowed || allowed.Reason != DecisionAllowed {
		t.Fatalf("allowed decision = %#v, want allowed", allowed)
	}

	expired := DecideGrant(now, []AccountGrant{{
		ID:           "grant_2",
		UserID:       "sales_zhang_agent",
		CapabilityID: "cap_crm_customer_search",
		GrantType:    GrantTool,
		ExpiresAt:    &past,
	}}, "sales_zhang_agent", "cap_crm_customer_search", GrantTool)
	if expired.Allowed || expired.Reason != DecisionGrantExpired {
		t.Fatalf("expired decision = %#v, want grant_expired", expired)
	}

	missing := DecideGrant(now, nil, "sales_zhang_agent", "cap_crm_customer_search", GrantTool)
	if missing.Allowed || missing.Reason != DecisionNoMatchingGrant {
		t.Fatalf("missing decision = %#v, want no_matching_grant", missing)
	}
}

func TestDecideGrantReturnsTheSingleMatchedGrant(t *testing.T) {
	now := time.Date(2026, 7, 26, 10, 0, 0, 0, time.UTC)
	grant := AccountGrant{ID: "grant_1", UserID: "agent_1", CapabilityID: "cap_1", GrantType: GrantTool}
	decision := DecideGrant(now, []AccountGrant{grant}, "agent_1", "cap_1", GrantTool)
	if !decision.Allowed || decision.Grant == nil || decision.Grant.ID != grant.ID {
		t.Fatalf("decision = %#v", decision)
	}
}

func TestDecideGrantTreatsExpiresAtEqualToNowAsExpired(t *testing.T) {
	now := time.Now().UTC()

	decision := DecideGrant(now, []AccountGrant{{
		ID:           "grant_equal_now",
		UserID:       "sales_zhang_agent",
		CapabilityID: "cap_crm_customer_search",
		GrantType:    GrantTool,
		ExpiresAt:    &now,
	}}, "sales_zhang_agent", "cap_crm_customer_search", GrantTool)
	if decision.Allowed || decision.Reason != DecisionGrantExpired {
		t.Fatalf("decision = %#v, want grant_expired", decision)
	}
}

func TestDecideGrantActiveMatchWinsAfterExpiredMatch(t *testing.T) {
	now := time.Now().UTC()
	past := now.Add(-time.Hour)
	future := now.Add(time.Hour)

	decision := DecideGrant(now, []AccountGrant{
		{
			ID:           "grant_expired",
			UserID:       "sales_zhang_agent",
			CapabilityID: "cap_crm_customer_search",
			GrantType:    GrantTool,
			ExpiresAt:    &past,
		},
		{
			ID:           "grant_active",
			UserID:       "sales_zhang_agent",
			CapabilityID: "cap_crm_customer_search",
			GrantType:    GrantTool,
			ExpiresAt:    &future,
		},
	}, "sales_zhang_agent", "cap_crm_customer_search", GrantTool)
	if !decision.Allowed || decision.Reason != DecisionAllowed {
		t.Fatalf("decision = %#v, want allowed", decision)
	}
}

func TestDecideGrantIgnoresExpiredMismatchedGrants(t *testing.T) {
	now := time.Now().UTC()
	past := now.Add(-time.Hour)

	decision := DecideGrant(now, []AccountGrant{
		{
			ID:           "grant_other_agent",
			UserID:       "finance_li_agent",
			CapabilityID: "cap_crm_customer_search",
			GrantType:    GrantTool,
			ExpiresAt:    &past,
		},
		{
			ID:           "grant_other_capability",
			UserID:       "sales_zhang_agent",
			CapabilityID: "cap_crm_account_search",
			GrantType:    GrantTool,
			ExpiresAt:    &past,
		},
		{
			ID:           "grant_other_type",
			UserID:       "sales_zhang_agent",
			CapabilityID: "cap_crm_customer_search",
			GrantType:    GrantResource,
			ExpiresAt:    &past,
		},
	}, "sales_zhang_agent", "cap_crm_customer_search", GrantTool)
	if decision.Allowed || decision.Reason != DecisionNoMatchingGrant {
		t.Fatalf("decision = %#v, want no_matching_grant", decision)
	}
}
