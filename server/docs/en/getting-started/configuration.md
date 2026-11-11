# Configuration Reference

**English** · [简体中文](../../getting-started/configuration.md)

## Configuration Sources

The service reads YAML and allows bound `CLAW_GATEWAY_*` environment variables to override corresponding fields. Configuration paths follow these rules:

1. An absolute `--config` path is read directly.
2. When `CLAWEE_OPS_DIR` is set, a relative path is resolved from that directory.
3. When `CLAWEE_OPS_DIR` is set and `--config` is omitted, `configs/config.yaml` in that directory is read.
4. Without `CLAWEE_OPS_DIR`, no configuration file is read. Explicit relative paths are rejected, and startup must be configured entirely through environment variables.
5. If `CLAWEE_OPS_DIR/.env` exists, it is loaded before process environment variables are applied as overrides.

If an explicitly configured external configuration root is unavailable, the application fails immediately instead of falling back to repository configuration.

The public repository provides only `configs/config.example.yaml`. On first use, copy it to an independent private operations directory:

```bash
# Run from the integrated repository root after pnpm run setup:
export CLAWEE_OPS_DIR="$HOME/clawee-ops"
pnpm run init --ops-dir "$CLAWEE_OPS_DIR"
```

Initialization generates two independent random keys and refuses to write configuration into the source directory. The JWT signing key must contain at least 32 ASCII characters, and the Agent Token encryption key must contain exactly 32 ASCII characters. `--container` generates a container-network database address and a random database password in the external `.env`. Repeating initialization does not convert or overwrite existing configuration.

## Environment Variable Naming

Bound fields use the `CLAW_GATEWAY_` prefix, with dots in YAML hierarchies replaced by underscores:

```text
database.url                    -> CLAW_GATEWAY_DATABASE_URL
server.addr                     -> CLAW_GATEWAY_SERVER_ADDR
security.user_jwt_signing_key   -> CLAW_GATEWAY_SECURITY_USER_JWT_SIGNING_KEY
mcp.public_base_url             -> CLAW_GATEWAY_MCP_PUBLIC_BASE_URL
```

Not every optional integration field supports environment variable overrides. Before deployment, refer to the `bindEnv` list in `internal/config/config.go`.

## Configuration Groups

| Group | Purpose |
| --- | --- |
| `server` | Listen address and profiling switch |
| `database` | PostgreSQL connection string |
| `admin` | Administration bootstrap token |
| `security` | Cookie, session, JWT, and token encryption configuration |
| `logging` | Log level, format, output, and access logs |
| `static` | Management console static files |
| `mcp` | Public MCP address, OAuth metadata, and scopes |
| `knowledge` | Knowledge base switch and provider configuration |
| `skillhub` | Skill packages, Git sources, and working directories |
| `shared_files` | Shared file local directory and OSS CNAME allowlist |
| `dingtalk`, `bilibili` | Optional external identity and data integrations |
| `claw_admin`, `sub2api`, `model_access` | Optional model configuration and billing integrations |
| `agent_activity` | Agent activity reporting switch |
| `feedback` | Feedback collection service and management console visibility |

## Secret Management

The following values must be provided by the deployment environment and must not be committed to Git:

- Database passwords and complete production connection strings;
- Administration tokens;
- JWT signing keys and Agent Token encryption keys;
- OAuth client secrets;
- Cloud service AccessKeys;
- Upstream MCP credentials;
- External management service deployment credentials and API keys.

Example configuration contains only empty values, local addresses, or placeholders that cannot be used in production. Complete configuration objects must not be written to logs.

## Optional Capabilities

Knowledge bases, Skill Git synchronization, DingTalk, Bilibili, external model configuration, and billing integrations must be explicitly enabled. Complete provider configuration is required before enabling them. Keep unused integrations disabled; the core Gateway must not depend on them.

The shared drive uses the local directory specified by `shared_files.storage_root` by default. OSS profiles, encrypted credentials, and the active storage backend are maintained in the management console. Official `aliyuncs.com` OSS endpoints require no additional configuration. Only when using a reviewed custom OSS CNAME may deployers add the following to the external configuration:

```yaml
shared_files:
  storage_root: "data/shared-files"
  oss:
    allowed_endpoint_hosts:
      - "storage.example.com"
```

The allowlist accepts hostnames only, without schemes, paths, or ports. The management console cannot allow arbitrary endpoints.

## Feedback Administration Page

The feedback administration menu and page are hidden by default. To display them, set the following in the external configuration:

```yaml
feedback:
  enabled: true
  admin_ui_enabled: true
```

The visibility switch can also be overridden with `CLAW_GATEWAY_FEEDBACK_ADMIN_UI_ENABLED=true`; restart the Gateway after changing it. Display also requires an available feedback service, the `console:feedback:read` permission, and data authorization for **Central Feedback → All Feedback**. `admin_ui_enabled` controls console visibility only and does not change feedback submission, collection policies, or API permissions.

## Production Validation

- Use different names for user and administrator session cookies.
- JWT signing keys must contain at least 32 ASCII characters.
- Use controlled callback URLs when DingTalk or Bilibili is enabled.
- MCP public, resource, and OAuth metadata URLs must match the external HTTPS address.
- File storage directories must be on persistent volumes with restricted operating-system permissions.

## RAGFlow 1.0 Knowledge Bases

Knowledge bases are disabled by default, and the provider defaults to `bailian`. Enable RAGFlow in the external `$CLAWEE_OPS_DIR/configs/config.yaml`:

```yaml
knowledge:
  enabled: true
  provider_type: ragflow
  ragflow:
    base_url: http://127.0.0.1:18080
    api_key_ref: RAGFLOW_API_KEY
    embedding_model: ""
    rerank_id: ""
```

Store the real key only in `RAGFLOW_API_KEY` in the external `.env` or inject it through the runtime environment. `api_key_ref` stores the variable name; there is no plaintext `api_key` setting. An empty `embedding_model` inherits the default model from the RAGFlow service account. Otherwise, use the registered full `model_name@model_factory`. `rerank_id` is optional. RAGFlow is deployed independently and uses the v1.0.0 HTTP API; the Gateway does not probe the network during startup.

| Override variable | Purpose |
| --- | --- |
| `CLAW_GATEWAY_KNOWLEDGE_PROVIDER_TYPE` | `bailian` or `ragflow` |
| `CLAW_GATEWAY_KNOWLEDGE_RAGFLOW_BASE_URL` | Root HTTP(S) service address without user information, additional paths, query strings, or fragments |
| `CLAW_GATEWAY_KNOWLEDGE_RAGFLOW_API_KEY_REF` | Key environment variable name, defaulting to `RAGFLOW_API_KEY` |
| `CLAW_GATEWAY_KNOWLEDGE_RAGFLOW_EMBEDDING_MODEL` | Optional embedding model |
| `CLAW_GATEWAY_KNOWLEDGE_RAGFLOW_RERANK_ID` | Optional reranker |

A native Gateway on the host uses `http://127.0.0.1:18080`. A Docker Desktop container accesses the host through `http://host.docker.internal:18080`. Linux Docker also requires `host-gateway` and network access to the host entry point. On a shared Docker network, use the RAGFlow service DNS name and internal Nginx port, such as `http://ragflow-cpu:80`. Inside a container, `127.0.0.1` refers to the container itself.

For container deployment, explicitly include the optional override file. Compose `--env-file` is used for interpolation; the override file passes the key to the Gateway:

```bash
docker compose --env-file "$CLAWEE_OPS_DIR/.env" \
  -f deploy/docker-compose.yml -f deploy/docker-compose.ragflow.yml \
  up -d --build gateway
```

The override file assumes the default `RAGFLOW_API_KEY` reference. Custom references require explicit injection of the corresponding variable. Adjust the address and network settings in the override file for shared-network deployment. The production Gateway image is distroless; verify through host HTTP requests, logs, and the management console rather than relying on curl or a shell inside the container.

Each Gateway deployment enables only one provider. Startup reports the conflicting provider types and counts if other undeleted provider bindings with external IDs exist. Do not change old record types to switch data ownership. Isolated acceptance uses an independent Gateway database and a dedicated RAGFlow service account. This integration requires no migration and does not automatically import external datasets or unregistered documents.

Uploads initially return `processing`. When the App or management console reads the document list, records still processing are synchronized within a total budget of 10 seconds. Failures return the existing upstream service error while preserving local state. When no records are processing, only local state is read, although administrators can still synchronize manually. Retrieval continues through the Gateway's `knowledge.search`, scoped to knowledge bases for which the account has `mcp` authorization.
