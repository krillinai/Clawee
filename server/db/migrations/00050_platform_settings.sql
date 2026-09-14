-- +goose Up
CREATE TABLE IF NOT EXISTS platform_settings (
    namespace TEXT NOT NULL,
    config_key TEXT NOT NULL,
    config_value JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (namespace, config_key)
);

-- +goose Down
DROP TABLE IF EXISTS platform_settings;
