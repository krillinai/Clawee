-- +goose Up
DROP TABLE IF EXISTS model_api_keys;

-- +goose Down
SELECT 1;
