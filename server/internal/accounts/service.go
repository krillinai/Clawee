package accounts

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	defaultSessionDuration = 24 * time.Hour
	sessionRollbackTimeout = 5 * time.Second
)

var (
	ErrInvalidCredentials    = errors.New("invalid credentials")
	ErrInvalidAccountRequest = errors.New("invalid account request")
	ErrAccountUserIDRequired = errors.New("account user id is required")
	ErrAccountNameRequired   = errors.New("account name is required")
	ErrInvalidSession        = errors.New("invalid account session")
	ErrPasswordTooShort      = errors.New("password must be at least 8 characters")
	ErrAccountAgentNotFound  = errors.New("account agent binding not found")
)

type Config struct {
	Store           Store
	Clock           func() time.Time
	SessionDuration time.Duration
	JWTSigningKey   []byte
}

type Service struct {
	store           Store
	clock           func() time.Time
	sessionDuration time.Duration
	jwtSigningKey   []byte
}

type CreateAccountRequest struct {
	Email    string
	Name     string
	Password string
	Status   string
}

func NewService(cfg Config) *Service {
	store := cfg.Store
	if store == nil {
		store = NewMemoryStore()
	}
	clock := cfg.Clock
	if clock == nil {
		clock = time.Now
	}
	sessionDuration := cfg.SessionDuration
	if sessionDuration == 0 {
		sessionDuration = defaultSessionDuration
	}
	return &Service{
		store:           store,
		clock:           clock,
		sessionDuration: sessionDuration,
		jwtSigningKey:   append([]byte(nil), cfg.JWTSigningKey...),
	}
}

func (s *Service) Register(ctx context.Context, req RegisterRequest) (RegistrationResult, error) {
	email := normalizeEmail(req.Email)
	name := normalizeAccountName(req.Name)
	if email == "" || name == "" {
		return RegistrationResult{}, ErrInvalidAccountRequest
	}
	if len(req.Password) < 8 {
		return RegistrationResult{}, ErrPasswordTooShort
	}
	passwordHash, err := HashPassword(req.Password)
	if err != nil {
		return RegistrationResult{}, err
	}

	var result RegistrationResult
	err = s.store.WithBootstrapLock(ctx, func(ctx context.Context) error {
		count, err := s.store.CountAccounts(ctx)
		if err != nil {
			return err
		}
		now := s.clock()
		account := Account{
			UserID:       generateID("usr"),
			Email:        email,
			Name:         name,
			PasswordHash: passwordHash,
			Status:       StatusActive,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := s.store.SaveAccount(ctx, account); err != nil {
			return err
		}
		result = RegistrationResult{Account: account, NeedsAdminBootstrap: count == 0}
		return nil
	})
	if err != nil {
		return RegistrationResult{}, err
	}
	return result, nil
}

func (s *Service) AuthenticateCredentials(ctx context.Context, req LoginRequest) (Account, error) {
	email := normalizeEmail(req.Email)
	if email == "" {
		return Account{}, ErrInvalidCredentials
	}
	account, err := s.store.GetAccountByEmail(ctx, email)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return Account{}, ErrInvalidCredentials
		}
		return Account{}, err
	}
	if account.Status != StatusActive {
		return Account{}, ErrInvalidCredentials
	}
	if account.PasswordHash == "" {
		return Account{}, ErrInvalidCredentials
	}
	if !CheckPassword(account.PasswordHash, req.Password) {
		return Account{}, ErrInvalidCredentials
	}
	return account, nil
}

func (s *Service) ResolveExternalIdentity(ctx context.Context, identity AccountIdentity) (Account, error) {
	identity = normalizeIdentity(identity)
	if !validIdentity(identity) {
		return Account{}, ErrInvalidAccountRequest
	}
	var account Account
	err := s.store.WithExternalIdentityLock(ctx, identity.ProviderType, identity.ProviderKey, identity.ProviderSubject, func(ctx context.Context) error {
		existing, err := s.store.GetAccountIdentity(ctx, identity.ProviderType, identity.ProviderKey, identity.ProviderSubject)
		if err != nil {
			return err
		}
		account, err = s.store.GetAccount(ctx, existing.UserID)
		if err != nil {
			return err
		}
		if account.Status != StatusActive {
			return ErrAccountNotActive
		}
		identity.UpdatedAt = s.clock().UTC()
		return s.store.UpdateAccountIdentityVerification(ctx, identity)
	})
	return account, err
}

func (s *Service) ProvisionExternalAccount(ctx context.Context, identity AccountIdentity, req ExternalAccountRequest, autoProvision, hasActiveAdmin bool) (Account, error) {
	account, _, err := s.ProvisionExternalAccountWithCreated(ctx, identity, req, autoProvision, hasActiveAdmin)
	return account, err
}

func (s *Service) ProvisionExternalAccountWithCreated(ctx context.Context, identity AccountIdentity, req ExternalAccountRequest, autoProvision, hasActiveAdmin bool) (Account, bool, error) {
	identity = normalizeIdentity(identity)
	email := normalizeEmail(req.Email)
	name := normalizeAccountName(req.Name)
	if !validIdentity(identity) {
		return Account{}, false, ErrInvalidAccountRequest
	}
	var account Account
	created := false
	err := s.store.WithExternalIdentityLock(ctx, identity.ProviderType, identity.ProviderKey, identity.ProviderSubject, func(ctx context.Context) error {
		existing, err := s.store.GetAccountIdentity(ctx, identity.ProviderType, identity.ProviderKey, identity.ProviderSubject)
		if err == nil {
			account, err = s.store.GetAccount(ctx, existing.UserID)
			if err != nil {
				return err
			}
			if account.Status != StatusActive {
				return ErrAccountNotActive
			}
			identity.UpdatedAt = s.clock().UTC()
			return s.store.UpdateAccountIdentityVerification(ctx, identity)
		}
		if !errors.Is(err, ErrAccountIdentityNotFound) {
			return err
		}
		if email == "" {
			return ErrInvalidAccountRequest
		}
		if _, err := s.store.GetAccountByEmail(ctx, email); err == nil {
			return ErrExternalAccountConflict
		} else if !errors.Is(err, ErrAccountNotFound) {
			return err
		}
		if !autoProvision {
			return ErrExternalAccountProvisionDisabled
		}
		if !hasActiveAdmin {
			return ErrSystemNotInitialized
		}
		if name == "" {
			name = email
		}
		now := s.clock().UTC()
		account = Account{
			UserID: generateID("usr"), Email: email, Name: name, PasswordHash: "", Status: StatusActive,
			CreatedAt: now, UpdatedAt: now,
		}
		if err := s.store.SaveAccount(ctx, account); err != nil {
			if errors.Is(err, ErrEmailExists) {
				return ErrExternalAccountConflict
			}
			return err
		}
		identity.UserID = account.UserID
		identity.CreatedAt = now
		identity.UpdatedAt = now
		if err := s.store.InsertAccountIdentity(ctx, identity); err != nil {
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), sessionRollbackTimeout)
			defer cancel()
			return errors.Join(err, s.store.DeleteAccount(cleanupCtx, account.UserID))
		}
		created = true
		return nil
	})
	return account, created, err
}

func (s *Service) BindExternalIdentity(ctx context.Context, userID string, identity AccountIdentity) error {
	userID = strings.TrimSpace(userID)
	identity = normalizeIdentity(identity)
	if userID == "" || !validIdentity(identity) {
		return ErrInvalidAccountRequest
	}
	return s.store.WithExternalIdentityLock(ctx, identity.ProviderType, identity.ProviderKey, identity.ProviderSubject, func(ctx context.Context) error {
		account, err := s.store.GetAccount(ctx, userID)
		if err != nil {
			return err
		}
		if account.Status != StatusActive {
			return ErrAccountNotActive
		}
		if _, err := s.store.GetAccountIdentity(ctx, identity.ProviderType, identity.ProviderKey, identity.ProviderSubject); err == nil {
			return ErrAccountIdentityExists
		} else if !errors.Is(err, ErrAccountIdentityNotFound) {
			return err
		}
		if _, err := s.store.GetAccountIdentityForUser(ctx, userID, identity.ProviderType, identity.ProviderKey); err == nil {
			return ErrAccountIdentityUserConflict
		} else if !errors.Is(err, ErrAccountIdentityNotFound) {
			return err
		}
		now := s.clock().UTC()
		identity.UserID = userID
		identity.CreatedAt = now
		identity.UpdatedAt = now
		return s.store.InsertAccountIdentity(ctx, identity)
	})
}

func (s *Service) AccountIdentityForUser(ctx context.Context, userID, providerType, providerKey string) (AccountIdentity, error) {
	return s.store.GetAccountIdentityForUser(ctx, strings.TrimSpace(userID), strings.TrimSpace(providerType), strings.TrimSpace(providerKey))
}

func (s *Service) UnbindExternalIdentity(ctx context.Context, userID, providerType, providerKey, password string) (AccountIdentity, error) {
	userID = strings.TrimSpace(userID)
	providerType = strings.TrimSpace(providerType)
	providerKey = strings.TrimSpace(providerKey)
	if userID == "" || providerType == "" || providerKey == "" {
		return AccountIdentity{}, ErrInvalidAccountRequest
	}
	identity, err := s.store.GetAccountIdentityForUser(ctx, userID, providerType, providerKey)
	if err != nil {
		return AccountIdentity{}, err
	}
	err = s.store.WithExternalIdentityLock(ctx, identity.ProviderType, identity.ProviderKey, identity.ProviderSubject, func(ctx context.Context) error {
		current, err := s.store.GetAccountIdentityForUser(ctx, userID, providerType, providerKey)
		if err != nil {
			return err
		}
		if current.ProviderSubject != identity.ProviderSubject {
			return ErrAccountIdentityNotFound
		}
		account, err := s.store.GetAccount(ctx, userID)
		if err != nil {
			return err
		}
		if account.Status != StatusActive {
			return ErrAccountNotActive
		}
		if account.PasswordHash == "" {
			return ErrLocalPasswordRequired
		}
		if !CheckPassword(account.PasswordHash, password) {
			return ErrInvalidCredentials
		}
		return s.store.DeleteAccountIdentity(ctx, userID, providerType, providerKey)
	})
	if err != nil {
		return AccountIdentity{}, err
	}
	return identity, nil
}

func (s *Service) SaveOAuthLoginState(ctx context.Context, state OAuthLoginState) error {
	return s.store.SaveOAuthLoginState(ctx, state)
}

func (s *Service) ConsumeOAuthLoginState(ctx context.Context, stateHash string, now time.Time) (OAuthLoginState, error) {
	return s.store.ConsumeOAuthLoginState(ctx, stateHash, now)
}

func (s *Service) DeleteExpiredOAuthLoginStates(ctx context.Context, now time.Time) error {
	return s.store.DeleteExpiredOAuthLoginStates(ctx, now)
}

func (s *Service) SaveOAuthAuthorizationCode(ctx context.Context, code OAuthAuthorizationCode) error {
	return s.store.SaveOAuthAuthorizationCode(ctx, code)
}

func (s *Service) ConsumeOAuthAuthorizationCode(ctx context.Context, req OAuthAuthorizationCodeConsumeRequest) (OAuthAuthorizationCode, error) {
	return s.store.ConsumeOAuthAuthorizationCode(ctx, req)
}

func (s *Service) DeleteExpiredOAuthAuthorizationCodes(ctx context.Context, now time.Time) error {
	return s.store.DeleteExpiredOAuthAuthorizationCodes(ctx, now)
}

func normalizeIdentity(identity AccountIdentity) AccountIdentity {
	identity.ProviderType = strings.TrimSpace(identity.ProviderType)
	identity.ProviderKey = strings.TrimSpace(identity.ProviderKey)
	identity.ProviderSubject = strings.TrimSpace(identity.ProviderSubject)
	identity.ExternalUserID = strings.TrimSpace(identity.ExternalUserID)
	return identity
}

func validIdentity(identity AccountIdentity) bool {
	return identity.ProviderType != "" && identity.ProviderKey != "" && identity.ProviderSubject != "" && identity.ExternalUserID != "" && !identity.VerifiedAt.IsZero()
}

func (s *Service) IssueTokens(ctx context.Context, account Account, requests []TokenRequest) (TokenBatch, error) {
	if account.UserID == "" || account.Status != StatusActive || len(s.jwtSigningKey) < 32 || len(requests) == 0 || s.sessionDuration < time.Second || s.sessionDuration%time.Second != 0 {
		return TokenBatch{}, ErrInvalidAccountRequest
	}
	seen := make(map[string]struct{}, len(requests))
	for _, request := range requests {
		if !validTokenRequest(request) {
			return TokenBatch{}, ErrInvalidAccountRequest
		}
		if _, exists := seen[request.Audience]; exists {
			return TokenBatch{}, ErrInvalidAccountRequest
		}
		seen[request.Audience] = struct{}{}
	}

	issuedAt := s.clock().UTC().Truncate(time.Second)
	expiresAt := issuedAt.Add(s.sessionDuration)
	result := TokenBatch{Tokens: make(map[string]IssuedToken, len(requests))}
	createdSessionIDs := make([]string, 0, len(requests))
	for _, request := range requests {
		sessionID := generateID("sess")
		claims := JWTClaims{
			ClientID: request.ClientID,
			AgentID:  request.AgentID,
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer: JWTIssuer, Subject: account.UserID, Audience: jwt.ClaimStrings{request.Audience}, ID: sessionID,
				IssuedAt: jwt.NewNumericDate(issuedAt), ExpiresAt: jwt.NewNumericDate(expiresAt),
			},
		}
		plaintext, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSigningKey)
		if err != nil {
			return TokenBatch{}, errors.Join(err, s.rollbackSessions(ctx, createdSessionIDs))
		}
		session := Session{
			SessionID: sessionID, UserID: account.UserID, AgentID: request.AgentID, TokenHash: hashSessionToken(plaintext),
			ExpiresAt: expiresAt, CreatedAt: issuedAt,
		}
		if err := s.store.SaveSession(ctx, session); err != nil {
			return TokenBatch{}, errors.Join(err, s.rollbackSessions(ctx, createdSessionIDs))
		}
		createdSessionIDs = append(createdSessionIDs, sessionID)
		result.Tokens[request.Audience] = IssuedToken{
			Token: plaintext, Session: session,
		}
	}
	return result, nil
}

func (s *Service) AuthenticateToken(ctx context.Context, plaintext, expectedAudience string) (AuthenticatedIdentity, error) {
	if len(s.jwtSigningKey) < 32 || (expectedAudience != AudienceFrontend && expectedAudience != AudienceAdmin) {
		return AuthenticatedIdentity{}, ErrInvalidSession
	}
	claims := new(JWTClaims)
	token, err := jwt.ParseWithClaims(plaintext, claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidSession
		}
		return s.jwtSigningKey, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithIssuer(JWTIssuer), jwt.WithAudience(expectedAudience), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithTimeFunc(s.clock))
	if err != nil || !token.Valid || claims.Subject == "" || claims.ID == "" || claims.IssuedAt == nil || len(claims.Audience) != 1 || claims.Audience[0] != expectedAudience || !validClientForAudience(claims.ClientID, expectedAudience) {
		return AuthenticatedIdentity{}, ErrInvalidSession
	}
	session, err := s.store.GetSessionByHash(ctx, hashSessionToken(plaintext))
	if err != nil {
		if errors.Is(err, ErrSessionNotFound) {
			return AuthenticatedIdentity{}, ErrInvalidSession
		}
		return AuthenticatedIdentity{}, err
	}
	if session.SessionID != claims.ID || session.UserID != claims.Subject || session.AgentID != claims.AgentID ||
		!validAgentForClient(claims.ClientID, claims.AgentID) || !session.ExpiresAt.Equal(claims.ExpiresAt.Time) || !session.ExpiresAt.After(s.clock()) {
		return AuthenticatedIdentity{}, ErrInvalidSession
	}
	account, err := s.store.GetAccount(ctx, claims.Subject)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return AuthenticatedIdentity{}, ErrInvalidSession
		}
		return AuthenticatedIdentity{}, err
	}
	if account.Status != StatusActive {
		return AuthenticatedIdentity{}, ErrInvalidSession
	}
	return AuthenticatedIdentity{
		Account: account, Session: session,
		Principal: Principal{UserID: claims.Subject, AgentID: claims.AgentID, SessionID: claims.ID, Audience: expectedAudience, ClientID: claims.ClientID},
	}, nil
}

func (s *Service) RevokeToken(ctx context.Context, plaintext, expectedAudience string) error {
	identity, err := s.AuthenticateToken(ctx, plaintext, expectedAudience)
	if err != nil {
		if errors.Is(err, ErrInvalidSession) {
			return nil
		}
		return err
	}
	return s.store.DeleteSession(ctx, identity.Session.SessionID)
}

func (s *Service) ListAccounts(ctx context.Context) ([]Account, error) {
	return s.store.ListAccounts(ctx)
}

func (s *Service) Account(ctx context.Context, userID string) (Account, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return Account{}, ErrInvalidAccountRequest
	}
	return s.store.GetAccount(ctx, userID)
}

func (s *Service) CreateAccount(ctx context.Context, req CreateAccountRequest) (Account, error) {
	email := normalizeEmail(req.Email)
	name := normalizeAccountName(req.Name)
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = StatusActive
	}
	if email == "" || name == "" || !validStatus(status) {
		return Account{}, ErrInvalidAccountRequest
	}
	if len(req.Password) < 8 {
		return Account{}, ErrPasswordTooShort
	}
	passwordHash, err := HashPassword(req.Password)
	if err != nil {
		return Account{}, err
	}

	now := s.clock()
	account := Account{
		UserID:       generateID("usr"),
		Email:        email,
		Name:         name,
		PasswordHash: passwordHash,
		Status:       status,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := s.store.WithBootstrapLock(ctx, func(ctx context.Context) error {
		return s.store.SaveAccount(ctx, account)
	}); err != nil {
		return Account{}, err
	}
	return account, nil
}

func normalizeAccountName(value string) string {
	return strings.TrimSpace(value)
}

func (s *Service) UpdateAccountName(ctx context.Context, userID, name string) (Account, error) {
	userID = strings.TrimSpace(userID)
	name = normalizeAccountName(name)
	if userID == "" {
		return Account{}, ErrAccountUserIDRequired
	}
	if name == "" {
		return Account{}, ErrAccountNameRequired
	}

	var account Account
	err := s.store.WithBootstrapLock(ctx, func(ctx context.Context) error {
		var err error
		account, err = s.store.GetAccount(ctx, userID)
		if err != nil {
			return err
		}
		account.Name = name
		account.UpdatedAt = s.clock()
		return s.store.SaveAccount(ctx, account)
	})
	if err != nil {
		return Account{}, err
	}
	return account, nil
}

func (s *Service) UpdateAccountStatus(ctx context.Context, userID, status string) (Account, error) {
	return s.updateAccountStatus(ctx, userID, status, nil)
}

func (s *Service) UpdateAccountStatusWithValidation(ctx context.Context, userID, status string, validate func(context.Context) error) (Account, error) {
	return s.updateAccountStatus(ctx, userID, status, validate)
}

func (s *Service) updateAccountStatus(ctx context.Context, userID, status string, validate func(context.Context) error) (Account, error) {
	if !validStatus(status) {
		return Account{}, ErrInvalidAccountRequest
	}

	var account Account
	err := s.store.WithBootstrapLock(ctx, func(ctx context.Context) error {
		var err error
		account, err = s.store.GetAccount(ctx, userID)
		if err != nil {
			return err
		}
		if validate != nil {
			if err := validate(ctx); err != nil {
				return err
			}
		}
		account.Status = status
		account.UpdatedAt = s.clock()
		return s.store.SaveAccount(ctx, account)
	})
	if err != nil {
		return Account{}, err
	}
	return account, nil
}

func (s *Service) ResetAccountPassword(ctx context.Context, userID, password string) (Account, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return Account{}, ErrInvalidAccountRequest
	}
	if len(password) < 8 {
		return Account{}, ErrPasswordTooShort
	}
	passwordHash, err := HashPassword(password)
	if err != nil {
		return Account{}, err
	}

	var account Account
	err = s.store.WithBootstrapLock(ctx, func(ctx context.Context) error {
		var err error
		account, err = s.store.GetAccount(ctx, userID)
		if err != nil {
			return err
		}
		account.PasswordHash = passwordHash
		account.UpdatedAt = s.clock()
		if err := s.store.SaveAccount(ctx, account); err != nil {
			return err
		}
		return s.store.DeleteSessionsForUser(ctx, userID)
	})
	if err != nil {
		return Account{}, err
	}
	return account, nil
}

func (s *Service) BindAgent(ctx context.Context, userID, agentID string) error {
	userID = strings.TrimSpace(userID)
	agentID = strings.TrimSpace(agentID)
	if userID == "" || agentID == "" {
		return ErrInvalidAccountRequest
	}
	if _, err := s.store.GetAccount(ctx, userID); err != nil {
		return err
	}
	items, err := s.store.ListAccountAgents(ctx, userID)
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.AgentID == agentID {
			return nil
		}
	}
	return s.store.SaveAccountAgent(ctx, AccountAgent{
		UserID:    userID,
		AgentID:   agentID,
		CreatedAt: s.clock(),
	})
}

func (s *Service) PrimaryAgentID(ctx context.Context, userID string) (string, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return "", ErrInvalidAccountRequest
	}
	if _, err := s.store.GetAccount(ctx, userID); err != nil {
		return "", err
	}
	items, err := s.store.ListAccountAgents(ctx, userID)
	if err != nil {
		return "", err
	}
	if len(items) == 0 {
		return "", ErrAccountAgentNotFound
	}
	return items[0].AgentID, nil
}

func (s *Service) AgentIDs(ctx context.Context, userID string) ([]string, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, ErrInvalidAccountRequest
	}
	if _, err := s.store.GetAccount(ctx, userID); err != nil {
		return nil, err
	}
	items, err := s.store.ListAccountAgents(ctx, userID)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.AgentID)
	}
	return ids, nil
}

func (s *Service) AccountForAgent(ctx context.Context, agentID string) (Account, error) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return Account{}, ErrInvalidAccountRequest
	}
	return s.store.GetAccountForAgent(ctx, agentID)
}

func (s *Service) DeleteAccount(ctx context.Context, userID string) error {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return ErrInvalidAccountRequest
	}
	return s.store.WithBootstrapLock(ctx, func(ctx context.Context) error {
		return s.store.DeleteAccount(ctx, userID)
	})
}

func (s *Service) rollbackSessions(ctx context.Context, sessionIDs []string) error {
	if len(sessionIDs) == 0 {
		return nil
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), sessionRollbackTimeout)
	defer cancel()
	var rollbackErr error
	for _, sessionID := range sessionIDs {
		if err := s.store.DeleteSession(cleanupCtx, sessionID); err != nil && !errors.Is(err, ErrSessionNotFound) {
			rollbackErr = errors.Join(rollbackErr, fmt.Errorf("rollback session %s: %w", sessionID, err))
		}
	}
	return rollbackErr
}

func validTokenRequest(request TokenRequest) bool {
	return validClientForAudience(request.ClientID, request.Audience) && validAgentForClient(request.ClientID, request.AgentID)
}

func validAgentForClient(clientID, agentID string) bool {
	if clientID == ClientClaweeAgent {
		return strings.TrimSpace(agentID) != ""
	}
	return agentID == ""
}

func validClientForAudience(clientID, audience string) bool {
	switch audience {
	case AudienceFrontend:
		return clientID == ClientWeb || clientID == ClientElectron || clientID == ClientClaweeAgent
	case AudienceAdmin:
		return clientID == ClientWeb
	default:
		return false
	}
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func validStatus(status string) bool {
	return status == StatusActive || status == StatusDisabled
}

func hashSessionToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

func generateID(prefix string) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Errorf("generate %s id: %w", prefix, err))
	}
	return prefix + "_" + hex.EncodeToString(b[:])
}
