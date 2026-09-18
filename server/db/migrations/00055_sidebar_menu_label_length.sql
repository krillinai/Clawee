-- +goose Up
ALTER TABLE platform_branding
    DROP CONSTRAINT platform_branding_sidebar_skills_label_check,
    DROP CONSTRAINT platform_branding_sidebar_knowledge_label_check,
    DROP CONSTRAINT platform_branding_sidebar_drive_label_check,
    DROP CONSTRAINT platform_branding_sidebar_dashboard_label_check,
    ADD CONSTRAINT platform_branding_sidebar_skills_label_check CHECK (char_length(sidebar_skills_label) BETWEEN 1 AND 10),
    ADD CONSTRAINT platform_branding_sidebar_knowledge_label_check CHECK (char_length(sidebar_knowledge_label) BETWEEN 1 AND 10),
    ADD CONSTRAINT platform_branding_sidebar_drive_label_check CHECK (char_length(sidebar_drive_label) BETWEEN 1 AND 10),
    ADD CONSTRAINT platform_branding_sidebar_dashboard_label_check CHECK (char_length(sidebar_dashboard_label) BETWEEN 1 AND 10);

-- +goose Down
ALTER TABLE platform_branding
    DROP CONSTRAINT platform_branding_sidebar_skills_label_check,
    DROP CONSTRAINT platform_branding_sidebar_knowledge_label_check,
    DROP CONSTRAINT platform_branding_sidebar_drive_label_check,
    DROP CONSTRAINT platform_branding_sidebar_dashboard_label_check,
    ADD CONSTRAINT platform_branding_sidebar_skills_label_check CHECK (char_length(sidebar_skills_label) BETWEEN 1 AND 4),
    ADD CONSTRAINT platform_branding_sidebar_knowledge_label_check CHECK (char_length(sidebar_knowledge_label) BETWEEN 1 AND 4),
    ADD CONSTRAINT platform_branding_sidebar_drive_label_check CHECK (char_length(sidebar_drive_label) BETWEEN 1 AND 4),
    ADD CONSTRAINT platform_branding_sidebar_dashboard_label_check CHECK (char_length(sidebar_dashboard_label) BETWEEN 1 AND 4);
