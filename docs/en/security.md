# Security Reporting

**English** · [简体中文](../../SECURITY.md)

Do not submit valid credentials, account information, or details that could be used to attack an online service in public issues, PRs, or logs.

Prefer the **Report a vulnerability** private reporting entry on the repository's Security page. If that entry is not enabled, create an issue without vulnerability details and ask the maintainers to enable a private reporting channel. Provide reproduction material only after the channel is confirmed.

Include the affected version, deployment method, reproduction steps, expected and actual behavior, and minimal redacted evidence. Maintainers schedule fixes based on reproduction results; no fixed response SLA is currently promised.

The initial integrated version and subsequent stable releases are currently maintained. Deployers are responsible for TLS, backups, account approvals, upstream MCP authorization, and model service credentials. Third-party Skills and MCP tools may execute code or access external networks; review their sources and permissions before installation and authorization.

The local daemon must listen only on the local machine and retain token verification. Do not expose it directly as a public multi-user service. Complete administrator registration on a controlled network before opening a new deployment to others.
