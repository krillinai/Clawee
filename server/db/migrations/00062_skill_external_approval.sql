-- +goose Up
ALTER TABLE skill_spaces
    ADD COLUMN approval_provider TEXT NOT NULL DEFAULT 'local' CHECK (approval_provider IN ('local','dingtalk')),
    ADD COLUMN external_approval_template_id TEXT NOT NULL DEFAULT '',
    ADD CONSTRAINT skill_space_external_approval_template CHECK (approval_provider <> 'dingtalk' OR external_approval_template_id <> '');

CREATE TABLE skill_version_approval_instances (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES skill_versions(version_id) ON DELETE CASCADE,
    space_id TEXT NOT NULL REFERENCES skill_spaces(space_id),
    package_sha256 TEXT NOT NULL,
    template_id TEXT NOT NULL,
    provider_instance_id TEXT,
    initiator_user_id TEXT NOT NULL REFERENCES accounts(user_id),
    initiator_external_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('submitting','running','finished','terminated','failed','invalidated','uncertain')),
    decision TEXT CHECK (decision IN ('approved','rejected')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX skill_approval_provider_instance_unique ON skill_version_approval_instances(provider_instance_id) WHERE provider_instance_id IS NOT NULL;
CREATE UNIQUE INDEX skill_approval_active_version_unique ON skill_version_approval_instances(version_id) WHERE status IN ('submitting','running','uncertain');
CREATE INDEX skill_approval_version_latest ON skill_version_approval_instances(version_id,created_at DESC);

-- +goose Down
DROP TABLE skill_version_approval_instances;
ALTER TABLE skill_spaces DROP CONSTRAINT skill_space_external_approval_template, DROP COLUMN external_approval_template_id, DROP COLUMN approval_provider;
