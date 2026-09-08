-- +goose Up
CREATE TABLE IF NOT EXISTS knowledge_bases (
    knowledge_base_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    provider_type TEXT NOT NULL,
    external_knowledge_base_id TEXT,
    status TEXT NOT NULL,
    error_message TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_bases_active_name
    ON knowledge_bases (name) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_bases_provider_binding
    ON knowledge_bases (provider_type, external_knowledge_base_id)
    WHERE external_knowledge_base_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_bases_updated_at
    ON knowledge_bases (updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS knowledge_documents (
    document_id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(knowledge_base_id),
    name TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT '',
    external_document_id TEXT,
    status TEXT NOT NULL,
    error_message TEXT NOT NULL DEFAULT '',
    uploaded_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_documents_provider_binding
    ON knowledge_documents (knowledge_base_id, external_document_id)
    WHERE external_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_knowledge_base
    ON knowledge_documents (knowledge_base_id, updated_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE mcp_proxy_audit_records
    ADD COLUMN IF NOT EXISTS resolved_data_scope JSONB;

-- +goose Down
ALTER TABLE mcp_proxy_audit_records
    DROP COLUMN IF EXISTS resolved_data_scope;
DROP TABLE IF EXISTS knowledge_documents;
DROP TABLE IF EXISTS knowledge_bases;
