-- +goose Up
ALTER TABLE platform_branding
    ADD COLUMN sidebar_skills_label TEXT CHECK (char_length(sidebar_skills_label) BETWEEN 1 AND 4),
    ADD COLUMN sidebar_knowledge_label TEXT CHECK (char_length(sidebar_knowledge_label) BETWEEN 1 AND 4),
    ADD COLUMN sidebar_drive_label TEXT CHECK (char_length(sidebar_drive_label) BETWEEN 1 AND 4),
    ADD COLUMN sidebar_dashboard_label TEXT CHECK (char_length(sidebar_dashboard_label) BETWEEN 1 AND 4);

-- +goose Down
ALTER TABLE platform_branding
    DROP COLUMN sidebar_skills_label,
    DROP COLUMN sidebar_knowledge_label,
    DROP COLUMN sidebar_drive_label,
    DROP COLUMN sidebar_dashboard_label;
