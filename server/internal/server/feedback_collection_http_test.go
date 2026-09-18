package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/feedback"
	"github.com/krillinai/Clawee/server/internal/server"
)

func consoleSubmissionRequest(t *testing.T, metadata string, screenshots int, cookie *http.Cookie) *http.Request {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	_ = form.WriteField("metadata", metadata)
	for i := 0; i < screenshots; i++ {
		part, err := form.CreatePart(textproto.MIMEHeader{"Content-Disposition": {`form-data; name="screenshots"; filename="private-name.png"`}, "Content-Type": {"image/png"}})
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(bytes.Repeat([]byte("x"), 2<<20))
	}
	_ = form.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/feedback/collect", &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	if cookie != nil {
		req.AddCookie(cookie)
	}
	return req
}

func TestConsoleFeedbackCollectionRequiresAuthenticatedAdmin(t *testing.T) {
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{AccountService: accountSvc})
	cookies := register(t, router, `{"email":"console-admin@example.com","name":"管理员","password":"passw0rd!"}`)
	for _, path := range []string{"/api/v1/admin/feedback/collection-policy", "/api/v1/admin/feedback/collect"} {
		method := http.MethodGet
		if strings.HasSuffix(path, "/collect") {
			method = http.MethodPost
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(method, path, nil))
		if w.Code != 401 {
			t.Fatalf("anonymous request status=%d", w.Code)
		}
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/feedback/collection-policy", nil)
	req.AddCookie(adminCookie(t, cookies))
	router.ServeHTTP(w, req)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"external_feedback_allowed":true`) {
		t.Fatalf("reporting must work without local centre service: %d %s", w.Code, w.Body.String())
	}
	regular, err := accountSvc.Register(context.Background(), accounts.RegisterRequest{Email: "console-user@example.com", Name: "普通用户", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(context.Background(), regular.Account, []accounts.TokenRequest{{Audience: accounts.AudienceAdmin, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	req = consoleSubmissionRequest(t, `{"confirmed":false}`, 0, &http.Cookie{Name: "claw_admin_token", Value: tokens.Token(accounts.AudienceAdmin).Token})
	router.ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatalf("non-admin request status=%d %s", w.Code, w.Body.String())
	}
}

func TestConsoleFeedbackCollectionPolicyAndConsent(t *testing.T) {
	for _, allowed := range []bool{false, true} {
		accountSvc := newTestAccountService(accounts.NewMemoryStore())
		router := newTestRouter(t, server.Options{AccountService: accountSvc, ExternalFeedbackAllowed: &allowed})
		cookies := register(t, router, `{"email":"console-admin@example.com","name":"管理员","password":"passw0rd!"}`)
		w := httptest.NewRecorder()
		req := consoleSubmissionRequest(t, `{"confirmed":false,"accept_partial":false}`, 0, adminCookie(t, cookies))
		router.ServeHTTP(w, req)
		expected := 400
		if !allowed {
			expected = 403
		}
		if w.Code != expected {
			t.Fatalf("policy=%v status=%d %s", allowed, w.Code, w.Body.String())
		}
		if !allowed && !strings.Contains(w.Body.String(), "feedback_policy_disabled") {
			t.Fatal("missing policy rejection")
		}
		if allowed {
			w = httptest.NewRecorder()
			req = consoleSubmissionRequest(t, `{"confirmed":true}`, 0, adminCookie(t, cookies))
			req.Header.Set("Origin", "https://attacker.example")
			router.ServeHTTP(w, req)
			if w.Code != 403 {
				t.Fatalf("foreign origin accepted: %d", w.Code)
			}
		}
	}
}

func TestConsoleFeedbackCollectionValidatesMultipartAndCleansTemporaryFiles(t *testing.T) {
	temporary := t.TempDir()
	t.Setenv("TMPDIR", temporary)
	accountSvc := newTestAccountService(accounts.NewMemoryStore())
	router := newTestRouter(t, server.Options{AccountService: accountSvc})
	cookies := register(t, router, `{"email":"console-admin@example.com","name":"管理员","password":"passw0rd!"}`)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	metadata, _ := json.Marshal(feedback.ConsoleInput{ClientID: "console_test0001", RecoveryToken: strings.Repeat("a", 43), StatusToken: strings.Repeat("b", 43), Description: "异常反馈", OccurredAt: now, SnapshotAt: now, ConfirmedAt: now, Page: "/admin", Confirmed: true, AcceptPartial: true})
	for _, item := range []struct {
		metadata      string
		files, status int
	}{
		{`{"confirmed":false,"confirmed":true}`, 0, 400},
		{`{"confirmed":true,"arbitrary_secret":"private"}`, 0, 400},
		{string(metadata), 6, 413},
		{string(metadata), 1, 400},
	} {
		w := httptest.NewRecorder()
		req := consoleSubmissionRequest(t, item.metadata, item.files, adminCookie(t, cookies))
		router.ServeHTTP(w, req)
		if w.Code != item.status {
			t.Fatalf("multipart status=%d want=%d %s", w.Code, item.status, w.Body.String())
		}
		entries, err := os.ReadDir(temporary)
		if err != nil || len(entries) != 0 {
			t.Fatalf("temporary material left behind: %v %v", entries, err)
		}
	}
}
