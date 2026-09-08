package knowledge

import (
	"fmt"
	"os"
	"strings"

	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/config"
	"github.com/krillinai/Clawee/server/internal/knowledge/provider"
)

type Runtime struct {
	Provider provider.KnowledgeProvider
}

func NewRuntime(cfg config.KnowledgeConfig, loggers ...*zap.Logger) (Runtime, error) {
	if !cfg.Enabled {
		return Runtime{}, fmt.Errorf("knowledge is disabled")
	}
	if strings.TrimSpace(cfg.ProviderType) != ProviderBailian {
		return Runtime{}, fmt.Errorf("unsupported knowledge provider %q", cfg.ProviderType)
	}
	accessKeyID, err := resolveConfiguredSecret(cfg.Bailian.AccessKeyID, cfg.Bailian.AccessKeyIDRef)
	if err != nil {
		return Runtime{}, fmt.Errorf("resolve bailian access key id: %w", err)
	}
	accessKeySecret, err := resolveConfiguredSecret(cfg.Bailian.AccessKeySecret, cfg.Bailian.AccessKeySecretRef)
	if err != nil {
		return Runtime{}, fmt.Errorf("resolve bailian access key secret: %w", err)
	}
	p, err := provider.NewBailianProvider(provider.BailianConfig{
		Endpoint:        cfg.Bailian.Endpoint,
		WorkspaceID:     cfg.Bailian.WorkspaceID,
		AccessKeyID:     accessKeyID,
		AccessKeySecret: accessKeySecret,
		Logger:          firstLogger(loggers),
	})
	if err != nil {
		return Runtime{}, err
	}
	return Runtime{Provider: p}, nil
}

func firstLogger(loggers []*zap.Logger) *zap.Logger {
	if len(loggers) > 0 {
		return loggers[0]
	}
	return nil
}

func ResolveCredential(reference string) (string, error) {
	return resolveSecret(reference)
}

func ResolveConfiguredCredential(value, reference string) (string, error) {
	return resolveConfiguredSecret(value, reference)
}

func resolveConfiguredSecret(value, reference string) (string, error) {
	if value = strings.TrimSpace(value); value != "" {
		return value, nil
	}
	return resolveSecret(reference)
}

func resolveSecret(reference string) (string, error) {
	reference = strings.TrimSpace(reference)
	if reference == "" {
		return "", fmt.Errorf("credential reference is required")
	}
	value := strings.TrimSpace(os.Getenv(reference))
	if value == "" {
		return "", fmt.Errorf("environment variable %s is empty", reference)
	}
	return value, nil
}
