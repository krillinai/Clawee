package dataaccess

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestRoleGrantSubjectAndActions(t *testing.T) {
	for _, test := range []struct {
		name         string
		userID       string
		roleID       string
		resourceType string
		actions      []string
	}{
		{name: "无主体", resourceType: ResourceSkillSpace, actions: []string{ActionRead}},
		{name: "双主体", userID: "user", roleID: "role", resourceType: ResourceSkillSpace, actions: []string{ActionRead}},
		{name: "角色跨资源", roleID: "role", resourceType: ResourceSharedSpace, actions: []string{ActionRead}},
		{name: "非法动作", roleID: "role", resourceType: ResourceSkillSpace, actions: []string{ActionUpload}},
		{name: "空动作", roleID: "role", resourceType: ResourceSkillSpace},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := NewService(NewMemoryStore())
			input := SetInput{UserID: test.userID, RoleID: test.roleID, ResourceType: test.resourceType,
				ResourceID: "space", Actions: test.actions, CreatedBy: "operator"}
			if _, err := service.Create(context.Background(), input); !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("Create() = %v", err)
			}
			if _, err := service.Replace(context.Background(), input); !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("Replace() = %v", err)
			}
		})
	}
}

func TestRoleGrantManagementKeepsAccountSourceAndAudits(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(store)
	input := SetInput{RoleID: " role ", ResourceType: " skill_space ", ResourceID: " space ",
		Actions: []string{ActionRead, ActionRead}, CreatedBy: "operator", RequestID: "request"}
	items, err := service.Create(ctx, input)
	if err != nil || len(items) != 1 || items[0].RoleID != "role" || items[0].UserID != "" {
		t.Fatalf("Create() = %#v, %v", items, err)
	}
	if _, err := service.Create(ctx, input); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate Create() = %v", err)
	}
	accountInput := SetInput{UserID: "role", ResourceType: ResourceSkillSpace, ResourceID: "space", Actions: []string{ActionRead}, CreatedBy: "operator"}
	if _, err := service.Create(ctx, accountInput); err != nil {
		t.Fatal(err)
	}
	input.Actions = []string{ActionRead, ActionWrite}
	if _, err := service.Replace(ctx, input); err != nil {
		t.Fatal(err)
	}
	if err := service.RecordFailure(ctx, input); err != nil {
		t.Fatal(err)
	}
	audits := store.Audits()
	last := audits[len(audits)-1]
	if last.TargetRoleID != "role" || last.TargetUserID != "" || last.OperatorID != "operator" || last.RequestID != "request" || last.Result != "failed" ||
		!reflect.DeepEqual(last.BeforeActions, []string{ActionRead, ActionWrite}) || !reflect.DeepEqual(last.BeforeActions, last.AfterActions) {
		t.Fatalf("failed audit = %#v", last)
	}
	if err := service.RemoveSubject(ctx, input); err != nil {
		t.Fatal(err)
	}
	roles, err := service.List(ctx, Filter{ResourceType: ResourceSkillSpace, ResourceID: "space", RoleGrants: true})
	if err != nil || len(roles) != 0 {
		t.Fatalf("role grants = %#v, %v", roles, err)
	}
	users, err := service.List(ctx, Filter{ResourceType: ResourceSkillSpace, ResourceID: "space"})
	if err != nil || len(users) != 1 || users[0].UserID != "role" || users[0].RoleID != "" {
		t.Fatalf("account grants = %#v, %v", users, err)
	}
	last = store.Audits()[len(store.Audits())-1]
	if last.TargetUserID != "" || last.TargetRoleID != "role" || !reflect.DeepEqual(last.BeforeActions, []string{ActionRead, ActionWrite}) || len(last.AfterActions) != 0 {
		t.Fatalf("remove audit = %#v", last)
	}
	if err := service.RemoveSubject(ctx, input); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second remove = %v", err)
	}
}

func TestRoleGrantDoesNotBecomeAccountGrant(t *testing.T) {
	ctx := context.Background()
	service := NewService(NewMemoryStore())
	if _, err := service.Create(ctx, SetInput{RoleID: "role", ResourceType: ResourceSkillSpace, ResourceID: "space", Actions: []string{ActionRead}, CreatedBy: "operator"}); err != nil {
		t.Fatal(err)
	}
	if allowed, err := service.HasResourceGrants(ctx, ResourceSkillSpace, "space"); err != nil || !allowed {
		t.Fatalf("HasResourceGrants() = %v, %v", allowed, err)
	}
	if allowed, err := service.HasAction(ctx, "role", ResourceSkillSpace, "space", ActionRead); err != nil || allowed {
		t.Fatalf("HasAction(role ID as account) = %v, %v", allowed, err)
	}
	if _, err := service.HasAction(ctx, "", ResourceSkillSpace, "space", ActionRead); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("empty account HasAction() = %v", err)
	}
	for _, input := range []SetInput{{}, {UserID: "user", RoleID: "role"}, {RoleID: "role", ResourceType: ResourceSharedSpace}} {
		input.ResourceID, input.CreatedBy = "space", "operator"
		if input.ResourceType == "" {
			input.ResourceType = ResourceSkillSpace
		}
		if err := service.RemoveSubject(ctx, input); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("invalid remove = %v", err)
		}
	}
	if _, err := service.List(ctx, Filter{UserID: "user", RoleGrants: true, ResourceType: ResourceSkillSpace}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("mixed source filter = %v", err)
	}
}
