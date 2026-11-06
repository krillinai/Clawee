-- +goose Up
ALTER TABLE platform_branding ADD COLUMN accent_color TEXT;

-- +goose Down
ALTER TABLE platform_branding DROP COLUMN accent_color;
