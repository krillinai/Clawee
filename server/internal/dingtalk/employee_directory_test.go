package dingtalk

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type employeeDirectoryFixture struct{ userID string }

func (f *employeeDirectoryFixture) LookupEmployee(_ context.Context, userID string) (EmployeeProfile, error) {
	f.userID = userID
	return EmployeeProfile{Name: "员工", Phone: "13800000000", EnterpriseUserID: "demo-1"}, nil
}

func TestExternalDirectoryKeepsUnionIDConversionAndSkipsDingTalkDetail(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/user-token":
			writeJSON(t, w, map[string]any{"accessToken": "user-token"})
		case "/me":
			writeJSON(t, w, map[string]any{"unionId": "union-1"})
		case "/app-token":
			writeJSON(t, w, map[string]any{"accessToken": "app-token", "expireIn": 7200})
		case "/by-union":
			writeJSON(t, w, map[string]any{"errcode": 0, "result": map[string]any{"userid": "000123"}})
		default:
			t.Error("DingTalk employee detail must not be queried")
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	client := NewClientWithEndpoints("app", "secret", upstream.Client(), Endpoints{UserToken: upstream.URL + "/user-token", CurrentUser: upstream.URL + "/me", AppToken: upstream.URL + "/app-token", UserByUnionID: upstream.URL + "/by-union", UserDetail: upstream.URL + "/detail"}, time.Now)
	directory := &employeeDirectoryFixture{}
	client.SetEmployeeDirectory(directory)
	member, err := client.ResolveMember(context.Background(), "code")
	if err != nil || directory.userID != "000123" || member.UnionID != "union-1" || member.UserID != "000123" || member.Phone != "13800000000" || member.Email != "" {
		t.Fatalf("member = %#v, %v", member, err)
	}
}
