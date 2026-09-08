-- +goose Up
ALTER TABLE business_data_sources DROP CONSTRAINT IF EXISTS business_data_sources_provider_check;
ALTER TABLE business_data_sources ADD CONSTRAINT business_data_sources_provider_check
    CHECK (provider IN ('xiaohongshu', 'douyin_ads', 'bilibili'));

CREATE TABLE business_data_source_credentials (
    source_id TEXT PRIMARY KEY REFERENCES business_data_sources(source_id) ON DELETE CASCADE,
    access_token_ciphertext BYTEA NOT NULL,
    refresh_token_ciphertext BYTEA NOT NULL,
    token_expires_at TIMESTAMPTZ NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE business_data_oauth_states (
    state_hash BYTEA PRIMARY KEY,
    created_by TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE bilibili_account_metric_snapshots (
    source_id TEXT NOT NULL REFERENCES business_data_sources(source_id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    follower_count BIGINT NOT NULL CHECK (follower_count >= 0),
    following_count BIGINT NOT NULL CHECK (following_count >= 0),
    published_count BIGINT NOT NULL CHECK (published_count >= 0),
    sync_run_id TEXT NOT NULL REFERENCES business_sync_runs(run_id),
    PRIMARY KEY (source_id, snapshot_date)
);

CREATE TABLE bilibili_content_metric_snapshots (
    source_id TEXT NOT NULL,
    external_content_id TEXT NOT NULL,
    snapshot_date DATE NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    view_count BIGINT NOT NULL CHECK (view_count >= 0),
    danmaku_count BIGINT NOT NULL CHECK (danmaku_count >= 0),
    reply_count BIGINT NOT NULL CHECK (reply_count >= 0),
    favorite_count BIGINT NOT NULL CHECK (favorite_count >= 0),
    coin_count BIGINT NOT NULL CHECK (coin_count >= 0),
    share_count BIGINT NOT NULL CHECK (share_count >= 0),
    like_count BIGINT NOT NULL CHECK (like_count >= 0),
    sync_run_id TEXT NOT NULL REFERENCES business_sync_runs(run_id),
    PRIMARY KEY (source_id, external_content_id, snapshot_date),
    FOREIGN KEY (source_id, external_content_id)
        REFERENCES business_contents(source_id, external_content_id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE IF EXISTS bilibili_content_metric_snapshots;
DROP TABLE IF EXISTS bilibili_account_metric_snapshots;
DROP TABLE IF EXISTS business_data_oauth_states;
DROP TABLE IF EXISTS business_data_source_credentials;
DELETE FROM business_data_sources WHERE provider='bilibili';
ALTER TABLE business_data_sources DROP CONSTRAINT IF EXISTS business_data_sources_provider_check;
ALTER TABLE business_data_sources ADD CONSTRAINT business_data_sources_provider_check
    CHECK (provider IN ('xiaohongshu', 'douyin_ads'));
