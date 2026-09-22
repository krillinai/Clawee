package server

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"

	"github.com/krillinai/Clawee/server/internal/accounts"
)

// An existing owner keeps the installation ID; other accounts get a stable ID.
func accountScopedAgentID(ctx context.Context, accountSvc *accounts.Service, userID, installationID string) (string, error) {
	owner, err := accountSvc.AccountForAgent(ctx, installationID)
	if err == nil {
		if owner.UserID == userID {
			return installationID, nil
		}
	} else if !errors.Is(err, accounts.ErrAccountAgentNotFound) {
		return "", err
	}

	hash := sha256.Sum256([]byte(installationID + ":" + userID))
	hash[6] = (hash[6] & 0x0f) | 0x50
	hash[8] = (hash[8] & 0x3f) | 0x80
	return fmt.Sprintf("clawee_%x-%x-%x-%x-%x", hash[:4], hash[4:6], hash[6:8], hash[8:10], hash[10:16]), nil
}
