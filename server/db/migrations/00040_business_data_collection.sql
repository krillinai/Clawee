-- +goose Up
CREATE TABLE IF NOT EXISTS business_data_sources (
    source_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('xiaohongshu', 'douyin_ads')),
    external_account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    next_sync_at TIMESTAMPTZ,
    last_attempt_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error_code TEXT NOT NULL DEFAULT '',
    last_error_summary TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (provider, external_account_id)
);

CREATE INDEX IF NOT EXISTS idx_business_data_sources_due
    ON business_data_sources (status, next_sync_at);

CREATE TABLE IF NOT EXISTS business_sync_runs (
    run_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES business_data_sources(source_id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed')),
    fetched_count BIGINT NOT NULL DEFAULT 0 CHECK (fetched_count >= 0),
    upserted_count BIGINT NOT NULL DEFAULT 0 CHECK (upserted_count >= 0),
    error_code TEXT NOT NULL DEFAULT '',
    error_summary TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK (start_date <= end_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_business_sync_runs_active_source
    ON business_sync_runs (source_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_business_sync_runs_queue
    ON business_sync_runs (status, created_at);

CREATE TABLE IF NOT EXISTS business_contents (
    source_id TEXT NOT NULL REFERENCES business_data_sources(source_id) ON DELETE CASCADE,
    external_content_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source_id, external_content_id)
);

CREATE TABLE IF NOT EXISTS business_content_daily_metrics (
    source_id TEXT NOT NULL,
    external_content_id TEXT NOT NULL,
    stat_date DATE NOT NULL,
    exposure_count BIGINT NOT NULL CHECK (exposure_count >= 0),
    like_count BIGINT NOT NULL CHECK (like_count >= 0),
    favorite_count BIGINT NOT NULL CHECK (favorite_count >= 0),
    comment_count BIGINT NOT NULL CHECK (comment_count >= 0),
    share_count BIGINT NOT NULL CHECK (share_count >= 0),
    sync_run_id TEXT NOT NULL REFERENCES business_sync_runs(run_id),
    ingested_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source_id, external_content_id, stat_date),
    FOREIGN KEY (source_id, external_content_id)
        REFERENCES business_contents(source_id, external_content_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS business_account_daily_metrics (
    source_id TEXT NOT NULL REFERENCES business_data_sources(source_id) ON DELETE CASCADE,
    stat_date DATE NOT NULL,
    new_follower_count BIGINT NOT NULL CHECK (new_follower_count >= 0),
    sync_run_id TEXT NOT NULL REFERENCES business_sync_runs(run_id),
    ingested_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source_id, stat_date)
);

CREATE TABLE IF NOT EXISTS business_campaigns (
    source_id TEXT NOT NULL REFERENCES business_data_sources(source_id) ON DELETE CASCADE,
    external_campaign_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    campaign_type TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source_id, external_campaign_id)
);

CREATE TABLE IF NOT EXISTS business_campaign_daily_metrics (
    source_id TEXT NOT NULL,
    external_campaign_id TEXT NOT NULL,
    stat_date DATE NOT NULL,
    spend_minor BIGINT NOT NULL CHECK (spend_minor >= 0),
    impression_count BIGINT NOT NULL CHECK (impression_count >= 0),
    video_play_count BIGINT NOT NULL CHECK (video_play_count >= 0),
    click_count BIGINT NOT NULL CHECK (click_count >= 0),
    sync_run_id TEXT NOT NULL REFERENCES business_sync_runs(run_id),
    ingested_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source_id, external_campaign_id, stat_date),
    FOREIGN KEY (source_id, external_campaign_id)
        REFERENCES business_campaigns(source_id, external_campaign_id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE IF EXISTS business_campaign_daily_metrics;
DROP TABLE IF EXISTS business_campaigns;
DROP TABLE IF EXISTS business_account_daily_metrics;
DROP TABLE IF EXISTS business_content_daily_metrics;
DROP TABLE IF EXISTS business_contents;
DROP TABLE IF EXISTS business_sync_runs;
DROP TABLE IF EXISTS business_data_sources;
