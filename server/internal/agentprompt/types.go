package agentprompt

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

const DefaultID = "default"
const MaxPromptLength = 32 * 1024

var (
	ErrPromptTooLong        = errors.New("agent prompt is too long")
	ErrPromptContainsSecret = errors.New("agent prompt must not contain credentials")
)

type Policy struct {
	Version      int64
	ServerPrompt string
	ClaweePrompt string
	UpdatedBy    string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

type UpdateInput struct {
	ServerPrompt string
	ClaweePrompt string
	UpdatedBy    string
	UpdatedAt    time.Time
}

type Store interface {
	Get(context.Context) (Policy, error)
	Update(context.Context, UpdateInput) (Policy, error)
}

func validatePrompt(prompt string) error {
	if utf8.RuneCountInString(prompt) > MaxPromptLength {
		return ErrPromptTooLong
	}
	lower := strings.ToLower(prompt)
	for _, marker := range []string{
		"authorization:", "bearer ", "api_key", "apikey", "access_token",
		"refresh_token", "client_secret", "password=", "密码=", "token=", "secret=",
	} {
		if strings.Contains(lower, marker) {
			return ErrPromptContainsSecret
		}
	}
	return nil
}

func ValidateInput(input UpdateInput) error {
	if err := validatePrompt(input.ServerPrompt); err != nil {
		return err
	}
	return validatePrompt(input.ClaweePrompt)
}
