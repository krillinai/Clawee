package businessdata

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"net/url"
	"testing"
	"time"
)

type bilibiliTestCipher struct{}

func (bilibiliTestCipher) Encrypt(value []byte) ([]byte, error) {
	return append([]byte("enc:"), value...), nil
}
func (bilibiliTestCipher) Decrypt(value []byte) ([]byte, error) {
	return bytes.TrimPrefix(value, []byte("enc:")), nil
}

type bilibiliOAuthStoreFixture struct {
	stateHash      []byte
	stateSaveErr   error
	expiresAt      time.Time
	consumed       bool
	credential     BilibiliCredential
	casResult      bool
	authorization  BilibiliAuthorization
	disabledOpenID string
}

func (s *bilibiliOAuthStoreFixture) SaveBilibiliOAuthState(_ context.Context, hash []byte, _ string, expires, _ time.Time) error {
	s.stateHash, s.expiresAt = append([]byte(nil), hash...), expires
	return s.stateSaveErr
}
func (s *bilibiliOAuthStoreFixture) ConsumeBilibiliOAuthState(_ context.Context, hash []byte, now time.Time) (string, error) {
	if s.consumed || !bytes.Equal(hash, s.stateHash) || !s.expiresAt.After(now) {
		return "", ErrInvalidRequest
	}
	s.consumed = true
	return "admin", nil
}
func (s *bilibiliOAuthStoreFixture) UpsertBilibiliAuthorization(_ context.Context, value BilibiliAuthorization, now time.Time) (Source, error) {
	s.authorization = value
	return Source{SourceID: "bdsrc_1", Provider: ProviderBilibili, ExternalAccountID: value.AccountInfo.OpenID, Status: SourceStatusActive, NextSyncAt: &now}, nil
}
func (s *bilibiliOAuthStoreFixture) DisableBilibiliAuthorization(_ context.Context, openID string, _ time.Time) error {
	s.disabledOpenID = openID
	return nil
}
func (s *bilibiliOAuthStoreFixture) GetBilibiliCredential(context.Context, string) (BilibiliCredential, error) {
	return s.credential, nil
}
func (s *bilibiliOAuthStoreFixture) CompareAndSwapBilibiliCredential(_ context.Context, _ string, _ []byte, access, refresh []byte, expires, _ time.Time) (bool, error) {
	if s.casResult {
		s.credential.AccessTokenCiphertext, s.credential.RefreshTokenCiphertext, s.credential.TokenExpiresAt = access, refresh, expires
		return true, nil
	}
	s.credential.AccessTokenCiphertext = []byte("enc:concurrent-access")
	s.credential.TokenExpiresAt = expires.Add(time.Hour)
	return false, nil
}

type bilibiliClientFixture struct {
	token      BilibiliToken
	scopes     []string
	account    BilibiliAccountInfo
	archives   map[int][]BilibiliArchive
	stats      map[string]BilibiliArchiveStat
	missing    string
	refreshErr error
	statErr    map[string]error
}

func (c *bilibiliClientFixture) AuthorizationURL(redirect, state string) string {
	return "https://auth.test/?gourl=" + url.QueryEscape(redirect) + "&state=" + url.QueryEscape(state)
}
func (c *bilibiliClientFixture) ExchangeToken(context.Context, string, string) (BilibiliToken, error) {
	return c.token, nil
}
func (c *bilibiliClientFixture) RefreshToken(context.Context, string) (BilibiliToken, error) {
	return c.token, c.refreshErr
}
func (c *bilibiliClientFixture) Scopes(context.Context, string) ([]string, error) {
	return c.scopes, nil
}
func (c *bilibiliClientFixture) AccountInfo(context.Context, string) (BilibiliAccountInfo, error) {
	return c.account, nil
}
func (*bilibiliClientFixture) UserStat(context.Context, string) (BilibiliUserStat, error) {
	return BilibiliUserStat{Follower: 10, Following: 2, ArcPassedTotal: 3}, nil
}
func (c *bilibiliClientFixture) Archives(_ context.Context, _ string, page, _ int) ([]BilibiliArchive, error) {
	return c.archives[page], nil
}
func (c *bilibiliClientFixture) ArchiveStat(_ context.Context, _, resourceID string) (BilibiliArchiveStat, error) {
	if resourceID == c.missing {
		return BilibiliArchiveStat{}, ErrBilibiliContentMissing
	}
	if err := c.statErr[resourceID]; err != nil {
		return BilibiliArchiveStat{}, err
	}
	return c.stats[resourceID], nil
}

func TestBilibiliOAuthStateScopeAndEncryptedCredentials(t *testing.T) {
	now := time.Date(2026, 8, 28, 2, 0, 0, 0, time.UTC)
	store := &bilibiliOAuthStoreFixture{}
	client := &bilibiliClientFixture{
		token:  BilibiliToken{AccessToken: "access-secret", RefreshToken: "refresh-secret", ExpiresAtUnix: now.Add(time.Hour).Unix()},
		scopes: append([]string(nil), requiredBilibiliScopes...), account: BilibiliAccountInfo{OpenID: "open-1", Name: "账号"},
	}
	service := NewBilibiliOAuthService(store, client, bilibiliTestCipher{}, "https://gateway.test/api/v1/integrations/bilibili/oauth/callback")
	service.clock = func() time.Time { return now }
	authorizationURL, err := service.AuthorizationURL(context.Background(), "admin")
	if err != nil || len(store.stateHash) != sha256.Size || bytes.Contains(store.stateHash, []byte("state")) {
		t.Fatalf("url=%q hash=%x err=%v", authorizationURL, store.stateHash, err)
	}
	parsed, _ := url.Parse(authorizationURL)
	state := parsed.Query().Get("state")
	source, err := service.HandleCallback(context.Background(), "code-secret", state)
	if err != nil || source.ExternalAccountID != "open-1" || string(store.authorization.AccessTokenCiphertext) == "access-secret" {
		t.Fatalf("source=%#v authorization=%#v err=%v", source, store.authorization, err)
	}
	if !store.authorization.TokenExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("token expires at=%v", store.authorization.TokenExpiresAt)
	}
	if err := service.HandleDeauthorize(context.Background(), " open-1 "); err != nil || store.disabledOpenID != "open-1" {
		t.Fatalf("disabled openid=%q err=%v", store.disabledOpenID, err)
	}
	if _, err := service.HandleCallback(context.Background(), "code-secret", state); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("replay error=%v", err)
	}
}

func TestBilibiliOAuthClassifiesStateStoreFailure(t *testing.T) {
	store := &bilibiliOAuthStoreFixture{stateSaveErr: errors.New("relation business_data_oauth_states does not exist")}
	service := NewBilibiliOAuthService(store, &bilibiliClientFixture{}, bilibiliTestCipher{}, "https://gateway.test/api/v1/integrations/bilibili/oauth/callback")

	_, err := service.AuthorizationURL(context.Background(), "admin")
	if !errors.Is(err, ErrBilibiliOAuthStateUnavailable) {
		t.Fatalf("authorization error=%v, want OAuth state store unavailable", err)
	}
}

func TestBilibiliOAuthRejectsMissingScopeAndRefreshesWithCASReread(t *testing.T) {
	if hasRequiredBilibiliScopes([]string{"USER_INFO", "USER_DATA", "ARC_BASE"}) {
		t.Fatal("missing ARC_DATA scope was accepted")
	}
	now := time.Date(2026, 8, 28, 2, 0, 0, 0, time.UTC)
	store := &bilibiliOAuthStoreFixture{credential: BilibiliCredential{
		SourceID: "bdsrc_1", AccessTokenCiphertext: []byte("enc:old-access"), RefreshTokenCiphertext: []byte("enc:old-refresh"), TokenExpiresAt: now.Add(time.Minute),
	}}
	client := &bilibiliClientFixture{token: BilibiliToken{AccessToken: "new-access", RefreshToken: "new-refresh", ExpiresAtUnix: now.Add(time.Hour).Unix()}}
	service := NewBilibiliOAuthService(store, client, bilibiliTestCipher{}, "https://gateway.test/api/v1/integrations/bilibili/oauth/callback")
	service.clock = func() time.Time { return now }
	token, err := service.AccessToken(context.Background(), "bdsrc_1")
	if err != nil || token != "concurrent-access" {
		t.Fatalf("token=%q err=%v", token, err)
	}
}

func TestBilibiliOAuthReturnsUnexpiredAccessTokenWithoutRefresh(t *testing.T) {
	now := time.Date(2026, 8, 28, 2, 0, 0, 0, time.UTC)
	store := &bilibiliOAuthStoreFixture{credential: BilibiliCredential{
		SourceID: "bdsrc_1", AccessTokenCiphertext: []byte("enc:current-access"),
		RefreshTokenCiphertext: []byte("enc:refresh"), TokenExpiresAt: now.Add(11 * time.Minute),
	}}
	service := NewBilibiliOAuthService(store, &bilibiliClientFixture{}, bilibiliTestCipher{}, "https://gateway.test/api/v1/integrations/bilibili/oauth/callback")
	service.clock = func() time.Time { return now }
	token, err := service.AccessToken(context.Background(), "bdsrc_1")
	if err != nil || token != "current-access" {
		t.Fatalf("token=%q err=%v", token, err)
	}
}

func TestBilibiliOAuthStateExpiresAndRefreshLifecycle(t *testing.T) {
	now := time.Date(2026, 8, 28, 2, 0, 0, 0, time.UTC)
	store := &bilibiliOAuthStoreFixture{}
	client := &bilibiliClientFixture{token: BilibiliToken{AccessToken: "new-access", RefreshToken: "new-refresh", ExpiresAtUnix: now.Add(time.Hour).Unix()}}
	service := NewBilibiliOAuthService(store, client, bilibiliTestCipher{}, "https://gateway.test/api/v1/integrations/bilibili/oauth/callback")
	service.clock = func() time.Time { return now }
	authorizationURL, err := service.AuthorizationURL(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(authorizationURL)
	service.clock = func() time.Time { return now.Add(bilibiliOAuthStateTTL) }
	if _, err := service.HandleCallback(context.Background(), "code", parsed.Query().Get("state")); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("expired state error=%v", err)
	}

	store.credential = BilibiliCredential{SourceID: "bdsrc", AccessTokenCiphertext: []byte("enc:old"), RefreshTokenCiphertext: []byte("enc:refresh"), TokenExpiresAt: now}
	store.casResult = true
	service.clock = func() time.Time { return now }
	token, err := service.AccessToken(context.Background(), "bdsrc")
	if err != nil || token != "new-access" {
		t.Fatalf("refreshed token=%q err=%v", token, err)
	}
	if !store.credential.TokenExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("refreshed token expires at=%v", store.credential.TokenExpiresAt)
	}
	client.refreshErr = errors.New("refresh rejected")
	store.credential.TokenExpiresAt = now
	if _, err := service.AccessToken(context.Background(), "bdsrc"); !errors.Is(err, ErrBilibiliReauthRequired) {
		t.Fatalf("refresh failure error=%v", err)
	}
}
