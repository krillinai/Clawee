package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"

	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/app"
	"github.com/krillinai/Clawee/server/internal/buildinfo"
	"github.com/krillinai/Clawee/server/internal/config"
	"github.com/krillinai/Clawee/server/internal/store"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		panic(err)
	}
}

type commandDeps struct {
	loadConfig func(string) (config.Config, error)
	serve      func(context.Context, config.Config) error
	migrateUp  func(context.Context, config.Config) error
}

func run(ctx context.Context, args []string) error {
	return runWithDeps(ctx, args, commandDeps{
		loadConfig: config.Load,
		serve:      serve,
		migrateUp: func(ctx context.Context, cfg config.Config) error {
			return store.MigrateUp(ctx, cfg.Database.URL)
		},
	})
}

func runWithDeps(ctx context.Context, args []string, deps commandDeps) error {
	if len(args) > 0 {
		switch args[0] {
		case "serve":
			return runServeCommand(ctx, args[1:], deps)
		case "migrate":
			return runMigrateCommand(ctx, args[1:], deps)
		}
	}
	return runServeCommand(ctx, args, deps)
}

func runServeCommand(ctx context.Context, args []string, deps commandDeps) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	configPath := fs.String("config", "", "path to config file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := deps.loadConfig(*configPath)
	if err != nil {
		return err
	}
	return deps.serve(ctx, cfg)
}

func runMigrateCommand(ctx context.Context, args []string, deps commandDeps) error {
	if len(args) == 0 {
		return fmt.Errorf("migration command is required")
	}
	switch args[0] {
	case "up":
		fs := flag.NewFlagSet("migrate up", flag.ContinueOnError)
		configPath := fs.String("config", "", "path to config file")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		cfg, err := deps.loadConfig(*configPath)
		if err != nil {
			return err
		}
		return deps.migrateUp(ctx, cfg)
	default:
		return fmt.Errorf("unsupported migration command %q", args[0])
	}
}

func serve(ctx context.Context, cfg config.Config) error {
	application, err := app.New(context.Background(), cfg)
	if err != nil {
		return err
	}
	defer application.Close()
	defer application.Logger.Sync()

	application.Logger.Info("claw-mcp server listening",
		zap.String("addr", cfg.Server.Addr),
		zap.String("mcp_endpoint", "/mcp"),
		zap.String("version", buildinfo.FullVersion()),
	)

	if err := http.ListenAndServe(cfg.Server.Addr, application.Router); err != nil {
		application.Logger.Fatal("server stopped", zap.Error(err))
	}
	return nil
}
