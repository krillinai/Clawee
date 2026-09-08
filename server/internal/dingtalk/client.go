package dingtalk

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const maxResponseBytes = 1 << 20

type Endpoints struct {
	UserToken     string
	CurrentUser   string
	AppToken      string
	UserByUnionID string
	UserDetail    string
}

func ProductionEndpoints() Endpoints {
	return Endpoints{
		UserToken:     "https://api.dingtalk.com/v1.0/oauth2/userAccessToken",
		CurrentUser:   "https://api.dingtalk.com/v1.0/contact/users/me",
		AppToken:      "https://api.dingtalk.com/v1.0/oauth2/accessToken",
		UserByUnionID: "https://oapi.dingtalk.com/topapi/user/getbyunionid",
		UserDetail:    "https://oapi.dingtalk.com/topapi/v2/user/get",
	}
}

type Client struct {
	clientID     string
	clientSecret string
	httpClient   *http.Client
	endpoints    Endpoints
	clock        func() time.Time

	mu             sync.Mutex
	appToken       string
	appTokenExpiry time.Time
}

func (c *Client) AuthorizationURL(redirectURL, state string) string {
	query := url.Values{
		"client_id": {c.clientID}, "redirect_uri": {redirectURL}, "response_type": {"code"},
		"scope": {"openid"}, "state": {state}, "prompt": {"consent"},
	}
	return "https://login.dingtalk.com/oauth2/auth?" + query.Encode()
}

func NewClient(clientID, clientSecret string, timeout time.Duration) *Client {
	return NewClientWithEndpoints(clientID, clientSecret, &http.Client{Timeout: timeout}, ProductionEndpoints(), time.Now)
}

func NewClientWithEndpoints(clientID, clientSecret string, httpClient *http.Client, endpoints Endpoints, clock func() time.Time) *Client {
	if clock == nil {
		clock = time.Now
	}
	return &Client{clientID: clientID, clientSecret: clientSecret, httpClient: httpClient, endpoints: endpoints, clock: clock}
}

func (c *Client) ResolveMember(ctx context.Context, code string) (Member, error) {
	userToken, err := c.exchangeUserToken(ctx, code)
	if err != nil {
		return Member{}, err
	}
	unionID, fallbackName, err := c.currentUser(ctx, userToken)
	if err != nil {
		return Member{}, err
	}
	appToken, err := c.getAppToken(ctx)
	if err != nil {
		return Member{}, err
	}
	userID, err := c.userIDByUnionID(ctx, appToken, unionID)
	if err != nil {
		return Member{}, err
	}
	name, email, err := c.userDetail(ctx, appToken, userID)
	if err != nil {
		return Member{}, err
	}
	if strings.TrimSpace(name) == "" {
		name = fallbackName
	}
	return Member{UnionID: unionID, UserID: userID, Name: strings.TrimSpace(name), Email: strings.TrimSpace(email)}, nil
}

func (c *Client) exchangeUserToken(ctx context.Context, code string) (string, error) {
	var response struct {
		AccessToken string `json:"accessToken"`
	}
	err := c.doJSON(ctx, "user_token", http.MethodPost, c.endpoints.UserToken, map[string]string{
		"clientId": c.clientID, "clientSecret": c.clientSecret, "code": code, "grantType": "authorization_code",
	}, nil, &response)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(response.AccessToken) == "" {
		return "", &APIError{Step: "user_token", Code: "invalid_response", HTTPStatus: http.StatusOK}
	}
	return response.AccessToken, nil
}

func (c *Client) currentUser(ctx context.Context, userToken string) (string, string, error) {
	var response struct {
		UnionID string `json:"unionId"`
		Nick    string `json:"nick"`
	}
	err := c.doJSON(ctx, "current_user", http.MethodGet, c.endpoints.CurrentUser, nil,
		map[string]string{"x-acs-dingtalk-access-token": userToken}, &response)
	if err != nil {
		return "", "", err
	}
	if strings.TrimSpace(response.UnionID) == "" {
		return "", "", &APIError{Step: "current_user", Code: "invalid_response", HTTPStatus: http.StatusOK}
	}
	return strings.TrimSpace(response.UnionID), strings.TrimSpace(response.Nick), nil
}

func (c *Client) getAppToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.appToken != "" && c.clock().Before(c.appTokenExpiry) {
		return c.appToken, nil
	}
	var response struct {
		AccessToken string `json:"accessToken"`
		ExpireIn    int64  `json:"expireIn"`
	}
	if err := c.doJSON(ctx, "app_token", http.MethodPost, c.endpoints.AppToken,
		map[string]string{"appKey": c.clientID, "appSecret": c.clientSecret}, nil, &response); err != nil {
		return "", err
	}
	if strings.TrimSpace(response.AccessToken) == "" || response.ExpireIn <= 0 {
		return "", &APIError{Step: "app_token", Code: "invalid_response", HTTPStatus: http.StatusOK}
	}
	ttl := response.ExpireIn
	if ttl > 200 {
		ttl -= 200
	}
	c.appToken = response.AccessToken
	c.appTokenExpiry = c.clock().Add(time.Duration(ttl) * time.Second)
	return c.appToken, nil
}

func (c *Client) userIDByUnionID(ctx context.Context, appToken, unionID string) (string, error) {
	var response struct {
		ErrCode int `json:"errcode"`
		Result  struct {
			UserID string `json:"userid"`
		} `json:"result"`
	}
	endpoint := withAccessToken(c.endpoints.UserByUnionID, appToken)
	if err := c.doJSON(ctx, "user_by_union_id", http.MethodPost, endpoint, map[string]string{"unionid": unionID}, nil, &response); err != nil {
		return "", err
	}
	if response.ErrCode != 0 {
		return "", &APIError{Step: "user_by_union_id", Code: fmt.Sprint(response.ErrCode), HTTPStatus: http.StatusOK}
	}
	if strings.TrimSpace(response.Result.UserID) == "" {
		return "", &APIError{Step: "user_by_union_id", Code: "not_found", HTTPStatus: http.StatusOK}
	}
	return strings.TrimSpace(response.Result.UserID), nil
}

func (c *Client) userDetail(ctx context.Context, appToken, userID string) (string, string, error) {
	var response struct {
		ErrCode int `json:"errcode"`
		Result  *struct {
			Name      string `json:"name"`
			OrgEmail  string `json:"org_email"`
			Email     string `json:"email"`
			Extension string `json:"extension"`
		} `json:"result"`
	}
	endpoint := withAccessToken(c.endpoints.UserDetail, appToken)
	if err := c.doJSON(ctx, "user_detail", http.MethodPost, endpoint, map[string]string{"userid": userID}, nil, &response); err != nil {
		return "", "", err
	}
	if response.ErrCode != 0 {
		return "", "", &APIError{Step: "user_detail", Code: fmt.Sprint(response.ErrCode), HTTPStatus: http.StatusOK}
	}
	if response.Result == nil {
		return "", "", &APIError{Step: "user_detail", Code: "invalid_response", HTTPStatus: http.StatusOK}
	}
	email := strings.TrimSpace(response.Result.OrgEmail)
	if email == "" {
		email = strings.TrimSpace(response.Result.Email)
	}
	if email == "" && response.Result.Extension != "" {
		var extension map[string]any
		if json.Unmarshal([]byte(response.Result.Extension), &extension) == nil {
			if value, ok := extension["企业邮箱"].(string); ok {
				email = strings.TrimSpace(value)
			}
		}
	}
	return strings.TrimSpace(response.Result.Name), email, nil
}

func withAccessToken(endpoint, token string) string {
	parsed, _ := url.Parse(endpoint)
	query := parsed.Query()
	query.Set("access_token", token)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func (c *Client) doJSON(ctx context.Context, step, method, endpoint string, input any, headers map[string]string, output any) error {
	var body io.Reader
	if input != nil {
		payload, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return &APIError{Step: step, Code: "transport_error"}
	}
	defer response.Body.Close()
	reader := io.LimitReader(response.Body, maxResponseBytes+1)
	raw, err := io.ReadAll(reader)
	if err != nil || len(raw) > maxResponseBytes {
		return &APIError{Step: step, Code: "invalid_response", HTTPStatus: response.StatusCode}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return parseAPIError(step, response.StatusCode, raw)
	}
	if err := json.Unmarshal(raw, output); err != nil {
		return &APIError{Step: step, Code: "invalid_response", HTTPStatus: response.StatusCode}
	}
	return nil
}

func parseAPIError(step string, status int, raw []byte) error {
	var response struct {
		Code    string `json:"code"`
		ErrCode int    `json:"errcode"`
	}
	_ = json.Unmarshal(raw, &response)
	code := strings.TrimSpace(response.Code)
	if code == "" && response.ErrCode != 0 {
		code = fmt.Sprint(response.ErrCode)
	}
	if code == "" {
		code = "upstream_error"
	}
	return &APIError{Step: step, Code: code, HTTPStatus: status}
}
