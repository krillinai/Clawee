package platformbranding

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct{ pool *pgxpool.Pool }

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore { return &PostgresStore{pool: pool} }

func (s *PostgresStore) Get(ctx context.Context) (Configuration, error) {
	row := s.pool.QueryRow(ctx, `SELECT sidebar_logo, sidebar_logo_content_type,
sidebar_compact_logo, sidebar_compact_logo_content_type, updated_by, created_at, updated_at,
COALESCE(sidebar_skills_label,''), COALESCE(sidebar_knowledge_label,''),
COALESCE(sidebar_drive_label,''), COALESCE(sidebar_dashboard_label,'')
FROM platform_branding WHERE id=$1`, DefaultID)
	configuration, err := scanConfiguration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Configuration{}, nil
	}
	return configuration, err
}

func (s *PostgresStore) Update(ctx context.Context, input UpdateInput) (Configuration, error) {
	logoContent, logoContentType := actionValues(input.SidebarLogoAction, input.SidebarLogo)
	compactContent, compactContentType := actionValues(input.SidebarCompactLogoAction, input.SidebarCompactLogo)
	skills, updateSkills := input.SidebarMenuLabels["skills"]
	knowledge, updateKnowledge := input.SidebarMenuLabels["knowledge"]
	drive, updateDrive := input.SidebarMenuLabels["drive"]
	dashboard, updateDashboard := input.SidebarMenuLabels["dashboard"]
	row := s.pool.QueryRow(ctx, `INSERT INTO platform_branding
(id, sidebar_logo, sidebar_logo_content_type, sidebar_compact_logo,
 sidebar_compact_logo_content_type, updated_by, created_at, updated_at,
 sidebar_skills_label, sidebar_knowledge_label, sidebar_drive_label, sidebar_dashboard_label)
VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$10,$11,$12,$13)
ON CONFLICT (id) DO UPDATE SET
 sidebar_logo=CASE WHEN $8='keep' THEN platform_branding.sidebar_logo ELSE EXCLUDED.sidebar_logo END,
 sidebar_logo_content_type=CASE WHEN $8='keep' THEN platform_branding.sidebar_logo_content_type ELSE EXCLUDED.sidebar_logo_content_type END,
 sidebar_compact_logo=CASE WHEN $9='keep' THEN platform_branding.sidebar_compact_logo ELSE EXCLUDED.sidebar_compact_logo END,
 sidebar_compact_logo_content_type=CASE WHEN $9='keep' THEN platform_branding.sidebar_compact_logo_content_type ELSE EXCLUDED.sidebar_compact_logo_content_type END,
 sidebar_skills_label=CASE WHEN $14 THEN EXCLUDED.sidebar_skills_label ELSE platform_branding.sidebar_skills_label END,
 sidebar_knowledge_label=CASE WHEN $15 THEN EXCLUDED.sidebar_knowledge_label ELSE platform_branding.sidebar_knowledge_label END,
 sidebar_drive_label=CASE WHEN $16 THEN EXCLUDED.sidebar_drive_label ELSE platform_branding.sidebar_drive_label END,
 sidebar_dashboard_label=CASE WHEN $17 THEN EXCLUDED.sidebar_dashboard_label ELSE platform_branding.sidebar_dashboard_label END,
 updated_by=EXCLUDED.updated_by,
 updated_at=EXCLUDED.updated_at
RETURNING sidebar_logo, sidebar_logo_content_type, sidebar_compact_logo,
 sidebar_compact_logo_content_type, updated_by, created_at, updated_at,
 COALESCE(sidebar_skills_label,''), COALESCE(sidebar_knowledge_label,''),
 COALESCE(sidebar_drive_label,''), COALESCE(sidebar_dashboard_label,'')`,
		DefaultID, logoContent, logoContentType, compactContent, compactContentType,
		input.UpdatedBy, input.UpdatedAt, input.SidebarLogoAction, input.SidebarCompactLogoAction,
		skills, knowledge, drive, dashboard, updateSkills, updateKnowledge, updateDrive, updateDashboard)
	return scanConfiguration(row)
}

type rowScanner interface{ Scan(...any) error }

func scanConfiguration(row rowScanner) (Configuration, error) {
	var configuration Configuration
	var logoContent, compactContent []byte
	var logoContentType, compactContentType *string
	err := row.Scan(&logoContent, &logoContentType, &compactContent, &compactContentType,
		&configuration.UpdatedBy, &configuration.CreatedAt, &configuration.UpdatedAt,
		&configuration.SidebarMenuLabels.Skills, &configuration.SidebarMenuLabels.Knowledge,
		&configuration.SidebarMenuLabels.Drive, &configuration.SidebarMenuLabels.Dashboard)
	if err != nil {
		return Configuration{}, err
	}
	if logoContentType != nil {
		configuration.SidebarLogo = &Image{Content: logoContent, ContentType: *logoContentType}
	}
	if compactContentType != nil {
		configuration.SidebarCompactLogo = &Image{Content: compactContent, ContentType: *compactContentType}
	}
	return configuration, nil
}

func actionValues(action Action, content []byte) ([]byte, *string) {
	if action != ActionReplace {
		return nil, nil
	}
	contentType := detectContentType(content)
	return content, &contentType
}
