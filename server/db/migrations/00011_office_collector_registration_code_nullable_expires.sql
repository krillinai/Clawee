-- +goose Up
ALTER TABLE office_collector_registration_codes
    ALTER COLUMN expires_at DROP NOT NULL;

-- +goose Down
UPDATE office_collector_registration_codes
SET expires_at = now() + interval '30 days'
WHERE expires_at IS NULL;

ALTER TABLE office_collector_registration_codes
    ALTER COLUMN expires_at SET NOT NULL;
