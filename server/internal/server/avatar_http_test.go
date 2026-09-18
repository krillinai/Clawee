package server_test

import (
	"bytes"
	"context"
	"image"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/server"
)

func TestAccountAvatarRequiresAuthenticationAndOwnsAccess(t *testing.T) {
	ctx := context.Background()
	accountSvc, rbacSvc := newJWTAccountAndRBAC(t)
	registered, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "avatar-api@example.com", Name: "Avatar", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	router := server.NewRouter(server.Options{AccountService: accountSvc, RBACService: rbacSvc})
	request := func(path, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	if rec := request("/api/v1/auth/avatar", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated avatar status = %d", rec.Code)
	}
	token := tokens.Token(accounts.AudienceFrontend).Token
	if rec := request("/api/v1/auth/avatar/another-user", token); rec.Code != http.StatusForbidden {
		t.Fatalf("other account avatar status = %d", rec.Code)
	}
	rec := request("/api/v1/auth/avatar/"+registered.Account.UserID, token)
	if rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("avatar cache control = %q", rec.Header().Get("Cache-Control"))
	}
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/svg+xml" || !bytes.Contains(rec.Body.Bytes(), []byte("<svg")) {
		t.Fatalf("default avatar response = %d, %s, %s", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
}

func TestAccountAvatarUploadValidationAndReset(t *testing.T) {
	ctx := context.Background()
	accountSvc, rbacSvc := newJWTAccountAndRBAC(t)
	registered, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "avatar-upload@example.com", Name: "Avatar", Password: "passw0rd!"})
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := accountSvc.IssueTokens(ctx, registered.Account, []accounts.TokenRequest{{Audience: accounts.AudienceFrontend, ClientID: accounts.ClientWeb}})
	if err != nil {
		t.Fatal(err)
	}
	token := tokens.Token(accounts.AudienceFrontend).Token
	router := server.NewRouter(server.Options{AccountService: accountSvc, RBACService: rbacSvc})
	upload := func(data []byte) *httptest.ResponseRecorder {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		file, err := writer.CreateFormFile("avatar", "avatar.png")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(data); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/avatar", &body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	for _, invalid := range [][]byte{[]byte("not a PNG"), bytes.Repeat([]byte("x"), (2<<20)+1)} {
		if rec := upload(invalid); rec.Code != http.StatusBadRequest {
			t.Fatalf("invalid upload status = %d, body=%s", rec.Code, rec.Body.String())
		}
	}
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	var jpegData bytes.Buffer
	if err := jpeg.Encode(&jpegData, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	for _, encoded := range [][]byte{data.Bytes(), jpegData.Bytes()} {
		for size := 1; size < len(encoded); size++ {
			truncated := encoded[:size]
			if _, _, err := image.DecodeConfig(bytes.NewReader(truncated)); err != nil {
				continue
			}
			if rec := upload(truncated); rec.Code != http.StatusBadRequest {
				t.Fatalf("truncated image upload status = %d, body=%s", rec.Code, rec.Body.String())
			}
			break
		}
	}
	if rec := upload(data.Bytes()); rec.Code != http.StatusOK {
		t.Fatalf("PNG upload status = %d, body=%s", rec.Code, rec.Body.String())
	}
	avatar, err := accountSvc.AccountAvatar(ctx, registered.Account.UserID)
	if err != nil || avatar.Source != accounts.AvatarSourceUpload || avatar.ContentType != "image/png" || !bytes.Equal(avatar.Data, data.Bytes()) {
		t.Fatalf("uploaded avatar = %#v, %v", avatar, err)
	}
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/avatar", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("reset avatar status = %d, body=%s", rec.Code, rec.Body.String())
	}
	avatar, err = accountSvc.AccountAvatar(ctx, registered.Account.UserID)
	if err != nil || avatar.Source != accounts.AvatarSourceGenerated {
		t.Fatalf("reset avatar = %#v, %v", avatar, err)
	}
}
