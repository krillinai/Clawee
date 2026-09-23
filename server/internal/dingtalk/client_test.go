package dingtalk

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type avatarRoundTripper func(*http.Request) (*http.Response, error)

func (f avatarRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestFetchAvatarValidatesCompleteImages(t *testing.T) {
	for _, format := range []string{"png", "jpeg"} {
		t.Run(format, func(t *testing.T) {
			var encoded bytes.Buffer
			picture := image.NewRGBA(image.Rect(0, 0, 2, 2))
			var err error
			if format == "png" {
				err = png.Encode(&encoded, picture)
			} else {
				err = jpeg.Encode(&encoded, picture, nil)
			}
			if err != nil {
				t.Fatal(err)
			}
			data := encoded.Bytes()
			httpClient := &http.Client{Transport: avatarRoundTripper(func(_ *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(data)), Header: make(http.Header)}, nil
			})}
			client := NewClientWithEndpoints("app", "secret", httpClient, Endpoints{}, time.Now)
			actual, contentType, err := client.FetchAvatar(context.Background(), "https://static.dingtalk.com/avatar")
			if err != nil || !bytes.Equal(actual, data) || contentType != "image/"+format {
				t.Fatalf("valid avatar: content type=%q, error=%v", contentType, err)
			}
			for size := 1; size < len(encoded.Bytes()); size++ {
				data = encoded.Bytes()[:size]
				if _, _, err := image.DecodeConfig(bytes.NewReader(data)); err != nil {
					continue
				}
				if _, _, err := client.FetchAvatar(context.Background(), "https://static.dingtalk.com/avatar"); err == nil {
					t.Fatal("truncated avatar was accepted")
				}
				break
			}
		})
	}
}

func TestTrustedAvatarURL(t *testing.T) {
	for _, test := range []struct {
		url     string
		trusted bool
	}{
		{url: "https://static.dingtalk.com/media/avatar.png", trusted: true},
		{url: "http://static.dingtalk.com/media/avatar.png"},
		{url: "https://dingtalk.com.attacker.example/avatar.png"},
		{url: "https://127.0.0.1/avatar.png"},
		{url: "https://user@static.dingtalk.com/avatar.png"},
		{url: "https://static.dingtalk.com:443/avatar.png"},
	} {
		t.Run(test.url, func(t *testing.T) {
			parsed, err := url.Parse(test.url)
			if err != nil {
				t.Fatal(err)
			}
			if trustedAvatarURL(parsed) != test.trusted {
				t.Fatalf("trustedAvatarURL(%q) != %v", test.url, test.trusted)
			}
		})
	}
}

func TestResolveMemberUsesFourStepFlowAndCachesAppToken(t *testing.T) {
	var appTokenCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/user-token":
			writeJSON(t, w, map[string]any{"accessToken": "user-token"})
		case "/me":
			if r.Header.Get("x-acs-dingtalk-access-token") != "user-token" {
				t.Fatal("missing user token header")
			}
			writeJSON(t, w, map[string]any{"unionId": "union-1", "nick": "昵称", "avatarUrl": "https://img.dingtalk.com/avatar.jpg"})
		case "/app-token":
			appTokenCalls.Add(1)
			writeJSON(t, w, map[string]any{"accessToken": "app-token", "expireIn": 7200})
		case "/by-union":
			if r.URL.Query().Get("access_token") != "app-token" {
				t.Fatal("missing app token query")
			}
			writeJSON(t, w, map[string]any{"errcode": 0, "result": map[string]any{"userid": "staff-1"}})
		case "/detail":
			writeJSON(t, w, map[string]any{"errcode": 0, "result": map[string]any{"name": "成员", "org_email": "member@example.com"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := NewClientWithEndpoints("app", "secret", server.Client(), Endpoints{
		UserToken: server.URL + "/user-token", CurrentUser: server.URL + "/me", AppToken: server.URL + "/app-token",
		UserByUnionID: server.URL + "/by-union", UserDetail: server.URL + "/detail",
	}, time.Now)
	for range 2 {
		member, err := client.ResolveMember(context.Background(), "code")
		if err != nil {
			t.Fatal(err)
		}
		if member != (Member{UnionID: "union-1", UserID: "staff-1", Name: "成员", Email: "member@example.com", AvatarURL: "https://img.dingtalk.com/avatar.jpg"}) {
			t.Fatalf("member = %#v", member)
		}
	}
	if appTokenCalls.Load() != 1 {
		t.Fatalf("app token calls = %d, want 1", appTokenCalls.Load())
	}
}

func TestGetApprovalIncludesBindingEvidence(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/app-token":
			writeJSON(t, w, map[string]any{"accessToken": "app-token", "expireIn": 7200})
		case "/approval":
			writeJSON(t, w, map[string]any{"result": map[string]any{
				"processInstanceId": "instance-1", "processCode": "PROC-1", "originatorUserId": "staff-1",
				"status": "COMPLETED", "result": "agree",
				"formComponentValues": []map[string]string{{"name": "包 SHA-256", "value": "sha-1"}},
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := NewClientWithEndpoints("app", "secret", server.Client(), Endpoints{
		AppToken: server.URL + "/app-token", GetProcess: server.URL + "/approval",
	}, time.Now)
	detail, err := client.GetApproval(context.Background(), "instance-1")
	if err != nil || detail.OriginatorUserID != "staff-1" || len(detail.FormComponentValues) != 1 || detail.FormComponentValues[0].Value != "sha-1" {
		t.Fatalf("approval binding evidence: %#v, %v", detail, err)
	}
}

func TestResolveMemberMapsEnterpriseRejection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/user-token":
			writeJSON(t, w, map[string]any{"accessToken": "user-token"})
		case "/me":
			writeJSON(t, w, map[string]any{"unionId": "union-1"})
		case "/app-token":
			writeJSON(t, w, map[string]any{"accessToken": "app-token", "expireIn": 7200})
		case "/by-union":
			writeJSON(t, w, map[string]any{"errcode": 60011, "errmsg": "not found"})
		}
	}))
	defer server.Close()
	client := NewClientWithEndpoints("app", "secret", server.Client(), Endpoints{
		UserToken: server.URL + "/user-token", CurrentUser: server.URL + "/me", AppToken: server.URL + "/app-token",
		UserByUnionID: server.URL + "/by-union", UserDetail: server.URL + "/detail",
	}, time.Now)
	_, err := client.ResolveMember(context.Background(), "code")
	if !IsNotEnterpriseMember(err) {
		t.Fatalf("error = %v, want enterprise rejection", err)
	}
}

func TestResolveMemberRejectsMissingStaffResult(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/user-token":
			writeJSON(t, w, map[string]any{"accessToken": "user-token"})
		case "/me":
			writeJSON(t, w, map[string]any{"unionId": "union-1"})
		case "/app-token":
			writeJSON(t, w, map[string]any{"accessToken": "app-token", "expireIn": 7200})
		case "/by-union":
			writeJSON(t, w, map[string]any{"errcode": 0, "result": map[string]any{"userid": "staff-1"}})
		case "/detail":
			writeJSON(t, w, map[string]any{"errcode": 0})
		}
	}))
	defer server.Close()
	client := NewClientWithEndpoints("app", "secret", server.Client(), Endpoints{
		UserToken: server.URL + "/user-token", CurrentUser: server.URL + "/me", AppToken: server.URL + "/app-token",
		UserByUnionID: server.URL + "/by-union", UserDetail: server.URL + "/detail",
	}, time.Now)
	if _, err := client.ResolveMember(context.Background(), "code"); err == nil {
		t.Fatal("missing staff result error = nil")
	}
}

func TestClientRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", maxResponseBytes+1)))
	}))
	defer server.Close()
	client := NewClientWithEndpoints("app", "secret", server.Client(), Endpoints{UserToken: server.URL}, time.Now)
	if _, err := client.exchangeUserToken(context.Background(), "code"); err == nil {
		t.Fatal("oversized response error = nil")
	}
}

func TestClientRejectsTimeoutAndInvalidJSON(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			time.Sleep(50 * time.Millisecond)
			writeJSON(t, w, map[string]any{"accessToken": "late"})
		}))
		defer server.Close()
		client := NewClientWithEndpoints("app", "secret", &http.Client{Timeout: time.Millisecond}, Endpoints{UserToken: server.URL}, time.Now)
		if _, err := client.exchangeUserToken(context.Background(), "code"); err == nil {
			t.Fatal("timeout error = nil")
		}
	})
	t.Run("invalid json", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("not-json"))
		}))
		defer server.Close()
		client := NewClientWithEndpoints("app", "secret", server.Client(), Endpoints{UserToken: server.URL}, time.Now)
		if _, err := client.exchangeUserToken(context.Background(), "code"); err == nil {
			t.Fatal("invalid json error = nil")
		}
	})
}

func TestStaffEmailPriority(t *testing.T) {
	for _, test := range []struct {
		name      string
		result    map[string]any
		wantEmail string
	}{
		{name: "org email", result: map[string]any{"org_email": "org@example.com", "email": "plain@example.com", "extension": `{"企业邮箱":"extension@example.com"}`}, wantEmail: "org@example.com"},
		{name: "email", result: map[string]any{"email": "plain@example.com", "extension": `{"企业邮箱":"extension@example.com"}`}, wantEmail: "plain@example.com"},
		{name: "extension", result: map[string]any{"extension": `{"企业邮箱":"extension@example.com"}`}, wantEmail: "extension@example.com"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(t, w, map[string]any{"errcode": 0, "result": test.result})
			}))
			defer server.Close()
			client := NewClientWithEndpoints("app", "secret", server.Client(), Endpoints{UserDetail: server.URL}, time.Now)
			_, email, _, err := client.userDetail(context.Background(), "app-token", "staff-1")
			if err != nil || email != test.wantEmail {
				t.Fatalf("email = %q, error = %v; want %q", email, err, test.wantEmail)
			}
		})
	}
}

func TestAppTokenRefreshesEarlyAndOnlyOnceConcurrently(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		call := calls.Add(1)
		time.Sleep(10 * time.Millisecond)
		writeJSON(t, w, map[string]any{"accessToken": "token-" + string(rune('0'+call)), "expireIn": 300})
	}))
	defer server.Close()
	now := time.Unix(1_700_000_000, 0)
	client := NewClientWithEndpoints("app", "secret", server.Client(), Endpoints{AppToken: server.URL}, func() time.Time { return now })
	first, err := client.getAppToken(context.Background())
	if err != nil || first != "token-1" {
		t.Fatalf("first token=%q err=%v", first, err)
	}
	now = now.Add(99 * time.Second)
	if token, err := client.getAppToken(context.Background()); err != nil || token != first || calls.Load() != 1 {
		t.Fatalf("cached token=%q calls=%d err=%v", token, calls.Load(), err)
	}
	now = now.Add(time.Second)

	const workers = 12
	var wait sync.WaitGroup
	wait.Add(workers)
	errors := make(chan error, workers)
	for range workers {
		go func() {
			defer wait.Done()
			token, err := client.getAppToken(context.Background())
			if err != nil {
				errors <- err
				return
			}
			if token != "token-2" {
				errors <- &APIError{Step: "test", Code: "unexpected_token"}
			}
		}()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("app token calls=%d, want 2", calls.Load())
	}
}

func writeJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Fatal(err)
	}
}
