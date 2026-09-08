package accounts

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testUserJWTSigningKey = "01234567890123456789012345678901"

func TestAccountDisplayNameUsesStableFallbackOrder(t *testing.T) {
	for _, test := range []struct {
		name    string
		account Account
		want    string
	}{
		{name: "name", account: Account{Name: "  平台管理员  ", Email: "admin@example.com", UserID: "usr_1"}, want: "平台管理员"},
		{name: "email", account: Account{Email: " admin@example.com ", UserID: "usr_1"}, want: "admin@example.com"},
		{name: "user id", account: Account{UserID: " usr_1 "}, want: "usr_1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := test.account.DisplayName(); got != test.want {
				t.Fatalf("DisplayName() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestExternalIdentityProvisionAndResolve(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	svc := NewService(Config{Store: store, Clock: func() time.Time { return now }})
	identity := AccountIdentity{ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-1", ExternalUserID: "staff-1", VerifiedAt: now}

	if _, err := svc.ProvisionExternalAccount(ctx, identity, ExternalAccountRequest{Email: "member@example.com", Name: "成员"}, false, true); !errors.Is(err, ErrExternalAccountProvisionDisabled) {
		t.Fatalf("disabled provision error = %v", err)
	}
	if _, err := svc.ProvisionExternalAccount(ctx, identity, ExternalAccountRequest{Email: "member@example.com", Name: "成员"}, true, false); !errors.Is(err, ErrSystemNotInitialized) {
		t.Fatalf("uninitialized provision error = %v", err)
	}
	account, err := svc.ProvisionExternalAccount(ctx, identity, ExternalAccountRequest{Email: "member@example.com", Name: "成员"}, true, true)
	if err != nil {
		t.Fatal(err)
	}
	if account.PasswordHash != "" || account.Status != StatusActive {
		t.Fatalf("provisioned account = %#v", account)
	}
	if _, err := svc.AuthenticateCredentials(ctx, LoginRequest{Email: account.Email, Password: ""}); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("empty password login error = %v", err)
	}

	now = now.Add(time.Hour)
	identity.ExternalUserID = "staff-2"
	identity.VerifiedAt = now
	resolved, err := svc.ResolveExternalIdentity(ctx, identity)
	if err != nil || resolved.UserID != account.UserID {
		t.Fatalf("ResolveExternalIdentity() = %#v, %v", resolved, err)
	}
	stored, err := svc.AccountIdentityForUser(ctx, account.UserID, "dingtalk", "default")
	if err != nil || stored.ExternalUserID != "staff-2" || !stored.VerifiedAt.Equal(now) {
		t.Fatalf("updated identity = %#v, %v", stored, err)
	}
}

func TestExternalIdentityDoesNotSilentlyBindMatchingEmail(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store})
	if _, err := svc.CreateAccount(ctx, CreateAccountRequest{Email: "member@example.com", Name: "已有账户", Password: "passw0rd!"}); err != nil {
		t.Fatal(err)
	}
	identity := AccountIdentity{ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-1", ExternalUserID: "staff-1", VerifiedAt: time.Now()}
	_, err := svc.ProvisionExternalAccount(ctx, identity, ExternalAccountRequest{Email: "MEMBER@example.com", Name: "成员"}, true, true)
	if !errors.Is(err, ErrExternalAccountConflict) {
		t.Fatalf("matching email error = %v", err)
	}
}

func TestUnbindExternalIdentityRequiresWorkingLocalPassword(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store})
	registered, err := svc.Register(ctx, RegisterRequest{Email: "member@example.com", Name: "Member", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	identity := AccountIdentity{
		ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-unbind",
		ExternalUserID: "staff-unbind", VerifiedAt: time.Now().UTC(),
	}
	if err := svc.BindExternalIdentity(ctx, registered.Account.UserID, identity); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.UnbindExternalIdentity(ctx, registered.Account.UserID, "dingtalk", "default", "wrong-password"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password error = %v, want %v", err, ErrInvalidCredentials)
	}
	if _, err := svc.AccountIdentityForUser(ctx, registered.Account.UserID, "dingtalk", "default"); err != nil {
		t.Fatalf("wrong password removed identity: %v", err)
	}

	removed, err := svc.UnbindExternalIdentity(ctx, registered.Account.UserID, "dingtalk", "default", "passw0rd!")
	if err != nil {
		t.Fatal(err)
	}
	if removed.ProviderSubject != identity.ProviderSubject {
		t.Fatalf("removed identity = %#v", removed)
	}
	if _, err := svc.AccountIdentityForUser(ctx, registered.Account.UserID, "dingtalk", "default"); !errors.Is(err, ErrAccountIdentityNotFound) {
		t.Fatalf("identity after unbind error = %v, want %v", err, ErrAccountIdentityNotFound)
	}
	if account, err := svc.Account(ctx, registered.Account.UserID); err != nil || account.Email != registered.Account.Email {
		t.Fatalf("account after unbind = %#v, %v", account, err)
	}
}

func TestUnbindExternalIdentityRejectsAccountWithoutLocalPassword(t *testing.T) {
	ctx := context.Background()
	svc := NewService(Config{Store: NewMemoryStore()})
	identity := AccountIdentity{
		ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-only",
		ExternalUserID: "staff-only", VerifiedAt: time.Now().UTC(),
	}
	account, err := svc.ProvisionExternalAccount(ctx, identity, ExternalAccountRequest{Email: "only@example.com", Name: "Only"}, true, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UnbindExternalIdentity(ctx, account.UserID, "dingtalk", "default", "anything"); !errors.Is(err, ErrLocalPasswordRequired) {
		t.Fatalf("passwordless account error = %v, want %v", err, ErrLocalPasswordRequired)
	}
	if _, err := svc.AccountIdentityForUser(ctx, account.UserID, "dingtalk", "default"); err != nil {
		t.Fatalf("passwordless account identity removed: %v", err)
	}
}

func TestExternalProvisionAllowsDuplicateName(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store})
	if _, err := svc.CreateAccount(ctx, CreateAccountRequest{Email: "existing@example.com", Name: "成员", Password: "passw0rd!"}); err != nil {
		t.Fatal(err)
	}
	identity := AccountIdentity{
		ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-new",
		ExternalUserID: "staff-new", VerifiedAt: time.Now(),
	}
	account, err := svc.ProvisionExternalAccount(ctx, identity, ExternalAccountRequest{Email: "new@example.com", Name: "成员"}, true, true)
	if err != nil {
		t.Fatal(err)
	}
	if account.Name != "成员" {
		t.Fatalf("provisioned name = %q, want 成员", account.Name)
	}
}

func TestOAuthLoginStateIsConsumedOnce(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store})
	now := time.Now()
	state := OAuthLoginState{StateHash: "hash", ProviderType: "dingtalk", ProviderKey: "default", Intent: "login", RedirectTo: "/app", CreatedAt: now, ExpiresAt: now.Add(time.Minute)}
	if err := svc.SaveOAuthLoginState(ctx, state); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConsumeOAuthLoginState(ctx, "hash", now); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConsumeOAuthLoginState(ctx, "hash", now); !errors.Is(err, ErrOAuthLoginStateNotFound) {
		t.Fatalf("replay error = %v", err)
	}
}

func TestOAuthAuthorizationCodeIsBoundAndConsumedOnce(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store})
	now := time.Now()
	code := OAuthAuthorizationCode{
		CodeHash: "hash", UserID: "usr_1", AgentID: "clawee_1", RedirectURI: "http://127.0.0.1:49152/enterprise/dingtalk/callback",
		PKCEChallenge: strings.Repeat("a", 43), CreatedAt: now, ExpiresAt: now.Add(time.Minute),
	}
	if err := svc.SaveOAuthAuthorizationCode(ctx, code); err != nil {
		t.Fatal(err)
	}
	base := OAuthAuthorizationCodeConsumeRequest{
		CodeHash: code.CodeHash, AgentID: code.AgentID, RedirectURI: code.RedirectURI, PKCEChallenge: code.PKCEChallenge, Now: now,
	}
	for _, mutate := range []func(*OAuthAuthorizationCodeConsumeRequest){
		func(req *OAuthAuthorizationCodeConsumeRequest) { req.AgentID = "clawee_2" },
		func(req *OAuthAuthorizationCodeConsumeRequest) { req.RedirectURI += "/" },
		func(req *OAuthAuthorizationCodeConsumeRequest) { req.PKCEChallenge = strings.Repeat("b", 43) },
		func(req *OAuthAuthorizationCodeConsumeRequest) { req.Now = code.ExpiresAt },
	} {
		req := base
		mutate(&req)
		if _, err := svc.ConsumeOAuthAuthorizationCode(ctx, req); !errors.Is(err, ErrOAuthAuthorizationCodeNotFound) {
			t.Fatalf("mismatched consume error = %v", err)
		}
	}
	consumed, err := svc.ConsumeOAuthAuthorizationCode(ctx, base)
	if err != nil || consumed.UserID != code.UserID {
		t.Fatalf("consume = %#v, %v", consumed, err)
	}
	if _, err := svc.ConsumeOAuthAuthorizationCode(ctx, base); !errors.Is(err, ErrOAuthAuthorizationCodeNotFound) {
		t.Fatalf("replay error = %v", err)
	}
}

func TestOAuthAuthorizationCodeConcurrentConsumeHasOneWinner(t *testing.T) {
	ctx := context.Background()
	svc := NewService(Config{Store: NewMemoryStore()})
	now := time.Now()
	code := OAuthAuthorizationCode{
		CodeHash: "concurrent-hash", UserID: "usr_1", AgentID: "clawee_1",
		RedirectURI:   "http://127.0.0.1:49152/enterprise/dingtalk/callback",
		PKCEChallenge: strings.Repeat("a", 43), CreatedAt: now, ExpiresAt: now.Add(time.Minute),
	}
	if err := svc.SaveOAuthAuthorizationCode(ctx, code); err != nil {
		t.Fatal(err)
	}
	req := OAuthAuthorizationCodeConsumeRequest{
		CodeHash: code.CodeHash, AgentID: code.AgentID, RedirectURI: code.RedirectURI, PKCEChallenge: code.PKCEChallenge, Now: now,
	}
	start := make(chan struct{})
	errorsCh := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			_, err := svc.ConsumeOAuthAuthorizationCode(ctx, req)
			errorsCh <- err
		}()
	}
	close(start)
	successes, misses := 0, 0
	for range 2 {
		err := <-errorsCh
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrOAuthAuthorizationCodeNotFound):
			misses++
		default:
			t.Fatalf("consume error = %v", err)
		}
	}
	if successes != 1 || misses != 1 {
		t.Fatalf("successes=%d misses=%d", successes, misses)
	}
}

func TestDeleteExpiredOAuthAuthorizationCodesKeepsActiveCodes(t *testing.T) {
	ctx := context.Background()
	svc := NewService(Config{Store: NewMemoryStore()})
	now := time.Now()
	for _, code := range []OAuthAuthorizationCode{
		{CodeHash: "expired", UserID: "usr_1", AgentID: "agent", RedirectURI: "redirect", PKCEChallenge: "challenge", CreatedAt: now.Add(-time.Minute), ExpiresAt: now},
		{CodeHash: "active", UserID: "usr_1", AgentID: "agent", RedirectURI: "redirect", PKCEChallenge: "challenge", CreatedAt: now, ExpiresAt: now.Add(time.Minute)},
	} {
		if err := svc.SaveOAuthAuthorizationCode(ctx, code); err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.DeleteExpiredOAuthAuthorizationCodes(ctx, now); err != nil {
		t.Fatal(err)
	}
	base := OAuthAuthorizationCodeConsumeRequest{AgentID: "agent", RedirectURI: "redirect", PKCEChallenge: "challenge", Now: now}
	base.CodeHash = "expired"
	if _, err := svc.ConsumeOAuthAuthorizationCode(ctx, base); !errors.Is(err, ErrOAuthAuthorizationCodeNotFound) {
		t.Fatalf("expired consume error = %v", err)
	}
	base.CodeHash = "active"
	if _, err := svc.ConsumeOAuthAuthorizationCode(ctx, base); err != nil {
		t.Fatalf("active consume error = %v", err)
	}
}

type identityInsertFailureStore struct {
	*MemoryStore
}

func (s *identityInsertFailureStore) InsertAccountIdentity(context.Context, AccountIdentity) error {
	return errors.New("identity insert failed")
}

func TestExternalProvisionRollsBackAccountWhenIdentityInsertFails(t *testing.T) {
	ctx := context.Background()
	store := &identityInsertFailureStore{MemoryStore: NewMemoryStore()}
	svc := NewService(Config{Store: store})
	identity := AccountIdentity{
		ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-1",
		ExternalUserID: "staff-1", VerifiedAt: time.Now(),
	}
	if _, err := svc.ProvisionExternalAccount(ctx, identity, ExternalAccountRequest{Email: "member@example.com", Name: "成员"}, true, true); err == nil {
		t.Fatal("provision error = nil")
	}
	if count, err := store.CountAccounts(ctx); err != nil || count != 0 {
		t.Fatalf("account count = %d, %v; want 0", count, err)
	}
}

func TestConcurrentExternalProvisionCreatesOneAccount(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store})
	identity := AccountIdentity{
		ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-concurrent",
		ExternalUserID: "staff-1", VerifiedAt: time.Now(),
	}
	var wg sync.WaitGroup
	results := make(chan Account, 2)
	errorsCh := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			account, err := svc.ProvisionExternalAccount(ctx, identity, ExternalAccountRequest{Email: "member@example.com", Name: "成员"}, true, true)
			results <- account
			errorsCh <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errorsCh)
	for err := range errorsCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	userID := ""
	for account := range results {
		if userID == "" {
			userID = account.UserID
		} else if account.UserID != userID {
			t.Fatalf("concurrent user ids = %q and %q", userID, account.UserID)
		}
	}
	if count, err := store.CountAccounts(ctx); err != nil || count != 1 {
		t.Fatalf("account count = %d, %v; want 1", count, err)
	}
}

func TestRegisterTrimsNamesAndAllowsDuplicates(t *testing.T) {
	svc := NewService(Config{Store: NewMemoryStore()})
	if _, err := svc.Register(context.Background(), RegisterRequest{Email: "blank@example.com", Name: "   ", Password: "passw0rd!"}); !errors.Is(err, ErrInvalidAccountRequest) {
		t.Fatalf("blank name error = %v", err)
	}
	first, err := svc.Register(context.Background(), RegisterRequest{Email: "one@example.com", Name: "  Alice  ", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Account.Name != "Alice" {
		t.Fatalf("stored name = %q", first.Account.Name)
	}
	second, err := svc.Register(context.Background(), RegisterRequest{Email: "two@example.com", Name: "Alice", Password: "passw0rd!"})
	if err != nil || second.Account.Name != "Alice" {
		t.Fatalf("duplicate name registration = %#v, %v", second.Account, err)
	}
}

func TestCreateAccountRequiresName(t *testing.T) {
	svc := NewService(Config{Store: NewMemoryStore()})
	_, err := svc.CreateAccount(context.Background(), CreateAccountRequest{Email: "admin@example.com", Name: "", Password: "passw0rd!", Status: StatusActive})
	if !errors.Is(err, ErrInvalidAccountRequest) {
		t.Fatalf("CreateAccount() error = %v, want %v", err, ErrInvalidAccountRequest)
	}
}

func TestUpdateAccountNameTrimsAndAllowsDuplicates(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store})
	first, err := svc.CreateAccount(ctx, CreateAccountRequest{Email: "one@example.com", Name: "Alice", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateAccount(ctx, CreateAccountRequest{Email: "two@example.com", Name: "Bob", Password: "passw0rd!"}); err != nil {
		t.Fatal(err)
	}

	updated, err := svc.UpdateAccountName(ctx, first.UserID, "  Carol  ")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "Carol" {
		t.Fatalf("updated name = %q, want Carol", updated.Name)
	}
	if _, err := svc.UpdateAccountName(ctx, first.UserID, "   "); !errors.Is(err, ErrAccountNameRequired) {
		t.Fatalf("blank name error = %v, want %v", err, ErrAccountNameRequired)
	}
	if _, err := svc.UpdateAccountName(ctx, "   ", "Carol"); !errors.Is(err, ErrAccountUserIDRequired) {
		t.Fatalf("blank user id error = %v, want %v", err, ErrAccountUserIDRequired)
	}
	if _, err := svc.UpdateAccountName(ctx, first.UserID, "Bob"); err != nil {
		t.Fatalf("duplicate name update error = %v", err)
	}
	persisted, err := svc.Account(ctx, first.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Name != "Bob" {
		t.Fatalf("persisted name = %q, want Bob", persisted.Name)
	}
}

func TestIssueAndAuthenticateJWT(t *testing.T) {
	ctx := context.Background()
	clock := func() time.Time { return time.Date(2026, 7, 29, 10, 0, 0, 987654321, time.UTC) }
	store := NewMemoryStore()
	svc := NewService(Config{Store: store, Clock: clock, SessionDuration: 2 * time.Hour, JWTSigningKey: []byte(testUserJWTSigningKey)})
	registration, err := svc.Register(ctx, RegisterRequest{Email: "admin@example.com", Name: "Admin", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	if !registration.NeedsAdminBootstrap {
		t.Fatal("first account must request admin bootstrap")
	}
	if sessions := store.sessions; len(sessions) != 0 {
		t.Fatalf("Register() created %d sessions, want 0", len(sessions))
	}
	account, err := svc.AuthenticateCredentials(ctx, LoginRequest{Email: "admin@example.com", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	batch, err := svc.IssueTokens(ctx, account, []TokenRequest{
		{Audience: AudienceFrontend, ClientID: ClientWeb},
		{Audience: AudienceAdmin, ClientID: ClientWeb},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Tokens) != 2 {
		t.Fatalf("token count = %d, want 2", len(batch.Tokens))
	}
	issued := batch.Token(AudienceFrontend)
	if issued.Token == "" {
		t.Fatal("missing frontend token")
	}
	parser := jwt.NewParser(jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithTimeFunc(clock))
	claims := new(JWTClaims)
	if _, err := parser.ParseWithClaims(issued.Token, claims, func(*jwt.Token) (any, error) {
		return []byte(testUserJWTSigningKey), nil
	}); err != nil {
		t.Fatalf("parse issued JWT: %v", err)
	}
	if claims.Issuer != JWTIssuer || claims.Subject != account.UserID || len(claims.Audience) != 1 || claims.Audience[0] != AudienceFrontend {
		t.Fatalf("registered claims = %#v", claims.RegisteredClaims)
	}
	if claims.ID != issued.Session.SessionID || claims.ClientID != ClientWeb {
		t.Fatalf("custom claims = %#v", claims)
	}
	if !claims.IssuedAt.Time.Equal(clock().UTC().Truncate(time.Second)) || !claims.ExpiresAt.Time.Equal(issued.Session.ExpiresAt) {
		t.Fatalf("claim times = iat %v exp %v session exp %v", claims.IssuedAt.Time, claims.ExpiresAt.Time, issued.Session.ExpiresAt)
	}
	identity, err := svc.AuthenticateToken(ctx, issued.Token, AudienceFrontend)
	if err != nil {
		t.Fatal(err)
	}
	if identity.Principal != (Principal{UserID: account.UserID, SessionID: issued.Session.SessionID, Audience: AudienceFrontend, ClientID: ClientWeb}) {
		t.Fatalf("principal = %#v", identity.Principal)
	}
	if _, err := svc.AuthenticateToken(ctx, issued.Token, AudienceAdmin); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("wrong audience error = %v, want %v", err, ErrInvalidSession)
	}
}

func TestIssueAndAuthenticateClaweeAgentJWT(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store, SessionDuration: time.Hour, JWTSigningKey: []byte(testUserJWTSigningKey)})
	account := Account{UserID: "usr_1", Email: "user@example.com", Status: StatusActive}
	if err := store.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}

	batch, err := svc.IssueTokens(ctx, account, []TokenRequest{{
		Audience: AudienceFrontend, ClientID: ClientClaweeAgent, AgentID: "clawee_agent_1",
	}})
	if err != nil {
		t.Fatal(err)
	}
	issued := batch.Token(AudienceFrontend)
	if issued.Session.AgentID != "clawee_agent_1" {
		t.Fatalf("session agent_id = %q, want clawee_agent_1", issued.Session.AgentID)
	}

	claims := new(JWTClaims)
	if _, err := jwt.ParseWithClaims(issued.Token, claims, func(*jwt.Token) (any, error) {
		return []byte(testUserJWTSigningKey), nil
	}); err != nil {
		t.Fatal(err)
	}
	if claims.AgentID != "clawee_agent_1" {
		t.Fatalf("claim agent_id = %q, want clawee_agent_1", claims.AgentID)
	}

	identity, err := svc.AuthenticateToken(ctx, issued.Token, AudienceFrontend)
	if err != nil {
		t.Fatal(err)
	}
	if identity.Principal.AgentID != "clawee_agent_1" {
		t.Fatalf("principal agent_id = %q, want clawee_agent_1", identity.Principal.AgentID)
	}

	session := issued.Session
	session.AgentID = "clawee_agent_2"
	store.sessions[session.SessionID] = session
	if _, err := svc.AuthenticateToken(ctx, issued.Token, AudienceFrontend); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("mismatched agent_id error = %v, want %v", err, ErrInvalidSession)
	}
}

func TestIssueTokensEnforcesClientAgentBinding(t *testing.T) {
	svc := NewService(Config{Store: NewMemoryStore(), SessionDuration: time.Hour, JWTSigningKey: []byte(testUserJWTSigningKey)})
	account := Account{UserID: "usr_1", Status: StatusActive}
	for _, test := range []struct {
		name    string
		request TokenRequest
	}{
		{name: "clawee missing agent", request: TokenRequest{Audience: AudienceFrontend, ClientID: ClientClaweeAgent}},
		{name: "web with agent", request: TokenRequest{Audience: AudienceFrontend, ClientID: ClientWeb, AgentID: "agent_1"}},
		{name: "electron with agent", request: TokenRequest{Audience: AudienceFrontend, ClientID: ClientElectron, AgentID: "agent_1"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := svc.IssueTokens(context.Background(), account, []TokenRequest{test.request}); !errors.Is(err, ErrInvalidAccountRequest) {
				t.Fatalf("IssueTokens() error = %v, want %v", err, ErrInvalidAccountRequest)
			}
		})
	}
}

func TestAuthenticateTokenRejectsLegacyClaweeSessionWithoutAgent(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	svc := NewService(Config{Store: store, Clock: func() time.Time { return now }, SessionDuration: time.Hour, JWTSigningKey: []byte(testUserJWTSigningKey)})
	account := Account{UserID: "usr_1", Email: "user@example.com", Status: StatusActive}
	if err := store.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	claims := JWTClaims{
		ClientID: ClientClaweeAgent,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: JWTIssuer, Subject: account.UserID, Audience: jwt.ClaimStrings{AudienceFrontend}, ID: "sess_legacy_clawee",
			IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
		},
	}
	plaintext, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testUserJWTSigningKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSession(ctx, Session{
		SessionID: claims.ID, UserID: account.UserID, TokenHash: hashSessionToken(plaintext), ExpiresAt: now.Add(time.Hour), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AuthenticateToken(ctx, plaintext, AudienceFrontend); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("AuthenticateToken() error = %v, want %v", err, ErrInvalidSession)
	}
}

func TestIssueTokensRejectsDurationThatCannotUseSecondPrecision(t *testing.T) {
	for _, duration := range []time.Duration{500 * time.Millisecond, 1500 * time.Millisecond} {
		t.Run(duration.String(), func(t *testing.T) {
			ctx := context.Background()
			store := NewMemoryStore()
			svc := NewService(Config{
				Store: store, SessionDuration: duration, JWTSigningKey: []byte(testUserJWTSigningKey),
			})
			account := Account{UserID: "usr_1", Email: "user@example.com", Status: StatusActive}
			if err := store.SaveAccount(ctx, account); err != nil {
				t.Fatal(err)
			}

			if _, err := svc.IssueTokens(ctx, account, []TokenRequest{{Audience: AudienceFrontend, ClientID: ClientWeb}}); !errors.Is(err, ErrInvalidAccountRequest) {
				t.Fatalf("IssueTokens() error = %v, want %v", err, ErrInvalidAccountRequest)
			}
		})
	}
}

func TestAuthenticateTokenRejectsMissingIssuedAt(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	svc := NewService(Config{
		Store: store, Clock: func() time.Time { return now }, SessionDuration: time.Hour,
		JWTSigningKey: []byte(testUserJWTSigningKey),
	})
	account := Account{UserID: "usr_1", Email: "user@example.com", Status: StatusActive}
	if err := store.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	expiresAt := now.Add(time.Hour)
	claims := JWTClaims{
		ClientID: ClientWeb,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: JWTIssuer, Subject: account.UserID, Audience: jwt.ClaimStrings{AudienceFrontend},
			ID: "sess_missing_iat", ExpiresAt: jwt.NewNumericDate(expiresAt),
		},
	}
	plaintext, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testUserJWTSigningKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSession(ctx, Session{
		SessionID: claims.ID, UserID: account.UserID, TokenHash: hashSessionToken(plaintext),
		ExpiresAt: expiresAt, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.AuthenticateToken(ctx, plaintext, AudienceFrontend); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("AuthenticateToken() error = %v, want %v", err, ErrInvalidSession)
	}
}

func TestAuthenticateTokenRejectsAlgorithmIssuerAndSessionMismatch(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	svc := NewService(Config{Store: store, Clock: func() time.Time { return now }, SessionDuration: time.Hour, JWTSigningKey: []byte(testUserJWTSigningKey)})
	account := Account{UserID: "usr_1", Email: "user@example.com", Status: StatusActive}
	if err := store.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	issued, err := svc.IssueTokens(ctx, account, []TokenRequest{{Audience: AudienceFrontend, ClientID: ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	token := issued.Token(AudienceFrontend).Token

	for name, value := range map[string]string{
		"wrong signature": token[:len(token)-1] + "x",
		"random token":    "legacy-random-session-token",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := svc.AuthenticateToken(ctx, value, AudienceFrontend); !errors.Is(err, ErrInvalidSession) {
				t.Fatalf("AuthenticateToken() error = %v, want %v", err, ErrInvalidSession)
			}
		})
	}

	wrongIssuer := JWTClaims{
		ClientID: ClientWeb,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: "other", Subject: account.UserID, Audience: jwt.ClaimStrings{AudienceFrontend}, ID: "sess_wrong_issuer",
			IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
		},
	}
	wrongIssuerToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, wrongIssuer).SignedString([]byte(testUserJWTSigningKey))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AuthenticateToken(ctx, wrongIssuerToken, AudienceFrontend); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("wrong issuer error = %v, want %v", err, ErrInvalidSession)
	}

	wrongAlgorithm := JWTClaims{
		ClientID: ClientWeb,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: JWTIssuer, Subject: account.UserID, Audience: jwt.ClaimStrings{AudienceFrontend}, ID: "sess_wrong_algorithm",
			IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
		},
	}
	wrongAlgorithmToken, err := jwt.NewWithClaims(jwt.SigningMethodHS384, wrongAlgorithm).SignedString([]byte(testUserJWTSigningKey))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AuthenticateToken(ctx, wrongAlgorithmToken, AudienceFrontend); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("wrong algorithm error = %v, want %v", err, ErrInvalidSession)
	}

	expired := wrongAlgorithm
	expired.ID = "sess_expired"
	expired.IssuedAt = jwt.NewNumericDate(now.Add(-2 * time.Hour))
	expired.ExpiresAt = jwt.NewNumericDate(now.Add(-time.Hour))
	expiredToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, expired).SignedString([]byte(testUserJWTSigningKey))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AuthenticateToken(ctx, expiredToken, AudienceFrontend); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("expired token error = %v, want %v", err, ErrInvalidSession)
	}

	parts := issued.Token(AudienceFrontend)
	session := parts.Session
	session.UserID = "usr_other"
	store.sessions[session.SessionID] = session
	if _, err := svc.AuthenticateToken(ctx, token, AudienceFrontend); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("session mismatch error = %v, want %v", err, ErrInvalidSession)
	}
}

func TestJWTInvalidatesAfterDisablePasswordResetAndSessionDeletion(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	svc := NewService(Config{Store: store, Clock: func() time.Time { return now }, SessionDuration: time.Hour, JWTSigningKey: []byte(testUserJWTSigningKey)})
	registration, err := svc.Register(ctx, RegisterRequest{Email: "user@example.com", Name: "User", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	issue := func() IssuedToken {
		batch, err := svc.IssueTokens(ctx, registration.Account, []TokenRequest{{Audience: AudienceFrontend, ClientID: ClientWeb}})
		if err != nil {
			t.Fatal(err)
		}
		return batch.Token(AudienceFrontend)
	}

	disabled := issue()
	if _, err := svc.UpdateAccountStatus(ctx, registration.Account.UserID, StatusDisabled); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AuthenticateToken(ctx, disabled.Token, AudienceFrontend); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("disabled account error = %v, want %v", err, ErrInvalidSession)
	}
	if _, err := svc.UpdateAccountStatus(ctx, registration.Account.UserID, StatusActive); err != nil {
		t.Fatal(err)
	}

	reset := issue()
	if _, err := svc.ResetAccountPassword(ctx, registration.Account.UserID, "new-passw0rd!"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AuthenticateToken(ctx, reset.Token, AudienceFrontend); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("reset password error = %v, want %v", err, ErrInvalidSession)
	}

	deleted := issue()
	if err := store.DeleteSession(ctx, deleted.Session.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AuthenticateToken(ctx, deleted.Token, AudienceFrontend); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("deleted session error = %v, want %v", err, ErrInvalidSession)
	}
}

func TestIssueTokensRollsBackEarlierSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	base := NewMemoryStore()
	store := &failNthSessionStore{Store: base, failAt: 2, cancelOnFail: cancel}
	svc := NewService(Config{Store: store, SessionDuration: time.Hour, JWTSigningKey: []byte(testUserJWTSigningKey)})
	account := Account{UserID: "usr_1", Email: "user@example.com", Status: StatusActive}
	if err := base.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	batch, err := svc.IssueTokens(ctx, account, []TokenRequest{
		{Audience: AudienceFrontend, ClientID: ClientWeb},
		{Audience: AudienceAdmin, ClientID: ClientWeb},
	})
	if err == nil {
		t.Fatal("IssueTokens() error = nil, want second session failure")
	}
	if len(batch.Tokens) != 0 {
		t.Fatalf("partial tokens = %#v", batch.Tokens)
	}
	if len(base.sessions) != 0 {
		t.Fatalf("remaining sessions = %#v, want none", base.sessions)
	}
}

func TestIssueTokensReportsSessionRollbackFailure(t *testing.T) {
	ctx := context.Background()
	base := NewMemoryStore()
	store := &failNthSessionStore{
		Store: base, failAt: 2, deleteErr: errors.New("delete session failed"),
	}
	svc := NewService(Config{Store: store, SessionDuration: time.Hour, JWTSigningKey: []byte(testUserJWTSigningKey)})
	account := Account{UserID: "usr_1", Email: "user@example.com", Status: StatusActive}
	if err := base.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}

	_, err := svc.IssueTokens(ctx, account, []TokenRequest{
		{Audience: AudienceFrontend, ClientID: ClientWeb},
		{Audience: AudienceAdmin, ClientID: ClientWeb},
	})
	if err == nil || !strings.Contains(err.Error(), "save session failed") || !strings.Contains(err.Error(), "delete session failed") {
		t.Fatalf("IssueTokens() error = %v, want save and rollback errors", err)
	}
}

func TestIssueTokensRejectsShortSigningKey(t *testing.T) {
	svc := NewService(Config{Store: NewMemoryStore(), JWTSigningKey: []byte("short")})
	_, err := svc.IssueTokens(context.Background(), Account{UserID: "usr_1", Status: StatusActive}, []TokenRequest{{Audience: AudienceFrontend, ClientID: ClientWeb}})
	if !errors.Is(err, ErrInvalidAccountRequest) {
		t.Fatalf("IssueTokens() error = %v, want %v", err, ErrInvalidAccountRequest)
	}
}

type failNthSessionStore struct {
	Store
	saves        int
	failAt       int
	cancelOnFail context.CancelFunc
	deleteErr    error
}

func (s *failNthSessionStore) SaveSession(ctx context.Context, session Session) error {
	s.saves++
	if s.saves == s.failAt {
		if s.cancelOnFail != nil {
			s.cancelOnFail()
		}
		return errors.New("save session failed")
	}
	return s.Store.SaveSession(ctx, session)
}

func (s *failNthSessionStore) DeleteSession(ctx context.Context, sessionID string) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	return s.Store.DeleteSession(ctx, sessionID)
}

func TestMemoryStoreAccountServiceContract(t *testing.T) {
	runAccountServiceContract(t, NewMemoryStore())
}

func TestPostgresStoreNilPoolDoesNotPanic(t *testing.T) {
	ctx := context.Background()
	store := NewPostgresStore(nil)

	if err := store.WithBootstrapLock(ctx, func(context.Context) error { return nil }); !errors.Is(err, ErrPostgresStoreUnavailable) {
		t.Fatalf("WithBootstrapLock error = %v, want %v", err, ErrPostgresStoreUnavailable)
	}
	if err := store.SaveAccount(ctx, Account{}); !errors.Is(err, ErrPostgresStoreUnavailable) {
		t.Fatalf("SaveAccount error = %v, want %v", err, ErrPostgresStoreUnavailable)
	}
	if _, err := store.GetAccount(ctx, "missing"); !errors.Is(err, ErrPostgresStoreUnavailable) {
		t.Fatalf("GetAccount error = %v, want %v", err, ErrPostgresStoreUnavailable)
	}
	if _, err := store.GetAccountByEmail(ctx, "missing@example.com"); !errors.Is(err, ErrPostgresStoreUnavailable) {
		t.Fatalf("GetAccountByEmail error = %v, want %v", err, ErrPostgresStoreUnavailable)
	}
	if _, err := store.ListAccounts(ctx); !errors.Is(err, ErrPostgresStoreUnavailable) {
		t.Fatalf("ListAccounts error = %v, want %v", err, ErrPostgresStoreUnavailable)
	}
	if _, err := store.CountAccounts(ctx); !errors.Is(err, ErrPostgresStoreUnavailable) {
		t.Fatalf("CountAccounts error = %v, want %v", err, ErrPostgresStoreUnavailable)
	}
	if err := store.SaveSession(ctx, Session{}); !errors.Is(err, ErrPostgresStoreUnavailable) {
		t.Fatalf("SaveSession error = %v, want %v", err, ErrPostgresStoreUnavailable)
	}
	if _, err := store.GetSessionByHash(ctx, "missing"); !errors.Is(err, ErrPostgresStoreUnavailable) {
		t.Fatalf("GetSessionByHash error = %v, want %v", err, ErrPostgresStoreUnavailable)
	}
	if err := store.DeleteSession(ctx, "missing"); !errors.Is(err, ErrPostgresStoreUnavailable) {
		t.Fatalf("DeleteSession error = %v, want %v", err, ErrPostgresStoreUnavailable)
	}
	if err := store.SaveAccountAgent(ctx, AccountAgent{}); !errors.Is(err, ErrPostgresStoreUnavailable) {
		t.Fatalf("SaveAccountAgent error = %v, want %v", err, ErrPostgresStoreUnavailable)
	}
	if _, err := store.ListAccountAgents(ctx, "missing"); !errors.Is(err, ErrPostgresStoreUnavailable) {
		t.Fatalf("ListAccountAgents error = %v, want %v", err, ErrPostgresStoreUnavailable)
	}
	if _, err := store.GetAccountForAgent(ctx, "missing"); !errors.Is(err, ErrPostgresStoreUnavailable) {
		t.Fatalf("GetAccountForAgent error = %v, want %v", err, ErrPostgresStoreUnavailable)
	}
}

func TestAccountForAgentUsesUniqueOwnership(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store})
	first := Account{UserID: "usr_1", Email: "one@example.com", Status: StatusActive}
	second := Account{UserID: "usr_2", Email: "two@example.com", Status: StatusActive}
	if err := store.SaveAccount(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAccount(ctx, second); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAccountAgent(ctx, AccountAgent{UserID: first.UserID, AgentID: "agent_1"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAccountAgent(ctx, AccountAgent{UserID: second.UserID, AgentID: "agent_1"}); !errors.Is(err, ErrAccountAgentExists) {
		t.Fatalf("second ownership error = %v, want %v", err, ErrAccountAgentExists)
	}
	owner, err := svc.AccountForAgent(ctx, "agent_1")
	if err != nil {
		t.Fatal(err)
	}
	if owner.UserID != first.UserID {
		t.Fatalf("owner = %q, want %q", owner.UserID, first.UserID)
	}
}

func TestSaveActiveAccountAgentRequiresActiveAccount(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	item := AccountAgent{UserID: "usr_1", AgentID: "agent_1"}

	if err := store.SaveActiveAccountAgent(ctx, item); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("missing account error = %v, want %v", err, ErrAccountNotFound)
	}
	if err := store.SaveAccount(ctx, Account{UserID: item.UserID, Email: "one@example.com", Status: StatusDisabled}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveActiveAccountAgent(ctx, item); !errors.Is(err, ErrAccountNotActive) {
		t.Fatalf("disabled account error = %v, want %v", err, ErrAccountNotActive)
	}
	account, err := store.GetAccount(ctx, item.UserID)
	if err != nil {
		t.Fatal(err)
	}
	account.Status = StatusActive
	if err := store.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveActiveAccountAgent(ctx, item); err != nil {
		t.Fatalf("active account binding: %v", err)
	}
	items, err := store.ListAccountAgents(ctx, item.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].AgentID != item.AgentID {
		t.Fatalf("bindings = %#v, want agent %q", items, item.AgentID)
	}
}

func TestPrimaryAgentIDUsesCreatedAtThenAgentIDOrder(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	svc := NewService(Config{Store: store})
	account := Account{UserID: "usr_1", Email: "one@example.com", Status: StatusActive}
	if err := store.SaveAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	createdAt := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	for _, agentID := range []string{"agent_b", "agent_a"} {
		if err := store.SaveAccountAgent(ctx, AccountAgent{UserID: account.UserID, AgentID: agentID, CreatedAt: createdAt}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := svc.PrimaryAgentID(ctx, account.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if got != "agent_a" {
		t.Fatalf("PrimaryAgentID = %q, want agent_a", got)
	}
}

func runAccountServiceContract(t *testing.T, store Store) {
	t.Helper()

	ctx := context.Background()
	svc := NewService(Config{
		Store:         store,
		Clock:         func() time.Time { return time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC) },
		JWTSigningKey: []byte(testUserJWTSigningKey),
	})

	first, err := svc.Register(ctx, RegisterRequest{Email: "admin@example.com", Name: "Admin", Password: "passw0rd!"})
	if err != nil {
		t.Fatalf("register first: %v", err)
	}
	if !first.NeedsAdminBootstrap {
		t.Fatal("first registration did not request admin bootstrap")
	}

	if _, err := svc.AuthenticateCredentials(ctx, LoginRequest{Email: "admin@example.com", Password: "bad"}); err == nil {
		t.Fatalf("login with bad password succeeded")
	}
	account, err := svc.AuthenticateCredentials(ctx, LoginRequest{Email: "admin@example.com", Password: "passw0rd!"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	batch, err := svc.IssueTokens(ctx, account, []TokenRequest{{Audience: AudienceFrontend, ClientID: ClientWeb}})
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	current, err := svc.AuthenticateToken(ctx, batch.Token(AudienceFrontend).Token, AudienceFrontend)
	if err != nil {
		t.Fatalf("token lookup: %v", err)
	}
	if current.Account.Email != "admin@example.com" {
		t.Fatalf("session account email = %q", current.Account.Email)
	}

	second, err := svc.Register(ctx, RegisterRequest{Email: "user@example.com", Name: "User", Password: "passw0rd!"})
	if err != nil {
		t.Fatalf("register second: %v", err)
	}
	if second.NeedsAdminBootstrap {
		t.Fatal("second registration unexpectedly requested admin bootstrap")
	}
}
