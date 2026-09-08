package mcpgateway

import (
	"crypto/sha256"
	"encoding/hex"
)

type SessionKeyInput struct {
	InboundSessionID string
	AgentID          string
	ActorID          string
	TenantID         string
	UpstreamServerID string
	BearerToken      string
}

func NewSessionKey(input SessionKeyInput) SessionKey {
	return SessionKey{
		InboundSessionID: input.InboundSessionID,
		AgentID:          input.AgentID,
		ActorID:          input.ActorID,
		TenantID:         input.TenantID,
		UpstreamServerID: input.UpstreamServerID,
		TokenHash:        HashToken(input.BearerToken),
	}
}

func HashToken(token string) string {
	if token == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
