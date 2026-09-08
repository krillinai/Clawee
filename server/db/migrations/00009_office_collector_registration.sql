-- +goose Up
CREATE TABLE IF NOT EXISTS office_collector_registration_codes (
    registration_code_hash TEXT PRIMARY KEY,
    registration_code TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS office_collector_registrations (
    registration_id TEXT PRIMARY KEY,
    registration_code_hash TEXT NOT NULL,
    collector_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL DEFAULT '',
    hostname TEXT NOT NULL DEFAULT '',
    os TEXT NOT NULL DEFAULT '',
    arch TEXT NOT NULL DEFAULT '',
    collector_version TEXT NOT NULL DEFAULT '',
    registered_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_office_collector_registrations_collector_id
    ON office_collector_registrations (collector_id);

CREATE INDEX IF NOT EXISTS idx_office_collector_registration_codes_expires_at
    ON office_collector_registration_codes (expires_at);

-- +goose Down
DROP TABLE IF EXISTS office_collector_registrations;
DROP TABLE IF EXISTS office_collector_registration_codes;
