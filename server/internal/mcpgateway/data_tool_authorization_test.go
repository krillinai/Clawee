package mcpgateway

import (
	"context"
	"testing"

	"github.com/krillinai/Clawee/server/internal/dataaccess"
)

func TestContributionCallsAndConfirmationUseCurrentDataPermission(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedContributionDiscovery(t, ctx, store, false)
	if err := store.RotateAccountToken(ctx, "usr_sales", AccountToken{ID: "token_1", UserID: "usr_sales", TokenHash: HashToken("token"), Status: StatusActive, Scopes: []string{"mcp:call"}}); err != nil {
		t.Fatal(err)
	}
	access := dataaccess.NewService(dataaccess.NewMemoryStore())
	if _, err := access.Create(ctx, dataaccess.SetInput{UserID: "usr_sales", ResourceType: dataaccess.ResourceDataView, ResourceID: dataaccess.ViewSkillContributions, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	upstream := &recordingUpstreamClient{}
	service := newTestService(Config{Store: store, DataAccessService: access, UpstreamClient: upstream})
	request := ToolCallRequest{Identity: AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"}, ExposedName: "skill_contributions.skill_contributions_query", Arguments: JSONMap{}, BearerToken: "token"}
	if _, err := service.CallTool(ctx, request); err != nil || upstream.calls != 1 {
		t.Fatalf("只有数据权限即可调用: %v", err)
	}
	capability, err := store.GetCapabilityByExposedName(ctx, request.ExposedName)
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
	result, err := service.CallTool(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	gateID := result.StructuredContent.(JSONMap)["gate_id"].(string)
	if err := store.SaveGrant(ctx, AccountGrant{ID: "legacy", UserID: "usr_sales", CapabilityID: capability.ID, GrantType: GrantTool}); err != nil {
		t.Fatal(err)
	}
	if err := access.RemoveBy(ctx, "usr_sales", dataaccess.ResourceDataView, dataaccess.ViewSkillContributions, "admin", "request"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CallTool(ctx, request); err == nil {
		t.Fatal("旧工具授权不能兜底")
	}
	if gate, err := service.AcceptConfirmation(ctx, gateID); err == nil || gate.Status != GateFailed {
		t.Fatal(gate, err)
	}
	if upstream.calls != 1 {
		t.Fatal("撤权后仍执行上游")
	}
}

func TestContributionAuthorizationMatchesRealUpstreamAndTool(t *testing.T) {
	server := UpstreamServer{ID: "skill-contributions", Transport: TransportBuiltin}
	capability := Capability{UpstreamServerID: server.ID, Type: CapabilityTool, UpstreamName: "skill_contributions_query"}
	if !IsSkillContributionsTool(server, capability) {
		t.Fatal("内置工具应匹配")
	}
	server.Transport = TransportStreamableHTTP
	if IsSkillContributionsTool(server, capability) {
		t.Fatal("同名远端上游不能匹配")
	}
	server.Transport = TransportBuiltin
	capability.UpstreamName = "other"
	if IsSkillContributionsTool(server, capability) {
		t.Fatal("同一上游的其他工具不能放行")
	}
	capability.UpstreamName = "skill_contributions_query"
	capability.UpstreamServerID = "other"
	if IsSkillContributionsTool(server, capability) {
		t.Fatal("其他上游同名工具不能放行")
	}
}
