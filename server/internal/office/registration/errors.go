package registration

import "errors"

var (
	ErrInvalidRegistrationCode  = errors.New("registration code is invalid")
	ErrRegistrationCodeExpired  = errors.New("registration code is expired")
	ErrRegistrationCodeRevoked  = errors.New("registration code is revoked")
	ErrRegistrationOwnerInvalid = errors.New("registration code owner is invalid")
	ErrAgentIDConflict          = errors.New("agent ID belongs to another account")
)
