# HTTP API Overview

**English** · [简体中文](../../reference/http-api.md)

## Basic Conventions

- The API prefix is `/api/v1`.
- Requests and responses use UTF-8 JSON except for file upload and download endpoints.
- Time fields use RFC 3339.
- Application APIs use the current user's identity, while administration APIs additionally enforce RBAC.
- List endpoints return `[]` for empty results instead of `null`.

Error responses use stable machine-readable error codes. Clients should handle HTTP statuses and error codes rather than relying on error messages.

## Public and Authentication APIs

| Path group | Purpose |
| --- | --- |
| `/healthz`, `/readyz`, `/version` | Health and version information |
| `/api/v1/auth/*` | Registration, login, logout, current account, and external identity authentication |
| `/api/v1/integrations/*` | Controlled OAuth callbacks and webhooks |

## Application APIs

`/api/v1/app/*` serves the current account and its bound Agents. Primary resources include:

- `agents`, `mcp/catalog`, and `mcp/token`;
- `skills` and `skill-spaces`;
- `knowledge-bases` and their documents;
- `shared-spaces` and `shared-files`;
- `activity`;
- `business-data-sources` and `business-dashboards`;
- `billing` and `model-configuration`.

Shared drive file deletion uses action endpoints. The application endpoint `POST /api/v1/app/shared-files/remove` requires `delete` membership authorization in the file's space. The administration endpoint `POST /api/v1/admin/shared-files/remove` requires the `console:shared_files:delete` permission. The request body contains `file_id` and `expected_revision`, and success returns `204`.

When an optional service is not enabled, related APIs may return `503 Service Unavailable`.

## Administration APIs

`/api/v1/admin/*` serves administrators with the corresponding permissions:

| Path group | Permission scope |
| --- | --- |
| `accounts` | Account viewing, creation, disabling, and password resets |
| `rbac` | Permission catalog, roles, and account roles |
| `mcp/upstream-servers` | Upstream MCP Server management and capability synchronization |
| `mcp/capabilities` | Capability catalog and gate policies |
| `mcp/agents` | Agent management and ownership |
| `mcp/grants` | Agent capability grants |
| `mcp/gates` | User confirmation and administrator approval |
| `mcp/audits` | MCP invocation audits |
| `knowledge-bases` | Knowledge base and document management |
| `skills`, `skill-sources`, `skill-spaces` | Skill and source management |
| `shared-spaces`, `shared-files` | Shared file management |
| `data-resource-grants` | Account data resource permissions |
| `activity` | Agent activity management |

Specific permission codes are defined in `internal/rbac/catalog.go`.

## MCP and OAuth Metadata

MCP requests do not use the `/api/v1` prefix:

- `/mcp`
- `/mcp/servers/:server_id`
- `/mcp/knowledge`

Clients discover resource and authorization server information through the corresponding `/.well-known/oauth-protected-resource/...` endpoints. MCP tokens must have the scope required by the server and be bound to a valid account and Agent.

## Client Handling Requirements

- `400`: Correct the request parameters before resubmitting.
- `401`: Clear invalid authentication state and log in again or obtain new credentials.
- `403`: The current principal is not authorized; do not retry automatically.
- `404`: The resource does not exist or is not visible to the current principal.
- `409`: Resource state or version conflict; read the resource again and let the user decide.
- `429`: Follow the rate-limit response guidance and back off.
- `500`: Record the request ID and avoid automatically retrying non-idempotent operations.
- `503`: A dependent service is not enabled or is temporarily unavailable.

Treat all requests that create, modify, delete, upload, synchronize, rotate, or top up as non-idempotent unless the specific endpoint explicitly provides an idempotency key or semantics.
