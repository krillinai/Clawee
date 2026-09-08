-- +goose Up
ALTER TABLE oauth_login_states
    ADD COLUMN IF NOT EXISTS agent_id TEXT,
    ADD COLUMN IF NOT EXISTS pkce_challenge TEXT;

ALTER TABLE oauth_login_states
    DROP CONSTRAINT IF EXISTS oauth_login_states_intent_check,
    DROP CONSTRAINT IF EXISTS oauth_login_states_bind_user_check,
    DROP CONSTRAINT IF EXISTS oauth_login_states_check;

ALTER TABLE oauth_login_states
    ADD CONSTRAINT oauth_login_states_intent_check
        CHECK (intent IN ('login', 'bind_current_user', 'login_clawee')),
    ADD CONSTRAINT oauth_login_states_bind_user_check CHECK (
        (intent = 'bind_current_user' AND bind_user_id IS NOT NULL)
        OR
        (intent IN ('login', 'login_clawee') AND bind_user_id IS NULL)
    );

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
    code_hash TEXT PRIMARY KEY CHECK (char_length(code_hash) = 64),
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL CHECK (char_length(agent_id) BETWEEN 1 AND 64),
    redirect_uri TEXT NOT NULL CHECK (redirect_uri <> ''),
    pkce_challenge TEXT NOT NULL CHECK (char_length(pkce_challenge) = 43),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_expires_at
    ON oauth_authorization_codes (expires_at);

-- +goose Down
DROP TABLE IF EXISTS oauth_authorization_codes;

ALTER TABLE oauth_login_states
    DROP CONSTRAINT IF EXISTS oauth_login_states_bind_user_check,
    DROP CONSTRAINT IF EXISTS oauth_login_states_intent_check,
    DROP COLUMN IF EXISTS agent_id,
    DROP COLUMN IF EXISTS pkce_challenge;

ALTER TABLE oauth_login_states
    ADD CONSTRAINT oauth_login_states_intent_check
        CHECK (intent IN ('login', 'bind_current_user')),
    ADD CONSTRAINT oauth_login_states_bind_user_check CHECK (
        (intent = 'login' AND bind_user_id IS NULL)
        OR
        (intent = 'bind_current_user' AND bind_user_id IS NOT NULL)
    );
