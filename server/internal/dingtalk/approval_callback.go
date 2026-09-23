package dingtalk

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"
)

type ApprovalEvent struct {
	EventType         string `json:"EventType"`
	ProcessInstanceID string `json:"processInstanceId"`
	ProcessCode       string `json:"processCode"`
	Type              string `json:"type"`
	Result            string `json:"result"`
}

type ApprovalCallback struct{ Token, EncodingAESKey string }

func (c ApprovalCallback) key() ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(c.EncodingAESKey + "=")
	if err != nil || len(key) != 32 {
		return nil, errors.New("invalid dingtalk callback key")
	}
	return key, nil
}

func (c ApprovalCallback) signature(timestamp, nonce, encrypted string) string {
	parts := []string{c.Token, timestamp, nonce, encrypted}
	sort.Strings(parts)
	digest := sha1.Sum([]byte(strings.Join(parts, "")))
	return hex.EncodeToString(digest[:])
}

func (c ApprovalCallback) Decode(signature, timestamp, nonce, encrypted string) (ApprovalEvent, string, error) {
	var event ApprovalEvent
	if timestamp == "" || nonce == "" || encrypted == "" || len(signature) != 40 || subtle.ConstantTimeCompare([]byte(strings.ToLower(signature)), []byte(c.signature(timestamp, nonce, encrypted))) != 1 {
		return event, "", errors.New("invalid callback signature")
	}
	key, err := c.key()
	if err != nil {
		return event, "", err
	}
	ciphertext, err := base64.StdEncoding.DecodeString(encrypted)
	if err != nil || len(ciphertext) == 0 || len(ciphertext)%aes.BlockSize != 0 {
		return event, "", errors.New("invalid callback ciphertext")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return event, "", err
	}
	plain := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, key[:aes.BlockSize]).CryptBlocks(plain, ciphertext)
	padding := int(plain[len(plain)-1])
	if padding < 1 || padding > 32 || padding > len(plain) {
		return event, "", errors.New("invalid callback padding")
	}
	for _, value := range plain[len(plain)-padding:] {
		if int(value) != padding {
			return event, "", errors.New("invalid callback padding")
		}
	}
	plain = plain[:len(plain)-padding]
	if len(plain) < 20 {
		return event, "", errors.New("invalid callback payload")
	}
	size := int(binary.BigEndian.Uint32(plain[16:20]))
	if size <= 0 || size > len(plain)-20 {
		return event, "", errors.New("invalid callback payload")
	}
	if err := json.Unmarshal(plain[20:20+size], &event); err != nil {
		return event, "", err
	}
	receiver := string(plain[20+size:])
	if receiver == "" {
		return event, "", errors.New("invalid callback receiver")
	}
	return event, receiver, nil
}

func (c ApprovalCallback) Success(timestamp, nonce, receiver string) (string, string, error) {
	key, err := c.key()
	if err != nil {
		return "", "", err
	}
	plain := make([]byte, 20+len("success")+len(receiver))
	if _, err = io.ReadFull(rand.Reader, plain[:16]); err != nil {
		return "", "", err
	}
	binary.BigEndian.PutUint32(plain[16:20], uint32(len("success")))
	copy(plain[20:], "success")
	copy(plain[20+len("success"):], receiver)
	padding := 32 - len(plain)%32
	for i := 0; i < padding; i++ {
		plain = append(plain, byte(padding))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", "", err
	}
	ciphertext := make([]byte, len(plain))
	cipher.NewCBCEncrypter(block, key[:aes.BlockSize]).CryptBlocks(ciphertext, plain)
	encrypted := base64.StdEncoding.EncodeToString(ciphertext)
	return encrypted, c.signature(timestamp, nonce, encrypted), nil
}
