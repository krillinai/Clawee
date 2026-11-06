package accounts

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/textutil"
)

func NormalizePhone(value string) string {
	value = textutil.CleanInputIdentifier(value)
	value = strings.TrimPrefix(strings.TrimPrefix(value, "+86"), "0086")
	if len(value) != 11 || value[0] != '1' || value[1] < '3' || value[1] > '9' {
		return ""
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return ""
		}
	}
	return value
}

func (s *MemoryStore) GetAccountByPhone(ctx context.Context, phone string) (Account, error) {
	if err := ctx.Err(); err != nil {
		return Account{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	userID, ok := s.phoneToUserID[phone]
	if !ok {
		return Account{}, ErrAccountNotFound
	}
	return s.accounts[userID], nil
}

func (s *MemoryStore) UpdateExternalAccountProfile(ctx context.Context, userID, phone, name string, updatedAt time.Time) (Account, error) {
	if err := ctx.Err(); err != nil {
		return Account{}, err
	}
	s.bootstrapMu.Lock()
	defer s.bootstrapMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	account, ok := s.accounts[userID]
	if !ok {
		return Account{}, ErrAccountNotFound
	}
	if account.Status != StatusActive {
		return Account{}, ErrAccountNotActive
	}
	if owner, ok := s.phoneToUserID[phone]; ok && owner != userID {
		return Account{}, ErrPhoneExists
	}
	delete(s.phoneToUserID, account.Phone)
	account.Phone = phone
	if name != "" {
		account.Name = name
	}
	account.UpdatedAt = updatedAt
	s.accounts[userID] = account
	s.phoneToUserID[phone] = userID
	return account, nil
}

func (s *Service) SyncExternalAccountProfile(ctx context.Context, identity AccountIdentity, req ExternalAccountRequest) (Account, error) {
	identity = normalizeIdentity(identity)
	if !validIdentity(identity) || NormalizePhone(req.Phone) == "" {
		return Account{}, ErrInvalidAccountRequest
	}
	var account Account
	err := s.store.WithExternalIdentityLock(ctx, identity.ProviderType, identity.ProviderKey, identity.ProviderSubject, func(ctx context.Context) error {
		existing, err := s.store.GetAccountIdentity(ctx, identity.ProviderType, identity.ProviderKey, identity.ProviderSubject)
		if err != nil {
			return err
		}
		if existing.EnterpriseUserID != "" && existing.EnterpriseUserID != identity.EnterpriseUserID {
			return ErrExternalAccountConflict
		}
		account, err = s.store.GetAccount(ctx, existing.UserID)
		if err != nil {
			return err
		}
		if account.Status != StatusActive {
			return ErrAccountNotActive
		}
		account, err = s.store.UpdateExternalAccountProfile(ctx, account.UserID, NormalizePhone(req.Phone), normalizeAccountName(req.Name), s.clock().UTC())
		if err != nil {
			if errors.Is(err, ErrPhoneExists) {
				return ErrExternalAccountConflict
			}
			return err
		}
		identity.UpdatedAt = account.UpdatedAt
		return s.store.UpdateAccountIdentityVerification(ctx, identity)
	})
	return account, err
}
