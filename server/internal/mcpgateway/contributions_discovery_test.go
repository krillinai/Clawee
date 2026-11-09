package mcpgateway

import (
	"context"
	"errors"
	"testing"

	"github.com/krillinai/Clawee/server/internal/dataaccess"
)

func TestVisibleContributionToolsUseDataGrant(t *testing.T) {
	ctx := context.Background()
	for _, test := range []struct {
		name       string
		withAccess bool
		dataGrant  bool
		toolGrant  bool
	}{
		{name: "no access service", toolGrant: true},
		{name: "tool grant only", withAccess: true, toolGrant: true},
		{name: "data grant only", withAccess: true, dataGrant: true},
		{name: "both grants", withAccess: true, dataGrant: true, toolGrant: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := NewMemoryStore()
			seedContributionDiscovery(t, ctx, store, test.toolGrant)
			var access *dataaccess.Service
			if test.withAccess {
				access = dataaccess.NewService(dataaccess.NewMemoryStore())
				if test.dataGrant {
					if _, err := access.Create(ctx, dataaccess.SetInput{UserID: "usr_sales", ResourceType: dataaccess.ResourceDataView, ResourceID: dataaccess.ViewSkillContributions, Actions: []string{dataaccess.ActionRead}, CreatedBy: "admin"}); err != nil {
						t.Fatal(err)
					}
				}
			}
			service := newTestService(Config{Store: store, DataAccessService: access})
			identity := AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"}
			assertVisible := func(wantContributions int) {
				t.Helper()
				for _, upstream := range []string{"", "skill-contributions", "crm-main"} {
					tools, err := service.visibleTools(ctx, identity, upstream)
					if err != nil {
						t.Fatal(err)
					}
					want := wantContributions
					if upstream == "" {
						want++
					} else if upstream == "crm-main" {
						want = 1
					}
					if len(tools) != want {
						t.Fatalf("upstream %q: got %d tools, want %d", upstream, len(tools), want)
					}
					for _, tool := range tools {
						if tool.UpstreamServerID == "skill-contributions" && wantContributions == 0 {
							t.Fatalf("unauthorized contribution tool: %#v", tool)
						}
					}
				}
			}
			want := 0
			if test.dataGrant {
				want = 2
			}
			assertVisible(want)
			catalog, err := service.ToolCatalog(ctx, identity)
			if err != nil {
				t.Fatal(err)
			}
			for _, upstream := range catalog {
				if upstream.ID == "skill-contributions" {
					for _, tool := range upstream.Tools {
						if tool.Authorized != test.dataGrant {
							t.Fatalf("catalog authorization: %+v", tool)
						}
					}
				}
			}
			if test.dataGrant {
				if err := access.RemoveBy(ctx, "usr_sales", dataaccess.ResourceDataView, dataaccess.ViewSkillContributions, "admin", "request"); err != nil {
					t.Fatal(err)
				}
				assertVisible(0)
			}
		})
	}
}

func TestContributionDiscoveryFailureDoesNotBlockOtherUpstream(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	seedContributionDiscovery(t, ctx, store, true)
	failure := errors.New("data authorization unavailable")
	access := dataaccess.NewService(&failingContributionAccessStore{MemoryStore: dataaccess.NewMemoryStore(), err: failure})
	service := newTestService(Config{Store: store, DataAccessService: access})
	identity := AgentIdentity{UserID: "usr_sales", AgentID: "sales_zhang_agent"}
	tools, err := service.VisibleToolsForUpstream(ctx, identity, "crm-main")
	if err != nil || len(tools) != 1 || tools[0].UpstreamServerID != "crm-main" {
		t.Fatalf("unrelated upstream: tools=%#v err=%v", tools, err)
	}
	for _, upstream := range []string{"", "skill-contributions"} {
		tools, err := service.visibleTools(ctx, identity, upstream)
		if !errors.Is(err, failure) || len(tools) != 0 {
			t.Fatalf("contribution discovery must fail closed: tools=%#v err=%v", tools, err)
		}
	}
	audits := store.ListAuditRecordsForTest()
	if len(audits) != 3 || audits[0].Decision != DecisionAllowed || audits[1].Decision != DecisionInternalError || audits[2].Decision != DecisionInternalError {
		t.Fatalf("unexpected discovery audits: %#v", audits)
	}
}

type failingContributionAccessStore struct {
	*dataaccess.MemoryStore
	err error
}

func (s *failingContributionAccessStore) ListGrants(context.Context, dataaccess.Filter) ([]dataaccess.Grant, error) {
	return nil, s.err
}

func seedContributionDiscovery(t *testing.T, ctx context.Context, store Store, grantTools bool) {
	t.Helper()
	seedGrantedAndUngrantedTools(t, ctx, store)
	if err := store.SaveUpstreamServer(ctx, UpstreamServer{ID: "skill-contributions", Namespace: "skill_contributions", Transport: TransportBuiltin, Status: StatusActive}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"skill_contributions_query", "skill_contributions_export"} {
		if err := store.SaveCapability(ctx, Capability{ID: name, UpstreamServerID: "skill-contributions", Type: CapabilityTool, UpstreamName: name, ExposedName: "skill_contributions." + name, InputSchema: JSONMap{"type": "object"}, Status: StatusActive}); err != nil {
			t.Fatal(err)
		}
		if grantTools {
			if err := store.SaveGrant(ctx, AccountGrant{ID: "grant_" + name, UserID: "usr_sales", CapabilityID: name, GrantType: GrantTool}); err != nil {
				t.Fatal(err)
			}
		}
	}
}
