-- +goose Up
ALTER TABLE platform_branding
    ADD COLUMN sidebar_logo_dark BYTEA,
    ADD COLUMN sidebar_logo_dark_content_type TEXT,
    ADD COLUMN sidebar_compact_logo_dark BYTEA,
    ADD COLUMN sidebar_compact_logo_dark_content_type TEXT,
    ADD CONSTRAINT platform_branding_logo_dark_pair
        CHECK ((sidebar_logo_dark IS NULL) = (sidebar_logo_dark_content_type IS NULL)),
    ADD CONSTRAINT platform_branding_compact_logo_dark_pair
        CHECK ((sidebar_compact_logo_dark IS NULL) = (sidebar_compact_logo_dark_content_type IS NULL));

-- +goose Down
ALTER TABLE platform_branding
    DROP COLUMN sidebar_logo_dark,
    DROP COLUMN sidebar_logo_dark_content_type,
    DROP COLUMN sidebar_compact_logo_dark,
    DROP COLUMN sidebar_compact_logo_dark_content_type;
