package sharedfiles

import (
	"context"
	"errors"
	"io"
	"strings"

	"github.com/jackc/pgx/v5"
)

func (s *Service) CreateSpaceTx(ctx context.Context, tx pgx.Tx, name, description, operator string) (string, error) {
	name, description, err := normalizeSpaceInput(name, description)
	if err != nil || strings.TrimSpace(operator) == "" {
		return "", ErrInvalidRequest
	}
	store, ok := s.store.(*PostgresStore)
	if !ok {
		return "", ErrStorageUnavailable
	}
	now := s.clock()
	space := Space{SpaceID: newID("space_"), Name: name, Description: description, CreatedBy: operator, UpdatedBy: operator, CreatedAt: now, UpdatedAt: now}
	return space.SpaceID, store.CreateSpaceTx(ctx, tx, space)
}

func (s *Service) CreateGeneratedSpaceTx(ctx context.Context, tx pgx.Tx, name, description, operator string) (string, error) {
	name = truncateSpaceName(name)
	var err error
	name, description, err = normalizeSpaceInput(name, description)
	if err != nil || strings.TrimSpace(operator) == "" {
		return "", ErrInvalidRequest
	}
	store, ok := s.store.(*PostgresStore)
	if !ok {
		return "", ErrStorageUnavailable
	}
	now := s.clock()
	space := Space{SpaceID: newID("space_"), Name: name, Description: description, CreatedBy: operator, UpdatedBy: operator, CreatedAt: now, UpdatedAt: now}
	if err := store.createGeneratedSpaceTx(ctx, tx, space); err != nil {
		return "", err
	}
	return space.SpaceID, nil
}

func (s *Service) EnsureMembersTx(ctx context.Context, tx pgx.Tx, spaceID string, users []string, operator string) error {
	store, ok := s.store.(*PostgresStore)
	if !ok {
		return ErrStorageUnavailable
	}
	return store.EnsureMembersTx(ctx, tx, spaceID, users, operator)
}

func (s *Service) CheckSpaceAccess(ctx context.Context, user, space, action string) error {
	return s.store.CheckSpaceAccess(ctx, user, space, action)
}

func (s *Service) GetFileByPath(ctx context.Context, user, space, logicalPath string) (File, error) {
	return s.store.GetAuthorizedFileByPath(ctx, user, space, logicalPath, ActionRead)
}

func (s *Service) CheckSpaceAccessTx(ctx context.Context, tx pgx.Tx, user, space, action string) error {
	store, ok := s.store.(*PostgresStore)
	if !ok {
		return ErrStorageUnavailable
	}
	return store.CheckSpaceAccessTx(ctx, tx, user, space, action)
}

func (s *Service) GetFileTx(ctx context.Context, tx pgx.Tx, user, fileID string) (File, error) {
	store, ok := s.store.(*PostgresStore)
	if !ok {
		return File{}, ErrStorageUnavailable
	}
	return store.GetFileTx(ctx, tx, user, fileID)
}

func (s *Service) UploadOnce(ctx context.Context, user, agent, space, logicalPath, contentType string, size int64, sha256 string, source io.Reader) (File, error) {
	result, err := s.upload(ctx, user, user, agent, space, logicalPath, contentType, size, sha256, nil, source, false)
	if errors.Is(err, ErrFileAlreadyExists) {
		file, readErr := s.store.GetAuthorizedFileByPath(ctx, user, space, logicalPath, ActionWrite)
		if readErr != nil {
			return File{}, readErr
		}
		if file.SizeBytes != size || file.SHA256 != sha256 || file.CreatedByUserID != user {
			return File{}, ErrRevisionConflict
		}
		return file, nil
	}
	if err != nil {
		return File{}, err
	}
	file, err := s.GetFile(ctx, user, result.FileID)
	if err == nil && file.CreatedByUserID != user {
		return File{}, ErrRevisionConflict
	}
	return file, err
}
