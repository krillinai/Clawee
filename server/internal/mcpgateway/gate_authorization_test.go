package mcpgateway

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/dataaccess"
)

type gateTokenLookupStore struct {
	Store
	token *AccountToken
	err   error
}

func (s *gateTokenLookupStore) GetAccountTokenByHash(ctx context.Context, hash string) (AccountToken, error) {
	if s.err != nil {
		return AccountToken{}, s.err
	}
	if s.token != nil {
		return *s.token, nil
	}
	return s.Store.GetAccountTokenByHash(ctx, hash)
}

func TestAcceptConfirmationChecksOriginalToken(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	future := now.Add(time.Hour)
	lookupError := errors.New("token lookup unavailable")
	for _, name := range []string{"valid", "revoked", "rotated", "missing", "expired", "expiry boundary", "wrong hash", "wrong id", "wrong user", "scope removed", "unrelated scope", "lookup error"} {
		t.Run(name, func(t *testing.T) {
			base := NewMemoryStore()
			seedGrantedAndUngrantedTools(t, ctx, base)
			token := AccountToken{ID: "token_1", UserID: "usr_sales", TokenHash: HashToken("delegated-token"), Status: StatusActive, ExpiresAt: &future, Scopes: []string{"mcp:call"}}
			if err := base.RotateAccountToken(ctx, token.UserID, token); err != nil {
				t.Fatal(err)
			}
			store := &gateTokenLookupStore{Store: base}
			capability, err := base.GetCapabilityByExposedName(ctx, "crm.customer.search")
			if err != nil {
				t.Fatal(err)
			}
			capability.ConfirmRequired = true
			if err := base.SaveCapability(ctx, capability); err != nil {
				t.Fatal(err)
			}
			upstream := &recordingUpstreamClient{result: UpstreamCallResult{StructuredContent: JSONMap{"ok": true}}}
			service := newTestService(Config{Store: store, UpstreamClient: upstream, Clock: func() time.Time { return now }})
			result, err := service.CallTool(ctx, ToolCallRequest{
				Identity:    AgentIdentity{UserID: token.UserID, Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: token.ID},
				ExposedName: capability.ExposedName, Arguments: JSONMap{"keyword": "acme"}, BearerToken: "delegated-token",
			})
			if err != nil {
				t.Fatal(err)
			}
			switch name {
			case "revoked":
				if _, err := base.RevokeAccountTokens(ctx, token.UserID, now); err != nil {
					t.Fatal(err)
				}
			case "rotated":
				if err := base.RotateAccountToken(ctx, token.UserID, AccountToken{ID: "token_2", UserID: token.UserID, TokenHash: HashToken("new-token"), Status: StatusActive}); err != nil {
					t.Fatal(err)
				}
			case "missing":
				store.err = ErrAccountTokenNotFound
			case "expired":
				expired := now.Add(-time.Second)
				token.ExpiresAt = &expired
				store.token = &token
			case "expiry boundary":
				token.ExpiresAt = &now
				store.token = &token
			case "wrong hash":
				token.TokenHash = HashToken("other-token")
				store.token = &token
			case "wrong id":
				token.ID = "other-token"
				store.token = &token
			case "wrong user":
				token.UserID = "other-user"
				store.token = &token
			case "scope removed":
				token.Scopes = nil
				store.token = &token
			case "unrelated scope":
				token.Scopes = []string{"mcp:read"}
				store.token = &token
			case "lookup error":
				store.err = lookupError
			}
			gate, err := service.AcceptConfirmation(ctx, result.StructuredContent.(JSONMap)["gate_id"].(string))
			if name == "valid" {
				if err != nil || gate.Status != GateCompleted || upstream.calls != 1 {
					t.Fatalf("有效 Token 应执行: gate=%+v calls=%d err=%v", gate, upstream.calls, err)
				}
				return
			}
			if err == nil || gate.Status != GateFailed || upstream.calls != 0 || len(gate.ResponseBody) != 0 {
				t.Fatalf("无效 Token 不能执行: gate=%+v calls=%d err=%v", gate, upstream.calls, err)
			}
			if name == "lookup error" && !errors.Is(err, lookupError) {
				t.Fatalf("查询错误未保留: %v", err)
			}
		})
	}
}

func TestContributionCompletedConfirmationRechecksDataPermission(t *testing.T) {
	ctx := context.Background()
	for _, name := range []string{"query revoked", "export revoked", "authorization error", "access unavailable", "capability disabled", "capability moved", "capability renamed", "upstream disabled", "account disabled", "agent disabled"} {
		t.Run(name, func(t *testing.T) {
			store := NewMemoryStore()
			seedContributionDiscovery(t, ctx, store, true)
			access := dataaccess.NewService(dataaccess.NewMemoryStore())
			if _, err := access.Create(ctx, dataaccess.SetInput{UserID: "usr_sales", ResourceType: dataaccess.ResourceDataView, ResourceID: dataaccess.ViewSkillContributions, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
				t.Fatal(err)
			}
			nameOfTool := "skill_contributions.skill_contributions_query"
			if name == "export revoked" {
				nameOfTool = "skill_contributions.skill_contributions_export"
			}
			capability, err := store.GetCapabilityByExposedName(ctx, nameOfTool)
			if err != nil {
				t.Fatal(err)
			}
			capability.ConfirmRequired = true
			if err := store.SaveCapability(ctx, capability); err != nil {
				t.Fatal(err)
			}
			if err := store.RotateAccountToken(ctx, "usr_sales", AccountToken{ID: "token_1", UserID: "usr_sales", TokenHash: HashToken("token"), Status: StatusActive, Scopes: []string{"mcp:call"}}); err != nil {
				t.Fatal(err)
			}
			upstream := &recordingUpstreamClient{result: UpstreamCallResult{StructuredContent: JSONMap{"private": "贡献数据"}}}
			service := newTestService(Config{Store: store, DataAccessService: access, UpstreamClient: upstream})
			request := ToolCallRequest{Identity: AgentIdentity{UserID: "usr_sales", Subject: "sales_zhang", AgentID: "sales_zhang_agent", TokenID: "token_1"}, ExposedName: nameOfTool, Arguments: JSONMap{}, BearerToken: "token"}
			pending, err := service.CallTool(ctx, request)
			if err != nil {
				t.Fatal(err)
			}
			retry := ConfirmationRetryRequest{GateID: pending.StructuredContent.(JSONMap)["gate_id"].(string), Identity: request.Identity, ExposedName: request.ExposedName, Arguments: request.Arguments, BearerToken: request.BearerToken, Action: SyncConfirmationAccepted}
			if _, err := service.ResolveConfirmation(ctx, retry); err != nil {
				t.Fatal(err)
			}
			if replay, err := service.ResolveConfirmation(ctx, retry); err != nil || replay.StructuredContent.(JSONMap)["private"] == nil || upstream.calls != 1 {
				t.Fatalf("有权重放应复用结果: %+v %v calls=%d", replay, err, upstream.calls)
			}
			failure := errors.New("data authorization unavailable")
			switch name {
			case "authorization error":
				service.dataAccessService = dataaccess.NewService(&failingContributionAccessStore{MemoryStore: dataaccess.NewMemoryStore(), err: failure})
			case "access unavailable":
				service.dataAccessService = nil
			case "capability disabled", "capability moved", "capability renamed":
				switch name {
				case "capability disabled":
					capability.Status = StatusDisabled
				case "capability moved":
					capability.UpstreamServerID = "other"
				case "capability renamed":
					capability.UpstreamName = "other"
				}
				if err := store.SaveCapability(ctx, capability); err != nil {
					t.Fatal(err)
				}
			case "upstream disabled":
				server, err := store.GetUpstreamServer(ctx, capability.UpstreamServerID)
				if err != nil {
					t.Fatal(err)
				}
				server.Status = StatusDisabled
				if err := store.SaveUpstreamServer(ctx, server); err != nil {
					t.Fatal(err)
				}
			case "account disabled":
				service.accountActiveValidator = func(context.Context, string) error { return errors.New("account is disabled") }
			case "agent disabled":
				agent, err := store.GetAgent(ctx, request.Identity.AgentID)
				if err != nil {
					t.Fatal(err)
				}
				agent.Status = StatusDisabled
				if err := store.SaveAgent(ctx, agent); err != nil {
					t.Fatal(err)
				}
			default:
				if err := access.RemoveBy(ctx, "usr_sales", dataaccess.ResourceDataView, dataaccess.ViewSkillContributions, "admin", "request"); err != nil {
					t.Fatal(err)
				}
			}
			if replay, err := service.ResolveConfirmation(ctx, retry); err == nil || replay.StructuredContent != nil || upstream.calls != 1 {
				t.Fatalf("撤权或错误后不能返回缓存: %+v %v calls=%d", replay, err, upstream.calls)
			} else if name == "authorization error" && !errors.Is(err, failure) {
				t.Fatalf("授权查询错误未保留: %v", err)
			}
		})
	}
}
