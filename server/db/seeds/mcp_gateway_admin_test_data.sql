-- MCP Gateway Admin API test data.
-- Import after running db/migrations. This file is idempotent and safe to rerun.

BEGIN;

WITH seed_clock AS (
    SELECT
        TIMESTAMPTZ '2026-05-27 00:00:00+00' AS created_at,
        TIMESTAMPTZ '2026-05-27 00:00:01+00' AS completed_at,
        TIMESTAMPTZ '2030-01-01 00:00:00+00' AS expires_at
)
INSERT INTO mcp_upstream_servers (
    server_id, name, domain, transport, endpoint, auth_type, credential_ref,
    owner_team, namespace, status, created_at, updated_at
)
SELECT *
FROM (
    SELECT
        'crm-main',
        'CRM Main',
        'crm',
        'streamable_http',
        'http://crm.example/mcp',
        '',
        '',
        'sales-platform',
        'crm',
        'active',
        created_at,
        created_at
    FROM seed_clock
    UNION ALL
    SELECT
        'finance-main',
        'Finance Main',
        'finance',
        'streamable_http',
        'http://finance.example/mcp',
        '',
        '',
        'finance-platform',
        'finance',
        'disabled',
        created_at,
        created_at
    FROM seed_clock
) AS rows (
    server_id, name, domain, transport, endpoint, auth_type, credential_ref,
    owner_team, namespace, status, created_at, updated_at
)
ON CONFLICT (server_id) DO UPDATE SET
    name = EXCLUDED.name,
    domain = EXCLUDED.domain,
    transport = EXCLUDED.transport,
    endpoint = EXCLUDED.endpoint,
    auth_type = EXCLUDED.auth_type,
    credential_ref = EXCLUDED.credential_ref,
    owner_team = EXCLUDED.owner_team,
    namespace = EXCLUDED.namespace,
    status = EXCLUDED.status,
    updated_at = EXCLUDED.updated_at;

WITH seed_clock AS (
    SELECT TIMESTAMPTZ '2026-05-27 00:00:00+00' AS created_at
)
INSERT INTO mcp_agents (
    agent_id, client_id, name, tenant_id, actor_id, status, created_at, updated_at
)
SELECT *
FROM (
    SELECT
        'sales_zhang_agent',
        'agent_client_openclaw',
        'Sales Zhang Agent',
        'demo',
        'sales_zhang',
        'active',
        created_at,
        created_at
    FROM seed_clock
    UNION ALL
    SELECT
        'finance_li_agent',
        'agent_client_codex',
        'Finance Li Agent',
        'demo',
        'finance_li',
        'disabled',
        created_at,
        created_at
    FROM seed_clock
) AS rows (
    agent_id, client_id, name, tenant_id, actor_id, status, created_at, updated_at
)
ON CONFLICT (agent_id) DO UPDATE SET
    client_id = EXCLUDED.client_id,
    name = EXCLUDED.name,
    tenant_id = EXCLUDED.tenant_id,
    actor_id = EXCLUDED.actor_id,
    status = EXCLUDED.status,
    updated_at = EXCLUDED.updated_at;

WITH seed_clock AS (
    SELECT TIMESTAMPTZ '2026-05-27 00:00:00+00' AS created_at
)
INSERT INTO accounts (
    user_id, email, name, password_hash, role, status, created_at, updated_at
)
SELECT *
FROM (
    SELECT
        'user_sales_zhang', 'sales.zhang@example.com', 'Sales Zhang',
        'seed-login-disabled', 'user', 'active', created_at, created_at
    FROM seed_clock
    UNION ALL
    SELECT
        'user_finance_li', 'finance.li@example.com', 'Finance Li',
        'seed-login-disabled', 'user', 'active', created_at, created_at
    FROM seed_clock
) AS rows (
    user_id, email, name, password_hash, role, status, created_at, updated_at
)
ON CONFLICT (user_id) DO UPDATE SET
    email = EXCLUDED.email,
    name = EXCLUDED.name,
    role = EXCLUDED.role,
    status = EXCLUDED.status,
    updated_at = EXCLUDED.updated_at;

WITH seed_clock AS (
    SELECT TIMESTAMPTZ '2026-05-27 00:00:00+00' AS created_at
)
INSERT INTO account_agents (user_id, agent_id, created_at)
SELECT *
FROM (
    SELECT 'user_sales_zhang', 'sales_zhang_agent', created_at FROM seed_clock
    UNION ALL
    SELECT 'user_finance_li', 'finance_li_agent', created_at FROM seed_clock
) AS rows (user_id, agent_id, created_at)
ON CONFLICT (user_id, agent_id) DO NOTHING;

WITH seed_clock AS (
    SELECT
        TIMESTAMPTZ '2026-05-27 00:00:00+00' AS created_at,
        TIMESTAMPTZ '2030-01-01 00:00:00+00' AS expires_at
)
INSERT INTO mcp_account_tokens (
    token_id, user_id, token_hash, fingerprint, status, expires_at, last_used_at,
    issuer, scopes, created_at, updated_at
)
SELECT *
FROM (
    SELECT
        'token_sales_zhang_agent_123',
        'user_sales_zhang',
        'sha256:seed_sales_zhang_agent_token_hash',
        'ab12cd34ef56',
        'revoked',
        expires_at,
        NULL::TIMESTAMPTZ,
        'claw-mcp-admin',
        '["mcp:call"]'::JSONB,
        created_at,
        created_at
    FROM seed_clock
    UNION ALL
    SELECT
        'token_finance_li_agent_revoked',
        'user_finance_li',
        'sha256:seed_finance_li_agent_token_hash',
        'fe98dc76ba54',
        'revoked',
        expires_at,
        created_at,
        'claw-mcp-admin',
        '["mcp:call"]'::JSONB,
        created_at,
        created_at
    FROM seed_clock
) AS rows (
    token_id, user_id, token_hash, fingerprint, status, expires_at, last_used_at,
    issuer, scopes, created_at, updated_at
)
ON CONFLICT (token_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    token_hash = EXCLUDED.token_hash,
    fingerprint = EXCLUDED.fingerprint,
    status = EXCLUDED.status,
    expires_at = EXCLUDED.expires_at,
    last_used_at = EXCLUDED.last_used_at,
    issuer = EXCLUDED.issuer,
    scopes = EXCLUDED.scopes,
    updated_at = EXCLUDED.updated_at;

WITH seed_clock AS (
    SELECT TIMESTAMPTZ '2026-05-27 00:00:00+00' AS created_at
)
INSERT INTO mcp_capabilities (
    capability_id, upstream_server_id, capability_type, upstream_name, exposed_name,
    title, description, input_schema, output_schema, annotations, risk_level,
    read_only, destructive, idempotent, approval_required, confirm_required, confirm_template, status, schema_hash,
    version, last_synced_at, created_at, updated_at
)
SELECT *
FROM (
    SELECT
        'cap_search',
        'crm-main',
        'tool',
        'customer.search',
        'crm.customer.search',
        'Search customers',
        'Search customers by keyword',
        '{"type":"object","properties":{"keyword":{"type":"string"}}}'::JSONB,
        '{"type":"object","properties":{"results":{"type":"array"}}}'::JSONB,
        '{"title":"Search customers"}'::JSONB,
        'low',
        TRUE,
        FALSE,
        TRUE,
        FALSE,
        FALSE,
        '',
        'active',
        'seed-crm-search-v1',
        'v1',
        created_at,
        created_at,
        created_at
    FROM seed_clock
    UNION ALL
    SELECT
        'cap_update_customer',
        'crm-main',
        'tool',
        'customer.update',
        'crm.customer.update',
        'Update customer',
        'Update customer profile fields',
        '{"type":"object","properties":{"customer_id":{"type":"string"},"fields":{"type":"object"}}}'::JSONB,
        '{"type":"object"}'::JSONB,
        '{"title":"Update customer"}'::JSONB,
        'high',
        FALSE,
        TRUE,
        FALSE,
        TRUE,
        TRUE,
        '请确认本次 CRM 写入动作的参数快照。',
        'pending',
        'seed-crm-update-v1',
        'v1',
        created_at,
        created_at,
        created_at
    FROM seed_clock
    UNION ALL
    SELECT
        'cap_invoice_lookup',
        'finance-main',
        'tool',
        'invoice.lookup',
        'finance.invoice.lookup',
        'Lookup invoice',
        'Lookup invoice by invoice number',
        '{"type":"object","properties":{"invoice_no":{"type":"string"}}}'::JSONB,
        '{"type":"object"}'::JSONB,
        '{"title":"Lookup invoice"}'::JSONB,
        'medium',
        TRUE,
        FALSE,
        TRUE,
        FALSE,
        FALSE,
        '',
        'disabled',
        'seed-finance-invoice-v1',
        'v1',
        created_at,
        created_at,
        created_at
    FROM seed_clock
) AS rows (
    capability_id, upstream_server_id, capability_type, upstream_name, exposed_name,
    title, description, input_schema, output_schema, annotations, risk_level,
    read_only, destructive, idempotent, approval_required, confirm_required, confirm_template, status, schema_hash,
    version, last_synced_at, created_at, updated_at
)
ON CONFLICT (capability_id) DO UPDATE SET
    upstream_server_id = EXCLUDED.upstream_server_id,
    capability_type = EXCLUDED.capability_type,
    upstream_name = EXCLUDED.upstream_name,
    exposed_name = EXCLUDED.exposed_name,
    title = EXCLUDED.title,
    description = EXCLUDED.description,
    input_schema = EXCLUDED.input_schema,
    output_schema = EXCLUDED.output_schema,
    annotations = EXCLUDED.annotations,
    risk_level = EXCLUDED.risk_level,
    read_only = EXCLUDED.read_only,
    destructive = EXCLUDED.destructive,
    idempotent = EXCLUDED.idempotent,
    approval_required = EXCLUDED.approval_required,
    confirm_required = EXCLUDED.confirm_required,
    confirm_template = EXCLUDED.confirm_template,
    status = EXCLUDED.status,
    schema_hash = EXCLUDED.schema_hash,
    version = EXCLUDED.version,
    last_synced_at = EXCLUDED.last_synced_at,
    updated_at = EXCLUDED.updated_at;

WITH seed_clock AS (
    SELECT
        TIMESTAMPTZ '2026-05-27 00:00:00+00' AS created_at,
        TIMESTAMPTZ '2030-01-01 00:00:00+00' AS expires_at
)
INSERT INTO mcp_account_grants (
    grant_id, user_id, capability_id, grant_type, data_scope, expires_at,
    created_by, created_at, updated_at
)
SELECT *
FROM (
    SELECT
        'grant_sales_zhang_agent_tool_cap_search',
        'user_sales_zhang',
        'cap_search',
        'tool',
        '{"regions":["north"]}'::JSONB,
        expires_at,
        'admin',
        created_at,
        created_at
    FROM seed_clock
    UNION ALL
    SELECT
        'grant_sales_zhang_agent_server_crm_main',
        'user_sales_zhang',
        'cap_search',
        'server',
        '{"server_id":"crm-main"}'::JSONB,
        NULL::TIMESTAMPTZ,
        'admin',
        created_at,
        created_at
    FROM seed_clock
) AS rows (
    grant_id, user_id, capability_id, grant_type, data_scope, expires_at,
    created_by, created_at, updated_at
)
ON CONFLICT (grant_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    capability_id = EXCLUDED.capability_id,
    grant_type = EXCLUDED.grant_type,
    data_scope = EXCLUDED.data_scope,
    expires_at = EXCLUDED.expires_at,
    created_by = EXCLUDED.created_by,
    updated_at = EXCLUDED.updated_at;

WITH seed_clock AS (
    SELECT
        TIMESTAMPTZ '2026-05-27 00:00:00+00' AS created_at,
        TIMESTAMPTZ '2026-05-27 00:00:01+00' AS completed_at
)
INSERT INTO mcp_proxy_audit_records (
    audit_id, trace_id, request_id, inbound_session_id, upstream_session_id,
    agent_id, actor_id, tenant_id, token_id, token_hash, upstream_server_id,
    capability_id, capability_type, exposed_name, upstream_name, request_headers,
    request_body, response_headers, response_body, decision, decision_reason,
    error, duration_ms, created_at, completed_at
)
SELECT *
FROM (
    SELECT
        'audit_001',
        'trace_001',
        'req_001',
        'sess_in_001',
        'sess_up_001',
        'sales_zhang_agent',
        'sales_zhang',
        'demo',
        'token_sales_zhang_agent_123',
        'sha256:masked',
        'crm-main',
        'cap_search',
        'tool',
        'crm.customer.search',
        'customer.search',
        '{"Authorization":"Bearer ***"}'::JSONB,
        '{"keyword":"Acme"}'::JSONB,
        '{"Content-Type":"application/json"}'::JSONB,
        '{"results":[]}'::JSONB,
        'allowed',
        'allowed',
        '',
        120::BIGINT,
        created_at,
        completed_at
    FROM seed_clock
    UNION ALL
    SELECT
        'audit_002',
        'trace_002',
        'req_002',
        'sess_in_002',
        'sess_up_002',
        'sales_zhang_agent',
        'sales_zhang',
        'demo',
        'token_sales_zhang_agent_123',
        'sha256:masked',
        'crm-main',
        'cap_update_customer',
        'tool',
        'crm.customer.update',
        'customer.update',
        '{"Authorization":"Bearer ***"}'::JSONB,
        '{"customer_id":"cust_001","fields":{"level":"vip"}}'::JSONB,
        '{}'::JSONB,
        '{}'::JSONB,
        'denied',
        'capability is not active',
        'capability is pending approval',
        8::BIGINT,
        created_at + INTERVAL '5 minutes',
        completed_at + INTERVAL '5 minutes'
    FROM seed_clock
) AS rows (
    audit_id, trace_id, request_id, inbound_session_id, upstream_session_id,
    agent_id, actor_id, tenant_id, token_id, token_hash, upstream_server_id,
    capability_id, capability_type, exposed_name, upstream_name, request_headers,
    request_body, response_headers, response_body, decision, decision_reason,
    error, duration_ms, created_at, completed_at
)
ON CONFLICT (audit_id) DO UPDATE SET
    trace_id = EXCLUDED.trace_id,
    request_id = EXCLUDED.request_id,
    inbound_session_id = EXCLUDED.inbound_session_id,
    upstream_session_id = EXCLUDED.upstream_session_id,
    agent_id = EXCLUDED.agent_id,
    actor_id = EXCLUDED.actor_id,
    tenant_id = EXCLUDED.tenant_id,
    token_id = EXCLUDED.token_id,
    token_hash = EXCLUDED.token_hash,
    upstream_server_id = EXCLUDED.upstream_server_id,
    capability_id = EXCLUDED.capability_id,
    capability_type = EXCLUDED.capability_type,
    exposed_name = EXCLUDED.exposed_name,
    upstream_name = EXCLUDED.upstream_name,
    request_headers = EXCLUDED.request_headers,
    request_body = EXCLUDED.request_body,
    response_headers = EXCLUDED.response_headers,
    response_body = EXCLUDED.response_body,
    decision = EXCLUDED.decision,
    decision_reason = EXCLUDED.decision_reason,
    error = EXCLUDED.error,
    duration_ms = EXCLUDED.duration_ms,
    created_at = EXCLUDED.created_at,
    completed_at = EXCLUDED.completed_at;

COMMIT;
