package agentidentity

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testAgentID = "clawee_550e8400-e29b-41d4-a716-446655440000"

func TestResolveInheritsClaweeAgentID(t *testing.T) {
	dir := t.TempDir()
	agentConfig := filepath.Join(dir, "runtime", "config.toml")
	collectorConfig := filepath.Join(dir, "collector", "config.toml")
	writeTestFile(t, agentConfig, "gateway = 'https://gateway.example.com'\nagent_id = '"+testAgentID+"'\n")
	writeTestFile(t, collectorConfig, "office_url = 'https://gateway.example.com'\nagent_id = 'clawee_123e4567-e89b-42d3-a456-426614174000'\n")

	got, err := Resolve(context.Background(), Options{
		ClaweeAgentConfigPath: agentConfig,
		CollectorConfigPath:   collectorConfig,
		OfficeURL:             "https://gateway.example.com/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != testAgentID {
		t.Fatalf("Resolve() = %q, want %q", got, testAgentID)
	}
}

func TestResolveBackfillsClaweeAgentConfigFromCollector(t *testing.T) {
	dir := t.TempDir()
	agentConfig := filepath.Join(dir, "config.toml")
	collectorConfig := filepath.Join(dir, "collector", "config.toml")
	writeTestFile(t, agentConfig, "gateway = 'https://gateway.example.com'\n")
	writeTestFile(t, collectorConfig, "office_url = 'https://gateway.example.com'\nagent_id = '"+testAgentID+"'\n")

	got, err := Resolve(context.Background(), Options{
		ClaweeAgentConfigPath: agentConfig,
		CollectorConfigPath:   collectorConfig,
		OfficeURL:             "https://gateway.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != testAgentID {
		t.Fatalf("Resolve() = %q, want %q", got, testAgentID)
	}
	body, err := os.ReadFile(agentConfig)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), testAgentID) {
		t.Fatalf("clawee-agent config was not backfilled: %s", body)
	}
}

func TestResolveGeneratesOnceWhenBothConfigsLackAgentID(t *testing.T) {
	dir := t.TempDir()
	agentConfig := filepath.Join(dir, "config.toml")
	writeTestFile(t, agentConfig, "gateway = 'https://gateway.example.com'\n")

	first, err := Resolve(context.Background(), Options{
		ClaweeAgentConfigPath: agentConfig,
		CollectorConfigPath:   filepath.Join(dir, "collector", "config.toml"),
		OfficeURL:             "https://gateway.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Resolve(context.Background(), Options{
		ClaweeAgentConfigPath: agentConfig,
		CollectorConfigPath:   filepath.Join(dir, "collector", "config.toml"),
		OfficeURL:             "https://gateway.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	if first != second || !IsValid(first) {
		t.Fatalf("generated IDs = %q and %q", first, second)
	}
}

func TestResolveRejectsGatewayMismatch(t *testing.T) {
	dir := t.TempDir()
	agentConfig := filepath.Join(dir, "config.toml")
	writeTestFile(t, agentConfig, "gateway = 'https://other.example.com'\nagent_id = '"+testAgentID+"'\n")

	_, err := Resolve(context.Background(), Options{
		ClaweeAgentConfigPath: agentConfig,
		OfficeURL:             "https://gateway.example.com",
	})
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("Resolve() error = %v", err)
	}
}

func TestResolveAcceptsSameGatewayOriginWithDifferentPaths(t *testing.T) {
	dir := t.TempDir()
	agentConfig := filepath.Join(dir, "config.toml")
	collectorConfig := filepath.Join(dir, "collector", "config.toml")
	writeTestFile(t, agentConfig, "gateway = 'https://gateway.example.com'\n")
	writeTestFile(t, collectorConfig, "office_url = 'https://gateway.example.com/office'\nagent_id = '"+testAgentID+"'\n")

	got, err := Resolve(context.Background(), Options{
		ClaweeAgentConfigPath: agentConfig,
		CollectorConfigPath:   collectorConfig,
		OfficeURL:             "https://gateway.example.com/office",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != testAgentID {
		t.Fatalf("Resolve() = %q, want %q", got, testAgentID)
	}
}

func TestResolveRejectsCollectorAgentIDWithoutOfficeURL(t *testing.T) {
	dir := t.TempDir()
	agentConfig := filepath.Join(dir, "config.toml")
	collectorConfig := filepath.Join(dir, "collector", "config.toml")
	writeTestFile(t, agentConfig, "gateway = 'https://gateway.example.com'\n")
	writeTestFile(t, collectorConfig, "agent_id = '"+testAgentID+"'\n")

	_, err := Resolve(context.Background(), Options{
		ClaweeAgentConfigPath: agentConfig,
		CollectorConfigPath:   collectorConfig,
		OfficeURL:             "https://gateway.example.com",
	})
	if err == nil || !strings.Contains(err.Error(), "office_url is required") {
		t.Fatalf("Resolve() error = %v", err)
	}
}

func TestResolveClaweeAgentConfigPathUsesExplicitThenEnvironment(t *testing.T) {
	t.Setenv(configEnvName, "/tmp/from-env.toml")
	explicit, err := ResolveClaweeAgentConfigPath("/tmp/explicit.toml")
	if err != nil || explicit != "/tmp/explicit.toml" {
		t.Fatalf("explicit path = %q, err = %v", explicit, err)
	}
	configured, err := ResolveClaweeAgentConfigPath("")
	if err != nil || configured != "/tmp/from-env.toml" {
		t.Fatalf("configured path = %q, err = %v", configured, err)
	}
}

func writeTestFile(t *testing.T, path string, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}
