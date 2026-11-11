# Repository Boundaries and Maintenance

**English** · [简体中文](../repository-maintenance.md)

## Source Ownership

AIGateway maintains the Gateway, management console, PostgreSQL migrations, and enterprise governance. ClaweeAgent maintains the Web workspace, daemon, Electron, Codex Runtime, and Web+daemon deployment packages. Each repository installs dependencies, builds, tests, and releases independently without reading the other repository's source code.

Original public source: `krillinai/aigateway @ 3ddfa81a51584f3f6b8815686a2afd9569119e48`. The initial split preserves the internal `client/` and `server/` paths, business APIs, database migrations, appId, local data directories, and stable Agent IDs.

## Versions and Compatibility

Both repositories use independent `VERSION` files and `vX.Y.Z` tags; their version numbers do not need to match. Gateway releases backward-compatible APIs before clients adopt them. New capabilities are exposed through existing capability queries or unavailable states. Changes to required fields or error semantics and interface removal require a compatibility period.

The initial compatibility baseline for the split is source code with `VERSION=1.0.25` in both repositories. This is a migration baseline, not a new published release. Subsequent release notes must record the mutually verified versions or full commit SHAs; branch names are not reproducible versions.

## Local Integration

The two directories may be adjacent, but this is not a runtime requirement. First prepare external configuration and an isolated database in AIGateway and start the Gateway. Then configure the Gateway Origin in ClaweeAgent (`http://127.0.0.1:1904` by default for local development) and run the client. Keep configuration and credentials outside the repositories.

Interface changes and release candidates must verify registration and login, session expiration, Agent identity, allowed and denied MCP calls, Skill digest verification and installation, knowledge base and shared file permissions, and approvals. Optional enterprise integrations retain their existing unavailable behavior when not configured.

Cross-repository features use mutually linked PRs and explicitly state server prerequisites. Automated integration requiring the other repository must check out a full SHA or download a pinned artifact; it must not rely on an adjacent local directory.

## Release Channels

ClaweeAgent retains desktop signing, notarization, Runtime verification, COS update sources, and the client website directory. Preserve the existing `COS_PREFIX` and update URLs used by installed clients. Release credentials are configured independently in the new repository; do not move old tags, delete old releases, or promote update channels early.

Gateway publishes server packages and the `ghcr.io/krillinai/aigateway-server` image independently and does not write to desktop COS channels. Each side has its own artifact inventory and release gates. Ordinary PRs run verification without production credentials.

Open-source fixes belong in their owning repository. New capabilities from the original private repository must be reviewed and migrated by ownership rather than overwritten as a complete bundle, which could cause regressions or reintroduce private content.

## Reproducible Interface Smoke Verification

ClaweeAgent provides `gateway:smoke` through its real daemon HTTP adapter. Build the client first, then write the disposable Gateway address and test account to a JSON file outside the repository and set `CLAWEE_GATEWAY_SMOKE_CONFIG`. The file fields are `disposable=true`, `gateway`, `email`, and `password`. The script registers the account in an empty test database and checks login, identity, catalog reads, disabled knowledge base behavior, and session expiration. The isolated environment does not configure Bailian credentials and keeps knowledge bases disabled. Never point this check at a user data instance.

ClaweeAgent's manual Gateway Compatibility workflow requires the full AIGateway SHA and uses disposable PostgreSQL without signing or production credentials. Complete desktop workflows, Skill installation, and permission boundaries remain covered by each side's integration and E2E tests. Catalog smoke verification does not replace full business acceptance.
