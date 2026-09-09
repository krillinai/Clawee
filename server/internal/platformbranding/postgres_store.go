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
sidebar_compact_logo, sidebar_compact_logo_content_type, updated_by, created_at, updated_at
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
	row := s.pool.QueryRow(ctx, `INSERT INTO platform_branding
(id, sidebar_logo, sidebar_logo_content_type, sidebar_compact_logo,
 sidebar_compact_logo_content_type, updated_by, created_at, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
ON CONFLICT (id) DO UPDATE SET
 sidebar_logo=CASE WHEN $8='keep' THEN platform_branding.sidebar_logo ELSE EXCLUDED.sidebar_logo END,
 sidebar_logo_content_type=CASE WHEN $8='keep' THEN platform_branding.sidebar_logo_content_type ELSE EXCLUDED.sidebar_logo_content_type END,
 sidebar_compact_logo=CASE WHEN $9='keep' THEN platform_branding.sidebar_compact_logo ELSE EXCLUDED.sidebar_compact_logo END,
 sidebar_compact_logo_content_type=CASE WHEN $9='keep' THEN platform_branding.sidebar_compact_logo_content_type ELSE EXCLUDED.sidebar_compact_logo_content_type END,
 updated_by=EXCLUDED.updated_by,
 updated_at=EXCLUDED.updated_at
RETURNING sidebar_logo, sidebar_logo_content_type, sidebar_compact_logo,
 sidebar_compact_logo_content_type, updated_by, created_at, updated_at`,
		DefaultID, logoContent, logoContentType, compactContent, compactContentType,
		input.UpdatedBy, input.UpdatedAt, input.SidebarLogoAction, input.SidebarCompactLogoAction)
	return scanConfiguration(row)
}

type rowScanner interface{ Scan(...any) error }

func scanConfiguration(row rowScanner) (Configuration, error) {
	var configuration Configuration
	var logoContent, compactContent []byte
	var logoContentType, compactContentType *string
	err := row.Scan(&logoContent, &logoContentType, &compactContent, &compactContentType,
		&configuration.UpdatedBy, &configuration.CreatedAt, &configuration.UpdatedAt)
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
