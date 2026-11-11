<div align="center">

# <img src="../assets/aigateway-logo.png" alt="" width="36" height="36" align="absmiddle" /> AI Gateway

**面向FDE、企业CTO、CIO和IT团队 · 由KrillinAI 团队打造**

统一接入模型、MCP 工具、知识库与共享资源，集中完成身份认证、权限控制、路由、审批、审计与用量分析。<br />
**支持所有主流 Agent，你正在使用的 Agent 都可以接入；支持接入 1100+ 模型。**

**简体中文** · [English](../../README.md)

[![GitHub Stars](https://img.shields.io/github/stars/krillinai/AIGateway?style=social)](https://github.com/krillinai/AIGateway/stargazers)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](../../LICENSE)
[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white)](../../server/go.mod)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](../../server/web/package.json)

</div>

<div align="center">
  <img src="../assets/aigateway-overview.png" alt="AI Gateway 统一连接 Agent、模型、工具、数据与业务系统" width="100%" />
</div>

## 项目概览

企业里的 Agent、模型和工具越来越多时，账号密钥容易分散，权限难以统一，调用记录也很难追踪。AI Gateway 把这些连接放到同一个入口，让你可以统一管理谁能使用哪些服务，并清楚查看每一次调用的过程和结果。

这个项目包含 **Gateway 服务端、网页管理台、数据库升级脚本和部署工具**。你可以把它部署在自己的服务器上独立使用，也可以接入 [ClaweeAgent](https://github.com/krillinai/ClaweeAgent)，作为它的企业管理后端。

AI Gateway 本身不是聊天 Agent，也不负责运行桌面客户端或企业业务系统。它更像企业 AI 的统一入口：Agent 通过常见的 OpenAI 兼容接口调用模型，通过 MCP 使用工具和数据。

## 系统架构

<table align="center"><tr><td><pre><code>Agents / IDE / MCP Clients / Enterprise Applications
                         |
          OpenAI-compatible / MCP / A2A (planned) / HTTP
                         |
+---------------------------------------------------------+
| AI Gateway                                              |
|                                                         |
| Shared Governance                                       |
| Identity / RBAC / Agent Management / Gates / Audit      |
| Token Usage / Usage Analytics                           |
|                                                         |
| Gateway Core                                            |
| Model Gateway / MCP Gateway / A2A Gateway (planned)     |
|                                                         |
| Foundational Extensions                                 |
| Skill Hub / Knowledge Bases / File System               |
|                                                         |
| Enterprise System Extensions                            |
| ERP / OA / MES / PLM / CRM / HR / SCM / WMS / TMS       |
| DingTalk / Bilibili / Workflows and Approvals           |
+---------------------------------------------------------+
          |                  |                    |
          v                  v                    v
 Model Upstreams       MCP Upstreams       Enterprise Systems
 OpenAI-compatible     HTTP / stdio         Apps / IM / Data

 PostgreSQL + Embedded Web Console + External Ops Config</code></pre></td></tr></table>

技术栈：**Go 1.25 · Gin · React 19 · TypeScript · Vite · PostgreSQL 16 · MCP Go SDK · Docker**。

## 网关内核

| 模块 | 能力 |
| --- | --- |
| 模型网关 | OpenAI 兼容接口、上游账号与模型目录、模型组、默认模型、故障转移和轮询、SSE 流式响应 |
| MCP 网关 | 纳管 `streamable_http` / `stdio` 上游，同步 tools、resources、prompts，按授权裁剪能力 |
| A2A 网关 | Agent 间协作接入（规划中） |
| 身份与权限 | 账户 Session、稳定 Agent ID、账户 Token、控制台 RBAC、数据资源授权 |
| Agent 管理 | Agent 活动 |
| 风险门禁 | MCP 用户确认与管理员审批，调用前重新校验授权、能力版本和参数快照 |
| 审计 | 记录调用主体、路由、状态、耗时和错误，提供个人记录与管理端分析 |
| Token 用量 | Token 总量、趋势、模型分布、员工排行及缺失用量提示 |

模型与 MCP 审计会脱敏，不保存明文 API Key、Cookie 或上游凭据。

## 基础能力扩展

| 模块 | 能力 |
| --- | --- |
| Skill Hub | Skill 包、版本、空间、Git 来源、审核发布与客户端下载 |
| 知识库 | 百炼、RAGFlow 知识库接入与授权访问 |
| 文件系统 | 共享空间、文件上传下载、本地或阿里云 OSS 存储 |

## 企业系统扩展

按需接入企业系统与办公平台，编排业务流程：

| 类目 | 具体实现 |
| --- | --- |
| 企业系统 | ERP、OA、MES、PLM、CRM、HR、SCM、WMS、TMS、OMS 等 |
| 企业IM | 钉钉 |
| 社媒数据 | Bilibili |
| 业务流程 | 工作流、审批 |

企业系统扩展未配置时，不影响核心账户、RBAC 与 MCP 治理能力。

## 支持的 Agent

支持所有主流 Agent。Agent 可通过自身支持的 OpenAI 兼容 API 或 MCP 配置能力接入 AI Gateway，复用统一的身份、权限、路由、审批和审计能力。

<div align="center">
  <img src="../assets/supported-agents.png" alt="AI Gateway 支持的 21 个主流 Agent 与平台" width="100%" />
</div>

<table align="center">
<thead><tr><th>Agent / 平台</th><th align="center">状态</th><th>快速接入</th></tr></thead>
<tbody>
<tr><td><a href="https://github.com/krillinai/ClaweeAgent">Clawee Agent</a></td><td align="center">✅ 原生配套</td><td><a href="#claweeagent">支持一键接入</a></td></tr>
<tr><td><a href="https://github.com/MoonshotAI/kimi-cli">Kimi</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://www.cursor.com/">Cursor</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://opencode.ai/">OpenCode</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://github.com/google-gemini/gemini-cli">Gemini CLI</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://github.com/features/copilot/cli">GitHub Copilot CLI</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://www.workbuddy.cn/">WorkBuddy</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://qwenwork.cn/">千问办公</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://www.doubao.com/work">豆包工作</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://github.com/openai/codex">Codex</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://github.com/openclaw/openclaw">OpenClaw</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://github.com/NousResearch/hermes-agent">Hermes</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://github.com/badlogic/pi-mono">Pi</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://kiro.dev/">Kiro</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://github.com/QwenLM/qwen-code">Qwen Code</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://github.com/Aider-AI/aider">Aider</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://github.com/Kilo-Org/kilocode">Kilo</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://www.trae.ai/">Trae</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
<tr><td><a href="https://qoder.com/">Qoder</a></td><td align="center">✅ 支持</td><td><a href="#客户端接入">接入指南</a></td></tr>
</tbody>
</table>

## 支持的模型

通过 OpenAI 兼容上游接入 1100+ 模型，覆盖国际与国内模型厂商、开源运行时、推理平台与聚合服务。实际可用模型与多模态能力取决于已配置的上游。

<div align="center">
  <img src="../assets/supported-models.png" alt="OpenAI、Anthropic、Gemini、DeepSeek、千问、Ollama、vLLM、OpenRouter 等 24 个模型厂商与平台" width="100%" />
</div>

## 快速开始

### 环境要求

- Go 1.25、Node.js 24、Corepack 和仓库锁定的 pnpm 10.33.3
- Docker 与 Docker Compose
- Bash 与 Make；Windows 建议使用 WSL2

### 从源码启动

在仓库根目录执行：

```bash
git clone https://github.com/krillinai/AIGateway.git
cd AIGateway
corepack enable pnpm
corepack pnpm run setup
```

初始化仓库外配置。该命令会生成随机密钥，已有配置不会被覆盖：

```bash
export CLAWEE_OPS_DIR="$HOME/aigateway-ops"
corepack pnpm run init \
  --ops-dir "$CLAWEE_OPS_DIR" \
  --gateway http://127.0.0.1:1904
```

启动一套新的本地开发数据库并执行迁移。以下密码仅用于本地开发：

```bash
export CLAWEE_POSTGRES_PASSWORD="local-dev-only"
export CLAW_GATEWAY_DATABASE_URL="postgres://claw_gateway:${CLAWEE_POSTGRES_PASSWORD}@127.0.0.1:15932/claw_gateway?sslmode=disable"
node scripts/clawee.mjs server deps-up
corepack pnpm db:migrate
```

启动 Gateway：

```bash
corepack pnpm server:dev
```

访问 **http://127.0.0.1:1904**。首次启动会在内嵌管理台不存在时自动构建前端。

如需前端热更新，在另一个终端运行 `corepack pnpm admin:dev`，访问 **http://127.0.0.1:5904**。

验证服务：

```bash
curl --fail http://127.0.0.1:1904/healthz
curl --fail http://127.0.0.1:1904/readyz
curl --fail http://127.0.0.1:1904/version
```

**系统中的首个注册账号自动成为管理员。** 请在受控网络中完成首个账号注册，再开放访问；生产环境必须使用 HTTPS。

<details>
<summary><strong>使用 Docker Compose 启动</strong></summary>

先完成 `corepack pnpm run setup`，再执行：

```bash
export CLAWEE_OPS_DIR="$HOME/aigateway-container-ops"
corepack pnpm run init \
  --ops-dir "$CLAWEE_OPS_DIR" \
  --container \
  --gateway http://127.0.0.1:1904

docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml build
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml up -d --wait postgres
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml run --rm gateway migrate up
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml up -d gateway
```

访问 `http://127.0.0.1:1904`。发布镜像为 `ghcr.io/krillinai/aigateway-server`。

Linux 宿主机需允许容器 UID/GID `65532` 读取外部配置。生产权限、HTTPS 和备份步骤见[生产部署指南](../../server/docs/deployment/production.md)。

</details>

## 客户端接入

### 模型 API

1. 在外部 `configs/config.yaml` 中设置 `model_access.mode: "platform_managed"` 并重启 Gateway。
2. 在“模型网关 → 上游账号”添加 OpenAI 兼容 Base URL、API Key 和模型目录。
3. 在“模型网关 → 模型组”配置成员账号、默认模型及 `failover` 或 `round_robin` 策略。
4. 在“我的 Agent”生成平台接入 Token，使用 `http://127.0.0.1:1904/v1` 作为模型 Base URL。

`platform_managed` 模式下，“Agent 动态”的 Token 总量、趋势、模型分布和员工排行直接统计 Gateway 调用记录，按北京时间和用户 ID 汇总。仅累计上游返回的已知用量；缺失或不完整的用量会提示，历史缺失数据不估算。余额与充值仍使用原计费接口。

验证模型目录与调用：

```bash
export GATEWAY_ORIGIN="http://127.0.0.1:1904"
export GATEWAY_API_KEY="<your-token>"

curl --fail "$GATEWAY_ORIGIN/v1/models" \
  -H "Authorization: Bearer $GATEWAY_API_KEY"

curl --fail "$GATEWAY_ORIGIN/v1/chat/completions" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

省略 `model` 时使用模型组默认模型。另支持 `POST /v1/responses` 和 SSE 流式响应，多模态能力由上游模型决定。

Token 同时用于模型与 MCP，分别需要 `model:call` 和 `mcp:call` scope。轮换或吊销会影响该账户下所有 Agent。

### MCP

1. 管理员注册上游并同步能力。
2. 在能力目录检查 Schema 与风险策略，为账户和 Agent 授予必要能力。
3. 需要时配置用户确认或管理员审批。
4. 在“我的 Agent”获取 Token、Agent ID 和 Endpoint，并配置 MCP Client：

```json
{
  "mcpServers": {
    "aigateway": {
      "url": "http://127.0.0.1:1904/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>",
        "X-Claw-Agent-ID": "<your-agent-id>"
      }
    }
  }
}
```

| Endpoint | 用途 |
| --- | --- |
| `/mcp` | 聚合已授权能力 |
| `/mcp/servers/:server_id` | 指定上游的已授权能力 |
| `/mcp/knowledge` | 知识库 MCP 能力 |

`stdio` 上游会在 Gateway 主机执行命令，只允许配置经过审核的可执行文件，并使用低权限系统账户运行 Gateway。

### ClaweeAgent

在 [ClaweeAgent](https://github.com/krillinai/ClaweeAgent) 中将 Gateway Origin 设置为当前部署地址，本地默认为 `http://127.0.0.1:1904`，然后使用 Gateway 账户注册或登录。

详细约定见[Clawee Agent 接入](../../server/docs/integration/clawee-agent.md)和[上游 MCP Server 接入](../../server/docs/integration/upstream-mcp.md)。

## 配置与开发

真实配置必须位于源码仓库之外，程序不会直接读取 `server/configs/config.example.yaml`：

```text
$CLAWEE_OPS_DIR/
├── configs/config.yaml   # 私有配置
├── .env                  # 容器初始化时生成
└── data/                 # Skill 与共享文件等数据
```

已绑定字段可通过 `CLAW_GATEWAY_*` 环境变量覆盖，例如：

| 环境变量 | 用途 |
| --- | --- |
| `CLAW_GATEWAY_SERVER_ADDR` | Gateway 监听地址 |
| `CLAW_GATEWAY_DATABASE_URL` | PostgreSQL 连接串 |
| `CLAW_GATEWAY_MCP_PUBLIC_BASE_URL` | 对外 Gateway Origin |
| `CLAW_GATEWAY_MODEL_ACCESS_MODE` | `platform_managed` 或 `enterprise_managed` |

完整字段与 Secret 要求见[配置参考](../../server/docs/getting-started/configuration.md)。

常用开发命令：

| 命令 | 用途 |
| --- | --- |
| `corepack pnpm run setup` | 安装根目录与管理台依赖 |
| `corepack pnpm server:dev` | 启动 Gateway |
| `corepack pnpm admin:dev` | 启动管理台开发服务器 |
| `corepack pnpm test` | 根目录脚本测试 |
| `corepack pnpm admin test` | 管理台测试 |
| `corepack pnpm server:test` | 服务端与管理台测试 |
| `corepack pnpm server:build` | 构建内嵌管理台的 Go 二进制 |
| `cd server && go vet ./...` | Go 静态检查 |
| `corepack pnpm container:smoke` | 隔离容器冒烟验证 |

服务端集成测试只使用隔离 PostgreSQL，可通过 `CLAW_GATEWAY_TEST_DATABASE_URL` 指定 `_test` 数据库。不要连接开发库或生产库执行测试。

生产部署前请阅读安全与运维文档，落实 HTTPS、Secret 管理、持久化、备份、迁移和指标访问控制。安全问题请按照[安全报告指南](../../SECURITY.md)私密报告。

## 文档导航

- **架构与权限**：[项目职责](../architecture.md) · [Gateway 架构](../../server/docs/architecture/overview.md) · [安全与权限](../../server/docs/architecture/security-and-permissions.md)
- **安装与配置**：[本地开发](../../server/docs/getting-started/development.md) · [配置参考](../../server/docs/getting-started/configuration.md) · [生产部署](../../server/docs/deployment/production.md)
- **客户端接入**：[Clawee Agent](../../server/docs/integration/clawee-agent.md) · [MCP 上游](../../server/docs/integration/upstream-mcp.md) · [HTTP API](../../server/docs/reference/http-api.md)
- **运维与开发**：[验证与操作](../validation-and-operations.md) · [运维手册](../operations/operations-guide.md) · [管理台规范](../frontend/frontend-development-guidelines.md)
- **项目协作**：[贡献指南](../../CONTRIBUTING.md) · [仓库维护约定](../repository-maintenance.md) · [第三方声明](../../third_party/README.md)

## 社区与支持

- 官网：[clawee.work](https://www.clawee.work/)
- Agent 客户端：[ClaweeAgent](https://github.com/krillinai/ClaweeAgent)
- 问题反馈：[GitHub Issues](https://github.com/krillinai/AIGateway/issues)
- 发布版本：[GitHub Releases](https://github.com/krillinai/AIGateway/releases)
- 企业部署：[hello@clawee.ai](mailto:hello@clawee.ai)

欢迎通过 Issue、Pull Request、文档和测试改进 AI Gateway。如果这个项目对你的团队有帮助，欢迎 Star 仓库。

## License

AI Gateway 使用 [Apache License 2.0](../../LICENSE) 开源。第三方声明见 [NOTICE](../../NOTICE) 和 [third_party](../../third_party/README.md)。
