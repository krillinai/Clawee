# Documentation

**English** · [简体中文](../README.md)

This directory contains the public documentation for the MCP Gateway backend. The project sits between Agent Runtimes and enterprise systems, providing centralized authentication, authorization, MCP capability governance, invocation gates, and auditing. The project does not implement Agent Runtimes or business systems such as OA, ERP, CRM, or knowledge bases.

## Reading Order

1. [Architecture Overview](architecture/overview.md): system boundaries, components, and primary invocation flows.
2. [Security and Permissions](architecture/security-and-permissions.md): identity, RBAC, Agent grants, gates, and auditing.
3. [Local Development](getting-started/development.md): start the database, backend, and management console.
4. [Configuration Reference](getting-started/configuration.md): configuration sources, override rules, and secret management requirements.
5. [Production Deployment](deployment/production.md): migrations, startup, reverse proxies, health checks, and persistence requirements.

The public repository contains only `configs/config.example.yaml`. Real configuration must be copied to an independent `CLAWEE_OPS_DIR` and must not be written back to the source repository, release packages, or container images.

## Integration Documentation

- [Clawee Agent Integration](integration/clawee-agent.md)
- [Upstream MCP Server Integration](integration/upstream-mcp.md)
- [HTTP API Overview](reference/http-api.md)

## Documentation Conventions

- Documentation describes only capabilities provided by the current code.
- `example.com`, `127.0.0.1`, and example identifiers are placeholders.
- Secrets must not be written to the repository, shell history, logs, diagnostic bundles, or frontend storage.
- Refer to the current version's code and tests for exact request fields and response structures.
