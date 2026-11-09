package mcpserver_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/dataaccess"
	"github.com/krillinai/Clawee/server/internal/mcpgateway"
	"github.com/krillinai/Clawee/server/internal/mcpserver"
	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type gateResultAccessStore struct {
	*dataaccess.MemoryStore
	err error
}

func (s *gateResultAccessStore) ListGrants(ctx context.Context, query dataaccess.Filter) ([]dataaccess.Grant, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.MemoryStore.ListGrants(ctx, query)
}

func TestMCPGateResultChecksContributionPermission(t *testing.T) {
	ctx := context.Background()
	for _, test := range []struct {
		name, serverID, tool, transport string
		allowed, queryError, wantResult bool
		mutation                        string
	}{
		{"授权有效", "skill-contributions", "skill_contributions_query", mcpgateway.TransportBuiltin, true, false, true, ""},
		{"查询撤权", "skill-contributions", "skill_contributions_query", mcpgateway.TransportBuiltin, false, false, false, ""},
		{"导出撤权", "skill-contributions", "skill_contributions_export", mcpgateway.TransportBuiltin, false, false, false, ""},
		{"授权查询故障", "skill-contributions", "skill_contributions_query", mcpgateway.TransportBuiltin, true, true, false, ""},
		{"同名远端上游", "skill-contributions", "skill_contributions_query", mcpgateway.TransportStreamableHTTP, false, true, true, ""},
		{"其他上游同名工具", "other", "skill_contributions_query", mcpgateway.TransportBuiltin, false, true, true, ""},
		{"内置上游其他工具", "skill-contributions", "other", mcpgateway.TransportBuiltin, false, true, true, ""},
		{"能力停用", "skill-contributions", "skill_contributions_query", mcpgateway.TransportBuiltin, true, false, false, "capability disabled"},
		{"能力改绑", "skill-contributions", "skill_contributions_query", mcpgateway.TransportBuiltin, true, false, false, "capability moved"},
		{"上游停用", "skill-contributions", "skill_contributions_query", mcpgateway.TransportBuiltin, true, false, false, "upstream disabled"},
		{"账户停用", "skill-contributions", "skill_contributions_query", mcpgateway.TransportBuiltin, true, false, false, "account disabled"},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := mcpgateway.NewMemoryStore()
			if err := store.SaveAgent(ctx, mcpgateway.AgentRegistration{AgentID: "sales_zhang_agent", TenantID: "tenant_crm", Status: mcpgateway.StatusActive}); err != nil {
				t.Fatal(err)
			}
			if err := store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{ID: test.serverID, Transport: test.transport, Status: mcpgateway.StatusActive}); err != nil {
				t.Fatal(err)
			}
			capability := mcpgateway.Capability{ID: "cap-contributions", UpstreamServerID: test.serverID, Type: mcpgateway.CapabilityTool, UpstreamName: test.tool, ExposedName: "contributions.query", Status: mcpgateway.StatusActive}
			if err := store.SaveCapability(ctx, capability); err != nil {
				t.Fatal(err)
			}
			accessStore := &gateResultAccessStore{MemoryStore: dataaccess.NewMemoryStore()}
			access := dataaccess.NewService(accessStore)
			if test.allowed || (!test.wantResult && !test.queryError) {
				if _, err := access.Create(ctx, dataaccess.SetInput{UserID: "sales_zhang", ResourceType: dataaccess.ResourceDataView, ResourceID: dataaccess.ViewSkillContributions, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
					t.Fatal(err)
				}
			}
			if test.queryError {
				accessStore.err = errors.New("data authorization unavailable")
			}
			gate := mcpgateway.GateRequest{
				ID: "gate-contributions", Type: mcpgateway.GateTypeUserConfirmation, Status: mcpgateway.GateCompleted,
				UserID: "sales_zhang", AgentID: "sales_zhang_agent", TenantID: "tenant_crm",
				UpstreamServerID: test.serverID, UpstreamName: test.tool, CapabilityType: mcpgateway.CapabilityTool, CapabilityID: capability.ID, ExposedName: capability.ExposedName,
				ResponseBody: mcpgateway.JSONMap{"private": "贡献数据"}, ExpiresAt: time.Now().Add(time.Hour),
			}
			if err := store.SaveGateRequest(ctx, gate); err != nil {
				t.Fatal(err)
			}
			proxy := newTestProxyGateway(mcpgateway.Config{Store: store, DataAccessService: access})
			httpServer := httptest.NewServer(auth.RequireBearerToken(testVerifier, nil)(
				mcp.NewStreamableHTTPHandler(func(request *http.Request) *mcp.Server {
					return mcpserver.New(mcpserver.Options{ProxyGateway: proxy}, request)
				}, nil),
			))
			defer httpServer.Close()
			client := mcp.NewClient(&mcp.Implementation{Name: "gate-authorization-test", Version: "v0.1.0"}, nil)
			session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: httpServer.URL, HTTPClient: &http.Client{Transport: &bearerRoundTripper{token: "demo-zhang-token"}}}, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			if !test.wantResult && !test.queryError {
				first, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "mcp.gate.result", Arguments: map[string]any{"gate_id": gate.ID}})
				if err != nil || first.IsError {
					t.Fatalf("撤权前应返回结果: %+v %v", first, err)
				}
				switch test.mutation {
				case "capability disabled", "capability moved":
					if test.mutation == "capability disabled" {
						capability.Status = mcpgateway.StatusDisabled
					} else {
						capability.UpstreamServerID = "other"
					}
					if err := store.SaveCapability(ctx, capability); err != nil {
						t.Fatal(err)
					}
				case "upstream disabled":
					if err := store.SaveUpstreamServer(ctx, mcpgateway.UpstreamServer{ID: test.serverID, Transport: test.transport, Status: mcpgateway.StatusDisabled}); err != nil {
						t.Fatal(err)
					}
				case "account disabled":
					proxy.SetIdentityResolvers(func(context.Context, string) (string, error) { return "sales_zhang", nil }, func(context.Context, string) error { return errors.New("account is disabled") })
				default:
					if err := access.RemoveBy(ctx, "sales_zhang", dataaccess.ResourceDataView, dataaccess.ViewSkillContributions, "admin", "request"); err != nil {
						t.Fatal(err)
					}
				}
			}
			status, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "mcp.gate.status", Arguments: map[string]any{"gate_id": gate.ID}})
			if err != nil || status.IsError {
				t.Fatalf("状态查询应保留: %+v %v", status, err)
			}
			result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "mcp.gate.result", Arguments: map[string]any{"gate_id": gate.ID}})
			if test.wantResult {
				if err != nil || result.IsError {
					t.Fatalf("有权或其他工具应保留结果: %+v %v", result, err)
				}
				body := result.StructuredContent.(map[string]any)["response_body"].(map[string]any)
				if body["private"] == nil {
					t.Fatal("缺少缓存结果")
				}
			} else if err == nil && (!result.IsError || result.StructuredContent != nil) {
				t.Fatalf("撤权或查询错误不能返回正文: %+v", result)
			}
		})
	}
}
