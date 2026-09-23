-- +goose Up
ALTER TABLE platform_branding ADD COLUMN admin_url TEXT;

-- +goose Down
ALTER TABLE platform_branding DROP COLUMN admin_url;
