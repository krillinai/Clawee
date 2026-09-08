package businessdata

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	bilibiliOAuthStateTTL       = 10 * time.Minute
	bilibiliTokenRefreshAdvance = 10 * time.Minute
)

var requiredBilibiliScopes = []string{"USER_INFO", "USER_DATA", "ARC_BASE", "ARC_DATA"}

type TokenCipher interface {
	Encrypt([]byte) ([]byte, error)
	Decrypt([]byte) ([]byte, error)
}

type BilibiliCredential struct {
	SourceID               string
	AccessTokenCiphertext  []byte
	RefreshTokenCiphertext []byte
	TokenExpiresAt         time.Time
	Scopes                 []string
}

type BilibiliAuthorization struct {
	AccountInfo            BilibiliAccountInfo
	AccessTokenCiphertext  []byte
	RefreshTokenCiphertext []byte
	TokenExpiresAt         time.Time
	Scopes                 []string
}

type BilibiliCredentialStore interface {
	SaveBilibiliOAuthState(context.Context, []byte, string, time.Time, time.Time) error
	ConsumeBilibiliOAuthState(context.Context, []byte, time.Time) (string, error)
	UpsertBilibiliAuthorization(context.Context, BilibiliAuthorization, time.Time) (Source, error)
	DisableBilibiliAuthorization(context.Context, string, time.Time) error
	GetBilibiliCredential(context.Context, string) (BilibiliCredential, error)
	CompareAndSwapBilibiliCredential(context.Context, string, []byte, []byte, []byte, time.Time, time.Time) (bool, error)
}

type BilibiliOAuthService struct {
	store       BilibiliCredentialStore
	client      BilibiliClient
	cipher      TokenCipher
	redirectURL string
	clock       func() time.Time
}

func NewBilibiliOAuthService(store BilibiliCredentialStore, client BilibiliClient, cipher TokenCipher, redirectURL string) *BilibiliOAuthService {
	return &BilibiliOAuthService{store: store, client: client, cipher: cipher, redirectURL: redirectURL, clock: time.Now}
}

func (s *BilibiliOAuthService) AuthorizationURL(ctx context.Context, createdBy string) (string, error) {
	createdBy = strings.TrimSpace(createdBy)
	if s == nil || s.store == nil || s.client == nil || createdBy == "" {
		return "", ErrInvalidRequest
	}
	state, err := randomOAuthStateValue()
	if err != nil {
		return "", err
	}
	now := s.clock().UTC()
	hash := sha256.Sum256([]byte(state))
	if err := s.store.SaveBilibiliOAuthState(ctx, hash[:], createdBy, now.Add(bilibiliOAuthStateTTL), now); err != nil {
		return "", fmt.Errorf("%w: %v", ErrBilibiliOAuthStateUnavailable, err)
	}
	return s.client.AuthorizationURL(s.redirectURL, state), nil
}

func (s *BilibiliOAuthService) HandleCallback(ctx context.Context, code, state string) (Source, error) {
	code, state = strings.TrimSpace(code), strings.TrimSpace(state)
	if s == nil || s.store == nil || s.client == nil || s.cipher == nil || code == "" || state == "" {
		return Source{}, ErrInvalidRequest
	}
	now := s.clock().UTC()
	hash := sha256.Sum256([]byte(state))
	if _, err := s.store.ConsumeBilibiliOAuthState(ctx, hash[:], now); err != nil {
		return Source{}, err
	}
	token, err := s.client.ExchangeToken(ctx, code, s.redirectURL)
	if err != nil {
		return Source{}, err
	}
	scopes, err := s.client.Scopes(ctx, token.AccessToken)
	if err != nil || !hasRequiredBilibiliScopes(scopes) {
		return Source{}, ErrBilibiliReauthRequired
	}
	account, err := s.client.AccountInfo(ctx, token.AccessToken)
	if err != nil {
		return Source{}, err
	}
	if strings.TrimSpace(account.OpenID) == "" {
		return Source{}, errors.New("bilibili account response is invalid")
	}
	accessCiphertext, err := s.cipher.Encrypt([]byte(token.AccessToken))
	if err != nil {
		return Source{}, err
	}
	refreshCiphertext, err := s.cipher.Encrypt([]byte(token.RefreshToken))
	if err != nil {
		return Source{}, err
	}
	return s.store.UpsertBilibiliAuthorization(ctx, BilibiliAuthorization{
		AccountInfo: account, AccessTokenCiphertext: accessCiphertext, RefreshTokenCiphertext: refreshCiphertext,
		TokenExpiresAt: time.Unix(token.ExpiresAtUnix, 0).UTC(), Scopes: scopes,
	}, now)
}

func (s *BilibiliOAuthService) HandleDeauthorize(ctx context.Context, openID string) error {
	openID = strings.TrimSpace(openID)
	if s == nil || s.store == nil || openID == "" {
		return ErrInvalidRequest
	}
	return s.store.DisableBilibiliAuthorization(ctx, openID, s.clock().UTC())
}

func (s *BilibiliOAuthService) AccessToken(ctx context.Context, sourceID string) (string, error) {
	if s == nil || s.store == nil || s.client == nil || s.cipher == nil || strings.TrimSpace(sourceID) == "" {
		return "", ErrInvalidRequest
	}
	for attempt := 0; attempt < 2; attempt++ {
		credential, err := s.store.GetBilibiliCredential(ctx, sourceID)
		if err != nil {
			return "", err
		}
		now := s.clock().UTC()
		if credential.TokenExpiresAt.After(now.Add(bilibiliTokenRefreshAdvance)) {
			return decryptBilibiliToken(s.cipher, credential.AccessTokenCiphertext)
		}
		refreshToken, err := decryptBilibiliToken(s.cipher, credential.RefreshTokenCiphertext)
		if err != nil {
			return "", err
		}
		refreshed, err := s.client.RefreshToken(ctx, refreshToken)
		if err != nil {
			return "", ErrBilibiliReauthRequired
		}
		accessCiphertext, err := s.cipher.Encrypt([]byte(refreshed.AccessToken))
		if err != nil {
			return "", err
		}
		refreshCiphertext, err := s.cipher.Encrypt([]byte(refreshed.RefreshToken))
		if err != nil {
			return "", err
		}
		updated, err := s.store.CompareAndSwapBilibiliCredential(ctx, sourceID, credential.RefreshTokenCiphertext, accessCiphertext, refreshCiphertext, time.Unix(refreshed.ExpiresAtUnix, 0).UTC(), now)
		if err != nil {
			return "", err
		}
		if updated {
			return refreshed.AccessToken, nil
		}
	}
	return "", ErrBilibiliReauthRequired
}

func hasRequiredBilibiliScopes(scopes []string) bool {
	granted := make(map[string]bool, len(scopes))
	for _, scope := range scopes {
		granted[strings.ToUpper(strings.TrimSpace(scope))] = true
	}
	for _, required := range requiredBilibiliScopes {
		if !granted[required] {
			return false
		}
	}
	return true
}

func decryptBilibiliToken(cipher TokenCipher, ciphertext []byte) (string, error) {
	plaintext, err := cipher.Decrypt(ciphertext)
	if err != nil {
		return "", err
	}
	if len(plaintext) == 0 {
		return "", ErrBilibiliReauthRequired
	}
	return string(plaintext), nil
}

func randomOAuthStateValue() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}
