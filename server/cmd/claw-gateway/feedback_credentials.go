package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"github.com/krillinai/Clawee/server/internal/feedback"
	"github.com/krillinai/Clawee/server/internal/store"
	"os"
	"time"
)

func runFeedbackCredentialCommand(ctx context.Context, args []string, deps commandDeps) error {
	if len(args) < 1 {
		return errors.New("需要 create 或 revoke 操作")
	}
	operation := args[0]
	fs := flag.NewFlagSet("feedback-credential", flag.ContinueOnError)
	configPath := fs.String("config", "", "运维配置路径")
	source := fs.String("source", "", "可信来源标识")
	output := fs.String("output", "", "凭证交付文件路径（仅创建时）")
	id := fs.String("id", "", "撤销的凭证编号")
	expires := fs.String("expires", "", "RFC3339 到期时间")
	quota := fs.Int64("capacity-bytes", 2<<30, "可信来源保留资料配额")
	if e := fs.Parse(args[1:]); e != nil {
		return e
	}
	cfg, e := deps.loadConfig(*configPath)
	if e != nil {
		return e
	}
	if !cfg.Feedback.Enabled {
		return errors.New("反馈接收模块未启用")
	}
	pool, e := store.OpenPostgres(ctx, cfg.Database.URL)
	if e != nil {
		return e
	}
	if pool == nil {
		return errors.New("缺少持久化数据库")
	}
	defer pool.Close()
	svc := feedback.NewService(feedback.NewPostgresStore(pool), nil, nil, cfg.Feedback.CapacityBytes)
	switch operation {
	case "create":
		if *output == "" {
			return errors.New("必须指定私有交付文件路径")
		}
		at, e := time.Parse(time.RFC3339, *expires)
		if e != nil {
			return errors.New("到期时间无效")
		}
		f, e := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return e
		}
		defer f.Close()
		c, raw, e := svc.CreateDeploymentCredential(ctx, *source, at, *quota)
		if e != nil {
			return e
		}
		return json.NewEncoder(f).Encode(map[string]any{"credential_id": c.ID, "source_id": c.SourceID, "expires_at": c.ExpiresAt, "capacity_bytes": c.CapacityBytes, "deployment_token": raw})
	case "revoke":
		return svc.RevokeDeploymentCredential(ctx, *id)
	default:
		return errors.New("不支持的凭证操作")
	}
}
