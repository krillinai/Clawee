package agentprompt

import (
	"context"
	"testing"
)

func TestMemoryStoreUpdatesVersionAndRejectsSecrets(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(store)

	policy, err := service.Update(context.Background(), UpdateInput{
		ServerPrompt: "优先使用企业知识库",
		ClaweePrompt: "称呼用户为 演示助手",
	})
	if err != nil {
		t.Fatal(err)
	}
	if policy.Version != 1 || policy.ServerPrompt == "" || policy.ClaweePrompt == "" {
		t.Fatalf("unexpected policy: %#v", policy)
	}

	if _, err := service.Update(context.Background(), UpdateInput{ServerPrompt: "api_key=secret"}); err != ErrPromptContainsSecret {
		t.Fatalf("secret validation error = %v", err)
	}
	if _, err := service.Update(context.Background(), UpdateInput{ServerPrompt: string(make([]rune, MaxPromptLength+1))}); err != ErrPromptTooLong {
		t.Fatalf("length validation error = %v", err)
	}
}
