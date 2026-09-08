# 本地开发

## 环境要求

- Go 1.25 或与 `go.mod` 一致的版本；
- Node.js 24；
- pnpm 10；
- Docker 与 Docker Compose；
- PostgreSQL 16（也可使用 Compose 启动）。

## 启动依赖

先指定独立于源码仓库的私有运维目录。仓库内的示例配置只用于初始化，不会被程序直接读取：

```bash
# 在整合仓库根目录先运行 npm run setup，然后进入 server/：
export CLAWEE_OPS_DIR="$HOME/clawee-ops"
node ../scripts/clawee.mjs init --ops-dir "$CLAWEE_OPS_DIR"
```

初始化会生成安全密钥。默认数据库位于本机 `15932` 端口；其他部署请修改私有配置或 `$CLAWEE_OPS_DIR/.env`。

```bash
docker compose -f deploy/docker-compose.yaml up -d postgres
```

确认数据库就绪：

```bash
docker compose -f deploy/docker-compose.yaml exec postgres \
  pg_isready -U claw_mcp -d claw_mcp
```

## 初始化数据库

```bash
make db-migrate-up
```

迁移只支持向上执行。运行迁移前应确认配置指向开发数据库；集成测试数据库名称必须以 `_test` 结尾。

## 启动后端和管理控制台

一条命令启动本地依赖、后端和 Web 开发服务器：

```bash
./scripts/dev.sh
```

默认地址：

- 后端：`http://127.0.0.1:1904`
- Web 开发服务器：`http://127.0.0.1:5904`

也可以分别启动：

```bash
./scripts/dev-backend.sh
./scripts/dev-web.sh
```

## 验证服务

```bash
curl --fail http://127.0.0.1:1904/healthz
curl --fail http://127.0.0.1:1904/readyz
curl --fail http://127.0.0.1:1904/version
```

## 测试与构建

```bash
./scripts/test.sh
./scripts/build-all.sh
```

仅运行后端单元测试：

```bash
go test ./...
```

仅运行前端测试：

```bash
pnpm --dir web install --frozen-lockfile
pnpm --dir web test
```

## 开发数据

`db/seeds/mcp_gateway_admin_test_data.sql` 只用于演示和测试。不要向共享或生产数据库导入测试 Seed，也不要把生产数据复制到本地测试环境。
