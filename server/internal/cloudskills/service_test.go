package cloudskills

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/settings"
	"github.com/krillinai/Clawee/server/internal/skillhub"
)

type accountReaderStub struct {
	account accounts.Account
	err     error
}

func (s accountReaderStub) AccountByEmail(context.Context, string) (accounts.Account, error) {
	return s.account, s.err
}

type skillReaderStub struct {
	items []skillhub.PublishedItem
}

func (s skillReaderStub) ListPublishedForUser(context.Context, string, string) ([]skillhub.PublishedItem, error) {
	return s.items, nil
}

func TestListUsesDefaultsAndPublishedItems(t *testing.T) {
	service := NewService(settings.NewMemoryStore(), accountReaderStub{account: accounts.Account{UserID: "demo", Email: DefaultAgentEmail, Name: "演示助手", Status: accounts.StatusActive}}, skillReaderStub{items: []skillhub.PublishedItem{{SkillID: "skill-1", Name: "数据分析", Version: "1.0.0", UpdatedAt: time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)}}})

	result, err := service.List(context.Background())
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if result.AgentEmail != DefaultAgentEmail || result.AgentName != "演示助手" || result.PromptTemplate != DefaultPromptTemplate {
		t.Fatalf("List() defaults = %#v", result)
	}
	if len(result.Skills) != 1 || result.Skills[0].Name != "数据分析" {
		t.Fatalf("List() skills = %#v", result.Skills)
	}
}

func TestUpdateValidatesConfigAndHonorsVersion(t *testing.T) {
	service := NewService(settings.NewMemoryStore(), nil, nil)
	ctx := context.Background()
	if _, err := service.Update(ctx, Config{AgentEmail: "bad", PromptTemplate: "提示"}, "admin", 0); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("invalid email error = %v", err)
	}
	updated, err := service.Update(ctx, Config{AgentEmail: "demo@example.com", PromptTemplate: "{skill_name}"}, "admin", 0)
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated.Version != 1 || updated.AgentEmail != "demo@example.com" {
		t.Fatalf("updated config = %#v", updated)
	}
	if _, err := service.Update(ctx, Config{AgentEmail: "demo@example.com", PromptTemplate: "next"}, "admin", 1); err != nil {
		t.Fatalf("versioned update error = %v", err)
	}
}
