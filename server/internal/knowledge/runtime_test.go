package knowledge

import (
	"testing"

	"github.com/krillinai/Clawee/server/internal/config"
)

func TestNewRuntimeResolvesSecrets(t *testing.T) {
	t.Setenv("TEST_BAILIAN_AK", "access-key")
	t.Setenv("TEST_BAILIAN_SECRET", "access-secret")

	runtime, err := NewRuntime(testKnowledgeConfig())
	if err != nil {
		t.Fatalf("NewRuntime() error = %v", err)
	}
	if runtime.Provider == nil {
		t.Fatalf("runtime = %#v", runtime)
	}
}

func TestNewRuntimeUsesDirectlyConfiguredSecrets(t *testing.T) {
	cfg := testKnowledgeConfig()
	cfg.Bailian.AccessKeyID = "direct-access-key"
	cfg.Bailian.AccessKeySecret = "direct-access-secret"
	cfg.Bailian.AccessKeyIDRef = ""
	cfg.Bailian.AccessKeySecretRef = ""

	runtime, err := NewRuntime(cfg)
	if err != nil {
		t.Fatalf("NewRuntime() error = %v", err)
	}
	if runtime.Provider == nil {
		t.Fatalf("runtime = %#v", runtime)
	}
}

func TestNewRuntimeRejectsMissingSecret(t *testing.T) {
	t.Setenv("TEST_BAILIAN_AK", "access-key")
	if _, err := NewRuntime(testKnowledgeConfig()); err == nil {
		t.Fatal("NewRuntime() should reject a missing access key secret")
	}
}

func testKnowledgeConfig() config.KnowledgeConfig {
	return config.KnowledgeConfig{
		Enabled:      true,
		ProviderType: ProviderBailian,
		Bailian: config.BailianConfig{
			Endpoint:           "https://example.com",
			WorkspaceID:        "workspace",
			AccessKeyIDRef:     "TEST_BAILIAN_AK",
			AccessKeySecretRef: "TEST_BAILIAN_SECRET",
		},
	}
}
