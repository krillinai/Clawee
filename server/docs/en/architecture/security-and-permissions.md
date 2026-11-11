# Security and Permissions

**English** · [简体中文](../../architecture/security-and-permissions.md)

## Identity Boundaries

The system distinguishes three types of callers:

- Users and administrators access the Web and HTTP APIs through account sessions.
- Clawee Agent uses an application token bound to a stable `agent_id` to access `/api/v1/app/*`.
- MCP Clients use account or Agent MCP credentials to access `/mcp*`.

Account IDs, Agent IDs, roles, and permissions submitted by clients cannot be used directly as authorization evidence. The server must reconstruct the principal from verified sessions, tokens, and database relationships.

## Management Console RBAC

Administration APIs are located under `/api/v1/admin/*`. Permissions are divided into `read` and `manage` by module and currently cover:

- Accounts, roles, and permissions;
- Agents;
- MCP upstreams, capabilities, grants, gates, and audits;
- Agent activity, knowledge bases, Skills, shared files, and data resource grants.

The `manage` permission includes `read` for the same module. High-privilege operations must still validate the target resource and business constraints in the service layer.

## Agent Capability Grants

MCP capabilities require explicit grants:

1. Upstream synchronization creates the capability catalog.
2. An administrator grants specific capabilities to specific Agents.
3. Agents can discover and invoke only capabilities that remain valid.
4. Disabling an upstream, capability, Agent, or grant immediately invalidates subsequent calls.

Capability lists are for presentation and discovery only. Authorization must be re-read before every tool call; previously showing a tool to a client does not constitute continuing authorization.

## User Confirmation and Administrator Approval

There are two types of gates:

- **User confirmation**: The user who initiated the call confirms its parameters and risks.
- **Administrator approval**: An administrator with gate management permission decides whether execution is allowed.

When a capability policy requires both, administrator approval is completed before user confirmation. A Gate stores the capability version, parameter digest, and parameter snapshot. If the capability schema or original parameters change after confirmation, the call must be rejected and initiated again.

## Data Resource Permissions

Resources such as knowledge bases, Skill spaces, and shared files use account-level data permissions. When access is denied, APIs should avoid revealing whether a resource exists through error differences. Agent MCP grants and account data permissions are separate dimensions and cannot replace each other.

## Auditing

MCP invocation audits associate at least:

- The caller, Agent, and target endpoint;
- The upstream, capability, and version;
- Grant and gate decisions;
- Request status, execution result, latency, and error category.

Audits and ordinary logs must not record plaintext passwords, Bearer tokens, OAuth secrets, upstream credentials, or uploaded file contents. For troubleshooting, prefer irreversible fingerprints, internal identifiers, and structured error codes.

## Deployment Requirements

- Production environments must use HTTPS and enable Secure Cookies.
- JWT signing keys and Agent Token encryption keys must be generated independently and stored in a secret management system.
- OAuth callback URLs must use explicitly allowed absolute URLs.
- Network policies must restrict access to `/metrics`, profiling, and administration endpoints.
- Databases, file directories, release artifacts, and backups must use least-privilege accounts.
