package sharedfiles

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"path"
	"regexp"
	"strings"
	"time"

	"go.uber.org/zap"
)

var digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type Service struct {
	store   Store
	storage Storage
	logger  *zap.Logger
	clock   func() time.Time
}

func NewService(store Store, storage Storage, logger *zap.Logger) *Service {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Service{store: store, storage: storage, logger: logger, clock: func() time.Time { return time.Now().UTC() }}
}

func (s *Service) CreateSpace(ctx context.Context, name, description, operator string) (SpaceSummary, error) {
	name, description, err := normalizeSpaceInput(name, description)
	if err != nil || strings.TrimSpace(operator) == "" {
		return SpaceSummary{}, ErrInvalidRequest
	}
	now := s.clock()
	space := Space{SpaceID: newID("space_"), Name: name, Description: description, CreatedBy: operator, UpdatedBy: operator, CreatedAt: now, UpdatedAt: now}
	return s.store.CreateSpace(ctx, space)
}

func (s *Service) UpdateSpace(ctx context.Context, spaceID, name, description, operator string) (SpaceSummary, error) {
	name, description, err := normalizeSpaceInput(name, description)
	if err != nil || strings.TrimSpace(spaceID) == "" || strings.TrimSpace(operator) == "" {
		return SpaceSummary{}, ErrInvalidRequest
	}
	return s.store.UpdateSpace(ctx, Space{SpaceID: spaceID, Name: name, Description: description, UpdatedBy: operator, UpdatedAt: s.clock()})
}

func (s *Service) GetSpaceSummary(ctx context.Context, spaceID string) (SpaceSummary, error) {
	if strings.TrimSpace(spaceID) == "" {
		return SpaceSummary{}, ErrInvalidRequest
	}
	return s.store.GetSpaceSummary(ctx, spaceID)
}

func (s *Service) ListAdminSpaces(ctx context.Context, query string, limit int, cursor string) (Page[SpaceSummary], error) {
	query, limit, decoded, err := normalizePage(query, limit, cursor, "time")
	if err != nil {
		return Page[SpaceSummary]{}, err
	}
	items, err := s.store.ListSpaceSummaries(ctx, SpaceFilter{Query: query, Limit: limit + 1, Cursor: decoded})
	return timePage(items, limit, func(item SpaceSummary) (time.Time, string) { return item.UpdatedAt, item.SpaceID }, err)
}

func (s *Service) ListSpaces(ctx context.Context, userID string, limit int, cursor string) (Page[Space], error) {
	_, limit, decoded, err := normalizePage("", limit, cursor, "time")
	if err != nil {
		return Page[Space]{}, err
	}
	if strings.TrimSpace(userID) == "" {
		return Page[Space]{}, ErrInvalidRequest
	}
	items, err := s.store.ListAuthorizedSpaces(ctx, SpaceFilter{UserID: userID, Limit: limit + 1, Cursor: decoded})
	return timePage(items, limit, func(item Space) (time.Time, string) { return item.UpdatedAt, item.SpaceID }, err)
}

func (s *Service) ListMembers(ctx context.Context, spaceID, query string, limit int, cursor string) (Page[Member], error) {
	return s.memberPage(ctx, spaceID, query, limit, cursor)
}

func (s *Service) ListMemberCandidates(ctx context.Context, spaceID, query string, limit int, cursor string) (Page[MemberCandidate], error) {
	query, limit, decoded, err := normalizePage(query, limit, cursor, "name")
	if err != nil {
		return Page[MemberCandidate]{}, err
	}
	if strings.TrimSpace(spaceID) == "" {
		return Page[MemberCandidate]{}, ErrInvalidRequest
	}
	if _, err := s.store.GetSpaceSummary(ctx, spaceID); err != nil {
		return Page[MemberCandidate]{}, err
	}
	items, err := s.store.ListMemberCandidates(ctx, MemberFilter{SpaceID: spaceID, Query: query, Limit: limit + 1, Cursor: decoded})
	return namePage(items, limit, func(item MemberCandidate) (string, string) { return item.Name, item.UserID }, err)
}

func (s *Service) memberPage(ctx context.Context, spaceID, query string, limit int, cursor string) (Page[Member], error) {
	query, limit, decoded, err := normalizePage(query, limit, cursor, "name")
	if err != nil {
		return Page[Member]{}, err
	}
	if strings.TrimSpace(spaceID) == "" {
		return Page[Member]{}, ErrInvalidRequest
	}
	if _, err := s.store.GetSpaceSummary(ctx, spaceID); err != nil {
		return Page[Member]{}, err
	}
	items, err := s.store.ListMembers(ctx, MemberFilter{SpaceID: spaceID, Query: query, Limit: limit + 1, Cursor: decoded})
	return namePage(items, limit, func(item Member) (string, string) { return item.Name, item.UserID }, err)
}

func (s *Service) AddMember(ctx context.Context, spaceID, userID, operator string) (Member, error) {
	return s.AddMemberWithActions(ctx, spaceID, userID, []string{ActionRead, ActionWrite}, operator)
}

func (s *Service) AddMemberWithActions(ctx context.Context, spaceID, userID string, actions []string, operator string) (Member, error) {
	if strings.TrimSpace(spaceID) == "" || strings.TrimSpace(userID) == "" || strings.TrimSpace(operator) == "" {
		return Member{}, ErrInvalidRequest
	}
	actions, err := normalizeMemberActions(actions)
	if err != nil {
		return Member{}, err
	}
	return s.store.AddMember(ctx, spaceID, userID, actions, operator)
}

func (s *Service) UpdateMember(ctx context.Context, spaceID, userID string, actions []string, operator string) (Member, error) {
	if strings.TrimSpace(spaceID) == "" || strings.TrimSpace(userID) == "" || strings.TrimSpace(operator) == "" {
		return Member{}, ErrInvalidRequest
	}
	actions, err := normalizeMemberActions(actions)
	if err != nil {
		return Member{}, err
	}
	return s.store.UpdateMember(ctx, spaceID, userID, actions, operator)
}

func (s *Service) RemoveMember(ctx context.Context, spaceID, userID string) error {
	if strings.TrimSpace(spaceID) == "" || strings.TrimSpace(userID) == "" {
		return ErrInvalidRequest
	}
	return s.store.RemoveMember(ctx, spaceID, userID)
}

func normalizeMemberActions(actions []string) ([]string, error) {
	seen := map[string]bool{}
	for _, action := range actions {
		action = strings.TrimSpace(action)
		if action != ActionRead && action != ActionWrite {
			return nil, ErrInvalidRequest
		}
		seen[action] = true
	}
	if !seen[ActionRead] {
		return nil, ErrInvalidRequest
	}
	normalized := []string{ActionRead}
	if seen[ActionWrite] {
		normalized = append(normalized, ActionWrite)
	}
	return normalized, nil
}

func (s *Service) ListFiles(ctx context.Context, userID, spaceID, query, prefix string, limit int, cursor string) (Page[File], error) {
	query, limit, decoded, err := normalizePage(query, limit, cursor, "time")
	if err != nil {
		return Page[File]{}, err
	}
	if strings.TrimSpace(userID) == "" {
		return Page[File]{}, ErrInvalidRequest
	}
	spaceID = strings.TrimSpace(spaceID)
	if spaceID != "" {
		if err := s.store.CheckSpaceAccess(ctx, userID, spaceID, ActionRead); err != nil {
			return Page[File]{}, err
		}
	}
	if prefix != "" {
		if _, err := NormalizeLogicalPath(prefix, true); err != nil {
			return Page[File]{}, err
		}
	}
	items, err := s.store.ListFiles(ctx, FileFilter{UserID: userID, SpaceID: spaceID, Query: query, LogicalPathPrefix: prefix, Limit: limit + 1, Cursor: decoded})
	return timePage(items, limit, func(item File) (time.Time, string) { return item.UpdatedAt, item.FileID }, err)
}

func (s *Service) ListAdminFiles(ctx context.Context, spaceID, query, prefix string, limit int, cursor string) (Page[File], error) {
	query, limit, decoded, err := normalizePage(query, limit, cursor, "time")
	if err != nil {
		return Page[File]{}, err
	}
	spaceID = strings.TrimSpace(spaceID)
	if spaceID == "" {
		return Page[File]{}, ErrInvalidRequest
	}
	if _, err := s.store.GetSpaceSummary(ctx, spaceID); err != nil {
		return Page[File]{}, err
	}
	if prefix != "" {
		if _, err := NormalizeLogicalPath(prefix, true); err != nil {
			return Page[File]{}, err
		}
	}
	items, err := s.store.ListAdminFiles(ctx, FileFilter{SpaceID: spaceID, Query: query, LogicalPathPrefix: prefix, Limit: limit + 1, Cursor: decoded})
	return timePage(items, limit, func(item File) (time.Time, string) { return item.UpdatedAt, item.FileID }, err)
}

func (s *Service) GetFile(ctx context.Context, userID, fileID string) (File, error) {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(fileID) == "" {
		return File{}, ErrInvalidRequest
	}
	return s.store.GetAuthorizedFile(ctx, userID, fileID, ActionRead)
}

func (s *Service) OpenFile(ctx context.Context, userID, fileID string) (File, io.ReadCloser, error) {
	file, err := s.GetFile(ctx, userID, fileID)
	if err != nil {
		return File{}, nil, err
	}
	reader, err := s.storage.Open(ctx, file.StorageKey)
	if err != nil {
		return File{}, nil, ErrStorageUnavailable
	}
	return file, reader, nil
}

func (s *Service) GetAdminFile(ctx context.Context, fileID string) (File, error) {
	if strings.TrimSpace(fileID) == "" {
		return File{}, ErrInvalidRequest
	}
	return s.store.GetAdminFile(ctx, fileID)
}

func (s *Service) OpenAdminFile(ctx context.Context, fileID string) (File, io.ReadCloser, error) {
	file, err := s.GetAdminFile(ctx, fileID)
	if err != nil {
		return File{}, nil, err
	}
	reader, err := s.storage.Open(ctx, file.StorageKey)
	if err != nil {
		return File{}, nil, ErrStorageUnavailable
	}
	return file, reader, nil
}

func (s *Service) Upload(ctx context.Context, userID, agentID, spaceID, logicalPath, contentType string, declaredSize int64, declaredDigest string, expectedRevision *int64, src io.Reader) (UploadResult, error) {
	return s.upload(ctx, userID, agentID, spaceID, logicalPath, contentType, declaredSize, declaredDigest, expectedRevision, src, false)
}

func (s *Service) UploadAdmin(ctx context.Context, operatorUserID, spaceID, logicalPath, contentType string, declaredSize int64, expectedRevision *int64, src io.Reader) (UploadResult, error) {
	if strings.TrimSpace(operatorUserID) == "" {
		return UploadResult{}, ErrInvalidRequest
	}
	return s.upload(ctx, operatorUserID, "", spaceID, logicalPath, contentType, declaredSize, "", expectedRevision, src, true)
}

func (s *Service) upload(ctx context.Context, userID, agentID, spaceID, logicalPath, contentType string, declaredSize int64, declaredDigest string, expectedRevision *int64, src io.Reader, admin bool) (UploadResult, error) {
	logicalPath, err := NormalizeLogicalPath(logicalPath, false)
	if err != nil {
		return UploadResult{}, err
	}
	if strings.TrimSpace(userID) == "" || (!admin && strings.TrimSpace(agentID) == "") || strings.TrimSpace(spaceID) == "" || declaredSize < 0 {
		return UploadResult{}, ErrInvalidRequest
	}
	if declaredSize > MaxFileSizeBytes {
		return UploadResult{}, ErrFileTooLarge
	}
	if !admin && !digestPattern.MatchString(declaredDigest) {
		return UploadResult{}, ErrInvalidDigest
	}
	if expectedRevision != nil && *expectedRevision < 1 {
		return UploadResult{}, ErrInvalidRequest
	}
	contentType = strings.TrimSpace(contentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if len([]byte(contentType)) > 255 || strings.ContainsAny(contentType, "\r\n") {
		return UploadResult{}, ErrInvalidRequest
	}

	fileID := newID("file_")
	if expectedRevision == nil {
		if admin {
			if _, err := s.store.GetSpaceSummary(ctx, spaceID); err != nil {
				return UploadResult{}, err
			}
		} else if err := s.store.CheckSpaceAccess(ctx, userID, spaceID, ActionWrite); err != nil {
			return UploadResult{}, err
		}
	} else {
		var current File
		var err error
		if admin {
			current, err = s.store.GetAdminFileByPath(ctx, spaceID, logicalPath)
		} else {
			current, err = s.store.GetAuthorizedFileByPath(ctx, userID, spaceID, logicalPath, ActionWrite)
		}
		if err != nil {
			return UploadResult{}, err
		}
		if current.Revision != *expectedRevision {
			return UploadResult{}, &RevisionConflictError{CurrentRevision: current.Revision}
		}
		fileID = current.FileID
	}
	storageKey := spaceID + "/" + fileID + "/" + newID("blob_")
	size, digest, err := s.storage.Put(ctx, storageKey, src, MaxFileSizeBytes)
	if err != nil {
		if errors.Is(err, ErrFileTooLarge) || errors.Is(err, ErrContentLengthMismatch) {
			return UploadResult{}, err
		}
		return UploadResult{}, ErrStorageUnavailable
	}
	cleanup := func() {
		if err := s.storage.Delete(context.WithoutCancel(ctx), storageKey); err != nil {
			s.logger.Error("清理共享文件新对象失败")
		}
	}
	if size != declaredSize {
		cleanup()
		return UploadResult{}, ErrContentLengthMismatch
	}
	if !admin && digest != declaredDigest {
		cleanup()
		return UploadResult{}, ErrDigestMismatch
	}
	now := s.clock()
	file := File{FileID: fileID, SpaceID: spaceID, LogicalPath: logicalPath, FileName: path.Base(logicalPath), StorageKey: storageKey,
		SizeBytes: size, SHA256: digest, ContentType: contentType, CreatedByUserID: userID, CreatedByAgentID: agentID,
		UpdatedByUserID: userID, UpdatedByAgentID: agentID, CreatedAt: now, UpdatedAt: now}
	created := expectedRevision == nil
	var oldKey string
	if created {
		if admin {
			file, err = s.store.CreateAdminFile(ctx, file)
		} else {
			file, err = s.store.CreateFileAuthorized(ctx, userID, file)
		}
	} else {
		if admin {
			file, oldKey, err = s.store.ReplaceAdminFile(ctx, file, *expectedRevision)
		} else {
			file, oldKey, err = s.store.ReplaceFileAuthorized(ctx, userID, file, *expectedRevision)
		}
	}
	if err != nil {
		cleanup()
		return UploadResult{}, err
	}
	if oldKey != "" {
		if err := s.storage.Delete(context.WithoutCancel(ctx), oldKey); err != nil {
			s.logger.Error("清理共享文件旧对象失败")
		}
	}
	return UploadResult{FileID: file.FileID, SpaceID: file.SpaceID, LogicalPath: file.LogicalPath, FileName: file.FileName,
		SizeBytes: file.SizeBytes, SHA256: file.SHA256, ContentType: file.ContentType, Revision: file.Revision, Created: created, UpdatedAt: file.UpdatedAt}, nil
}

func normalizePage(query string, limit int, cursor, kind string) (string, int, Cursor, error) {
	query, err := normalizeQuery(query)
	if err != nil {
		return "", 0, Cursor{}, err
	}
	limit, err = normalizeLimit(limit)
	if err != nil {
		return "", 0, Cursor{}, err
	}
	decoded, err := decodeCursor(cursor, kind)
	return query, limit, decoded, err
}

func timePage[T any](items []T, limit int, key func(T) (time.Time, string), err error) (Page[T], error) {
	if err != nil {
		return Page[T]{}, err
	}
	page := Page[T]{Items: items}
	if len(items) <= limit {
		return page, nil
	}
	page.HasNext, page.Items = true, items[:limit]
	at, id := key(page.Items[limit-1])
	page.NextCursor = encodeCursor(Cursor{UpdatedAt: at, ID: id})
	return page, nil
}

func namePage[T any](items []T, limit int, key func(T) (string, string), err error) (Page[T], error) {
	if err != nil {
		return Page[T]{}, err
	}
	page := Page[T]{Items: items}
	if len(items) <= limit {
		return page, nil
	}
	page.HasNext, page.Items = true, items[:limit]
	name, id := key(page.Items[limit-1])
	page.NextCursor = encodeCursor(Cursor{Name: name, ID: id})
	return page, nil
}

func newID(prefix string) string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return prefix + hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return prefix + hex.EncodeToString(raw[:])
}
