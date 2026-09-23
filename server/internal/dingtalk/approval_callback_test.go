package dingtalk

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"testing"
)

func TestApprovalCallbackVerifiesEncryptedEventAndReply(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	codec := ApprovalCallback{Token: "callback-token", EncodingAESKey: base64.StdEncoding.EncodeToString(key)[:43]}
	message := []byte(`{"EventType":"bpms_instance_change","processInstanceId":"instance-1","processCode":"PROC","type":"finish","result":"agree"}`)
	receiver := "enterprise-1"
	plain := make([]byte, 20+len(message)+len(receiver))
	binary.BigEndian.PutUint32(plain[16:20], uint32(len(message)))
	copy(plain[20:], message)
	copy(plain[20+len(message):], receiver)
	padding := 32 - len(plain)%32
	for i := 0; i < padding; i++ {
		plain = append(plain, byte(padding))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	ciphertext := make([]byte, len(plain))
	cipher.NewCBCEncrypter(block, key[:16]).CryptBlocks(ciphertext, plain)
	encrypted := base64.StdEncoding.EncodeToString(ciphertext)
	event, gotReceiver, err := codec.Decode(codec.signature("123", "nonce", encrypted), "123", "nonce", encrypted)
	if err != nil || event.ProcessInstanceID != "instance-1" || gotReceiver != receiver {
		t.Fatalf("decoded event=%#v receiver=%q err=%v", event, gotReceiver, err)
	}
	if _, _, err := codec.Decode(codec.signature("123", "nonce", encrypted), "123", "other", encrypted); err == nil {
		t.Fatal("tampered nonce accepted")
	}
	reply, signature, err := codec.Success("123", "nonce", receiver)
	if err != nil || signature != codec.signature("123", "nonce", reply) {
		t.Fatalf("reply signature=%q error=%v", signature, err)
	}
}
