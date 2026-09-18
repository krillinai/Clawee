package server_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/accounts"
	"github.com/krillinai/Clawee/server/internal/dingtalk"
	"github.com/krillinai/Clawee/server/internal/rbac"
	"github.com/krillinai/Clawee/server/internal/server"
)

type fakeDingTalkAvatarClient struct {
	fakeDingTalkClient
	avatarCalls *int
	avatarErr   error
}

func (f fakeDingTalkAvatarClient) FetchAvatar(_ context.Context, avatarURL string) ([]byte, string, error) {
	(*f.avatarCalls)++
	if avatarURL != "https://static.dingtalk.com/avatar.png" {
		return nil, "", errors.New("unexpected avatar URL")
	}
	return []byte("dingtalk-avatar"), "image/png", f.avatarErr
}

type avatarReadErrorStore struct {
	accounts.Store
}

func (s avatarReadErrorStore) GetAccountAvatar(context.Context, string) (accounts.AccountAvatar, error) {
	return accounts.AccountAvatar{}, errors.New("avatar unavailable")
}

func TestDingTalkLoginSyncsOnlyDefaultAvatar(t *testing.T) {
	for _, mode := range []string{"web", "clawee"} {
		for _, test := range []struct {
			name      string
			source    string
			avatarURL string
			fetchErr  error
			readErr   bool
			wantCalls int
			wantSync  bool
		}{
			{name: "default", wantCalls: 1, wantSync: true},
			{name: "uploaded", source: accounts.AvatarSourceUpload},
			{name: "already_synced", source: accounts.AvatarSourceDingTalk},
			{name: "no_dingtalk_avatar", avatarURL: " "},
			{name: "download_failed", fetchErr: errors.New("download failed"), wantCalls: 1},
			{name: "read_failed", readErr: true},
		} {
			t.Run(mode+"/"+test.name, func(t *testing.T) {
				ctx := context.Background()
				store := accounts.NewMemoryStore()
				var accountStore accounts.Store = store
				if test.readErr {
					accountStore = avatarReadErrorStore{Store: store}
				}
				accountSvc := accounts.NewService(accounts.Config{Store: accountStore, JWTSigningKey: []byte(testJWTKey)})
				registered, err := accountSvc.Register(ctx, accounts.RegisterRequest{Email: "avatar@example.com", Name: "成员", Password: "passw0rd!"})
				if err != nil {
					t.Fatal(err)
				}
				userID := registered.Account.UserID
				if test.source != "" {
					if err := accountSvc.SaveAccountAvatar(ctx, userID, accounts.AccountAvatar{
						Data: []byte("existing-avatar"), ContentType: "image/png", Source: test.source,
					}); err != nil {
						t.Fatal(err)
					}
				}
				before, err := store.GetAccountAvatar(ctx, userID)
				if err != nil {
					t.Fatal(err)
				}
				if err := accountSvc.BindExternalIdentity(ctx, userID, accounts.AccountIdentity{
					ProviderType: "dingtalk", ProviderKey: "default", ProviderSubject: "union-avatar",
					ExternalUserID: "staff-avatar", VerifiedAt: time.Now().UTC(),
				}); err != nil {
					t.Fatal(err)
				}
				rbacSvc := rbac.NewService(rbac.Config{Store: rbac.NewMemoryStore(), Accounts: accountSvc})
				if err := rbacSvc.Initialize(ctx); err != nil {
					t.Fatal(err)
				}
				avatarURL := test.avatarURL
				if avatarURL == "" {
					avatarURL = "https://static.dingtalk.com/avatar.png"
				}
				calls := 0
				router := server.NewRouter(server.Options{
					AccountService: accountSvc, RBACService: rbacSvc,
					DingTalkAuth: server.DingTalkAuthOptions{
						Enabled: true, ProviderKey: "default", RedirectURL: "http://gateway.test/api/v1/auth/dingtalk/callback",
						StateTTL: 10 * time.Minute, Client: fakeDingTalkAvatarClient{
							fakeDingTalkClient: fakeDingTalkClient{member: dingtalk.Member{
								UnionID: "union-avatar", UserID: "staff-avatar", AvatarURL: avatarURL,
							}}, avatarCalls: &calls, avatarErr: test.fetchErr,
						},
					},
				})
				startURL := "/api/v1/auth/dingtalk/start?redirect=/app/agents"
				if mode == "clawee" {
					startURL = claweeDingTalkStartURL("clawee_avatar_agent", "http://127.0.0.1:49152/enterprise/dingtalk/callback",
						dingTalkTestSecret('c'), "S256", dingTalkTestSecret('s'))
				}
				start := httptest.NewRecorder()
				router.ServeHTTP(start, httptest.NewRequest(http.MethodGet, startURL, nil))
				stateCookie := cookieByName(t, start.Result().Cookies(), "claw_dingtalk_oauth_state")
				callback := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/dingtalk/callback?code=code&state="+url.QueryEscape(stateCookie.Value), nil)
				request.AddCookie(stateCookie)
				router.ServeHTTP(callback, request)
				location, err := url.Parse(callback.Header().Get("Location"))
				if err != nil || callback.Code != http.StatusFound ||
					(mode == "web" && location.Path != "/app/agents") ||
					(mode == "clawee" && location.Query().Get("code") == "") {
					t.Fatalf("login status=%d location=%q error=%v", callback.Code, callback.Header().Get("Location"), err)
				}
				if calls != test.wantCalls {
					t.Fatalf("avatar downloads=%d, want %d", calls, test.wantCalls)
				}
				after, err := store.GetAccountAvatar(ctx, userID)
				if err != nil {
					t.Fatal(err)
				}
				if test.wantSync {
					if after.Source != accounts.AvatarSourceDingTalk || after.ContentType != "image/png" || string(after.Data) != "dingtalk-avatar" {
						t.Fatalf("synced avatar=%#v", after)
					}
				} else if after.Source != before.Source || after.ContentType != before.ContentType || string(after.Data) != string(before.Data) {
					t.Fatal("existing avatar was replaced")
				}
			})
		}
	}
}
