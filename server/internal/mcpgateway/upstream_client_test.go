package mcpgateway

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPToolCallTimeoutIs7500Seconds(t *testing.T) {
	if mcpToolCallTimeout != 7500*time.Second {
		t.Fatalf("MCP tool call timeout = %s", mcpToolCallTimeout)
	}
}

func TestSDKUpstreamClientPreservesOptionalOutputSchema(t *testing.T) {
	ctx := context.Background()
	server := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		upstream := mcp.NewServer(&mcp.Implementation{Name: "text-upstream", Version: "1.0.0"}, nil)
		upstream.AddTool(&mcp.Tool{Name: "text", InputSchema: map[string]any{"type": "object"}},
			func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "text-only"}}}, nil
			})
		mcp.AddTool(upstream, &mcp.Tool{Name: "structured"},
			func(context.Context, *mcp.CallToolRequest, map[string]any) (*mcp.CallToolResult, map[string]any, error) {
				return nil, map[string]any{"ok": true}, nil
			})
		return upstream
	}, nil))
	defer server.Close()
	client := NewSDKUpstreamClient("test-gateway")
	remote := UpstreamServer{ID: "text", Transport: TransportStreamableHTTP, Endpoint: server.URL}
	tools, err := client.ListTools(ctx, remote, "")
	if err != nil || len(tools) != 2 {
		t.Fatalf("list tools = %#v, error = %v", tools, err)
	}
	for _, tool := range tools {
		if tool.Name == "text" && len(tool.OutputSchema) != 0 {
			t.Fatalf("text-only tool gained output schema: %#v", tool.OutputSchema)
		}
		if tool.Name == "structured" && tool.OutputSchema["type"] != "object" {
			t.Fatalf("structured tool lost output schema: %#v", tool.OutputSchema)
		}
	}
	result, err := client.CallTool(ctx, UpstreamCallRequest{Server: remote, Capability: Capability{UpstreamName: "text"}})
	if err != nil || result.IsError || result.StructuredContent != nil || len(result.Content) != 1 {
		t.Fatalf("text-only result = %#v, error = %v", result, err)
	}
}

func TestStaticBearerHTTPUnauthorizedIsTyped(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client := NewSDKUpstreamClient("test-gateway")
	_, err := client.CallTool(context.Background(), UpstreamCallRequest{
		Server: UpstreamServer{
			ID:        KnowledgeAdapterServerID,
			Transport: TransportStreamableHTTP,
			Endpoint:  server.URL,
			AuthType:  "static_bearer",
		},
		Capability:  Capability{UpstreamName: KnowledgeSearchUpstreamName},
		BearerToken: "service-token",
	})
	if !errors.Is(err, ErrUpstreamUnauthorized) {
		t.Fatalf("CallTool() error = %v, want ErrUpstreamUnauthorized", err)
	}
}

func TestSDKUpstreamClientForwardsTaskInitiatorOnlyForSubmission(t *testing.T) {
	server := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		upstream := mcp.NewServer(&mcp.Implementation{Name: "clawee-task-service", Version: "0.1.0"}, nil)
		for _, name := range []string{"clawee_submit_task", "clawee_get_task", "other_tool"} {
			mcp.AddTool(upstream, &mcp.Tool{Name: name},
				func(_ context.Context, req *mcp.CallToolRequest, _ map[string]any) (*mcp.CallToolResult, map[string]any, error) {
					return nil, map[string]any{
						"user_id":       req.Extra.Header.Get("X-Claw-User-ID"),
						"agent_id":      req.Extra.Header.Get("X-Claw-Agent-ID"),
						"authorization": req.Extra.Header.Get("Authorization"),
					}, nil
				})
		}
		return upstream
	}, nil))
	defer server.Close()

	client := NewSDKUpstreamClient("test-gateway")
	remote := UpstreamServer{ID: "remote-agent", Transport: TransportStreamableHTTP, Endpoint: server.URL, AuthType: "static_bearer"}
	for _, test := range []struct {
		name      string
		caller    AgentIdentity
		wantUser  string
		wantAgent string
	}{
		{"clawee_submit_task", AgentIdentity{UserID: "user_1", AgentID: "agent_1"}, "user_1", "agent_1"},
		{"clawee_submit_task", AgentIdentity{UserID: "user_2", AgentID: "agent_2"}, "user_2", "agent_2"},
		{"clawee_submit_task", AgentIdentity{}, "", ""},
		{"clawee_get_task", AgentIdentity{UserID: "user_1", AgentID: "agent_1"}, "", ""},
		{"other_tool", AgentIdentity{UserID: "user_1", AgentID: "agent_1"}, "", ""},
	} {
		result, err := client.CallTool(context.Background(), UpstreamCallRequest{
			Server: remote, Capability: Capability{UpstreamName: test.name},
			Arguments: JSONMap{}, BearerToken: "runtime-token", Caller: test.caller,
		})
		if err != nil {
			t.Fatal(err)
		}
		content := result.StructuredContent.(map[string]any)
		if content["user_id"] != test.wantUser || content["agent_id"] != test.wantAgent || content["authorization"] != "Bearer runtime-token" {
			t.Fatalf("%s caller headers = %#v", test.name, content)
		}
	}
}

func TestBearerRoundTripperReplacesCallerHeadersWithoutMutatingRequest(t *testing.T) {
	received := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		received <- req.Header.Clone()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	req, err := http.NewRequest(http.MethodPost, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Claw-User-ID", "forged-user")
	req.Header.Set("X-Claw-Agent-ID", "forged-agent")
	for _, caller := range []AgentIdentity{{UserID: "user_1", AgentID: "agent_1"}, {}} {
		transport := &bearerRoundTripper{token: "runtime-token", caller: caller}
		response, err := transport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		headers := <-received
		if headers.Get("X-Claw-User-ID") != caller.UserID || headers.Get("X-Claw-Agent-ID") != caller.AgentID {
			t.Fatalf("caller headers = %#v", headers)
		}
		if req.Header.Get("X-Claw-User-ID") != "forged-user" || req.Header.Get("X-Claw-Agent-ID") != "forged-agent" {
			t.Fatal("original request headers were modified")
		}
	}
}

func TestSDKUpstreamClientForwardsJSONNumberProgressToken(t *testing.T) {
	var receivedProgressToken any
	server := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		upstream := mcp.NewServer(&mcp.Implementation{Name: "test-upstream", Version: "v0.1.0"}, nil)
		mcp.AddTool(upstream, &mcp.Tool{
			Name:        "task.run",
			InputSchema: map[string]any{"type": "object"},
		}, func(_ context.Context, req *mcp.CallToolRequest, _ map[string]any) (*mcp.CallToolResult, map[string]any, error) {
			receivedProgressToken = req.Params.GetProgressToken()
			return nil, map[string]any{"status": "completed"}, nil
		})
		return upstream
	}, nil))
	defer server.Close()

	client := NewSDKUpstreamClient("test-gateway")
	_, err := client.CallTool(context.Background(), UpstreamCallRequest{
		Server: UpstreamServer{
			ID:        "task-server",
			Transport: TransportStreamableHTTP,
			Endpoint:  server.URL,
		},
		Capability:    Capability{UpstreamName: "task.run"},
		ProgressToken: float64(4),
	})
	if err != nil {
		t.Fatalf("CallTool() error = %v", err)
	}
	if receivedProgressToken != float64(4) {
		t.Fatalf("upstream progress token = %#v, want JSON number 4", receivedProgressToken)
	}
}

func TestNormalizeSDKProgressTokenRejectsInvalidValues(t *testing.T) {
	for _, token := range []any{float64(1.5), true} {
		if _, err := normalizeSDKProgressToken(token); err == nil {
			t.Fatalf("normalizeSDKProgressToken(%#v) error = nil", token)
		}
	}
}

func TestSDKUpstreamClientSyncsToolsOverStdio(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	root := repoRoot(t)
	client := NewSDKUpstreamClient("test-gateway")
	tools, err := client.ListTools(ctx, UpstreamServer{
		ID:        "stdio-crm",
		Transport: TransportStdio,
		Stdio: StdioConfig{
			Command: "go",
			Args:    []string{"run", "./internal/teststdio"},
			CWD:     root,
		},
	}, "")
	if err != nil {
		t.Fatalf("list stdio tools: %v", err)
	}
	if len(tools) != 1 {
		t.Fatalf("tools length = %d, want 1", len(tools))
	}
	if tools[0].Name != "customer.search" {
		t.Fatalf("tool name = %q, want customer.search", tools[0].Name)
	}
}

func TestSDKUpstreamClientCallsToolOverStdioWithConfiguredEnv(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	root := repoRoot(t)
	client := NewSDKUpstreamClient("test-gateway")
	result, err := client.CallTool(ctx, UpstreamCallRequest{
		Server: UpstreamServer{
			ID:        "stdio-crm",
			Transport: TransportStdio,
			Stdio: StdioConfig{
				Command: "go",
				Args:    []string{"run", "./internal/teststdio"},
				CWD:     root,
				Env:     map[string]string{"UPSTREAM_TOKEN": "stdio-token"},
			},
		},
		Capability: Capability{UpstreamName: "customer.search"},
		Arguments:  JSONMap{"keyword": "acme"},
	})
	if err != nil {
		t.Fatalf("call stdio tool: %v", err)
	}
	content, ok := result.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("structured content = %T, want map[string]any", result.StructuredContent)
	}
	if content["token"] != "stdio-token" {
		t.Fatalf("token = %v, want stdio-token", content["token"])
	}
}

func TestSDKUpstreamClientRejectsUnsupportedTransport(t *testing.T) {
	ctx := context.Background()
	client := NewSDKUpstreamClient("test-gateway")
	_, err := client.ListTools(ctx, UpstreamServer{ID: "legacy", Transport: TransportSSE}, "")
	if !errors.Is(err, ErrUnsupportedTransport) {
		t.Fatalf("error = %v, want unsupported transport", err)
	}
}

func TestRoutingUpstreamClientUsesBuiltinRouteAndRemoteFallback(t *testing.T) {
	builtin := &recordingUpstreamClient{tools: []UpstreamTool{{Name: "search"}}}
	remote := &recordingUpstreamClient{tools: []UpstreamTool{{Name: "customer.search"}}}
	client := NewRoutingUpstreamClient(remote, map[string]UpstreamClient{
		KnowledgeAdapterServerID: builtin,
	})

	tools, err := client.ListTools(context.Background(), UpstreamServer{ID: KnowledgeAdapterServerID}, "")
	if err != nil || len(tools) != 1 || tools[0].Name != "search" {
		t.Fatalf("builtin ListTools() = %#v, %v", tools, err)
	}
	tools, err = client.ListTools(context.Background(), UpstreamServer{ID: "crm-main"}, "delegated-token")
	if err != nil || len(tools) != 1 || tools[0].Name != "customer.search" {
		t.Fatalf("remote ListTools() = %#v, %v", tools, err)
	}
	if remote.lastListToken != "delegated-token" {
		t.Fatalf("remote token = %q, want delegated-token", remote.lastListToken)
	}

	if _, err := client.CallTool(context.Background(), UpstreamCallRequest{Server: UpstreamServer{ID: KnowledgeAdapterServerID}}); err != nil {
		t.Fatalf("builtin CallTool() error = %v", err)
	}
	if builtin.calls != 1 || remote.calls != 0 {
		t.Fatalf("calls: builtin=%d remote=%d", builtin.calls, remote.calls)
	}
}

func TestRoutingUpstreamClientRegistersRoutes(t *testing.T) {
	client := NewRoutingUpstreamClient(nil, nil)
	registered := &recordingUpstreamClient{tools: []UpstreamTool{{Name: "summary"}}}
	if err := client.Register("agent-activity", registered); err != nil {
		t.Fatal(err)
	}
	if err := client.Register("agent-activity", registered); err == nil {
		t.Fatal("duplicate route error = nil")
	}
	if err := client.Register("", registered); err == nil {
		t.Fatal("empty route error = nil")
	}
	tools, err := client.ListTools(context.Background(), UpstreamServer{ID: "agent-activity"}, "")
	if err != nil || len(tools) != 1 || tools[0].Name != "summary" {
		t.Fatalf("tools = %#v, error = %v", tools, err)
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatalf("repo root: %v", err)
	}
	return root
}
