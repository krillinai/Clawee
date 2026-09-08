package sharedfiles

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"
)

type memoryAccount struct {
	UserID string
	Name   string
	Email  string
	Status string
}

type memoryGrant struct {
	Read      bool
	Write     bool
	CreatedAt time.Time
	UpdatedAt time.Time
}

type MemoryStore struct {
	mu       sync.RWMutex
	spaces   map[string]Space
	files    map[string]File
	grants   map[string]map[string]memoryGrant
	accounts map[string]memoryAccount
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{spaces: map[string]Space{}, files: map[string]File{}, grants: map[string]map[string]memoryGrant{}, accounts: map[string]memoryAccount{}}
}

func (s *MemoryStore) SetAccount(userID, name, email, status string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.accounts[userID] = memoryAccount{UserID: userID, Name: name, Email: email, Status: status}
}

func (s *MemoryStore) CreateSpace(ctx context.Context, space Space) (SpaceSummary, error) {
	if err := ctx.Err(); err != nil {
		return SpaceSummary{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, current := range s.spaces {
		if strings.EqualFold(current.Name, space.Name) {
			return SpaceSummary{}, ErrSpaceNameConflict
		}
	}
	s.spaces[space.SpaceID] = space
	return SpaceSummary{Space: space}, nil
}

func (s *MemoryStore) UpdateSpace(ctx context.Context, space Space) (SpaceSummary, error) {
	if err := ctx.Err(); err != nil {
		return SpaceSummary{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.spaces[space.SpaceID]
	if !ok {
		return SpaceSummary{}, ErrSharedSpaceNotFound
	}
	for id, other := range s.spaces {
		if id != space.SpaceID && strings.EqualFold(other.Name, space.Name) {
			return SpaceSummary{}, ErrSpaceNameConflict
		}
	}
	current.Name, current.Description, current.UpdatedBy, current.UpdatedAt = space.Name, space.Description, space.UpdatedBy, space.UpdatedAt
	s.spaces[space.SpaceID] = current
	return s.summaryLocked(current), nil
}

func (s *MemoryStore) GetSpaceSummary(ctx context.Context, spaceID string) (SpaceSummary, error) {
	if err := ctx.Err(); err != nil {
		return SpaceSummary{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	space, ok := s.spaces[spaceID]
	if !ok {
		return SpaceSummary{}, ErrSharedSpaceNotFound
	}
	return s.summaryLocked(space), nil
}

func (s *MemoryStore) ListSpaceSummaries(ctx context.Context, filter SpaceFilter) ([]SpaceSummary, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := []SpaceSummary{}
	for _, space := range s.spaces {
		if filter.Query != "" && !strings.Contains(strings.ToLower(space.Name), strings.ToLower(filter.Query)) {
			continue
		}
		if !afterTimeCursor(space.UpdatedAt, space.SpaceID, filter.Cursor) {
			continue
		}
		items = append(items, s.summaryLocked(space))
	}
	sort.Slice(items, func(i, j int) bool {
		return timeIDLess(items[i].UpdatedAt, items[i].SpaceID, items[j].UpdatedAt, items[j].SpaceID)
	})
	return take(items, filter.Limit), nil
}

func (s *MemoryStore) ListAuthorizedSpaces(ctx context.Context, filter SpaceFilter) ([]Space, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := []Space{}
	for id, space := range s.spaces {
		if !s.grants[id][filter.UserID].Read || !afterTimeCursor(space.UpdatedAt, id, filter.Cursor) {
			continue
		}
		items = append(items, space)
	}
	sort.Slice(items, func(i, j int) bool {
		return timeIDLess(items[i].UpdatedAt, items[i].SpaceID, items[j].UpdatedAt, items[j].SpaceID)
	})
	return take(items, filter.Limit), nil
}

func (s *MemoryStore) ListMembers(ctx context.Context, filter MemberFilter) ([]Member, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := []Member{}
	for userID, grant := range s.grants[filter.SpaceID] {
		account := s.accounts[userID]
		name := displayName(account)
		if filter.Query != "" && !containsAny(filter.Query, userID, name, account.Email) {
			continue
		}
		if !afterNameCursor(name, userID, filter.Cursor) {
			continue
		}
		items = append(items, memoryMember(userID, account, grant))
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].Name < items[j].Name || (items[i].Name == items[j].Name && items[i].UserID < items[j].UserID)
	})
	return take(items, filter.Limit), nil
}

func (s *MemoryStore) ListMemberCandidates(ctx context.Context, filter MemberFilter) ([]MemberCandidate, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := []MemberCandidate{}
	for userID, account := range s.accounts {
		grant := s.grants[filter.SpaceID][userID]
		name := displayName(account)
		if account.Status != "active" || grant.Read || grant.Write || (filter.Query != "" && !containsAny(filter.Query, userID, name, account.Email)) || !afterNameCursor(name, userID, filter.Cursor) {
			continue
		}
		items = append(items, MemberCandidate{UserID: userID, Name: name, Email: account.Email})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].Name < items[j].Name || (items[i].Name == items[j].Name && items[i].UserID < items[j].UserID)
	})
	return take(items, filter.Limit), nil
}

func (s *MemoryStore) AddMember(ctx context.Context, spaceID, userID string, actions []string, createdBy string) (Member, error) {
	return s.setMember(ctx, spaceID, userID, actions, false)
}

func (s *MemoryStore) UpdateMember(ctx context.Context, spaceID, userID string, actions []string, createdBy string) (Member, error) {
	return s.setMember(ctx, spaceID, userID, actions, true)
}

func (s *MemoryStore) setMember(ctx context.Context, spaceID, userID string, actions []string, replace bool) (Member, error) {
	if err := ctx.Err(); err != nil {
		return Member{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.spaces[spaceID]; !ok {
		return Member{}, ErrSharedSpaceNotFound
	}
	account, ok := s.accounts[userID]
	if !ok || account.Status != "active" {
		return Member{}, ErrMemberNotFound
	}
	current, exists := s.grants[spaceID][userID]
	if !replace && exists {
		return Member{}, ErrMemberAlreadyExists
	}
	if replace && !exists {
		return Member{}, ErrMemberNotFound
	}
	if s.grants[spaceID] == nil {
		s.grants[spaceID] = map[string]memoryGrant{}
	}
	now := time.Now().UTC()
	createdAt := now
	if replace {
		createdAt = current.CreatedAt
	}
	grant := memoryGrant{Read: true, Write: containsAction(actions, ActionWrite), CreatedAt: createdAt, UpdatedAt: now}
	s.grants[spaceID][userID] = grant
	return memoryMember(userID, account, grant), nil
}

func (s *MemoryStore) RemoveMember(ctx context.Context, spaceID, userID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.grants[spaceID][userID]; !ok {
		return ErrMemberNotFound
	}
	delete(s.grants[spaceID], userID)
	return nil
}

func (s *MemoryStore) ListFiles(ctx context.Context, filter FileFilter) ([]File, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := []File{}
	for _, file := range s.files {
		if !s.grants[file.SpaceID][filter.UserID].Read || (filter.SpaceID != "" && file.SpaceID != filter.SpaceID) ||
			(filter.Query != "" && !containsAny(filter.Query, file.FileID, file.FileName)) ||
			(filter.LogicalPathPrefix != "" && !strings.HasPrefix(file.LogicalPath, filter.LogicalPathPrefix)) || !afterTimeCursor(file.UpdatedAt, file.FileID, filter.Cursor) {
			continue
		}
		file.SpaceName = s.spaces[file.SpaceID].Name
		items = append(items, file)
	}
	sort.Slice(items, func(i, j int) bool {
		return timeIDLess(items[i].UpdatedAt, items[i].FileID, items[j].UpdatedAt, items[j].FileID)
	})
	return take(items, filter.Limit), nil
}

func (s *MemoryStore) ListAdminFiles(ctx context.Context, filter FileFilter) ([]File, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := []File{}
	for _, file := range s.files {
		if (filter.SpaceID != "" && file.SpaceID != filter.SpaceID) ||
			(filter.Query != "" && !containsAny(filter.Query, file.FileID, file.FileName)) ||
			(filter.LogicalPathPrefix != "" && !strings.HasPrefix(file.LogicalPath, filter.LogicalPathPrefix)) || !afterTimeCursor(file.UpdatedAt, file.FileID, filter.Cursor) {
			continue
		}
		file.SpaceName = s.spaces[file.SpaceID].Name
		items = append(items, file)
	}
	sort.Slice(items, func(i, j int) bool {
		return timeIDLess(items[i].UpdatedAt, items[i].FileID, items[j].UpdatedAt, items[j].FileID)
	})
	return take(items, filter.Limit), nil
}

func (s *MemoryStore) CheckSpaceAccess(ctx context.Context, userID, spaceID, action string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	grant := s.grants[spaceID][userID]
	if _, ok := s.spaces[spaceID]; !ok || (action == ActionRead && !grant.Read) || (action == ActionWrite && !grant.Write) {
		return ErrSharedSpaceNotFound
	}
	return nil
}

func (s *MemoryStore) GetAuthorizedFile(ctx context.Context, userID, fileID, action string) (File, error) {
	if err := ctx.Err(); err != nil {
		return File{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	file, ok := s.files[fileID]
	grant := s.grants[file.SpaceID][userID]
	if !ok || (action == ActionRead && !grant.Read) || (action == ActionWrite && !grant.Write) {
		return File{}, ErrSharedFileNotFound
	}
	file.SpaceName = s.spaces[file.SpaceID].Name
	return file, nil
}

func (s *MemoryStore) GetAuthorizedFileByPath(ctx context.Context, userID, spaceID, logicalPath, action string) (File, error) {
	if err := ctx.Err(); err != nil {
		return File{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	grant := s.grants[spaceID][userID]
	if (action == ActionRead && !grant.Read) || (action == ActionWrite && !grant.Write) {
		return File{}, ErrSharedFileNotFound
	}
	for _, file := range s.files {
		if file.SpaceID == spaceID && file.LogicalPath == logicalPath {
			file.SpaceName = s.spaces[spaceID].Name
			return file, nil
		}
	}
	return File{}, ErrSharedFileNotFound
}

func (s *MemoryStore) GetAdminFile(ctx context.Context, fileID string) (File, error) {
	if err := ctx.Err(); err != nil {
		return File{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	file, ok := s.files[fileID]
	if !ok {
		return File{}, ErrSharedFileNotFound
	}
	file.SpaceName = s.spaces[file.SpaceID].Name
	return file, nil
}

func (s *MemoryStore) GetAdminFileByPath(ctx context.Context, spaceID, logicalPath string) (File, error) {
	if err := ctx.Err(); err != nil {
		return File{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, file := range s.files {
		if file.SpaceID == spaceID && file.LogicalPath == logicalPath {
			file.SpaceName = s.spaces[spaceID].Name
			return file, nil
		}
	}
	return File{}, ErrSharedFileNotFound
}

func (s *MemoryStore) CreateFileAuthorized(ctx context.Context, userID string, file File) (File, error) {
	if err := ctx.Err(); err != nil {
		return File{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.grants[file.SpaceID][userID].Write {
		return File{}, ErrSharedSpaceNotFound
	}
	return s.createFileLocked(file)
}

func (s *MemoryStore) CreateAdminFile(ctx context.Context, file File) (File, error) {
	if err := ctx.Err(); err != nil {
		return File{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.spaces[file.SpaceID]; !ok {
		return File{}, ErrSharedSpaceNotFound
	}
	return s.createFileLocked(file)
}

func (s *MemoryStore) createFileLocked(file File) (File, error) {
	for _, current := range s.files {
		if current.SpaceID == file.SpaceID && current.LogicalPath == file.LogicalPath {
			return File{}, ErrFileAlreadyExists
		}
	}
	file.Revision = 1
	file.UpdatedByUserID, file.UpdatedByAgentID, file.UpdatedAt = file.CreatedByUserID, file.CreatedByAgentID, file.CreatedAt
	s.files[file.FileID] = file
	return file, nil
}

func (s *MemoryStore) ReplaceFileAuthorized(ctx context.Context, userID string, file File, expectedRevision int64) (File, string, error) {
	if err := ctx.Err(); err != nil {
		return File{}, "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.grants[file.SpaceID][userID].Write {
		return File{}, "", ErrSharedSpaceNotFound
	}
	return s.replaceFileLocked(file, expectedRevision)
}

func (s *MemoryStore) ReplaceAdminFile(ctx context.Context, file File, expectedRevision int64) (File, string, error) {
	if err := ctx.Err(); err != nil {
		return File{}, "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.spaces[file.SpaceID]; !ok {
		return File{}, "", ErrSharedSpaceNotFound
	}
	return s.replaceFileLocked(file, expectedRevision)
}

func (s *MemoryStore) replaceFileLocked(file File, expectedRevision int64) (File, string, error) {
	for id, current := range s.files {
		if current.SpaceID != file.SpaceID || current.LogicalPath != file.LogicalPath {
			continue
		}
		if current.Revision != expectedRevision {
			return File{}, "", &RevisionConflictError{CurrentRevision: current.Revision}
		}
		oldKey := current.StorageKey
		file.FileID, file.Revision = current.FileID, current.Revision+1
		file.CreatedByUserID, file.CreatedByAgentID, file.CreatedAt = current.CreatedByUserID, current.CreatedByAgentID, current.CreatedAt
		s.files[id] = file
		return file, oldKey, nil
	}
	return File{}, "", ErrSharedFileNotFound
}

func (s *MemoryStore) summaryLocked(space Space) SpaceSummary {
	item := SpaceSummary{Space: space}
	for _, grant := range s.grants[space.SpaceID] {
		if grant.Read {
			item.MemberCount++
		}
	}
	for _, file := range s.files {
		if file.SpaceID == space.SpaceID {
			item.FileCount++
			item.SizeBytes += file.SizeBytes
		}
	}
	return item
}

func displayName(account memoryAccount) string {
	if strings.TrimSpace(account.Name) != "" {
		return account.Name
	}
	if account.Email != "" {
		return account.Email
	}
	return account.UserID
}

func memoryMember(userID string, account memoryAccount, grant memoryGrant) Member {
	actions := []string{ActionRead}
	status := "incomplete"
	if grant.Write {
		actions = append(actions, ActionWrite)
		status = "complete"
	}
	updatedAt := grant.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = grant.CreatedAt
	}
	return Member{
		UserID: userID, Name: displayName(account), Email: account.Email, AccountStatus: account.Status,
		GrantStatus: status, Actions: actions, JoinedAt: grant.CreatedAt, UpdatedAt: updatedAt,
	}
}

func containsAction(actions []string, target string) bool {
	for _, action := range actions {
		if action == target {
			return true
		}
	}
	return false
}

func containsAny(query string, values ...string) bool {
	query = strings.ToLower(query)
	for _, value := range values {
		if strings.Contains(strings.ToLower(value), query) {
			return true
		}
	}
	return false
}
func afterNameCursor(name, id string, cursor Cursor) bool {
	return cursor.ID == "" || name > cursor.Name || (name == cursor.Name && id > cursor.ID)
}
func afterTimeCursor(updated time.Time, id string, cursor Cursor) bool {
	return cursor.ID == "" || updated.Before(cursor.UpdatedAt) || (updated.Equal(cursor.UpdatedAt) && id > cursor.ID)
}
func timeIDLess(at time.Time, aid string, bt time.Time, bid string) bool {
	return at.After(bt) || (at.Equal(bt) && aid < bid)
}
func take[T any](items []T, limit int) []T {
	if len(items) > limit {
		return items[:limit]
	}
	return items
}
