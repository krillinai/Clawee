package main

import (
	"context"
	"testing"

	"github.com/krillinai/Clawee/server/internal/config"
)

func TestRunDefaultsToServeForLegacyFlags(t *testing.T) {
	var served bool
	err := runWithDeps(context.Background(), []string{"--config", "testdata/config.yaml"}, commandDeps{
		loadConfig: func(path string) (config.Config, error) {
			if path != "testdata/config.yaml" {
				t.Fatalf("config path = %q", path)
			}
			return config.Config{}, nil
		},
		serve: func(context.Context, config.Config) error {
			served = true
			return nil
		},
		migrateUp: func(context.Context, config.Config) error {
			t.Fatal("migrate should not run for legacy serve flags")
			return nil
		},
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !served {
		t.Fatal("serve was not called")
	}
}

func TestRunDispatchesMigrateUp(t *testing.T) {
	var migrated bool
	err := runWithDeps(context.Background(), []string{"migrate", "up", "--config", "testdata/config.yaml"}, commandDeps{
		loadConfig: func(path string) (config.Config, error) {
			if path != "testdata/config.yaml" {
				t.Fatalf("config path = %q", path)
			}
			return config.Config{}, nil
		},
		serve: func(context.Context, config.Config) error {
			t.Fatal("serve should not run for migrate up")
			return nil
		},
		migrateUp: func(context.Context, config.Config) error {
			migrated = true
			return nil
		},
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !migrated {
		t.Fatal("migrate up was not called")
	}
}
