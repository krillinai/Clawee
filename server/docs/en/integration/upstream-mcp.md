# Upstream MCP Server Integration

**English** · [简体中文](../../integration/upstream-mcp.md)

## Integration Model

The Gateway manages existing MCP Servers; upstream implementations do not need to be copied into this project. After an administrator registers an upstream, synchronizes capabilities, and grants them to a user account, that account's Agents invoke capabilities through the Gateway's unified MCP endpoint.

```text
MCP Client -> Gateway Endpoint -> Authentication / Authorization / Gates / Audit -> Upstream MCP Server
```

## Supported Transports

- `streamable_http`: Configure the upstream HTTP endpoint and required authentication information.
- `stdio`: Configure a server-side executable, arguments, and a controlled environment.

A stdio command runs on the Gateway host and has the equivalent of server-side execution privileges. Administrators may configure only reviewed executables, and the Gateway must run under a dedicated low-privilege account.

## Administration Workflow

1. Create an upstream through the management console or `/api/v1/admin/mcp/upstream-servers`.
2. Call the synchronization endpoint to read upstream tools, resources, and prompts.
3. Review names, schemas, risk levels, and status in the capability catalog.
4. Configure user confirmation or administrator approval policies.
5. Explicitly grant the required capabilities to the user account. Grant APIs use `user_id`, `capability_id`, and `grant_type`.
6. Verify discovery and invocation through the corresponding MCP endpoint and review the audit records.

Resynchronize after changing upstream configuration. If an upstream removes a capability or its schema changes, clients must not continue using an old cached definition for write operations.

## Endpoints

| Path | Purpose |
| --- | --- |
| `/mcp` | Aggregate capabilities authorized for the current account |
| `/mcp/servers/:server_id` | Expose only authorized capabilities from a specific upstream |
| `/mcp/knowledge` | Built-in knowledge base MCP capabilities |

Each MCP endpoint has a corresponding OAuth Protected Resource Metadata path:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-protected-resource/mcp/servers/:server_id
/.well-known/oauth-protected-resource/mcp/knowledge
```

## Capability Naming and Filtering

When using an account MCP token, send both `Authorization: Bearer <token>` and `X-Claw-Agent-ID: <agent_id>`. The Agent must be active and belong to the account associated with the token; the token alone is not sufficient for authentication.

Capabilities use stable exposed names after entering the catalog. The Gateway filters lists by endpoint, account grants, capability status, and upstream status. Clients must not depend on original upstream names remaining unchanged across environments.

## Gates and Retries

Tool calls requiring confirmation or approval return gate information. Clients must display the server-generated summary and wait for a decision; they must not bypass the Gateway and call the upstream directly. Non-idempotent calls with unknown execution results must not be retried automatically.

## Upstream Credentials

- Store credentials only in controlled configuration or a secret management system.
- Administration APIs and logs return redacted metadata only, never plaintext credentials.
- Use independent credentials and least-privilege accounts for different upstreams.
- Revoke the corresponding access credentials when disabling or deleting an upstream.
