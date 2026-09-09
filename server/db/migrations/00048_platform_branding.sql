-- +goose Up
CREATE TABLE IF NOT EXISTS platform_branding (
    id TEXT PRIMARY KEY CHECK (id = 'default'),
    sidebar_logo BYTEA,
    sidebar_logo_content_type TEXT,
    sidebar_compact_logo BYTEA,
    sidebar_compact_logo_content_type TEXT,
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK ((sidebar_logo IS NULL) = (sidebar_logo_content_type IS NULL)),
    CHECK ((sidebar_compact_logo IS NULL) = (sidebar_compact_logo_content_type IS NULL))
);

-- +goose Down
DROP TABLE IF EXISTS platform_branding;
