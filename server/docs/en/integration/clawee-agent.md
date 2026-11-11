# Clawee Agent Integration

**English** · [简体中文](../../integration/clawee-agent.md)

## Invocation Boundaries

Clawee Web or Desktop handles user interaction. The local daemon holds authentication state, calls the Gateway, downloads Skills, and performs installation. The browser renderer must not store Bearer tokens or model credentials.

All example paths are relative to the Gateway Origin, such as `https://gateway.example.com`.

## Registration and Login

Clawee Agent calls these endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/auth/register` | Register an account and bind an Agent |
| `POST` | `/api/v1/auth/login` | Log in and restore the Agent context |
| `GET` | `/api/v1/auth/me` | Get the current account and Agent |
| `POST` | `/api/v1/auth/logout` | Log out of the current session |
| `GET` | `/api/v1/auth/methods` | Get available login methods |
| `POST` | `/api/v1/auth/dingtalk/clawee/token` | Exchange a DingTalk login result |

Registration and login use the fixed `client_id: "clawee-agent"` and a stable `agent_id` persisted on the local machine. After trimming whitespace, `agent_id` must be nonempty and no longer than 64 characters. The same ID cannot be reused by different accounts.

After receiving `401 Unauthorized`, the daemon must clear the invalid authentication state and require another login instead of retrying indefinitely.

## Agents and MCP

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/app/agents` | List Agents for the current account |
| `GET` | `/api/v1/app/agents/tools` | List tools available to an Agent |
| `GET` | `/api/v1/app/mcp/catalog` | Get the MCP capability catalog |
| `GET` | `/api/v1/app/mcp/token` | Get MCP token metadata |
| `POST` | `/api/v1/app/mcp/token/reveal` | Reveal a token in a controlled operation |
| `POST` | `/api/v1/app/mcp/token/rotate` | Rotate a token |
| `POST` | `/api/v1/app/mcp/token/revoke` | Revoke a token |

The server determines Agent MCP grants. Clients can only display capabilities returned by the server and cannot expand their own authorization.

## Skill Hub

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/app/skill-spaces` | List authorized Skill spaces |
| `GET` | `/api/v1/app/skills` | List published Skills |
| `GET` | `/api/v1/app/skills/detail` | Get Skill details |
| `GET` | `/api/v1/app/skills/version-files` | List files in a version |
| `GET` | `/api/v1/app/skills/version-file` | Download one version file |
| `GET` | `/api/v1/app/skills/package` | Download a release package |
| `POST` | `/api/v1/app/skills/versions` | Upload and publish a new version |

Before installation, verify the version and digest provided by the server. If the version changes, read the details again and retry after user confirmation. Installation failures must use the client's own transaction and rollback mechanisms.

## Knowledge Bases and Shared Files

Clawee can access only knowledge bases, documents, and shared spaces authorized for the current account. Uploads use streaming multipart; do not copy complete documents into the browser process, logs, or diagnostic bundles. Do not automatically repeat an upload when the request result is unknown, as this may create duplicate documents.

Primary paths:

- `/api/v1/app/knowledge-bases*`
- `/api/v1/app/shared-spaces*`
- `/api/v1/app/shared-files*`

## Optional APIs

The backend also provides APIs for Agent activity reporting, model configuration, balances, and top-up sessions. These APIs depend on the corresponding services enabled for the deployment. Clients receiving `503` must show that the capability is unavailable instead of guessing or constructing a result.

## Security Requirements

- Connect only to an HTTPS Origin in production.
- Only the local daemon holds tokens; tokens must not enter URLs, page state, or ordinary logs.
- Passwords are transmitted only during login requests and are not persisted.
- Verify the digest, size, and destination path of Skill packages and downloaded files before use.
- Clear authentication data on logout while retaining the stable `agent_id`.
