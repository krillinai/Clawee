package mcpgateway

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"sort"
	"sync"
	"time"
)

const (
	ModelGroupStatusActive    = "active"
	ModelGroupStatusDisabled  = "disabled"
	ModelGroupRouteFailover   = "failover"
	ModelGroupRouteRoundRobin = "round_robin"
)

var (
	ErrModelGroupNotFound           = errors.New("model group not found")
	ErrModelGroupNotConfigured      = errors.New("no active model group configured")
	ErrModelUpstreamAccountNotFound = errors.New("model upstream account not found")
)

type ModelGroup struct {
	ID            string
	Name          string
	RouteStrategy string
	DefaultModel  string
	Status        string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type ModelUpstreamAccount struct {
	ID               string
	Name             string
	BaseURL          string
	APIKeyCiphertext []byte
	Models           []string
	SyncedModels     []string
	ManualModels     []string
	ModelSyncAt      *time.Time
	ModelSyncError   string
	Status           string
	HealthStatus     string
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

type ModelGroupAccount struct {
	UpstreamAccountID string
	Name              string
	BaseURL           string
	Models            []string
	Status            string
	HealthStatus      string
	Priority          int
	Weight            int
}

type ModelGroupConfig struct {
	ModelGroup
	Accounts []ModelGroupAccount
}

func MergeModelNames(values ...[]string) []string {
	seen := make(map[string]struct{})
	merged := make([]string, 0)
	for _, items := range values {
		for _, item := range items {
			if item == "" {
				continue
			}
			if _, ok := seen[item]; ok {
				continue
			}
			seen[item] = struct{}{}
			merged = append(merged, item)
		}
	}
	sort.Strings(merged)
	return merged
}

func NormalizeModelUpstreamAccount(account *ModelUpstreamAccount) {
	if account == nil {
		return
	}
	if len(account.SyncedModels) == 0 && len(account.ManualModels) == 0 && len(account.Models) != 0 {
		account.ManualModels = append([]string(nil), account.Models...)
	}
	account.Models = MergeModelNames(account.SyncedModels, account.ManualModels)
}

type ModelGroupStore interface {
	GetUserModelGroup(context.Context, string) (ModelGroup, error)
	EnsureUserModelGroup(context.Context, string, time.Time) (ModelGroup, error)
}

type ModelUpstreamStore interface {
	ModelGroupStore
	ListModelUpstreamAccounts(context.Context) ([]ModelUpstreamAccount, error)
	GetModelUpstreamAccount(context.Context, string) (ModelUpstreamAccount, error)
	SaveModelUpstreamAccount(context.Context, ModelUpstreamAccount) error
	DeleteModelUpstreamAccount(context.Context, string) error
	ListModelGroups(context.Context) ([]ModelGroupConfig, error)
	GetModelGroup(context.Context, string) (ModelGroupConfig, error)
	SaveModelGroup(context.Context, ModelGroupConfig) error
	DeleteModelGroup(context.Context, string) error
	SetModelGroupAccounts(context.Context, string, []ModelGroupAccount) error
}

type MemoryModelGroupStore struct {
	mu          sync.RWMutex
	groups      map[string]ModelGroup
	assignments map[string]string
	accounts    map[string]ModelUpstreamAccount
	members     map[string][]ModelGroupAccount
}

func NewMemoryModelGroupStore() *MemoryModelGroupStore {
	now := time.Now().UTC()
	return &MemoryModelGroupStore{
		groups: map[string]ModelGroup{
			"default": {
				ID: "default", Name: "默认模型组", RouteStrategy: ModelGroupRouteFailover,
				Status: ModelGroupStatusActive, CreatedAt: now, UpdatedAt: now,
			},
		},
		assignments: map[string]string{},
		accounts:    map[string]ModelUpstreamAccount{},
		members:     map[string][]ModelGroupAccount{},
	}
}

func (s *MemoryModelGroupStore) GetUserModelGroup(ctx context.Context, userID string) (ModelGroup, error) {
	if err := ctx.Err(); err != nil {
		return ModelGroup{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	groupID, ok := s.assignments[userID]
	if !ok {
		return ModelGroup{}, ErrModelGroupNotFound
	}
	group, ok := s.groups[groupID]
	if !ok {
		return ModelGroup{}, ErrModelGroupNotFound
	}
	return group, nil
}

func (s *MemoryModelGroupStore) EnsureUserModelGroup(ctx context.Context, userID string, now time.Time) (ModelGroup, error) {
	if err := ctx.Err(); err != nil {
		return ModelGroup{}, err
	}
	if userID == "" {
		return ModelGroup{}, errors.New("user id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if groupID, ok := s.assignments[userID]; ok {
		if group, exists := s.groups[groupID]; exists {
			return group, nil
		}
		delete(s.assignments, userID)
	}
	active := make([]ModelGroup, 0, len(s.groups))
	for _, group := range s.groups {
		if group.Status == ModelGroupStatusActive {
			active = append(active, group)
		}
	}
	if len(active) == 0 {
		return ModelGroup{}, ErrModelGroupNotConfigured
	}
	index := 0
	if len(active) > 1 {
		value, err := rand.Int(rand.Reader, big.NewInt(int64(len(active))))
		if err != nil {
			return ModelGroup{}, err
		}
		index = int(value.Int64())
	}
	group := active[index]
	s.assignments[userID] = group.ID
	return group, nil
}

func (s *MemoryModelGroupStore) ListModelUpstreamAccounts(ctx context.Context) ([]ModelUpstreamAccount, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]ModelUpstreamAccount, 0, len(s.accounts))
	for _, account := range s.accounts {
		items = append(items, cloneModelUpstreamAccount(account))
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	return items, nil
}

func (s *MemoryModelGroupStore) GetModelUpstreamAccount(ctx context.Context, id string) (ModelUpstreamAccount, error) {
	if err := ctx.Err(); err != nil {
		return ModelUpstreamAccount{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	account, ok := s.accounts[id]
	if !ok {
		return ModelUpstreamAccount{}, ErrModelUpstreamAccountNotFound
	}
	return cloneModelUpstreamAccount(account), nil
}

func (s *MemoryModelGroupStore) SaveModelUpstreamAccount(ctx context.Context, account ModelUpstreamAccount) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if account.ID == "" || account.Name == "" || account.BaseURL == "" {
		return errors.New("invalid model upstream account")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if account.Status == "" {
		account.Status = ModelGroupStatusActive
	}
	if account.HealthStatus == "" {
		account.HealthStatus = "unknown"
	}
	NormalizeModelUpstreamAccount(&account)
	s.accounts[account.ID] = cloneModelUpstreamAccount(account)
	return nil
}

func (s *MemoryModelGroupStore) DeleteModelUpstreamAccount(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.accounts[id]; !ok {
		return ErrModelUpstreamAccountNotFound
	}
	delete(s.accounts, id)
	for groupID, members := range s.members {
		filtered := members[:0]
		for _, member := range members {
			if member.UpstreamAccountID != id {
				filtered = append(filtered, member)
			}
		}
		s.members[groupID] = filtered
	}
	return nil
}

func (s *MemoryModelGroupStore) ListModelGroups(ctx context.Context) ([]ModelGroupConfig, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]ModelGroupConfig, 0, len(s.groups))
	for _, group := range s.groups {
		items = append(items, s.modelGroupConfigLocked(group))
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	return items, nil
}

func (s *MemoryModelGroupStore) GetModelGroup(ctx context.Context, id string) (ModelGroupConfig, error) {
	if err := ctx.Err(); err != nil {
		return ModelGroupConfig{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	group, ok := s.groups[id]
	if !ok {
		return ModelGroupConfig{}, ErrModelGroupNotFound
	}
	return s.modelGroupConfigLocked(group), nil
}

func (s *MemoryModelGroupStore) SaveModelGroup(ctx context.Context, config ModelGroupConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if config.ID == "" || config.Name == "" {
		return errors.New("invalid model group")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if config.Status == "" {
		config.Status = ModelGroupStatusActive
	}
	if config.RouteStrategy == "" {
		config.RouteStrategy = ModelGroupRouteFailover
	}
	s.groups[config.ID] = config.ModelGroup
	return s.setModelGroupAccountsLocked(config.ID, config.Accounts)
}

func (s *MemoryModelGroupStore) DeleteModelGroup(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.groups[id]; !ok {
		return ErrModelGroupNotFound
	}
	delete(s.groups, id)
	delete(s.members, id)
	for userID, groupID := range s.assignments {
		if groupID == id {
			delete(s.assignments, userID)
		}
	}
	return nil
}

func (s *MemoryModelGroupStore) SetModelGroupAccounts(ctx context.Context, groupID string, accounts []ModelGroupAccount) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.setModelGroupAccountsLocked(groupID, accounts)
}

func (s *MemoryModelGroupStore) setModelGroupAccountsLocked(groupID string, members []ModelGroupAccount) error {
	if _, ok := s.groups[groupID]; !ok {
		return ErrModelGroupNotFound
	}
	for _, member := range members {
		if _, ok := s.accounts[member.UpstreamAccountID]; !ok {
			return ErrModelUpstreamAccountNotFound
		}
	}
	cloned := make([]ModelGroupAccount, len(members))
	copy(cloned, members)
	s.members[groupID] = cloned
	return nil
}

func (s *MemoryModelGroupStore) modelGroupConfigLocked(group ModelGroup) ModelGroupConfig {
	members := append([]ModelGroupAccount(nil), s.members[group.ID]...)
	for index := range members {
		if account, ok := s.accounts[members[index].UpstreamAccountID]; ok {
			members[index].Name = account.Name
			members[index].BaseURL = account.BaseURL
			members[index].Models = MergeModelNames(account.SyncedModels, account.ManualModels, account.Models)
			members[index].Status = account.Status
			members[index].HealthStatus = account.HealthStatus
		}
	}
	return ModelGroupConfig{ModelGroup: group, Accounts: members}
}

func cloneModelUpstreamAccount(account ModelUpstreamAccount) ModelUpstreamAccount {
	account.APIKeyCiphertext = append([]byte(nil), account.APIKeyCiphertext...)
	account.Models = append([]string(nil), account.Models...)
	account.SyncedModels = append([]string(nil), account.SyncedModels...)
	account.ManualModels = append([]string(nil), account.ManualModels...)
	if account.ModelSyncAt != nil {
		value := *account.ModelSyncAt
		account.ModelSyncAt = &value
	}
	return account
}
