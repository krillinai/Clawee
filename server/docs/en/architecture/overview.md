# Architecture Overview

**English** · [简体中文](../../architecture/overview.md)

## Project Positioning

This project is an MCP security governance layer between enterprise Agents and enterprise systems. It allows different Agent Runtimes to access existing MCP Servers, knowledge bases, and enterprise capabilities through a unified entry point with centralized authentication, authorization, gates, and auditing.

The project does not provide an Agent Runtime or replace existing enterprise business systems.

```text
Agent Layer
Clawee / Codex / Hermes / Other MCP Clients
                    |
                    v
Governance Layer (this project)
Authentication -> Agent Binding -> Capability Catalog -> Grants -> Gates -> Audit
                    |
                    v
Enterprise System Layer
MCP Servers / Knowledge Bases / Collaboration Systems / Business Systems
```

## Current Components

| Component | Responsibility |
| --- | --- |
| HTTP Server | Provides user, administrator, and integration APIs |
| MCP Endpoint | Exposes aggregated or upstream-isolated MCP endpoints to Agents |
| Account Service | Manages accounts, login sessions, and Agent ownership |
| RBAC Service | Manages console roles and permissions |
| MCP Gateway | Manages upstreams, capability catalogs, Agent grants, gates, and audits |
| Skill Hub | Manages Skills, versions, spaces, and Git sources |
| Knowledge | Manages knowledge base metadata, documents, and MCP knowledge capabilities |
| Shared Files | Manages account-authorized shared spaces and files |
| Management Console | Provides user and administrator interfaces |

DingTalk login, Bailian knowledge bases, Bilibili data, model configuration, and billing APIs are optional integrations. Missing external services must not affect core Gateway, account, RBAC, MCP onboarding, and auditing capabilities.

## Core Objects

- **Account**: The authenticated principal that owns sessions, roles, and data resource permissions.
- **Agent**: A governed Agent identity owned by an account, using its own MCP access credentials.
- **Upstream Server**: An MCP Server managed by the Gateway.
- **Capability**: A tool, resource, or prompt synchronized from an upstream into the capability catalog.
- **Grant**: Explicit authorization for an Agent to use a capability.
- **Gate**: A user confirmation or administrator approval record.
- **Audit**: Records produced by capability discovery, authorization decisions, and tool calls.

## MCP Invocation Flow

1. An MCP Client connects to the Gateway with credentials.
2. The Gateway validates the credentials, scopes, Agent status, and target endpoint.
3. The Gateway filters visible capabilities using the Agent's current grants.
4. Tool calls validate capability status and authorization again without trusting the client cache.
5. When a confirmation or approval policy applies, the Gateway creates a Gate and executes only the approved parameter snapshot after it passes.
6. The Gateway invokes the upstream MCP Server and records the result, latency, and decision details.

## HTTP Boundaries

| Path | Purpose |
| --- | --- |
| `/mcp` | Aggregated MCP endpoint |
| `/mcp/servers/:server_id` | MCP endpoint for a specific upstream |
| `/mcp/knowledge` | Knowledge base MCP endpoint |
| `/api/v1/auth/*` | Registration, login, logout, and external identity login |
| `/api/v1/app/*` | Application APIs for the current account and its Agents |
| `/api/v1/admin/*` | Administration APIs protected by RBAC |
| `/healthz`, `/readyz` | Liveness and readiness checks |
| `/metrics` | Prometheus metrics |

## Data and Runtime Boundaries

- PostgreSQL stores accounts, Agents, RBAC, capability catalogs, grants, gates, audits, and business metadata.
- Skill packages, shared files, and upstream Git workspaces use configured local directories.
- Management console static files can be embedded in the backend binary or served separately by the development server.
- Secrets are provided by the deployment environment and must not enter image layers, release packages, or version control.
