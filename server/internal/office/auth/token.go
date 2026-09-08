package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"strings"
)

func BearerToken(header string) (string, bool) {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	if token == "" || strings.Contains(token, " ") {
		return "", false
	}
	return token, true
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func CompareToken(hash string, token string) bool {
	got := HashToken(token)
	return subtle.ConstantTimeCompare([]byte(hash), []byte(got)) == 1
}

func GenerateToken(prefix string, byteCount int) (string, error) {
	if byteCount <= 0 {
		return "", errors.New("byteCount must be positive")
	}
	buf := make([]byte, byteCount)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(buf), nil
}
