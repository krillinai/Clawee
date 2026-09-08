package businessdata

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBilibiliSignatureFixedVectorAndEmptyBodyMD5(t *testing.T) {
	headers := bilibiliSignatureHeaders("client-id", nil, 1_700_000_000, "nonce-fixed")
	emptyDigest := md5.Sum(nil)
	if headers["x-bili-content-md5"] != hex.EncodeToString(emptyDigest[:]) {
		t.Fatalf("content md5 = %q", headers["x-bili-content-md5"])
	}
	got := signBilibiliHeaders(map[string]string{
		"x-bili-timestamp": "1700000000", "x-bili-accesskeyid": "client-id",
		"x-bili-signature-version": "2.0", "x-bili-content-md5": headers["x-bili-content-md5"],
		"x-bili-signature-nonce": "nonce-fixed", "x-bili-signature-method": "HMAC-SHA256",
		"access-token": "must-not-be-signed",
	}, "secret")
	const want = "d8a523384ffc77112de36368d1c960ce8abf6af889b9266a4a1e9b2438878e68"
	if got != want {
		t.Fatalf("signature = %q, want %q", got, want)
	}
}

func TestBilibiliSignedGETHeadersAndResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("access-token") != "access" || r.Header.Get("Authorization") == "" || r.Header.Get("x-bili-content-md5") != "d41d8cd98f00b204e9800998ecf8427e" {
			t.Fatalf("unexpected headers: %#v", r.Header)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"openid":"open-1","name":"账号"}}`))
	}))
	defer server.Close()
	client := NewBilibiliHTTPClient("client", "secret", server.Client())
	client.openBaseURL = server.URL
	client.clock = func() time.Time { return time.Unix(1_700_000_000, 0) }
	client.nonce = func() (string, error) { return "nonce", nil }
	account, err := client.AccountInfo(context.Background(), "access")
	if err != nil || account.OpenID != "open-1" {
		t.Fatalf("account=%#v err=%v", account, err)
	}
}

func TestBilibiliTokenRequestsIncludeGrantType(t *testing.T) {
	const expiresAtUnix = int64(1_800_000_000)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		if r.Form.Get("client_id") != "client" || r.Form.Get("client_secret") != "secret" {
			t.Errorf("credentials form=%v", r.Form)
		}
		switch r.URL.Path {
		case "/token":
			if r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("code") != "code" || r.Form.Get("gourl") != "https://gateway.test/callback" {
				t.Errorf("exchange form=%v", r.Form)
			}
		case "/refresh_token":
			if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "refresh" {
				t.Errorf("refresh form=%v", r.Form)
			}
		default:
			t.Errorf("path=%q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"access_token":"access","refresh_token":"refresh","expires_in":1800000000}}`))
	}))
	defer server.Close()

	client := NewBilibiliHTTPClient("client", "secret", server.Client())
	client.oauthBaseURL = server.URL
	for _, call := range []func() (BilibiliToken, error){
		func() (BilibiliToken, error) {
			return client.ExchangeToken(context.Background(), "code", "https://gateway.test/callback")
		},
		func() (BilibiliToken, error) { return client.RefreshToken(context.Background(), "refresh") },
	} {
		token, err := call()
		if err != nil || token.ExpiresAtUnix != expiresAtUnix {
			t.Fatalf("token=%#v err=%v", token, err)
		}
	}
}

func TestBilibiliHTTPErrorMapping(t *testing.T) {
	for status, target := range map[int]error{http.StatusUnauthorized: ErrBilibiliReauthRequired, http.StatusTooManyRequests: ErrBilibiliRateLimited} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) }))
			defer server.Close()
			client := NewBilibiliHTTPClient("client", "secret", server.Client())
			client.openBaseURL = server.URL
			if _, err := client.AccountInfo(context.Background(), "access"); !errors.Is(err, target) {
				t.Fatalf("error=%v, want %v", err, target)
			}
		})
	}
}
