package mcpserver_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/mcpserver"
)

type bearerRoundTripper struct {
	token          string
	firstRequestID string
	requestID      string
	base           http.RoundTripper
	count          int
}

func (rt *bearerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	rt.count++
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+rt.token)
	requestID := rt.requestID
	if rt.count == 1 && rt.firstRequestID != "" {
		requestID = rt.firstRequestID
	}
	if requestID != "" {
		req.Header.Set("X-Request-ID", requestID)
	}
	base := rt.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(req)
}

type mutableBearerRoundTripper struct {
	token *string
	base  http.RoundTripper
}

func (rt mutableBearerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+*rt.token)
	base := rt.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(req)
}

type testProxyUpstreamClient struct {
	result   mcpgateway.UpstreamCallResult
	calls    int
	lastCall mcpgateway.UpstreamCallRequest
}

func newTestProxyGateway(cfg mcpgateway.Config) *mcpgateway.Service {
	service := mcpgateway.NewService(cfg)
	service.SetIdentityResolvers(
		func(context.Context, string) (string, error) { return "sales_zhang", nil },
		func(context.Context, string) error { return nil },
	)
	return service
}

func (c *testProxyUpstreamClient) ListTools(ctx context.Context, server mcpgateway.UpstreamServer, bearerToken string) ([]mcpgateway.UpstreamTool, error) {
	return nil, nil
}

func (c *testProxyUpstreamClient) CallTool(ctx context.Context, req mcpgateway.UpstreamCallRequest) (mcpgateway.UpstreamCallResult, error) {
	c.calls++
	c.lastCall = req
	return c.result, nil
}

func TestMCPServerExposesOnlyGrantedProxyTools(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	server := mcpgateway.UpstreamServer{ID: "crm-main", Name: "CRM", Transport: mcpgateway.TransportStreamableHTTP, Endpoint: "http://crm.example/mcp", Namespace: "crm", Status: mcpgateway.StatusActive}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	search := mcpgateway.Capability{ID: "cap_search", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool, UpstreamName: "customer.search", ExposedName: "crm.customer.search", InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusActive}
	deleteTool := mcpgateway.Capability{ID: "cap_delete", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool, UpstreamName: "customer.delete", ExposedName: "crm.customer.delete", InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusActive}
	if err := store.SaveCapability(ctx, search); err != nil {
		t.Fatalf("save search: %v", err)
	}
	if err := store.SaveCapability(ctx, deleteTool); err != nil {
		t.Fatalf("save delete: %v", err)
	}
	if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_search", UserID: "sales_zhang", CapabilityID: "cap_search", GrantType: mcpgateway.GrantTool}); err != nil {
		t.Fatalf("save grant: %v", err)
	}

	httpServer := httptest.NewServer(auth.RequireBearerToken(testVerifier, nil)(
		mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
			return mcpserver.New(mcpserver.Options{
				ProxyGateway: newTestProxyGateway(mcpgateway.Config{Store: store}),
			}, r)
		}, &mcp.StreamableHTTPOptions{Stateless: false}),
	))
	defer httpServer.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "claw-mcp-test-client", Version: "v0.1.0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: httpServer.URL,
		HTTPClient: &http.Client{
			Transport: &bearerRoundTripper{token: "demo-zhang-token"},
		},
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer session.Close()
	if got := session.InitializeResult().ProtocolVersion; got != "2025-11-25" {
		t.Fatalf("protocol version = %q, want 2025-11-25", got)
	}

	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	names := map[string]bool{}
	for _, tool := range tools.Tools {
		names[tool.Name] = true
	}
	if names["agent_action"] {
		t.Fatal("agent_action must not be exposed by default")
	}
	if !names["crm.customer.search"] {
		t.Fatal("granted proxy tool not exposed")
	}
	if names["crm.customer.delete"] {
		t.Fatal("ungranted proxy tool exposed")
	}
}

func TestMCPUpstreamEndpointUsesLocalToolNamesAndOmitsGateTools(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	upstream := &testProxyUpstreamClient{result: mcpgateway.UpstreamCallResult{StructuredContent: mcpgateway.JSONMap{"ok": true}}}
	if err := store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{
		ID: "crm-main", Name: "CRM", Namespace: "crm", Status: mcpgateway.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{
		ID: "erp-main", Name: "ERP", Namespace: "erp", Status: mcpgateway.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	for _, capability := range []mcpgateway.Capability{
		{ID: "cap_search", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool, UpstreamName: "customer.search", ExposedName: "crm.customer.search", InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusActive},
		{ID: "cap_inventory", UpstreamServerID: "erp-main", Type: mcpgateway.CapabilityTool, UpstreamName: "inventory.query", ExposedName: "erp.inventory.query", InputSchema: mcpgateway.JSONMap{"type": "object"}, Status: mcpgateway.StatusActive},
	} {
		if err := store.SaveCapability(ctx, capability); err != nil {
			t.Fatal(err)
		}
		if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_" + capability.ID, UserID: "sales_zhang", CapabilityID: capability.ID, GrantType: mcpgateway.GrantTool}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	proxy := newTestProxyGateway(mcpgateway.Config{Store: store, UpstreamClient: upstream})
	httpServer := httptest.NewServer(auth.RequireBearerToken(testVerifier, nil)(
		mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
			return mcpserver.New(mcpserver.Options{ProxyGateway: proxy, UpstreamServerID: "crm-main"}, r)
		}, nil),
	))
	defer httpServer.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "agent", Version: "v0.1.0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   httpServer.URL,
		HTTPClient: &http.Client{Transport: &bearerRoundTripper{token: "demo-zhang-token"}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tools.Tools) != 1 || tools.Tools[0].Name != "customer.search" {
		t.Fatalf("tools = %#v, want only customer.search", tools.Tools)
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "customer.search", Arguments: map[string]any{}})
	if err != nil || result.IsError {
		t.Fatalf("call local tool result = %#v error = %v", result, err)
	}
	if upstream.calls != 1 || upstream.lastCall.Capability.ExposedName != "crm.customer.search" {
		t.Fatalf("upstream call = %#v, want internal exposed name", upstream.lastCall)
	}
}

func TestMCPServerSyncConfirmationUsesClientElicitation(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	upstream := &testProxyUpstreamClient{result: mcpgateway.UpstreamCallResult{StructuredContent: mcpgateway.JSONMap{"ok": true}}}
	server := mcpgateway.UpstreamServer{ID: "crm-main", Name: "CRM", Transport: mcpgateway.TransportStreamableHTTP, Endpoint: "http://crm.example/mcp", Namespace: "crm", Status: mcpgateway.StatusActive}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	capability := mcpgateway.Capability{
		ID: "cap_search", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool,
		UpstreamName: "customer.search", ExposedName: "crm.customer.search",
		InputSchema: mcpgateway.JSONMap{"type": "object", "required": []any{"keyword"}, "properties": mcpgateway.JSONMap{"keyword": mcpgateway.JSONMap{"type": "string"}}},
		Status:      mcpgateway.StatusActive, ConfirmRequired: true,
	}
	hash, err := mcpgateway.SchemaHash(capability.InputSchema)
	if err != nil {
		t.Fatalf("schema hash: %v", err)
	}
	capability.SchemaHash = hash
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_search", UserID: "sales_zhang", CapabilityID: "cap_search", GrantType: mcpgateway.GrantTool}); err != nil {
		t.Fatalf("save grant: %v", err)
	}

	httpServer := httptest.NewServer(auth.RequireBearerToken(testVerifier, nil)(
		mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
			return mcpserver.New(mcpserver.Options{
				ProxyGateway: newTestProxyGateway(mcpgateway.Config{Store: store, UpstreamClient: upstream}),
			}, r)
		}, nil),
	))
	defer httpServer.Close()

	var elicitationMessages []string
	client := mcp.NewClient(&mcp.Implementation{Name: "claw-mcp-test-client", Version: "v0.1.0"}, &mcp.ClientOptions{
		Capabilities: &mcp.ClientCapabilities{
			Elicitation: &mcp.ElicitationCapabilities{Form: &mcp.FormElicitationCapabilities{}},
		},
		ElicitationHandler: func(ctx context.Context, req *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
			elicitationMessages = append(elicitationMessages, req.Params.Message)
			return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": true}}, nil
		},
	})
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   httpServer.URL,
		HTTPClient: &http.Client{Transport: &bearerRoundTripper{token: "demo-zhang-token"}},
	}, nil)
	if err != nil {
		t.Fatalf("connect streamable HTTP client: %v", err)
	}
	defer session.Close()

	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "crm.customer.search",
		Arguments: map[string]any{"keyword": "acme"},
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if result.IsError {
		t.Fatalf("result IsError = true, content = %#v", result.Content)
	}
	content := result.StructuredContent.(map[string]any)
	if content["ok"] != true {
		t.Fatalf("structured content = %#v, want ok true", content)
	}
	if len(elicitationMessages) != 1 || !strings.Contains(elicitationMessages[0], "crm.customer.search") {
		t.Fatalf("elicitation messages = %#v, want tool name", elicitationMessages)
	}
	if upstream.calls != 1 {
		t.Fatalf("upstream calls = %d, want 1", upstream.calls)
	}
}

func TestMCPServerMultiRoundTripConfirmation(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	upstream := &testProxyUpstreamClient{result: mcpgateway.UpstreamCallResult{StructuredContent: mcpgateway.JSONMap{"ok": true}}}
	server := mcpgateway.UpstreamServer{ID: "crm-main", Name: "CRM", Transport: mcpgateway.TransportStreamableHTTP, Endpoint: "http://crm.example/mcp", Namespace: "crm", Status: mcpgateway.StatusActive}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	capability := mcpgateway.Capability{
		ID: "cap_search", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool,
		UpstreamName: "customer.search", ExposedName: "crm.customer.search",
		InputSchema: mcpgateway.JSONMap{"type": "object", "required": []any{"keyword"}, "properties": mcpgateway.JSONMap{"keyword": mcpgateway.JSONMap{"type": "string"}}},
		Status:      mcpgateway.StatusActive, ConfirmRequired: true,
	}
	var err error
	capability.SchemaHash, err = mcpgateway.SchemaHash(capability.InputSchema)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_search", UserID: "sales_zhang", CapabilityID: capability.ID, GrantType: mcpgateway.GrantTool}); err != nil {
		t.Fatal(err)
	}

	proxy := newTestProxyGateway(mcpgateway.Config{Store: store, UpstreamClient: upstream})
	verifier := func(ctx context.Context, token string, req *http.Request) (*auth.TokenInfo, error) {
		if token != "demo-zhang-token" && token != "demo-zhang-token-2" {
			return nil, auth.ErrInvalidToken
		}
		return &auth.TokenInfo{
			UserID:     "sales_zhang",
			Scopes:     []string{"mcp:call"},
			Expiration: time.Now().Add(time.Hour),
			Extra: map[string]any{
				"sub":       "sales_zhang",
				"user_id":   "sales_zhang",
				"client_id": "hermes-sales-demo",
				"agent_id":  "sales_zhang_agent",
				"iss":       "claw-mcp-demo",
				"jti":       token,
			},
		}, nil
	}
	httpServer := httptest.NewServer(auth.RequireBearerToken(verifier, nil)(
		mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
			return mcpserver.New(mcpserver.Options{ProxyGateway: proxy}, r)
		}, &mcp.StreamableHTTPOptions{Stateless: true}),
	))
	defer httpServer.Close()

	token := "demo-zhang-token"
	client := mcp.NewClient(&mcp.Implementation{Name: "claw-mcp-test-client", Version: "v0.1.0"}, &mcp.ClientOptions{
		MultiRoundTrip: &mcp.MultiRoundTripOptions{Disabled: true},
	})
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   httpServer.URL,
		HTTPClient: &http.Client{Transport: mutableBearerRoundTripper{token: &token}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if got := session.InitializeResult().ProtocolVersion; got != "2026-07-28" {
		t.Fatalf("protocol version = %q, want 2026-07-28", got)
	}

	args := map[string]any{"keyword": "acme"}
	first, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "crm.customer.search", Arguments: args})
	if err != nil {
		t.Fatal(err)
	}
	if !first.NeedsInput() || first.RequestState == "" {
		t.Fatalf("first result = %#v, want input_required with request state", first)
	}
	if _, ok := first.InputRequests["confirmation"].(*mcp.ElicitParams); !ok {
		t.Fatalf("confirmation input request = %T, want *mcp.ElicitParams", first.InputRequests["confirmation"])
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls before confirmation = %d, want 0", upstream.calls)
	}

	acceptedParams := &mcp.CallToolParams{
		Name:      "crm.customer.search",
		Arguments: args,
		InputResponses: mcp.InputResponseMap{
			"confirmation": &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": true}},
		},
		RequestState: first.RequestState,
	}
	accepted, err := session.CallTool(ctx, acceptedParams)
	if err != nil {
		t.Fatal(err)
	}
	if accepted.IsError || accepted.NeedsInput() {
		t.Fatalf("accepted result = %#v, want complete success", accepted)
	}
	if upstream.calls != 1 {
		t.Fatalf("upstream calls after acceptance = %d, want 1", upstream.calls)
	}
	completedGates, err := store.ListGateRequests(ctx, mcpgateway.GateFilter{Status: string(mcpgateway.GateCompleted), AgentID: "sales_zhang_agent"})
	if err != nil {
		t.Fatal(err)
	}
	if len(completedGates) != 1 || completedGates[0].RequestAuditID == "" || completedGates[0].ExecutionAuditID == "" {
		t.Fatalf("completed gates = %#v, want linked request and execution audits", completedGates)
	}
	audits, err := store.ListProxyAuditRecords(ctx, mcpgateway.ProxyAuditFilter{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	var requestTraceID, executionTraceID string
	for _, audit := range audits {
		switch audit.ID {
		case completedGates[0].RequestAuditID:
			requestTraceID = audit.TraceID
		case completedGates[0].ExecutionAuditID:
			executionTraceID = audit.TraceID
		}
	}
	if requestTraceID == "" || requestTraceID != executionTraceID || requestTraceID != completedGates[0].TraceID {
		t.Fatalf("audit trace IDs request=%q execution=%q gate=%q", requestTraceID, executionTraceID, completedGates[0].TraceID)
	}

	replayed, err := session.CallTool(ctx, acceptedParams)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.IsError || upstream.calls != 1 {
		t.Fatalf("replayed result = %#v, upstream calls = %d, want idempotent success", replayed, upstream.calls)
	}

	tampered := *acceptedParams
	tampered.Arguments = map[string]any{"keyword": "different"}
	if _, err := session.CallTool(ctx, &tampered); err == nil {
		t.Fatal("tampered arguments error = nil, want rejection")
	}
	tampered = *acceptedParams
	tampered.RequestState += "-tampered"
	if _, err := session.CallTool(ctx, &tampered); err == nil {
		t.Fatal("tampered request state error = nil, want rejection")
	}

	tokenFirst, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "crm.customer.search", Arguments: map[string]any{"keyword": "token-replay"}})
	if err != nil {
		t.Fatal(err)
	}
	token = "demo-zhang-token-2"
	_, err = session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "crm.customer.search",
		Arguments: map[string]any{"keyword": "token-replay"},
		InputResponses: mcp.InputResponseMap{
			"confirmation": &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": true}},
		},
		RequestState: tokenFirst.RequestState,
	})
	if err == nil {
		t.Fatal("different token replay error = nil, want rejection")
	}
	token = "demo-zhang-token"

	declineFirst, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "crm.customer.search", Arguments: map[string]any{"keyword": "decline"}})
	if err != nil {
		t.Fatal(err)
	}
	declined, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "crm.customer.search",
		Arguments: map[string]any{"keyword": "decline"},
		InputResponses: mcp.InputResponseMap{
			"confirmation": &mcp.ElicitResult{Action: "decline"},
		},
		RequestState: declineFirst.RequestState,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !declined.IsError || upstream.calls != 1 {
		t.Fatalf("declined result = %#v, upstream calls = %d, want no additional execution", declined, upstream.calls)
	}

	expiredFirst, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "crm.customer.search", Arguments: map[string]any{"keyword": "expired"}})
	if err != nil {
		t.Fatal(err)
	}
	gates, err := store.ListGateRequests(ctx, mcpgateway.GateFilter{Status: string(mcpgateway.GatePending), AgentID: "sales_zhang_agent"})
	if err != nil {
		t.Fatal(err)
	}
	var expiredGate mcpgateway.GateRequest
	for _, gate := range gates {
		if gate.ArgumentsHash == mustArgumentsHash(t, mcpgateway.JSONMap{"keyword": "expired"}) {
			expiredGate = gate
			break
		}
	}
	if expiredGate.ID == "" {
		t.Fatal("expired test gate not found")
	}
	expiredGate.ExpiresAt = time.Now().Add(-time.Minute)
	if err := store.SaveGateRequest(ctx, expiredGate); err != nil {
		t.Fatal(err)
	}
	_, err = session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "crm.customer.search",
		Arguments: map[string]any{"keyword": "expired"},
		InputResponses: mcp.InputResponseMap{
			"confirmation": &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": true}},
		},
		RequestState: expiredFirst.RequestState,
	})
	if err == nil {
		t.Fatal("expired confirmation error = nil, want rejection")
	}
	expiredGate, err = store.GetGateRequest(ctx, expiredGate.ID)
	if err != nil {
		t.Fatal(err)
	}
	if expiredGate.Status != mcpgateway.GateExpired || upstream.calls != 1 {
		t.Fatalf("expired gate status = %s, upstream calls = %d", expiredGate.Status, upstream.calls)
	}
}

func mustArgumentsHash(t *testing.T, arguments mcpgateway.JSONMap) string {
	t.Helper()
	hash, err := mcpgateway.ArgumentsHash(arguments)
	if err != nil {
		t.Fatal(err)
	}
	return hash
}

func TestMCPServerWithoutExplicitFormElicitationFallsBackToAsyncGate(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	upstream := &testProxyUpstreamClient{result: mcpgateway.UpstreamCallResult{StructuredContent: mcpgateway.JSONMap{"ok": true}}}
	server := mcpgateway.UpstreamServer{ID: "crm-main", Name: "CRM", Transport: mcpgateway.TransportStreamableHTTP, Endpoint: "http://crm.example/mcp", Namespace: "crm", Status: mcpgateway.StatusActive}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	capability := mcpgateway.Capability{
		ID: "cap_search", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool,
		UpstreamName: "customer.search", ExposedName: "crm.customer.search",
		InputSchema: mcpgateway.JSONMap{"type": "object", "required": []any{"keyword"}, "properties": mcpgateway.JSONMap{"keyword": mcpgateway.JSONMap{"type": "string"}}},
		Status:      mcpgateway.StatusActive, ConfirmRequired: true,
	}
	hash, err := mcpgateway.SchemaHash(capability.InputSchema)
	if err != nil {
		t.Fatalf("schema hash: %v", err)
	}
	capability.SchemaHash = hash
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_search", UserID: "sales_zhang", CapabilityID: "cap_search", GrantType: mcpgateway.GrantTool}); err != nil {
		t.Fatalf("save grant: %v", err)
	}

	httpServer := httptest.NewServer(auth.RequireBearerToken(testVerifier, nil)(
		mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
			return mcpserver.New(mcpserver.Options{
				ProxyGateway: newTestProxyGateway(mcpgateway.Config{Store: store, UpstreamClient: upstream}),
			}, r)
		}, nil),
	))
	defer httpServer.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "claw-mcp-test-client", Version: "v0.1.0"}, &mcp.ClientOptions{
		Capabilities: &mcp.ClientCapabilities{
			Elicitation: &mcp.ElicitationCapabilities{URL: &mcp.URLElicitationCapabilities{}},
		},
		ElicitationHandler: func(ctx context.Context, req *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
			t.Fatal("elicitation handler must not be called without explicit form capability")
			return nil, nil
		},
	})
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   httpServer.URL,
		HTTPClient: &http.Client{Transport: &bearerRoundTripper{token: "demo-zhang-token"}},
	}, nil)
	if err != nil {
		t.Fatalf("connect streamable HTTP client: %v", err)
	}
	defer session.Close()

	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "crm.customer.search",
		Arguments: map[string]any{"keyword": "acme"},
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if result.IsError {
		t.Fatalf("result IsError = true, content = %#v", result.Content)
	}
	content := result.StructuredContent.(map[string]any)
	if content["gate_required"] != true || content["gate_id"] == "" || content["status"] != string(mcpgateway.GatePending) {
		t.Fatalf("structured content = %#v, want async gate_required", content)
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
}

func TestMCPServerFallsBackToAsyncGateWithoutClientElicitation(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	upstream := &testProxyUpstreamClient{result: mcpgateway.UpstreamCallResult{StructuredContent: mcpgateway.JSONMap{"ok": true}}}
	server := mcpgateway.UpstreamServer{ID: "crm-main", Name: "CRM", Transport: mcpgateway.TransportStreamableHTTP, Endpoint: "http://crm.example/mcp", Namespace: "crm", Status: mcpgateway.StatusActive}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	capability := mcpgateway.Capability{
		ID: "cap_search", UpstreamServerID: "crm-main", Type: mcpgateway.CapabilityTool,
		UpstreamName: "customer.search", ExposedName: "crm.customer.search",
		InputSchema: mcpgateway.JSONMap{"type": "object", "required": []any{"keyword"}, "properties": mcpgateway.JSONMap{"keyword": mcpgateway.JSONMap{"type": "string"}}},
		Status:      mcpgateway.StatusActive, ConfirmRequired: true,
	}
	hash, err := mcpgateway.SchemaHash(capability.InputSchema)
	if err != nil {
		t.Fatalf("schema hash: %v", err)
	}
	capability.SchemaHash = hash
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("save capability: %v", err)
	}
	if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_search", UserID: "sales_zhang", CapabilityID: "cap_search", GrantType: mcpgateway.GrantTool}); err != nil {
		t.Fatalf("save grant: %v", err)
	}

	httpServer := httptest.NewServer(auth.RequireBearerToken(testVerifier, nil)(
		mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
			return mcpserver.New(mcpserver.Options{
				ProxyGateway: newTestProxyGateway(mcpgateway.Config{Store: store, UpstreamClient: upstream}),
			}, r)
		}, nil),
	))
	defer httpServer.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "claw-mcp-test-client", Version: "v0.1.0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   httpServer.URL,
		HTTPClient: &http.Client{Transport: &bearerRoundTripper{token: "demo-zhang-token"}},
	}, nil)
	if err != nil {
		t.Fatalf("connect streamable HTTP client: %v", err)
	}
	defer session.Close()

	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "crm.customer.search",
		Arguments: map[string]any{"keyword": "acme"},
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if result.IsError {
		t.Fatalf("result IsError = true, content = %#v", result.Content)
	}
	content := result.StructuredContent.(map[string]any)
	if content["gate_required"] != true || content["gate_id"] == "" || content["status"] != string(mcpgateway.GatePending) {
		t.Fatalf("structured content = %#v, want async gate_required", content)
	}
	if upstream.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", upstream.calls)
	}
}

func TestMCPServerExposesGateStatusAndResultTools(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	expiresAt := time.Now().UTC().Add(time.Hour)
	gate := mcpgateway.GateRequest{
		ID:           "gate_completed_001",
		Type:         mcpgateway.GateTypeUserConfirmation,
		Provider:     mcpgateway.GateProviderInternal,
		TenantID:     "tenant_crm",
		AgentID:      "sales_zhang_agent",
		CapabilityID: "cap_update",
		Status:       mcpgateway.GateCompleted,
		ConfirmURL:   "https://console.example/gates/gate_completed_001",
		ExpiresAt:    expiresAt,
		ResponseBody: mcpgateway.JSONMap{"ok": true, "customer_id": "cust_001"},
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}
	if err := store.SaveGateRequest(ctx, gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}

	httpServer := httptest.NewServer(auth.RequireBearerToken(testVerifier, nil)(
		mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
			return mcpserver.New(mcpserver.Options{
				ProxyGateway: newTestProxyGateway(mcpgateway.Config{Store: store}),
			}, r)
		}, nil),
	))
	defer httpServer.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "claw-mcp-test-client", Version: "v0.1.0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: httpServer.URL,
		HTTPClient: &http.Client{
			Transport: &bearerRoundTripper{token: "demo-zhang-token"},
		},
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer session.Close()

	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	names := map[string]bool{}
	for _, tool := range tools.Tools {
		names[tool.Name] = true
	}
	if !names["mcp.gate.status"] {
		t.Fatal("mcp.gate.status tool not exposed")
	}
	if !names["mcp.gate.result"] {
		t.Fatal("mcp.gate.result tool not exposed")
	}

	statusResult, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "mcp.gate.status",
		Arguments: map[string]any{"gate_id": gate.ID},
	})
	if err != nil {
		t.Fatalf("call gate status: %v", err)
	}
	statusContent, ok := statusResult.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("gate status structured content = %T, want map[string]any", statusResult.StructuredContent)
	}
	if got := statusContent["status"]; got != string(mcpgateway.GateCompleted) {
		t.Fatalf("gate status = %v, want %s", got, mcpgateway.GateCompleted)
	}

	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "mcp.gate.result",
		Arguments: map[string]any{"gate_id": gate.ID},
	})
	if err != nil {
		t.Fatalf("call gate result: %v", err)
	}
	resultContent, ok := result.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("gate result structured content = %T, want map[string]any", result.StructuredContent)
	}
	responseBody, ok := resultContent["response_body"].(map[string]any)
	if !ok {
		t.Fatalf("response_body = %T, want map[string]any", resultContent["response_body"])
	}
	if got := responseBody["customer_id"]; got != "cust_001" {
		t.Fatalf("response_body.customer_id = %v, want cust_001", got)
	}
}

func TestMCPGateToolsUseCurrentCallIdentity(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save first agent: %v", err)
	}
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "support_zhang_agent", TenantID: "tenant_crm", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save second agent: %v", err)
	}
	gate := mcpgateway.GateRequest{
		ID:        "gate_support_agent",
		Type:      mcpgateway.GateTypeUserConfirmation,
		Provider:  mcpgateway.GateProviderInternal,
		TenantID:  "tenant_crm",
		AgentID:   "support_zhang_agent",
		Status:    mcpgateway.GateCompleted,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := store.SaveGateRequest(ctx, gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}

	verifier := func(ctx context.Context, token string, req *http.Request) (*auth.TokenInfo, error) {
		if token != "demo-zhang-token" && token != "demo-support-token" {
			return nil, auth.ErrInvalidToken
		}
		agentID := "sales_zhang_agent"
		if token == "demo-support-token" {
			agentID = "support_zhang_agent"
		}
		return &auth.TokenInfo{
			UserID:     "sales_zhang",
			Scopes:     []string{"mcp:call"},
			Expiration: time.Now().Add(time.Hour),
			Extra: map[string]any{
				"sub":       "sales_zhang",
				"client_id": "hermes-sales-demo",
				"agent_id":  agentID,
				"iss":       "claw-mcp-demo",
				"jti":       token,
			},
		}, nil
	}
	httpServer := httptest.NewServer(auth.RequireBearerToken(verifier, nil)(
		mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
			return mcpserver.New(mcpserver.Options{
				ProxyGateway: newTestProxyGateway(mcpgateway.Config{Store: store}),
			}, r)
		}, nil),
	))
	defer httpServer.Close()

	token := "demo-zhang-token"
	client := mcp.NewClient(&mcp.Implementation{Name: "claw-mcp-test-client", Version: "v0.1.0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: httpServer.URL,
		HTTPClient: &http.Client{
			Transport: mutableBearerRoundTripper{token: &token},
		},
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer session.Close()

	token = "demo-support-token"
	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "mcp.gate.status",
		Arguments: map[string]any{"gate_id": gate.ID},
	})
	if err != nil {
		t.Fatalf("call gate status: %v", err)
	}
	content, ok := result.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("structured content = %T, want map[string]any", result.StructuredContent)
	}
	if got := content["status"]; got != string(mcpgateway.GateCompleted) {
		t.Fatalf("gate status = %v, want %s", got, mcpgateway.GateCompleted)
	}
}

func TestMCPGateToolsReturnAdminApprovalGateType(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	gate := mcpgateway.GateRequest{
		ID:           "mcp_approval_status",
		Type:         mcpgateway.GateTypeAdminApproval,
		Provider:     mcpgateway.GateProviderInternal,
		TenantID:     "tenant_crm",
		AgentID:      "sales_zhang_agent",
		ConfirmURL:   "/admin/mcp/gates/mcp_approval_status",
		Status:       mcpgateway.GatePending,
		ResponseBody: mcpgateway.JSONMap{"ok": true},
		ExpiresAt:    time.Now().UTC().Add(30 * time.Minute),
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}
	if err := store.SaveGateRequest(ctx, gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}

	httpServer := httptest.NewServer(auth.RequireBearerToken(testVerifier, nil)(
		mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
			return mcpserver.New(mcpserver.Options{
				ProxyGateway: newTestProxyGateway(mcpgateway.Config{Store: store}),
			}, r)
		}, nil),
	))
	defer httpServer.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "claw-mcp-test-client", Version: "v0.1.0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: httpServer.URL,
		HTTPClient: &http.Client{
			Transport: &bearerRoundTripper{token: "demo-zhang-token"},
		},
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer session.Close()

	statusResult, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "mcp.gate.status",
		Arguments: map[string]any{"gate_id": gate.ID},
	})
	if err != nil {
		t.Fatalf("call gate status: %v", err)
	}
	statusContent, ok := statusResult.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("gate status structured content = %T, want map[string]any", statusResult.StructuredContent)
	}
	if got := statusContent["gate_type"]; got != mcpgateway.GateTypeAdminApproval {
		t.Fatalf("gate_type = %v, want %s", got, mcpgateway.GateTypeAdminApproval)
	}
	if got := statusContent["status"]; got != string(mcpgateway.GatePending) {
		t.Fatalf("status = %v, want %s", got, mcpgateway.GatePending)
	}
}

func TestMCPGateToolsRejectDisabledAgent(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: mcpgateway.StatusDisabled}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	gate := mcpgateway.GateRequest{
		ID:        "gate_disabled_agent",
		Type:      mcpgateway.GateTypeUserConfirmation,
		Provider:  mcpgateway.GateProviderInternal,
		TenantID:  "tenant_crm",
		AgentID:   "sales_zhang_agent",
		Status:    mcpgateway.GateCompleted,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := store.SaveGateRequest(ctx, gate); err != nil {
		t.Fatalf("save gate: %v", err)
	}

	httpServer := httptest.NewServer(auth.RequireBearerToken(testVerifier, nil)(
		mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
			return mcpserver.New(mcpserver.Options{
				ProxyGateway: newTestProxyGateway(mcpgateway.Config{Store: store}),
			}, r)
		}, nil),
	))
	defer httpServer.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "claw-mcp-test-client", Version: "v0.1.0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: httpServer.URL,
		HTTPClient: &http.Client{
			Transport: &bearerRoundTripper{token: "demo-zhang-token"},
		},
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer session.Close()

	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "mcp.gate.status",
		Arguments: map[string]any{"gate_id": gate.ID},
	})
	if err != nil {
		t.Fatalf("call gate status: %v", err)
	}
	if !result.IsError {
		t.Fatalf("call gate status IsError = false, want true; result=%#v", result)
	}
	if len(result.Content) != 1 {
		t.Fatalf("call gate status content length = %d, want 1", len(result.Content))
	}
	text, ok := result.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("call gate status content = %T, want text content", result.Content[0])
	}
	if !strings.Contains(text.Text, "agent is not active") {
		t.Fatalf("call gate status error = %q, want inactive agent error", text.Text)
	}
}

func TestMCPServerNormalizesMalformedProxyToolSchemas(t *testing.T) {
	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	server := mcpgateway.UpstreamServer{ID: "crm-main", Name: "CRM", Transport: mcpgateway.TransportStreamableHTTP, Endpoint: "http://crm.example/mcp", Namespace: "crm", Status: mcpgateway.StatusActive}
	if err := store.SaveUpstreamServer(ctx, server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	tool := mcpgateway.Capability{
		ID:               "cap_bad_schema",
		UpstreamServerID: "crm-main",
		Type:             mcpgateway.CapabilityTool,
		UpstreamName:     "customer.bad_schema",
		ExposedName:      "crm.customer.bad_schema",
		InputSchema:      mcpgateway.JSONMap{"type": "string"},
		OutputSchema:     mcpgateway.JSONMap{"type": "array"},
		Status:           mcpgateway.StatusActive,
	}
	if err := store.SaveCapability(ctx, tool); err != nil {
		t.Fatalf("save tool: %v", err)
	}
	if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_bad_schema", UserID: "sales_zhang", CapabilityID: "cap_bad_schema", GrantType: mcpgateway.GrantTool}); err != nil {
		t.Fatalf("save grant: %v", err)
	}

	httpServer := httptest.NewServer(auth.RequireBearerToken(testVerifier, nil)(
		mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
			return mcpserver.New(mcpserver.Options{
				ProxyGateway: newTestProxyGateway(mcpgateway.Config{Store: store}),
			}, r)
		}, nil),
	))
	defer httpServer.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "claw-mcp-test-client", Version: "v0.1.0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: httpServer.URL,
		HTTPClient: &http.Client{
			Transport: &bearerRoundTripper{token: "demo-zhang-token"},
		},
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer session.Close()

	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	for _, tool := range tools.Tools {
		if tool.Name == "crm.customer.bad_schema" {
			return
		}
	}
	t.Fatalf("fallback schema tool not exposed in %#v", tools.Tools)
}

func TestMCPProxyToolCallForwardsToUpstreamWithBearerToken(t *testing.T) {
	var gotAuthorization string
	upstreamServer := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		gotAuthorization = r.Header.Get("Authorization")
		s := mcp.NewServer(&mcp.Implementation{Name: "crm-mcp", Version: "v0.1.0"}, nil)
		mcp.AddTool(s, &mcp.Tool{
			Name:        "customer.search",
			InputSchema: map[string]any{"type": "object"},
		}, func(ctx context.Context, req *mcp.CallToolRequest, input map[string]any) (*mcp.CallToolResult, map[string]any, error) {
			return nil, map[string]any{"items": []any{input["keyword"]}}, nil
		})
		return s
	}, nil))
	defer upstreamServer.Close()

	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	proxy := newTestProxyGateway(mcpgateway.Config{
		Store:          store,
		UpstreamClient: mcpgateway.NewSDKUpstreamClient("test-gateway"),
	})
	if err := store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{ID: "crm-main", Name: "CRM", Transport: mcpgateway.TransportStreamableHTTP, Endpoint: upstreamServer.URL, Namespace: "crm", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save upstream: %v", err)
	}
	if err := proxy.SyncTools(ctx, "crm-main", "demo-zhang-token"); err != nil {
		t.Fatalf("sync tools: %v", err)
	}
	capability, err := store.GetCapabilityByExposedName(ctx, "crm.customer.search")
	if err != nil {
		t.Fatalf("get capability: %v", err)
	}
	if capability.Status != mcpgateway.StatusPending {
		t.Fatalf("new capability status = %q, want pending before review", capability.Status)
	}
	capability.Status = mcpgateway.StatusActive
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatalf("activate capability: %v", err)
	}
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatalf("save agent: %v", err)
	}
	if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{ID: "grant_search", UserID: "sales_zhang", CapabilityID: capability.ID, GrantType: mcpgateway.GrantTool}); err != nil {
		t.Fatalf("save grant: %v", err)
	}

	gatewayServer := httptest.NewServer(auth.RequireBearerToken(testVerifier, nil)(
		mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
			return mcpserver.New(mcpserver.Options{ProxyGateway: proxy}, r)
		}, nil),
	))
	defer gatewayServer.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "agent", Version: "v0.1.0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: gatewayServer.URL,
		HTTPClient: &http.Client{
			Transport: &bearerRoundTripper{token: "demo-zhang-token", firstRequestID: "req_init_123", requestID: "req_mcp_123"},
		},
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer session.Close()

	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "crm.customer.search",
		Arguments: map[string]any{"keyword": "acme"},
	})
	if err != nil {
		t.Fatalf("call proxy tool: %v", err)
	}
	if gotAuthorization != "Bearer demo-zhang-token" {
		t.Fatalf("upstream authorization = %q, want bearer token", gotAuthorization)
	}
	content, ok := result.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("structured content = %T", result.StructuredContent)
	}
	if content["items"] == nil {
		t.Fatalf("structured content missing items: %#v", content)
	}

	audits, err := store.ListProxyAuditRecords(ctx, mcpgateway.ProxyAuditFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list audits: %v", err)
	}
	if len(audits) != 1 {
		t.Fatalf("audit length = %d, want 1", len(audits))
	}
	if audits[0].RequestBody["keyword"] != "acme" {
		t.Fatalf("audit request body = %#v", audits[0].RequestBody)
	}
	if audits[0].TokenHash == "" || audits[0].TokenHash == "demo-zhang-token" {
		t.Fatalf("audit token hash = %q, want hashed token", audits[0].TokenHash)
	}
	if audits[0].RequestID != "req_mcp_123" {
		t.Fatalf("audit request_id = %q, want req_mcp_123", audits[0].RequestID)
	}
}

func TestMCPProxyToolCallForwardsProgressBeforeFinalResult(t *testing.T) {
	const progressToken = "desktop-progress-token"
	firstProgressForwarded := make(chan struct{}, 1)
	upstreamServer := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		s := mcp.NewServer(&mcp.Implementation{Name: "clawee-server", Version: "v0.1.0"}, nil)
		mcp.AddTool(s, &mcp.Tool{
			Name:        "clawee_submit_task",
			InputSchema: map[string]any{"type": "object"},
		}, func(ctx context.Context, req *mcp.CallToolRequest, _ map[string]any) (*mcp.CallToolResult, map[string]any, error) {
			if got := req.Params.GetProgressToken(); got != progressToken {
				t.Errorf("upstream progress token = %#v, want %q", got, progressToken)
			}
			for i, message := range []string{"task accepted", "task running"} {
				if err := req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{
					ProgressToken: req.Params.GetProgressToken(),
					Progress:      float64(i + 1),
					Total:         2,
					Message:       message,
				}); err != nil {
					return nil, nil, err
				}
				if i == 0 {
					select {
					case <-firstProgressForwarded:
					case <-time.After(time.Second):
						t.Error("first progress was buffered until the final result")
					}
				}
			}
			return nil, map[string]any{"status": "completed"}, nil
		})
		return s
	}, nil))
	defer upstreamServer.Close()

	ctx := context.Background()
	store := mcpgateway.NewMemoryStore()
	proxy := newTestProxyGateway(mcpgateway.Config{
		Store:          store,
		UpstreamClient: mcpgateway.NewSDKUpstreamClient("test-gateway"),
	})
	if err := store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{
		ID: "clawee", Name: "Clawee", Transport: mcpgateway.TransportStreamableHTTP,
		Endpoint: upstreamServer.URL, Namespace: "clawee", Status: mcpgateway.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := proxy.SyncTools(ctx, "clawee", ""); err != nil {
		t.Fatal(err)
	}
	capability, err := store.GetCapabilityByExposedName(ctx, "clawee.clawee_submit_task")
	if err != nil {
		t.Fatal(err)
	}
	capability.Status = mcpgateway.StatusActive
	if err := store.SaveCapability(ctx, capability); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", Status: mcpgateway.StatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGrant(ctx, mcpgateway.AccountGrant{
		ID: "grant_submit_task", UserID: "sales_zhang", CapabilityID: capability.ID, GrantType: mcpgateway.GrantTool,
	}); err != nil {
		t.Fatal(err)
	}

	gatewayServer := httptest.NewServer(auth.RequireBearerToken(testVerifier, nil)(
		mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
			return mcpserver.New(mcpserver.Options{ProxyGateway: proxy}, r)
		}, nil),
	))
	defer gatewayServer.Close()

	progress := make(chan *mcp.ProgressNotificationParams, 2)
	client := mcp.NewClient(&mcp.Implementation{Name: "desktop", Version: "v0.1.0"}, &mcp.ClientOptions{
		ProgressNotificationHandler: func(_ context.Context, req *mcp.ProgressNotificationClientRequest) {
			progress <- req.Params
			if req.Params.Message == "task accepted" {
				select {
				case firstProgressForwarded <- struct{}{}:
				default:
				}
			}
		},
	})
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   gatewayServer.URL,
		HTTPClient: &http.Client{Transport: &bearerRoundTripper{token: "demo-zhang-token"}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	params := &mcp.CallToolParams{Name: "clawee.clawee_submit_task", Arguments: map[string]any{}}
	params.SetProgressToken(progressToken)
	result, err := session.CallTool(ctx, params)
	if err != nil {
		t.Fatal(err)
	}
	for i, wantMessage := range []string{"task accepted", "task running"} {
		select {
		case got := <-progress:
			if got.ProgressToken != progressToken || got.Message != wantMessage || got.Progress != float64(i+1) || got.Total != 2 {
				t.Fatalf("progress %d = %#v", i, got)
			}
		default:
			t.Fatalf("progress %d was not forwarded before final result", i)
		}
	}
	structured, ok := result.StructuredContent.(map[string]any)
	if !ok || structured["status"] != "completed" {
		t.Fatalf("final structured content = %#v", result.StructuredContent)
	}
}

func testVerifier(ctx context.Context, token string, req *http.Request) (*auth.TokenInfo, error) {
	if token != "demo-zhang-token" {
		return nil, auth.ErrInvalidToken
	}
	return &auth.TokenInfo{
		UserID:     "sales_zhang",
		Scopes:     []string{"mcp:call"},
		Expiration: time.Now().Add(time.Hour),
		Extra: map[string]any{
			"sub":       "sales_zhang",
			"user_id":   "sales_zhang",
			"client_id": "hermes-sales-demo",
			"agent_id":  "sales_zhang_agent",
			"iss":       "claw-mcp-demo",
			"jti":       "token_zhang_001",
		},
	}, nil
}
