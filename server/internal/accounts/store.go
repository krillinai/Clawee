package accounts

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"
)

var (
	ErrAccountNotFound                  = errors.New("account not found")
	ErrSessionNotFound                  = errors.New("account session not found")
	ErrEmailExists                      = errors.New("account email already exists")
	ErrAccountAgentExists               = errors.New("agent already belongs to another account")
	ErrAccountNotActive                 = errors.New("account is not active")
	ErrAccountIdentityNotFound          = errors.New("account identity not found")
	ErrAccountIdentityExists            = errors.New("account identity already exists")
	ErrAccountIdentityUserConflict      = errors.New("account already has an identity for this provider")
	ErrLocalPasswordRequired            = errors.New("local password is required")
	ErrOAuthLoginStateNotFound          = errors.New("oauth login state not found")
	ErrOAuthAuthorizationCodeNotFound   = errors.New("oauth authorization code not found")
	ErrExternalAccountConflict          = errors.New("external account conflicts with an existing account")
	ErrExternalAccountProvisionDisabled = errors.New("external account provisioning is disabled")
	ErrSystemNotInitialized             = errors.New("system is not initialized")
)

type Store interface {
	WithBootstrapLock(context.Context, func(context.Context) error) error
	SaveAccount(context.Context, Account) error
	DeleteAccount(context.Context, string) error
	GetAccount(context.Context, string) (Account, error)
	GetAccountByEmail(context.Context, string) (Account, error)
	ListAccounts(context.Context) ([]Account, error)
	CountAccounts(context.Context) (int, error)
	SaveSession(context.Context, Session) error
	GetSessionByHash(context.Context, string) (Session, error)
	DeleteSession(context.Context, string) error
	DeleteSessionsForUser(context.Context, string) error
	SaveAccountAgent(context.Context, AccountAgent) error
	ListAccountAgents(context.Context, string) ([]AccountAgent, error)
	GetAccountForAgent(context.Context, string) (Account, error)
	GetAccountIdentity(context.Context, string, string, string) (AccountIdentity, error)
	GetAccountIdentityForUser(context.Context, string, string, string) (AccountIdentity, error)
	InsertAccountIdentity(context.Context, AccountIdentity) error
	UpdateAccountIdentityVerification(context.Context, AccountIdentity) error
	DeleteAccountIdentity(context.Context, string, string, string) error
	SaveOAuthLoginState(context.Context, OAuthLoginState) error
	ConsumeOAuthLoginState(context.Context, string, time.Time) (OAuthLoginState, error)
	DeleteExpiredOAuthLoginStates(context.Context, time.Time) error
	SaveOAuthAuthorizationCode(context.Context, OAuthAuthorizationCode) error
	ConsumeOAuthAuthorizationCode(context.Context, OAuthAuthorizationCodeConsumeRequest) (OAuthAuthorizationCode, error)
	DeleteExpiredOAuthAuthorizationCodes(context.Context, time.Time) error
	WithExternalIdentityLock(context.Context, string, string, string, func(context.Context) error) error
}

type MemoryStore struct {
	mu                 sync.RWMutex
	bootstrapMu        sync.Mutex
	externalIdentityMu sync.Mutex
	accounts           map[string]Account
	emailToUserID      map[string]string
	sessions           map[string]Session
	accountAgents      map[string][]AccountAgent
	identities         map[string]AccountIdentity
	oauthStates        map[string]OAuthLoginState
	oauthCodes         map[string]OAuthAuthorizationCode
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		accounts:      map[string]Account{},
		emailToUserID: map[string]string{},
		sessions:      map[string]Session{},
		accountAgents: map[string][]AccountAgent{},
		identities:    map[string]AccountIdentity{},
		oauthStates:   map[string]OAuthLoginState{},
		oauthCodes:    map[string]OAuthAuthorizationCode{},
	}
}

func (s *MemoryStore) WithExternalIdentityLock(ctx context.Context, _, _, _ string, fn func(context.Context) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.externalIdentityMu.Lock()
	defer s.externalIdentityMu.Unlock()
	return fn(ctx)
}

func (s *MemoryStore) WithBootstrapLock(ctx context.Context, fn func(context.Context) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.bootstrapMu.Lock()
	defer s.bootstrapMu.Unlock()
	return fn(ctx)
}

func (s *MemoryStore) SaveAccount(ctx context.Context, account Account) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if existingUserID, ok := s.emailToUserID[account.Email]; ok && existingUserID != account.UserID {
		return ErrEmailExists
	}
	if existing, ok := s.accounts[account.UserID]; ok && existing.Email != account.Email {
		delete(s.emailToUserID, existing.Email)
	}
	s.accounts[account.UserID] = account
	s.emailToUserID[account.Email] = account.UserID
	return nil
}

func (s *MemoryStore) DeleteAccount(ctx context.Context, userID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	account, ok := s.accounts[userID]
	if !ok {
		return ErrAccountNotFound
	}
	delete(s.accounts, userID)
	delete(s.emailToUserID, account.Email)
	for sessionID, session := range s.sessions {
		if session.UserID == userID {
			delete(s.sessions, sessionID)
		}
	}
	delete(s.accountAgents, userID)
	for key, identity := range s.identities {
		if identity.UserID == userID {
			delete(s.identities, key)
		}
	}
	for key, state := range s.oauthStates {
		if state.BindUserID == userID {
			delete(s.oauthStates, key)
		}
	}
	for key, code := range s.oauthCodes {
		if code.UserID == userID {
			delete(s.oauthCodes, key)
		}
	}
	return nil
}

func (s *MemoryStore) GetAccount(ctx context.Context, userID string) (Account, error) {
	if err := ctx.Err(); err != nil {
		return Account{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	account, ok := s.accounts[userID]
	if !ok {
		return Account{}, ErrAccountNotFound
	}
	return account, nil
}

func (s *MemoryStore) GetAccountByEmail(ctx context.Context, email string) (Account, error) {
	if err := ctx.Err(); err != nil {
		return Account{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	userID, ok := s.emailToUserID[email]
	if !ok {
		return Account{}, ErrAccountNotFound
	}
	return s.accounts[userID], nil
}

func (s *MemoryStore) ListAccounts(ctx context.Context) ([]Account, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Account, 0, len(s.accounts))
	for _, account := range s.accounts {
		out = append(out, account)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

func (s *MemoryStore) CountAccounts(ctx context.Context) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.accounts), nil
}

func (s *MemoryStore) SaveSession(ctx context.Context, session Session) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[session.SessionID] = session
	return nil
}

func (s *MemoryStore) GetSessionByHash(ctx context.Context, tokenHash string) (Session, error) {
	if err := ctx.Err(); err != nil {
		return Session{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, session := range s.sessions {
		if session.TokenHash == tokenHash {
			return session, nil
		}
	}
	return Session{}, ErrSessionNotFound
}

func (s *MemoryStore) DeleteSession(ctx context.Context, sessionID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, sessionID)
	return nil
}

func (s *MemoryStore) DeleteSessionsForUser(ctx context.Context, userID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for sessionID, session := range s.sessions {
		if session.UserID == userID {
			delete(s.sessions, sessionID)
		}
	}
	return nil
}

func (s *MemoryStore) SaveAccountAgent(ctx context.Context, item AccountAgent) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveAccountAgentLocked(item)
}

func (s *MemoryStore) SaveActiveAccountAgent(ctx context.Context, item AccountAgent) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	account, ok := s.accounts[item.UserID]
	if !ok {
		return ErrAccountNotFound
	}
	if account.Status != StatusActive {
		return ErrAccountNotActive
	}
	return s.saveAccountAgentLocked(item)
}

func (s *MemoryStore) DeleteAccountAgent(ctx context.Context, agentID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for userID, items := range s.accountAgents {
		filtered := items[:0]
		for _, item := range items {
			if item.AgentID != agentID {
				filtered = append(filtered, item)
			}
		}
		if len(filtered) == 0 {
			delete(s.accountAgents, userID)
		} else {
			s.accountAgents[userID] = filtered
		}
	}
	for sessionID, session := range s.sessions {
		if session.AgentID == agentID {
			delete(s.sessions, sessionID)
		}
	}
	return nil
}

func (s *MemoryStore) saveAccountAgentLocked(item AccountAgent) error {
	for userID, items := range s.accountAgents {
		for _, existing := range items {
			if existing.AgentID != item.AgentID {
				continue
			}
			if userID == item.UserID {
				return nil
			}
			return ErrAccountAgentExists
		}
	}
	s.accountAgents[item.UserID] = append(s.accountAgents[item.UserID], item)
	return nil
}

func (s *MemoryStore) GetAccountForAgent(ctx context.Context, agentID string) (Account, error) {
	if err := ctx.Err(); err != nil {
		return Account{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for userID, items := range s.accountAgents {
		for _, item := range items {
			if item.AgentID == agentID {
				return s.accounts[userID], nil
			}
		}
	}
	return Account{}, ErrAccountAgentNotFound
}

func (s *MemoryStore) ListAccountAgents(ctx context.Context, userID string) ([]AccountAgent, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := s.accountAgents[userID]
	out := make([]AccountAgent, len(items))
	copy(out, items)
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].AgentID < out[j].AgentID
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out, nil
}

func identityKey(providerType, providerKey, providerSubject string) string {
	return providerType + "\x00" + providerKey + "\x00" + providerSubject
}

func (s *MemoryStore) GetAccountIdentity(ctx context.Context, providerType, providerKey, providerSubject string) (AccountIdentity, error) {
	if err := ctx.Err(); err != nil {
		return AccountIdentity{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	identity, ok := s.identities[identityKey(providerType, providerKey, providerSubject)]
	if !ok {
		return AccountIdentity{}, ErrAccountIdentityNotFound
	}
	return identity, nil
}

func (s *MemoryStore) GetAccountIdentityForUser(ctx context.Context, userID, providerType, providerKey string) (AccountIdentity, error) {
	if err := ctx.Err(); err != nil {
		return AccountIdentity{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, identity := range s.identities {
		if identity.UserID == userID && identity.ProviderType == providerType && identity.ProviderKey == providerKey {
			return identity, nil
		}
	}
	return AccountIdentity{}, ErrAccountIdentityNotFound
}

func (s *MemoryStore) InsertAccountIdentity(ctx context.Context, identity AccountIdentity) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := identityKey(identity.ProviderType, identity.ProviderKey, identity.ProviderSubject)
	if _, ok := s.identities[key]; ok {
		return ErrAccountIdentityExists
	}
	for _, existing := range s.identities {
		if existing.UserID == identity.UserID && existing.ProviderType == identity.ProviderType && existing.ProviderKey == identity.ProviderKey {
			return ErrAccountIdentityUserConflict
		}
	}
	s.identities[key] = identity
	return nil
}

func (s *MemoryStore) UpdateAccountIdentityVerification(ctx context.Context, identity AccountIdentity) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := identityKey(identity.ProviderType, identity.ProviderKey, identity.ProviderSubject)
	existing, ok := s.identities[key]
	if !ok {
		return ErrAccountIdentityNotFound
	}
	existing.ExternalUserID = identity.ExternalUserID
	existing.VerifiedAt = identity.VerifiedAt
	existing.UpdatedAt = identity.UpdatedAt
	s.identities[key] = existing
	return nil
}

func (s *MemoryStore) DeleteAccountIdentity(ctx context.Context, userID, providerType, providerKey string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, identity := range s.identities {
		if identity.UserID == userID && identity.ProviderType == providerType && identity.ProviderKey == providerKey {
			delete(s.identities, key)
			return nil
		}
	}
	return ErrAccountIdentityNotFound
}

func (s *MemoryStore) SaveOAuthLoginState(ctx context.Context, state OAuthLoginState) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.oauthStates[state.StateHash] = state
	return nil
}

func (s *MemoryStore) ConsumeOAuthLoginState(ctx context.Context, stateHash string, now time.Time) (OAuthLoginState, error) {
	if err := ctx.Err(); err != nil {
		return OAuthLoginState{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, ok := s.oauthStates[stateHash]
	if !ok || !state.ExpiresAt.After(now) {
		return OAuthLoginState{}, ErrOAuthLoginStateNotFound
	}
	delete(s.oauthStates, stateHash)
	return state, nil
}

func (s *MemoryStore) DeleteExpiredOAuthLoginStates(ctx context.Context, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, state := range s.oauthStates {
		if !state.ExpiresAt.After(now) {
			delete(s.oauthStates, key)
		}
	}
	return nil
}

func (s *MemoryStore) SaveOAuthAuthorizationCode(ctx context.Context, code OAuthAuthorizationCode) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.oauthCodes[code.CodeHash] = code
	return nil
}

func (s *MemoryStore) ConsumeOAuthAuthorizationCode(ctx context.Context, req OAuthAuthorizationCodeConsumeRequest) (OAuthAuthorizationCode, error) {
	if err := ctx.Err(); err != nil {
		return OAuthAuthorizationCode{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	code, ok := s.oauthCodes[req.CodeHash]
	if !ok || code.AgentID != req.AgentID || code.RedirectURI != req.RedirectURI ||
		code.PKCEChallenge != req.PKCEChallenge || !code.ExpiresAt.After(req.Now) {
		return OAuthAuthorizationCode{}, ErrOAuthAuthorizationCodeNotFound
	}
	delete(s.oauthCodes, req.CodeHash)
	return code, nil
}

func (s *MemoryStore) DeleteExpiredOAuthAuthorizationCodes(ctx context.Context, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, code := range s.oauthCodes {
		if !code.ExpiresAt.After(now) {
			delete(s.oauthCodes, key)
		}
	}
	return nil
}
