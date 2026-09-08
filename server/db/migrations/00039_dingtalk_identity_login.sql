-- +goose Up
CREATE TABLE IF NOT EXISTS account_identities (
    provider_type TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    external_user_id TEXT NOT NULL DEFAULT '',
    verified_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (provider_type, provider_key, provider_subject),
    UNIQUE (user_id, provider_type, provider_key)
);

CREATE INDEX IF NOT EXISTS idx_account_identities_user
    ON account_identities (user_id);

CREATE TABLE IF NOT EXISTS oauth_login_states (
    state_hash TEXT PRIMARY KEY,
    provider_type TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    intent TEXT NOT NULL,
    redirect_to TEXT NOT NULL,
    bind_user_id TEXT REFERENCES accounts(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (intent IN ('login', 'bind_current_user')),
    CHECK (
        (intent = 'login' AND bind_user_id IS NULL)
        OR
        (intent = 'bind_current_user' AND bind_user_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_oauth_login_states_expires_at
    ON oauth_login_states (expires_at);

-- +goose Down
DROP TABLE IF EXISTS oauth_login_states;
DROP TABLE IF EXISTS account_identities;
