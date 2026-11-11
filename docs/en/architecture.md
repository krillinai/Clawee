# AIGateway Architecture

**English** · [简体中文](../architecture.md)

The Go Gateway and the `server/web` management console provide accounts, Agent identities, HTTP/MCP interfaces, authorization gates, auditing, Skill Hub, knowledge bases, and shared files. PostgreSQL stores application data, with its schema managed by `server/db/migrations`. Optional enterprise integrations are enabled through deployment configuration.

The management console is built into `server/internal/server/webdist/dist` and distributed with the Go binary or container image. The console and server remain in the same repository and share a release version.

[ClaweeAgent](https://github.com/krillinai/ClaweeAgent) maintains local execution capabilities in a separate repository and calls Gateway HTTP/MCP interfaces through the Gateway Origin. Local tasks, Runtime sessions, and model credentials remain on users' devices. Gateway stores accounts, authorizations, audits, and shared resources; it does not directly read the client's SQLite database.

`server/cmd/clawee-collector*` retains its existing Go dependencies on enterprise governance APIs and remains in this repository for the initial split. See the [Gateway architecture overview](../../server/docs/en/architecture/overview.md) and [Clawee Agent integration](../../server/docs/en/integration/clawee-agent.md).
