<div align="center">

# <img src="./docs/assets/aigateway-logo.png" alt="" width="36" height="36" align="absmiddle" /> AI Gateway

**For forward deployed engineers (FDEs), enterprise CTOs, CIOs, and IT teams · Built by KrillinAI**

Connect models, MCP tools, knowledge bases, and shared resources through a single gateway for authentication, access control, routing, approvals, auditing, and usage analytics.<br />
**Supports 20+ mainstream Agents, including the one you already use, and over 1,100 models.**

[简体中文](./docs/zh-CN/README.md) · **English**

[![GitHub Stars](https://img.shields.io/github/stars/krillinai/AIGateway?style=social)](https://github.com/krillinai/AIGateway/stargazers)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white)](./server/go.mod)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](./server/web/package.json)

</div>

<div align="center">
  <img src="./docs/assets/aigateway-overview.png" alt="AI Gateway connecting Agents, models, tools, data, and business systems" width="100%" />
</div>

## Project Overview

As teams adopt more Agents, models, and tools, credentials become scattered, permissions become harder to manage, and it becomes difficult to see who called what. AI Gateway brings these connections into one place, so you can control who can use each service and keep a clear record of every call.

This project includes the **Gateway server, web management console, database migrations, and deployment tools**. You can deploy it on your own infrastructure and use it independently, or connect it to [ClaweeAgent](https://github.com/krillinai/ClaweeAgent) as its enterprise management backend.

AI Gateway is not a chat Agent, and it does not run desktop clients or your business systems. It provides a single entry point for enterprise AI: Agents call models through a familiar OpenAI-compatible API and access tools and data through MCP.

## System Architecture

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

Technology stack: **Go 1.25 · Gin · React 19 · TypeScript · Vite · PostgreSQL 16 · MCP Go SDK · Docker**.

## Gateway Core

| Module | Capabilities |
| --- | --- |
| Model Gateway | OpenAI-compatible APIs, upstream accounts and model catalogs, model groups, default models, failover, round robin, and SSE streaming |
| MCP Gateway | Manage `streamable_http` and `stdio` upstreams, synchronize tools, resources, and prompts, and filter capabilities by authorization |
| A2A Gateway | Agent-to-agent collaboration (planned) |
| Identity and Access | Account sessions, stable Agent IDs, account tokens, console RBAC, and data resource grants |
| Agent Management | Agent activity |
| Risk Gates | User confirmation and administrator approval for MCP calls, with authorization, capability version, and parameter snapshot checks before execution |
| Auditing | Track callers, routes, status, latency, and errors with personal history and administrator analytics |
| Token Usage | Token totals, trends, model distribution, employee rankings, and missing usage indicators |

Model and MCP audits are redacted and do not store plaintext API keys, cookies, or upstream credentials.

## Foundational Extensions

| Module | Capabilities |
| --- | --- |
| Skill Hub | Skill packages, versions, spaces, Git sources, review and publishing workflows, and client downloads |
| Knowledge Bases | Bailian and RAGFlow knowledge base integration with authorized access |
| File System | Shared spaces, file upload and download, and local or Alibaba Cloud OSS storage |

## Enterprise System Extensions

Connect enterprise systems and office platforms, and orchestrate business processes as needed:

| Category | Implementation |
| --- | --- |
| Enterprise systems | ERP, OA, MES, PLM, CRM, HR, SCM, WMS, TMS, OMS, and more |
| Enterprise IM | DingTalk |
| Social media data | Bilibili |
| Business processes | Workflows and approvals |

Enterprise system extensions are not required for core account, RBAC, and MCP governance capabilities.

## Agent Activity

Monitor adoption and usage across employees and Agents in one view. Filter by today, the last 7 days, or the last 30 days, then inspect:

- Token totals, active employees, active Agents, and completed turns
- Token trends and input, cached input, and output composition
- Request counts and token consumption rankings by user
- Model and MCP usage distribution
- Agent sessions, turns, status, and latest activity

<div align="center">
  <img src="./docs/assets/agent-activity.jpg" alt="Agent Activity dashboard with token trends, usage rankings, model and MCP distribution, and Agent status" width="100%" />
</div>

## Supported Agents

AI Gateway supports all mainstream Agents. Configure your Agent to use the Gateway's OpenAI-compatible API or MCP endpoint to access centralized identity, access control, routing, approvals, and auditing.

<div align="center">
  <img src="./docs/assets/supported-agents.png" alt="21 mainstream Agents and platforms supported by AI Gateway" width="100%" />
</div>

<table align="center">
<thead><tr><th>Agent / Platform</th><th align="center">Status</th><th>Quick Start</th></tr></thead>
<tbody>
<tr><td><a href="https://github.com/krillinai/ClaweeAgent">Clawee Agent</a></td><td align="center">✅ Native companion</td><td><a href="#claweeagent">One-click integration</a></td></tr>
<tr><td><a href="https://github.com/MoonshotAI/kimi-cli">Kimi</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://www.cursor.com/">Cursor</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://opencode.ai/">OpenCode</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://github.com/google-gemini/gemini-cli">Gemini CLI</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://github.com/features/copilot/cli">GitHub Copilot CLI</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://www.workbuddy.cn/">WorkBuddy</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://qwenwork.cn/">Qwen Workspace (千问办公)</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://www.doubao.com/work">Doubao Workspace (豆包工作)</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://github.com/openai/codex">Codex</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://github.com/openclaw/openclaw">OpenClaw</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://github.com/NousResearch/hermes-agent">Hermes</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://github.com/badlogic/pi-mono">Pi</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://kiro.dev/">Kiro</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://github.com/QwenLM/qwen-code">Qwen Code</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://github.com/Aider-AI/aider">Aider</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://github.com/Kilo-Org/kilocode">Kilo</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://www.trae.ai/">Trae</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
<tr><td><a href="https://qoder.com/">Qoder</a></td><td align="center">✅ Supported</td><td><a href="#client-integration">Integration guide</a></td></tr>
</tbody>
</table>

## Supported Models

Access over 1,100 models through OpenAI-compatible upstreams, spanning international and Chinese providers, open-source runtimes, inference platforms, and model aggregators. Available models and multimodal capabilities depend on the configured upstreams.

<div align="center">
  <img src="./docs/assets/supported-models.png" alt="24 model providers and platforms, including OpenAI, Anthropic, Gemini, DeepSeek, Qwen, Ollama, vLLM, and OpenRouter" width="100%" />
</div>

## Quick Start

### Prerequisites

- Go 1.25, Node.js 24, Corepack, and pnpm 10.33.3 as pinned by the repository
- Docker and Docker Compose
- Bash and Make; WSL2 is recommended on Windows

### Run from Source

Run the following commands from the repository root:

```bash
git clone https://github.com/krillinai/AIGateway.git
cd AIGateway
corepack enable pnpm
corepack pnpm run setup
```

Initialize configuration outside the repository. This command generates random secrets and never overwrites an existing configuration:

```bash
export CLAWEE_OPS_DIR="$HOME/aigateway-ops"
corepack pnpm run init \
  --ops-dir "$CLAWEE_OPS_DIR" \
  --gateway http://127.0.0.1:1904
```

Start a fresh local development database and run migrations. The following password is for local development only:

```bash
export CLAWEE_POSTGRES_PASSWORD="local-dev-only"
export CLAW_GATEWAY_DATABASE_URL="postgres://claw_gateway:${CLAWEE_POSTGRES_PASSWORD}@127.0.0.1:15932/claw_gateway?sslmode=disable"
node scripts/clawee.mjs server deps-up
corepack pnpm db:migrate
```

Start the Gateway:

```bash
corepack pnpm server:dev
```

Open **http://127.0.0.1:1904**. On the first launch, the management console is built automatically if its embedded assets are missing.

For frontend hot reloading, run `corepack pnpm admin:dev` in another terminal and open **http://127.0.0.1:5904**.

Verify the service:

```bash
curl --fail http://127.0.0.1:1904/healthz
curl --fail http://127.0.0.1:1904/readyz
curl --fail http://127.0.0.1:1904/version
```

**The first registered account automatically becomes the administrator.** Complete this registration on a controlled network before opening access to others. Production deployments must use HTTPS.

<details>
<summary><strong>Run with Docker Compose</strong></summary>

Complete `corepack pnpm run setup`, then run:

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

Open `http://127.0.0.1:1904`. The published image is `ghcr.io/krillinai/aigateway-server`.

On Linux hosts, allow container UID/GID `65532` to read the external configuration. See the [production deployment guide](./server/docs/en/deployment/production.md) for production permissions, HTTPS, and backup procedures.

</details>

## Client Integration

### Model API

1. Set `model_access.mode: "platform_managed"` in the external `configs/config.yaml` and restart the Gateway.
2. Under **Model Gateway → Upstream Accounts**, add an OpenAI-compatible Base URL, API key, and model catalog.
3. Under **Model Gateway → Model Groups**, configure member accounts, a default model, and a `failover` or `round_robin` strategy.
4. Under **My Agents**, generate a platform access token and use `http://127.0.0.1:1904/v1` as the model Base URL.

In `platform_managed` mode, token totals, trends, model distribution, and employee rankings on **Agent Activity** are calculated directly from Gateway invocation records, aggregated by Beijing time (UTC+8) and user ID. Only known usage returned by upstream providers is counted. Missing or incomplete usage is flagged, and missing historical data is not estimated. Balances and top-ups continue to use the existing billing API.

Verify the model catalog and a request:

```bash
export GATEWAY_ORIGIN="http://127.0.0.1:1904"
export GATEWAY_API_KEY="<your-token>"

curl --fail "$GATEWAY_ORIGIN/v1/models" \
  -H "Authorization: Bearer $GATEWAY_API_KEY"

curl --fail "$GATEWAY_ORIGIN/v1/chat/completions" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

If `model` is omitted, the model group's default model is used. `POST /v1/responses` and SSE streaming are also supported. Multimodal capabilities depend on the upstream model.

The same token is used for models and MCP, requiring the `model:call` and `mcp:call` scopes respectively. Rotating or revoking it affects every Agent under the account.

### MCP

1. An administrator registers an upstream and synchronizes its capabilities.
2. Review schemas and risk policies in the capability catalog, then grant the required capabilities to accounts and Agents.
3. Configure user confirmation or administrator approval when required.
4. Under **My Agents**, obtain the token, Agent ID, and endpoint, then configure the MCP client:

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

| Endpoint | Purpose |
| --- | --- |
| `/mcp` | Aggregated authorized capabilities |
| `/mcp/servers/:server_id` | Authorized capabilities from a specific upstream |
| `/mcp/knowledge` | Knowledge base MCP capabilities |

A `stdio` upstream executes commands on the Gateway host. Only configure reviewed executables and run the Gateway under a low-privilege system account.

### ClaweeAgent

In [ClaweeAgent](https://github.com/krillinai/ClaweeAgent), set the Gateway Origin to your deployment address. The local default is `http://127.0.0.1:1904`. Then register or sign in with a Gateway account.

See [Clawee Agent integration](./server/docs/en/integration/clawee-agent.md) and [upstream MCP Server integration](./server/docs/en/integration/upstream-mcp.md) for integration details.

## Configuration and Development

The real configuration must live outside the source repository. The application does not read `server/configs/config.example.yaml` directly:

```text
$CLAWEE_OPS_DIR/
├── configs/config.yaml   # Private configuration
├── .env                  # Generated during container initialization
└── data/                 # Skills, shared files, and other data
```

Bound fields can be overridden with `CLAW_GATEWAY_*` environment variables, for example:

| Environment variable | Purpose |
| --- | --- |
| `CLAW_GATEWAY_SERVER_ADDR` | Gateway listen address |
| `CLAW_GATEWAY_DATABASE_URL` | PostgreSQL connection string |
| `CLAW_GATEWAY_MCP_PUBLIC_BASE_URL` | Public Gateway Origin |
| `CLAW_GATEWAY_MODEL_ACCESS_MODE` | `platform_managed` or `enterprise_managed` |

See the [configuration reference](./server/docs/en/getting-started/configuration.md) for all fields and secret requirements.

Common development commands:

| Command | Purpose |
| --- | --- |
| `corepack pnpm run setup` | Install root and management console dependencies |
| `corepack pnpm server:dev` | Start the Gateway |
| `corepack pnpm admin:dev` | Start the management console development server |
| `corepack pnpm test` | Run root script tests |
| `corepack pnpm admin test` | Run management console tests |
| `corepack pnpm server:test` | Run server and management console tests |
| `corepack pnpm server:build` | Build the Go binary with the embedded management console |
| `cd server && go vet ./...` | Run Go static analysis |
| `corepack pnpm container:smoke` | Run isolated container smoke verification |

Server integration tests must use isolated PostgreSQL databases. Use `CLAW_GATEWAY_TEST_DATABASE_URL` to specify a `_test` database, and never run tests against development or production databases.

Before deploying to production, review the security and operations documentation and implement HTTPS, secret management, persistence, backups, migrations, and metrics access controls. Report security issues privately using the [security reporting guide](./docs/en/security.md).

## Documentation

- **Architecture and permissions:** [Project responsibilities](./docs/en/architecture.md) · [Gateway architecture](./server/docs/en/architecture/overview.md) · [Security and permissions](./server/docs/en/architecture/security-and-permissions.md)
- **Installation and configuration:** [Local development](./server/docs/en/getting-started/development.md) · [Configuration reference](./server/docs/en/getting-started/configuration.md) · [Production deployment](./server/docs/en/deployment/production.md)
- **Client integration:** [Clawee Agent](./server/docs/en/integration/clawee-agent.md) · [MCP upstreams](./server/docs/en/integration/upstream-mcp.md) · [HTTP API](./server/docs/en/reference/http-api.md)
- **Operations and development:** [Validation and operations](./docs/validation-and-operations.md) · [Operations guide](./docs/operations/operations-guide.md) · [Management console guidelines](./docs/frontend/frontend-development-guidelines.md)
- **Project collaboration:** [Contributing guide](./docs/en/contributing.md) · [Repository maintenance](./docs/en/repository-maintenance.md) · [Third-party notices](./third_party/README.md)

## Community and Support

- Website: [clawee.work](https://www.clawee.work/)
- Agent client: [ClaweeAgent](https://github.com/krillinai/ClaweeAgent)
- Issue reporting: [GitHub Issues](https://github.com/krillinai/AIGateway/issues)
- Releases: [GitHub Releases](https://github.com/krillinai/AIGateway/releases)

Contributions through issues, pull requests, documentation, and tests are welcome. If AI Gateway helps your team, please consider starring the repository.

## License

AI Gateway is open source under the [Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) and [third_party](./third_party/README.md) for third-party notices.
