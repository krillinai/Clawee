<div align="center">

# AI Gateway

**For forward deployed engineers (FDEs), enterprise CTOs, CIOs, and IT teams · Built by KrillinAI**

Connect models, MCP tools, knowledge bases, and shared resources through a single gateway for authentication, access control, routing, approvals, auditing, and usage analytics. **Supports all mainstream Agents, including the one you already use, and over 1,100 models.**

[Website](https://www.clawee.work/) · [Core Capabilities](#core-capabilities) · [Quick Start](#quick-start) · [Client Integration](#client-integration) · [Documentation](#documentation) · [简体中文](../../README.md)

[![GitHub Stars](https://img.shields.io/github/stars/krillinai/AIGateway?style=social)](https://github.com/krillinai/AIGateway/stargazers)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](../../LICENSE)
[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white)](../../server/go.mod)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](../../server/web/package.json)

</div>

## Project Overview

As organizations adopt more Agents, models, and tools, scattered credentials, permissions, and invocation logs quickly become difficult to manage. AI Gateway provides a unified governance layer between Agents and enterprise capabilities, giving every model or tool invocation a verified identity, explicit authorization, and a traceable audit trail.

This repository includes the **Go Gateway, React management console, PostgreSQL migrations, and deployment tooling**. It can run independently or serve as the backend for [ClaweeAgent](https://github.com/krillinai/ClaweeAgent).

AI Gateway does not provide a local Agent Runtime, desktop client, or enterprise business system. It exposes an OpenAI-compatible HTTP API for models and MCP over Streamable HTTP for tools.

<div align="center">
  <img src="../assets/aigateway-overview.png" alt="AI Gateway connecting Agents, models, tools, data, and business systems" width="100%" />
</div>

## Core Capabilities

| Module | Capabilities |
| --- | --- |
| Model Gateway | OpenAI-compatible APIs, upstream accounts and model catalogs, model groups, default models, failover, round robin, and SSE streaming |
| MCP Gateway | Manage `streamable_http` and `stdio` upstreams, synchronize tools, resources, and prompts, and filter capabilities by authorization |
| Identity and Access | Account sessions, stable Agent IDs, account tokens, console RBAC, and data resource grants |
| Risk Gates | User confirmation and administrator approval for MCP calls, with authorization, capability version, and parameter snapshot checks before execution |
| Auditing and Usage | Track callers, routes, status, latency, errors, and token usage with personal history and administrator analytics |
| Skill Hub | Skill packages, versions, spaces, Git sources, review and publishing workflows, and client downloads |
| Knowledge and Files | Bailian knowledge base integration, shared spaces, file upload and download, and local or Alibaba Cloud OSS storage |
| Enterprise Extensions | Workflows and approvals, Agent activity, DingTalk, Bilibili, external model configuration, billing, and other optional integrations |

Model and MCP audits are redacted and do not store plaintext API keys, cookies, or upstream credentials. Optional enterprise integrations are not required for core account, RBAC, and MCP governance capabilities.

## Supported Agents

AI Gateway supports all mainstream Agents. Configure your Agent to use the Gateway's OpenAI-compatible API or MCP endpoint to access centralized identity, access control, routing, approvals, and auditing.

### Our Products

| Product | Purpose |
| --- | --- |
| <img src="../assets/agents/clawee-agent.png" alt="Clawee Agent Logo" width="20" height="20" align="absmiddle" /> [Clawee Agent](https://github.com/krillinai/ClaweeAgent) | Our enterprise Agent for custom business modules |
| <img src="../assets/agents/opencreator.png" alt="OpenCreator Logo" width="20" height="20" align="absmiddle" /> [OpenCreator](https://github.com/krillinai/OpenCreator) | Our content creation Agent for enterprise content workflows |

### Mainstream Agents and Platforms

| | | |
| --- | --- | --- |
| <img src="../assets/agents/kimi.svg" alt="Kimi Logo" width="20" height="20" align="absmiddle" /> Kimi | <img src="../assets/agents/deepseek.svg" alt="DeepSeek Harness Logo" width="20" height="20" align="absmiddle" /> DeepSeek Harness | <img src="../assets/agents/cursor.svg" alt="Cursor Logo" width="20" height="20" align="absmiddle" /> [Cursor](https://www.cursor.com/) |
| <img src="../assets/agents/opencode.svg" alt="OpenCode Logo" width="20" height="20" align="absmiddle" /> [OpenCode](https://opencode.ai/) | <img src="../assets/agents/gemini.svg" alt="Gemini CLI Logo" width="20" height="20" align="absmiddle" /> [Gemini CLI](https://github.com/google-gemini/gemini-cli) | <img src="../assets/agents/copilot.svg" alt="GitHub Copilot CLI Logo" width="20" height="20" align="absmiddle" /> [GitHub Copilot CLI](https://github.com/features/copilot/cli) |
| <img src="../assets/agents/workbuddy.png" alt="WorkBuddy Logo" width="20" height="20" align="absmiddle" /> WorkBuddy | <img src="../assets/agents/qwen-work.png" alt="Qwen Workspace Logo" width="20" height="20" align="absmiddle" /> Qwen Workspace (千问办公) | <img src="../assets/agents/doubao-work.png" alt="Doubao Workspace Logo" width="20" height="20" align="absmiddle" /> Doubao Workspace (豆包工作) |
| <img src="../assets/agents/codex.svg" alt="Codex Logo" width="20" height="20" align="absmiddle" /> [Codex](https://github.com/openai/codex) | <img src="../assets/agents/openclaw.png" alt="OpenClaw Logo" width="20" height="20" align="absmiddle" /> [OpenClaw](https://github.com/openclaw/openclaw) | <img src="../assets/agents/hermes.svg" alt="Hermes Logo" width="20" height="20" align="absmiddle" /> [Hermes](https://github.com/NousResearch/hermes-agent) |
| <img src="../assets/agents/pi.svg" alt="Pi Logo" width="20" height="20" align="absmiddle" /> [Pi](https://github.com/badlogic/pi-mono) | <img src="../assets/agents/kiro.svg" alt="Kiro Logo" width="20" height="20" align="absmiddle" /> [Kiro](https://kiro.dev/) | <img src="../assets/agents/claude.svg" alt="Claude Code Logo" width="20" height="20" align="absmiddle" /> [Claude Code](https://docs.anthropic.com/en/docs/claude-code) |
| <img src="../assets/agents/qwen.svg" alt="Qwen Code Logo" width="20" height="20" align="absmiddle" /> Qwen Code | <img src="../assets/agents/aider.png" alt="Aider Logo" width="20" height="20" align="absmiddle" /> [Aider](https://github.com/Aider-AI/aider) | <img src="../assets/agents/kilo.svg" alt="Kilo Logo" width="20" height="20" align="absmiddle" /> [Kilo](https://github.com/Kilo-Org/kilocode) |
| <img src="../assets/agents/trae.png" alt="Trae Logo" width="20" height="20" align="absmiddle" /> [Trae](https://www.trae.ai/) | <img src="../assets/agents/qoder.svg" alt="Qoder Logo" width="20" height="20" align="absmiddle" /> [Qoder](https://qoder.com/) | |

<div align="center">
  <img src="../assets/supported-agents.png" alt="22 mainstream Agents and platforms supported by AI Gateway" width="100%" />
</div>

## System Architecture

```text
Agents / IDE / MCP Clients / Internal Apps
                    |
          OpenAI HTTP / MCP / HTTP API
                    |
+---------------------------------------------------+
| AI Gateway                                        |
| Authentication -> Authorization -> Gates -> Audit |
|                                                   |
| Model Gateway | MCP Gateway | Resource APIs       |
| Model Groups  | Grants      | Skills / Knowledge  |
| Routing       | Approvals   | Shared Files        |
+--------+--------------+-------------+-------------+
         |              |             |
         v              v             v
 OpenAI-compatible   MCP Servers    Enterprise Data
 Model Upstreams    HTTP / stdio    OSS / Knowledge

 PostgreSQL + Embedded Web Console + External Ops Config
```

Technology stack: **Go 1.25 · Gin · React 19 · TypeScript · Vite · PostgreSQL 16 · MCP Go SDK · Docker**.

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

On Linux hosts, allow container UID/GID `65532` to read the external configuration. See the [production deployment guide](../../server/docs/deployment/production.md) for production permissions, HTTPS, and backup procedures.

</details>

## Client Integration

### Model API

1. Set `model_access.mode: "platform_managed"` in the external `configs/config.yaml` and restart the Gateway.
2. Under **Model Gateway → Upstream Accounts**, add an OpenAI-compatible Base URL, API key, and model catalog.
3. Under **Model Gateway → Model Groups**, configure member accounts, a default model, and a `failover` or `round_robin` strategy.
4. Under **My Agents**, generate a platform access token and use `http://127.0.0.1:1904/v1` as the model Base URL.

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

See [Clawee Agent integration](../../server/docs/integration/clawee-agent.md) and [upstream MCP Server integration](../../server/docs/integration/upstream-mcp.md) for integration details.

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

See the [configuration reference](../../server/docs/getting-started/configuration.md) for all fields and secret requirements.

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

Before deploying to production, review the security and operations documentation and implement HTTPS, secret management, persistence, backups, migrations, and metrics access controls. Report security issues privately using the [security reporting guide](../../SECURITY.md).

## Documentation

- **Architecture and permissions:** [Project responsibilities](../architecture.md) · [Gateway architecture](../../server/docs/architecture/overview.md) · [Security and permissions](../../server/docs/architecture/security-and-permissions.md)
- **Installation and configuration:** [Local development](../../server/docs/getting-started/development.md) · [Configuration reference](../../server/docs/getting-started/configuration.md) · [Production deployment](../../server/docs/deployment/production.md)
- **Client integration:** [Clawee Agent](../../server/docs/integration/clawee-agent.md) · [MCP upstreams](../../server/docs/integration/upstream-mcp.md) · [HTTP API](../../server/docs/reference/http-api.md)
- **Operations and development:** [Validation and operations](../validation-and-operations.md) · [Operations guide](../operations/operations-guide.md) · [Management console guidelines](../frontend/frontend-development-guidelines.md)
- **Project collaboration:** [Contributing guide](../../CONTRIBUTING.md) · [Repository maintenance](../repository-maintenance.md) · [Third-party notices](../../third_party/README.md)

## Community and Support

- Website: [clawee.work](https://www.clawee.work/)
- Agent client: [ClaweeAgent](https://github.com/krillinai/ClaweeAgent)
- Issue reporting: [GitHub Issues](https://github.com/krillinai/AIGateway/issues)
- Releases: [GitHub Releases](https://github.com/krillinai/AIGateway/releases)
- Enterprise deployment: [hello@clawee.ai](mailto:hello@clawee.ai)

Contributions through issues, pull requests, documentation, and tests are welcome. If AI Gateway helps your team, please consider starring the repository.

## License

AI Gateway is open source under the [Apache License 2.0](../../LICENSE). See [NOTICE](../../NOTICE) and [third_party](../../third_party/README.md) for third-party notices.
