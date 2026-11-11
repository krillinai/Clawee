# Local Development

**English** · [简体中文](../../getting-started/development.md)

## Requirements

- Go 1.25 or a version compatible with `go.mod`;
- Node.js 24;
- Corepack, with pnpm 10.33.3 pinned across the repository root, client, and management console;
- Docker and Docker Compose;
- PostgreSQL 16, which can also be started with Compose.

## Start Dependencies

First specify a private operations directory independent of the source repository. The example configuration in the repository is used only for initialization and is not read directly by the application:

```bash
# Run pnpm run setup from the integrated repository root, then enter server/:
export CLAWEE_OPS_DIR="$HOME/clawee-ops"
node ../scripts/clawee.mjs init --ops-dir "$CLAWEE_OPS_DIR"
```

Initialization generates security keys. The default database uses local port `15932`; modify the private configuration or `$CLAWEE_OPS_DIR/.env` for other deployments.

```bash
docker compose -f deploy/docker-compose.yaml up -d postgres
```

Confirm that the database is ready:

```bash
docker compose -f deploy/docker-compose.yaml exec postgres \
  pg_isready -U claw_gateway -d claw_gateway
```

## Initialize the Database

```bash
make db-migrate-up
```

Migrations only run forward. Before running them, confirm that the configuration points to a development database. Integration test database names must end in `_test`.

## Start the Backend and Management Console

Start local dependencies, the backend, and the Web development server with one command:

```bash
./scripts/dev.sh
```

Default addresses:

- Backend: `http://127.0.0.1:1904`
- Web development server: `http://127.0.0.1:5904`

The Gateway and management console development servers listen on `0.0.0.0` by default. Other devices should use the development machine's actual IP address or hostname; the loopback addresses above are for local access. Initialization does not overwrite existing external configuration. Use `CLAW_GATEWAY_SERVER_ADDR=0.0.0.0:1904` to explicitly override the Gateway listen address, or `WEB_DEV_HOST` to override the combined development script's page listen address.

They can also be started separately:

```bash
./scripts/dev-backend.sh
./scripts/dev-web.sh
```

## Verify the Service

```bash
curl --fail http://127.0.0.1:1904/healthz
curl --fail http://127.0.0.1:1904/readyz
curl --fail http://127.0.0.1:1904/version
```

## Test and Build

```bash
./scripts/test.sh
./scripts/build-all.sh
```

Run backend unit tests only:

```bash
go test ./...
```

Run frontend tests only:

```bash
cd web
pnpm install --frozen-lockfile
pnpm test
```

## Development Data

`db/seeds/mcp_gateway_admin_test_data.sql` is for demos and testing only. Do not import test seeds into shared or production databases, and do not copy production data into local test environments.
