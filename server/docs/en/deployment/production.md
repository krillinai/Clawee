# Production Deployment

**English** · [简体中文](../../deployment/production.md)

## Deployment Boundaries

A production deployment consists of one Gateway backend, PostgreSQL, management console static files, and optional external services. Agent Runtimes and enterprise business systems are deployed independently and connect to the Gateway through MCP or HTTP.

This document does not prescribe a particular company's servers, accounts, or network topology. Deployers must implement secret injection, TLS, backups, and release approvals for their own infrastructure.

## Build

```bash
# Run from the integrated repository root:
docker build -f server/Dockerfile -t clawee-server:local .
```

The image does not contain a configuration file. Mount the private operations directory read-only at a fixed runtime location.

The image uses the nonroot UID/GID `65532` by default. On Linux hosts, allow this user to read and traverse the configuration directory while keeping it inaccessible to other users:

```bash
sudo chown -R 65532:65532 /etc/clawee/ops
sudo find /etc/clawee/ops -type d -exec chmod 750 {} +
sudo find /etc/clawee/ops -type f -exec chmod 600 {} +
```

```bash
docker run --rm --name mcp-gateway \
  -p 0.0.0.0:1904:1904 \
  -e CLAWEE_OPS_DIR=/run/clawee-ops \
  -v /etc/clawee/ops:/run/clawee-ops:ro \
  -v claw-gateway-data:/app/data \
  clawee-server:local
```

The mounted directory must contain `configs/config.yaml`. The database address must be reachable from the container network; do not use a `localhost` address that points only to the container itself.

## Using the Integrated Compose Deployment

Install dependencies from the repository root and use a fresh operations directory outside the repository. This process is for a new deployment and does not convert existing development configuration:

```bash
export CLAWEE_OPS_DIR="$HOME/clawee-container-ops"
pnpm run init --ops-dir "$CLAWEE_OPS_DIR" --container --gateway https://agent.example.com
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml build
```

Replace `agent.example.com` with the actual HTTPS hostname. On Linux hosts, allow container UID `65532` to read the configuration file. Change only this file's ownership; do not make the database password in `.env` publicly readable:

```bash
sudo chown 65532:65532 "$CLAWEE_OPS_DIR/configs/config.yaml"
sudo chmod 600 "$CLAWEE_OPS_DIR/configs/config.yaml"
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml up -d --wait postgres
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml run --rm gateway migrate up
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml up -d gateway
```

The Gateway maps host `0.0.0.0:1904`, while the database is not mapped to a host port. The service inside the image also listens on `0.0.0.0:1904`. Initializing with an HTTPS Origin enables Secure Cookies. Restrict the Gateway port with a firewall and limit the HTTPS proxy to networks controlled by the deployer until the first administrator registration is complete. Clients must use the actual hostname, not `0.0.0.0`.

After release, use `ghcr.io/krillinai/clawee-server:0.1.0` and pin the image to the actual release digest. Build unreleased versions locally instead of assuming that an image already exists.

Database and file data use separate Compose named volumes, and `docker compose down` does not remove them. Do not run `down -v` before creating backups. Use `pg_dump` for database backups. Archive file volumes after pausing writes, and store them encrypted together with the corresponding configuration keys. For recovery, stop the Gateway, restore the database and files to the same backup point, and verify readiness, login, and file downloads.

A local binary can also be built:

```bash
./scripts/build-all.sh
```

Release images and archives must not contain production configuration, `.env`, database data, or private Git credentials.

## Database Migrations

Before deploying each new version, run migrations with the same configuration as the service:

```bash
CLAWEE_OPS_DIR=/etc/clawee/ops ./claw-gateway migrate up
```

Run migrations as a separate controlled task after backing up the database. Do not run migrations concurrently from multiple replicas.

## Start the Service

```bash
CLAWEE_OPS_DIR=/etc/clawee/ops ./claw-gateway serve
```

For container deployment, mount configuration as a read-only file or secret and attach persistent volumes for local data such as Skill packages and shared files. Never bake host secrets into the image.

## Network and TLS

- Terminate TLS at a reverse proxy or load balancer for external traffic.
- Expose only the HTTP, MCP, and OAuth callback paths required by the deployment.
- Restrict databases, administration interfaces, metrics, and profiling endpoints to trusted networks.
- Preserve request IDs and set Host and protocol-related headers correctly when forwarding requests.

## Health Checks

| Path | Purpose |
| --- | --- |
| `/healthz` | Process liveness check |
| `/readyz` | Service readiness check |
| `/version` | Build version information |
| `/metrics` | Prometheus metrics; restrict access where possible |

After deployment, verify at least login, MCP capability discovery, one authorized invocation, and audit records.

## Persistence and Backups

Back up at least:

- PostgreSQL data;
- Skill package directories;
- Skill Git working directories, which can alternatively be resynchronized from their sources;
- Shared file directories;
- Deployment configuration and versioned secret records.

After switching the shared drive to Alibaba Cloud OSS, also back up the corresponding bucket data and `security.agent_token_encryption_key`. PostgreSQL, object data, and encryption keys must come from the same backup point; do not restore only one of them. Enable bucket versioning or cross-region replication where appropriate, and keep buckets private.

When using an ECS RAM Role, restrict permissions to the actual bucket and profile prefix. Include object upload, read, and delete permissions, plus multipart upload creation, part upload, part listing, completion, and abort permissions. Do not grant bucket creation, deletion, or ACL administration. Outside ECS, AccessKeys can be maintained in the management console and are stored only as AES-GCM ciphertext.

Encrypt secrets and business data in backups and use access controls separate from the production service.

## Upgrades and Rollback

1. Record the current application version and database backup point.
2. Run migrations and core workflow verification in a staging environment.
3. Deploy the new binary or image and check readiness.
4. If problems occur, roll back the application version. Evaluate database rollback separately for the relevant migrations.

Do not assume that rolling back the application binary automatically reverses database schema changes.

Once shared drive files have been written to OSS, do not roll back directly to a version that does not recognize `storage_profile_id`. First perform a reverse migration in the current version, confirm that the local profile contains all files and that migration failures and pending cleanup counts are zero, then evaluate application rollback and local volume changes. Switching the active profile affects only new writes and does not automatically move existing files.

When cleanup tasks created by non-migration uploads or replacements reach the automatic retry limit of 10, operators should first restore the corresponding storage. Then, after completing backups and within a maintenance transaction scoped to a specific `cleanup_id`, reset the task to `pending`, set `attempt_count` to zero, and update `next_attempt_at`. Never reset tasks in bulk by profile or table, and never manually delete objects still referenced by `shared_files`.
