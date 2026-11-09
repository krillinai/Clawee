package app

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
)

// 历史迁移与有效角色视图继续保留，但公开版本不接管外部组织同步。
// 拒绝连接已有组织数据的实例，避免留下失去同步维护的授权或自动清除权限。
func ensureNoLegacyOrganization(ctx context.Context, pool *pgxpool.Pool) error {
	if pool == nil {
		return nil
	}
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM rose_departments) OR EXISTS (SELECT 1 FROM rose_account_roles)`).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return errors.New("当前版本不支持已有的外部组织同步数据；请继续使用原部署并单独规划迁移，不要直接覆盖运行")
	}
	return nil
}
