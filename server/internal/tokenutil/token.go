package tokenutil

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
)

func Generate32(prefix string) (string, error) {
	if prefix != "agt_" && prefix != "col_" {
		return "", errors.New("unsupported token prefix")
	}
	var random [21]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(random[:]), nil
}
