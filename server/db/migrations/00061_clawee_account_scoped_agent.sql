-- +goose Up
ALTER TABLE oauth_login_states ADD COLUMN account_scoped_agent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE oauth_authorization_codes ADD COLUMN account_scoped_agent BOOLEAN NOT NULL DEFAULT FALSE;

-- +goose Down
ALTER TABLE oauth_authorization_codes DROP COLUMN account_scoped_agent;
ALTER TABLE oauth_login_states DROP COLUMN account_scoped_agent;
