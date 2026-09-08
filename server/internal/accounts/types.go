package accounts

import (
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	StatusActive   = "active"
	StatusDisabled = "disabled"

	JWTIssuer         = "claw-identity"
	AudienceFrontend  = "claw-frontend"
	AudienceAdmin     = "claw-admin"
	ClientWeb         = "web"
	ClientElectron    = "electron"
	ClientClaweeAgent = "clawee-agent"
)

type Account struct {
	UserID       string
	Email        string
	Name         string
	PasswordHash string
	Status       string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

func (a Account) DisplayName() string {
	if name := strings.TrimSpace(a.Name); name != "" {
		return name
	}
	if email := strings.TrimSpace(a.Email); email != "" {
		return email
	}
	return strings.TrimSpace(a.UserID)
}

type Session struct {
	SessionID  string
	UserID     string
	AgentID    string
	TokenHash  string
	ExpiresAt  time.Time
	CreatedAt  time.Time
	LastSeenAt *time.Time
}

type AccountAgent struct {
	UserID    string
	AgentID   string
	CreatedAt time.Time
}

type RegisterRequest struct {
	Email    string
	Name     string
	Password string
}

type LoginRequest struct {
	Email    string
	Password string
}

type RegistrationResult struct {
	Account             Account
	NeedsAdminBootstrap bool
}

type JWTClaims struct {
	ClientID string `json:"client_id"`
	AgentID  string `json:"agent_id,omitempty"`
	jwt.RegisteredClaims
}

type Principal struct {
	UserID    string
	AgentID   string
	SessionID string
	Audience  string
	ClientID  string
}

type TokenRequest struct {
	Audience string
	ClientID string
	AgentID  string
}

type IssuedToken struct {
	Token   string
	Session Session
}

type TokenBatch struct {
	Tokens map[string]IssuedToken
}

func (b TokenBatch) Token(audience string) IssuedToken {
	return b.Tokens[audience]
}

type AuthenticatedIdentity struct {
	Account   Account
	Session   Session
	Principal Principal
}

type AccountIdentity struct {
	ProviderType    string
	ProviderKey     string
	ProviderSubject string
	UserID          string
	ExternalUserID  string
	VerifiedAt      time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type OAuthLoginState struct {
	StateHash     string
	ProviderType  string
	ProviderKey   string
	Intent        string
	RedirectTo    string
	BindUserID    string
	AgentID       string
	PKCEChallenge string
	CreatedAt     time.Time
	ExpiresAt     time.Time
}

type OAuthAuthorizationCode struct {
	CodeHash      string
	UserID        string
	AgentID       string
	RedirectURI   string
	PKCEChallenge string
	CreatedAt     time.Time
	ExpiresAt     time.Time
}

type OAuthAuthorizationCodeConsumeRequest struct {
	CodeHash      string
	AgentID       string
	RedirectURI   string
	PKCEChallenge string
	Now           time.Time
}

type ExternalAccountRequest struct {
	Email string
	Name  string
}
