package dataaccess

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestKnowledgeBaseActionsAreWhitelisted(t *testing.T) {
	service := NewService(NewMemoryStore())
	for index, actions := range [][]string{{ActionRead}, {ActionRead, ActionUpload}, {ActionMCP}} {
		if _, err := service.Create(context.Background(), SetInput{
			UserID: "usr_1", ResourceType: ResourceKnowledgeBase, ResourceID: "kb_" + string(rune('1'+index)),
			Actions: actions, CreatedBy: "admin",
		}); err != nil {
			t.Fatalf("Create(%v) error = %v", actions, err)
		}
	}
	for _, actions := range [][]string{{ActionUpload}, {"delete"}} {
		if _, err := service.Create(context.Background(), SetInput{
			UserID: "usr_1", ResourceType: ResourceKnowledgeBase, ResourceID: "kb_invalid",
			Actions: actions, CreatedBy: "admin",
		}); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("Create(%v) error = %v, want invalid request", actions, err)
		}
	}
}

func TestSharedSpaceActionsAreWhitelisted(t *testing.T) {
	service := NewService(NewMemoryStore())
	if _, err := service.Create(context.Background(), SetInput{
		UserID: "usr_1", ResourceType: ResourceSharedSpace, ResourceID: "space_1",
		Actions: []string{ActionRead, ActionWrite}, CreatedBy: "admin",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := service.Create(context.Background(), SetInput{
		UserID: "usr_2", ResourceType: ResourceSharedSpace, ResourceID: "space_1",
		Actions: []string{ActionUpload}, CreatedBy: "admin",
	}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("Create(upload) error = %v, want invalid request", err)
	}
	if _, err := service.Create(context.Background(), SetInput{
		UserID: "usr_2", ResourceType: ResourceSharedSpace, ResourceID: "space_1",
		Actions: []string{ActionWrite}, CreatedBy: "admin",
	}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("Create(write) error = %v, want invalid request", err)
	}
}

func TestPostgresConstraintErrorsAreMappedBySQLState(t *testing.T) {
	for _, test := range []struct {
		code string
		want error
	}{
		{code: "23505", want: ErrConflict},
		{code: "23503", want: ErrNotFound},
	} {
		if err := mapStoreError(&pgconn.PgError{Code: test.code}); !errors.Is(err, test.want) {
			t.Fatalf("mapStoreError(%s) = %v, want %v", test.code, err, test.want)
		}
	}
}

func TestReplaceAndRemoveResourceActions(t *testing.T) {
	ctx := context.Background()
	service := NewService(NewMemoryStore())
	input := SetInput{UserID: "usr_1", ResourceType: ResourceKnowledgeBase, ResourceID: "kb_1", Actions: []string{ActionRead}, CreatedBy: "admin"}
	if _, err := service.Create(ctx, input); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Create(ctx, input); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate create error = %v", err)
	}
	input.Actions = []string{ActionRead, ActionUpload}
	items, err := service.Replace(ctx, input)
	if err != nil || len(items) != 2 {
		t.Fatalf("Replace() = %#v, %v", items, err)
	}
	allowed, err := service.HasAction(ctx, "usr_1", ResourceKnowledgeBase, "kb_1", ActionUpload)
	if err != nil || !allowed {
		t.Fatalf("HasAction() = %t, %v", allowed, err)
	}
	if err := service.Remove(ctx, "usr_1", ResourceKnowledgeBase, "kb_1"); err != nil {
		t.Fatal(err)
	}
	allowed, err = service.HasAction(ctx, "usr_1", ResourceKnowledgeBase, "kb_1", ActionRead)
	if err != nil || allowed {
		t.Fatalf("HasAction() after remove = %t, %v", allowed, err)
	}
}

func TestDataViewAcceptsBilibiliConnectOnlyWithReadAndAuditsRemoval(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(store)
	valid := SetInput{UserID: "usr_1", ResourceType: ResourceDataView, ResourceID: ViewAgentActivity, Actions: []string{ActionRead}, CreatedBy: "usr_admin", RequestID: "req_1"}
	if _, err := service.Create(ctx, valid); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Create(ctx, SetInput{UserID: "usr_2", ResourceType: ResourceDataView,
		ResourceID: ViewBilibiliOperation, Actions: []string{ActionRead, ActionConnect, ActionManage}, CreatedBy: "usr_admin"}); err != nil {
		t.Fatal(err)
	}
	if audit := store.Audits()[0]; audit.BeforeActions == nil || audit.AfterActions == nil {
		t.Fatalf("create audit actions must be non-nil: %#v", audit)
	}
	for _, input := range []SetInput{
		{UserID: "usr_1", ResourceType: ResourceDataView, ResourceID: "unknown", Actions: []string{ActionRead}, CreatedBy: "usr_admin"},
		{UserID: "usr_1", ResourceType: ResourceDataView, ResourceID: ViewAgentActivity, Actions: []string{ActionWrite}, CreatedBy: "usr_admin"},
		{UserID: "usr_1", ResourceType: ResourceDataView, ResourceID: ViewAgentActivity, Actions: []string{ActionRead, ActionConnect}, CreatedBy: "usr_admin"},
		{UserID: "usr_1", ResourceType: ResourceDataView, ResourceID: ViewAgentActivity, Actions: []string{ActionRead, ActionManage}, CreatedBy: "usr_admin"},
		{UserID: "usr_1", ResourceType: ResourceDataView, ResourceID: ViewBilibiliOperation, Actions: []string{ActionConnect}, CreatedBy: "usr_admin"},
		{UserID: "usr_1", ResourceType: ResourceDataView, ResourceID: ViewBilibiliOperation, Actions: []string{ActionManage}, CreatedBy: "usr_admin"},
	} {
		if _, err := service.Create(ctx, input); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("Create(%#v) = %v", input, err)
		}
	}
	if err := service.RemoveBy(ctx, "usr_1", ResourceDataView, ViewAgentActivity, "usr_admin", "req_2"); err != nil {
		t.Fatal(err)
	}
	allowed, err := service.HasAction(ctx, "usr_1", ResourceDataView, ViewAgentActivity, ActionRead)
	if err != nil || allowed {
		t.Fatalf("HasAction = %v, %v", allowed, err)
	}
	audits := store.Audits()
	if len(audits) != 3 || audits[2].RequestID != "req_2" || len(audits[2].BeforeActions) != 1 || len(audits[2].AfterActions) != 0 {
		t.Fatalf("audits = %#v", audits)
	}
}

func TestResourceCatalogDefinesBilibiliManagementActions(t *testing.T) {
	definition, ok := ResourceDefinitionFor(ResourceDataView)
	if !ok || definition.Name != "数据视图" || len(definition.Actions) != 3 {
		t.Fatalf("data view definition = %#v, %t", definition, ok)
	}
	if definition.Actions[0].Action != ActionRead || definition.Actions[1].Action != ActionConnect || definition.Actions[2].Action != ActionManage {
		t.Fatalf("data view actions = %#v", definition.Actions)
	}
	bilibiliActions := ActionDefinitionsFor(ResourceDataView, ViewBilibiliOperation)
	if len(bilibiliActions) != 3 || bilibiliActions[1].Name != "连接与同步账号" || bilibiliActions[2].Name != "管理账号同步" {
		t.Fatalf("bilibili actions = %#v", bilibiliActions)
	}
	otherActions := ActionDefinitionsFor(ResourceDataView, ViewAgentActivity)
	if len(otherActions) != 1 || otherActions[0].Action != ActionRead {
		t.Fatalf("other data view actions = %#v", otherActions)
	}

	definition.Actions[0].Name = "changed"
	again, _ := ResourceDefinitionFor(ResourceDataView)
	if again.Actions[0].Name != "查看数据视图" {
		t.Fatalf("catalog returned mutable actions: %#v", again.Actions)
	}
}

func TestCreateAuditIncludesExistingAndResultingActions(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(store)
	base := SetInput{UserID: "usr_1", ResourceType: ResourceKnowledgeBase, ResourceID: "kb_1", Actions: []string{ActionRead}, CreatedBy: "usr_admin"}
	if _, err := service.Create(ctx, base); err != nil {
		t.Fatal(err)
	}
	base.Actions = []string{ActionMCP}
	if _, err := service.Create(ctx, base); err != nil {
		t.Fatal(err)
	}
	audit := store.Audits()[1]
	if len(audit.BeforeActions) != 1 || audit.BeforeActions[0] != ActionRead || len(audit.AfterActions) != 2 || audit.AfterActions[0] != ActionMCP || audit.AfterActions[1] != ActionRead {
		t.Fatalf("audit = %#v", audit)
	}
}
