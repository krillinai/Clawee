package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/platformbranding"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
)

func TestPlatformBrandingHTTPUpdateAndFallback(t *testing.T) {
	service := platformbranding.NewService(platformbranding.NewMemoryStore())
	router := newTestRouter(t, server.Options{PlatformBrandingService: service})

	detail := doJSON(t, router, http.MethodGet, "/api/v1/admin/platform-branding", "", nil, http.StatusOK)
	if nestedBool(t, detail, "data", "sidebar_logo_configured") || nestedBool(t, detail, "data", "sidebar_compact_logo_configured") {
		t.Fatalf("initial detail = %#v", detail)
	}
	doRequest(t, router, http.MethodGet, "/api/v1/app/platform-branding/sidebar-logo", nil, "", nil, http.StatusNotFound)

	logo := testPNG(t, 12, 8)
	compact := testPNG(t, 8, 12)
	response := brandingMultipartRequest(t, router, map[string]string{
		"sidebar_logo_action": "replace", "sidebar_compact_logo_action": "replace",
	}, map[string][]byte{"sidebar_logo": logo, "sidebar_compact_logo": compact}, nil, http.StatusOK)
	if response.Code != http.StatusOK {
		t.Fatalf("update status = %d body=%s", response.Code, response.Body.String())
	}

	imageResponse := doRequest(t, router, http.MethodGet, "/api/v1/app/platform-branding/sidebar-logo", nil, "", nil, http.StatusOK)
	if imageResponse.Header().Get("Content-Type") != "image/png" || imageResponse.Header().Get("Cache-Control") != "no-store" || !bytes.Equal(imageResponse.Body.Bytes(), logo) {
		t.Fatalf("image response headers=%v body length=%d", imageResponse.Header(), imageResponse.Body.Len())
	}

	rejected := brandingMultipartRequest(t, router, map[string]string{
		"sidebar_logo_action": "reset", "sidebar_compact_logo_action": "replace",
	}, map[string][]byte{"sidebar_compact_logo": []byte("not an image")}, nil, http.StatusBadRequest)
	if rejected.Code != http.StatusBadRequest {
		t.Fatalf("invalid update status = %d body=%s", rejected.Code, rejected.Body.String())
	}
	configuration, err := service.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if configuration.SidebarLogo == nil || configuration.SidebarCompactLogo == nil {
		t.Fatal("invalid multipart request partially changed configuration")
	}
}

func TestPlatformBrandingAdminPermissionAndClientRead(t *testing.T) {
	accountService := newTestAccountService(accounts.NewMemoryStore())
	rbacService := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountService})
	if err := rbacService.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	router := newTestRouter(t, server.Options{
		AccountService: accountService, RBACService: rbacService,
		PlatformBrandingService: platformbranding.NewService(platformbranding.NewMemoryStore()),
	})
	adminCookies := register(t, router, `{"email":"admin@example.com","password":"passw0rd!"}`)
	userCookies := register(t, router, `{"email":"user@example.com","password":"passw0rd!"}`)
	role := doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/roles", `{
		"code":"account_reader",
		"name":"账号查看员",
		"permission_codes":["console:account:read"]
	}`, adminCookies, http.StatusCreated)
	userMe := doJSON(t, router, http.MethodGet, "/api/v1/auth/me", "", userCookies, http.StatusOK)
	doJSON(t, router, http.MethodPost, "/api/v1/admin/rbac/account-roles", `{"user_id":"`+nestedString(t, userMe, "data", "account", "user_id")+`","role_id":"`+nestedString(t, role, "data", "role_id")+`"}`, adminCookies, http.StatusCreated)
	userCookies = loginCookies(t, router, `{"email":"user@example.com","password":"passw0rd!"}`)

	doJSON(t, router, http.MethodGet, "/api/v1/app/platform-branding", "", userCookies, http.StatusOK)
	doJSON(t, router, http.MethodGet, "/api/v1/admin/platform-branding", "", userCookies, http.StatusForbidden)
}

func brandingMultipartRequest(t *testing.T, handler http.Handler, fields map[string]string, files map[string][]byte, cookies []*http.Cookie, wantStatus int) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatal(err)
		}
	}
	for name, content := range files {
		part, err := writer.CreateFormFile(name, name+".png")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return doRequest(t, handler, http.MethodPut, "/api/v1/admin/platform-branding", &body, writer.FormDataContentType(), cookies, wantStatus)
}

func doRequest(t *testing.T, handler http.Handler, method, path string, body *bytes.Buffer, contentType string, cookies []*http.Cookie, wantStatus int) *httptest.ResponseRecorder {
	t.Helper()
	if body == nil {
		body = &bytes.Buffer{}
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, body)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	handler.ServeHTTP(recorder, request)
	if recorder.Code != wantStatus {
		t.Fatalf("%s %s status = %d body=%s, want %d", method, path, recorder.Code, recorder.Body.String(), wantStatus)
	}
	return recorder
}

func nestedBool(t *testing.T, value map[string]any, keys ...string) bool {
	t.Helper()
	var current any = value
	for _, key := range keys {
		object, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("%v is not an object while reading %v", current, keys)
		}
		current = object[key]
	}
	result, ok := current.(bool)
	if !ok {
		encoded, _ := json.Marshal(value)
		t.Fatalf("%s field %v is not boolean", encoded, keys)
	}
	return result
}

func testPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	value := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			value.Set(x, y, color.RGBA{R: 10, G: 30, B: 90, A: 255})
		}
	}
	var output bytes.Buffer
	if err := png.Encode(&output, value); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}
