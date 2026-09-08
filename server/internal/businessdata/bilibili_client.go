package businessdata

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	bilibiliOAuthBaseURL = "https://api.bilibili.com/x/account-oauth2/v1"
	bilibiliOpenBaseURL  = "https://member.bilibili.com/arcopen/fn"
)

type BilibiliToken struct {
	AccessToken   string
	RefreshToken  string
	ExpiresAtUnix int64
}

type BilibiliAccountInfo struct {
	OpenID string `json:"openid"`
	Name   string `json:"name"`
}

type BilibiliUserStat struct {
	Follower       int64
	Following      int64
	ArcPassedTotal int64
}

type BilibiliArchive struct {
	ResourceID string
	Title      string
	State      int64
	PTime      int64
}

type BilibiliArchiveStat struct {
	View     int64
	Danmaku  int64
	Reply    int64
	Favorite int64
	Coin     int64
	Share    int64
	Like     int64
}

type BilibiliClient interface {
	AuthorizationURL(redirectURL, state string) string
	ExchangeToken(context.Context, string, string) (BilibiliToken, error)
	RefreshToken(context.Context, string) (BilibiliToken, error)
	Scopes(context.Context, string) ([]string, error)
	AccountInfo(context.Context, string) (BilibiliAccountInfo, error)
	UserStat(context.Context, string) (BilibiliUserStat, error)
	Archives(context.Context, string, int, int) ([]BilibiliArchive, error)
	ArchiveStat(context.Context, string, string) (BilibiliArchiveStat, error)
}

type BilibiliHTTPClient struct {
	clientID, clientSecret string
	httpClient             *http.Client
	oauthBaseURL           string
	openBaseURL            string
	clock                  func() time.Time
	nonce                  func() (string, error)
}

func NewBilibiliHTTPClient(clientID, clientSecret string, httpClient *http.Client) *BilibiliHTTPClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &BilibiliHTTPClient{
		clientID: strings.TrimSpace(clientID), clientSecret: clientSecret, httpClient: httpClient,
		oauthBaseURL: bilibiliOAuthBaseURL, openBaseURL: bilibiliOpenBaseURL,
		clock: time.Now, nonce: randomBilibiliNonce,
	}
}

func (c *BilibiliHTTPClient) AuthorizationURL(redirectURL, state string) string {
	query := url.Values{"client_id": {c.clientID}, "gourl": {redirectURL}, "state": {state}}
	return "https://account.bilibili.com/pc/account-pc/auth/oauth?" + query.Encode()
}

func (c *BilibiliHTTPClient) ExchangeToken(ctx context.Context, code, redirectURL string) (BilibiliToken, error) {
	return c.tokenRequest(ctx, "/token", url.Values{
		"client_id": {c.clientID}, "client_secret": {c.clientSecret}, "grant_type": {"authorization_code"}, "code": {code}, "gourl": {redirectURL},
	})
}

func (c *BilibiliHTTPClient) RefreshToken(ctx context.Context, refreshToken string) (BilibiliToken, error) {
	return c.tokenRequest(ctx, "/refresh_token", url.Values{
		"client_id": {c.clientID}, "client_secret": {c.clientSecret}, "grant_type": {"refresh_token"}, "refresh_token": {refreshToken},
	})
}

func (c *BilibiliHTTPClient) tokenRequest(ctx context.Context, path string, form url.Values) (BilibiliToken, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.oauthBaseURL+path, strings.NewReader(form.Encode()))
	if err != nil {
		return BilibiliToken{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	var data struct {
		AccessToken  string        `json:"access_token"`
		RefreshToken string        `json:"refresh_token"`
		ExpiresIn    bilibiliInt64 `json:"expires_in"`
	}
	if err := c.doJSON(req, &data); err != nil {
		return BilibiliToken{}, err
	}
	if data.AccessToken == "" || data.RefreshToken == "" || data.ExpiresIn <= 0 {
		return BilibiliToken{}, errors.New("bilibili token response is invalid")
	}
	return BilibiliToken{AccessToken: data.AccessToken, RefreshToken: data.RefreshToken, ExpiresAtUnix: int64(data.ExpiresIn)}, nil
}

func (c *BilibiliHTTPClient) Scopes(ctx context.Context, accessToken string) ([]string, error) {
	var data struct {
		Scopes []string `json:"scopes"`
		List   []string `json:"list"`
	}
	if err := c.signedGET(ctx, "/user/account/scopes", nil, accessToken, &data); err != nil {
		return nil, err
	}
	if len(data.Scopes) > 0 {
		return data.Scopes, nil
	}
	return data.List, nil
}

func (c *BilibiliHTTPClient) AccountInfo(ctx context.Context, accessToken string) (BilibiliAccountInfo, error) {
	var data BilibiliAccountInfo
	err := c.signedGET(ctx, "/user/account/info", nil, accessToken, &data)
	return data, err
}

func (c *BilibiliHTTPClient) UserStat(ctx context.Context, accessToken string) (BilibiliUserStat, error) {
	var data struct {
		Follower       bilibiliInt64 `json:"follower"`
		Following      bilibiliInt64 `json:"following"`
		ArcPassedTotal bilibiliInt64 `json:"arc_passed_total"`
	}
	err := c.signedGET(ctx, "/data/user/stat", nil, accessToken, &data)
	return BilibiliUserStat{Follower: int64(data.Follower), Following: int64(data.Following), ArcPassedTotal: int64(data.ArcPassedTotal)}, err
}

func (c *BilibiliHTTPClient) Archives(ctx context.Context, accessToken string, page, pageSize int) ([]BilibiliArchive, error) {
	var data struct {
		List []struct {
			ResourceID string        `json:"resource_id"`
			Title      string        `json:"title"`
			PTime      bilibiliInt64 `json:"ptime"`
			AdditInfo  struct {
				State bilibiliInt64 `json:"state"`
			} `json:"addit_info"`
		} `json:"list"`
	}
	query := url.Values{"pn": {strconv.Itoa(page)}, "ps": {strconv.Itoa(pageSize)}}
	if err := c.signedGET(ctx, "/archive/viewlist", query, accessToken, &data); err != nil {
		return nil, err
	}
	items := make([]BilibiliArchive, 0, len(data.List))
	for _, item := range data.List {
		items = append(items, BilibiliArchive{ResourceID: item.ResourceID, Title: item.Title, State: int64(item.AdditInfo.State), PTime: int64(item.PTime)})
	}
	return items, nil
}

func (c *BilibiliHTTPClient) ArchiveStat(ctx context.Context, accessToken, resourceID string) (BilibiliArchiveStat, error) {
	var data struct {
		View, Danmaku, Reply, Favorite, Coin, Share, Like bilibiliInt64
	}
	query := url.Values{"resource_id": {resourceID}}
	err := c.signedGET(ctx, "/data/arc/stat", query, accessToken, &data)
	return BilibiliArchiveStat{
		View: int64(data.View), Danmaku: int64(data.Danmaku), Reply: int64(data.Reply), Favorite: int64(data.Favorite),
		Coin: int64(data.Coin), Share: int64(data.Share), Like: int64(data.Like),
	}, err
}

func (c *BilibiliHTTPClient) signedGET(ctx context.Context, path string, query url.Values, accessToken string, target any) error {
	endpoint := c.openBaseURL + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	nonce, err := c.nonce()
	if err != nil {
		return err
	}
	headers := bilibiliSignatureHeaders(c.clientID, nil, c.clock().Unix(), nonce)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("access-token", accessToken)
	req.Header.Set("Authorization", signBilibiliHeaders(headers, c.clientSecret))
	return c.doJSON(req, target)
}

func (c *BilibiliHTTPClient) doJSON(req *http.Request, target any) error {
	response, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return fmt.Errorf("%w: http status %d", ErrBilibiliReauthRequired, response.StatusCode)
	}
	if response.StatusCode == http.StatusTooManyRequests {
		return fmt.Errorf("%w: http status %d", ErrBilibiliRateLimited, response.StatusCode)
	}
	if response.StatusCode == http.StatusNotFound && strings.HasSuffix(req.URL.Path, "/data/arc/stat") {
		return ErrBilibiliContentMissing
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("bilibili request failed with status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return err
	}
	var envelope struct {
		Code      bilibiliInt64   `json:"code"`
		Message   string          `json:"message"`
		Data      json.RawMessage `json:"data"`
		RequestID string          `json:"request_id"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return errors.New("bilibili response is invalid")
	}
	if envelope.Code != 0 {
		code := int(envelope.Code)
		switch code {
		case http.StatusUnauthorized, http.StatusForbidden, -http.StatusUnauthorized, -http.StatusForbidden:
			return fmt.Errorf("%w: upstream code %d", ErrBilibiliReauthRequired, code)
		case http.StatusTooManyRequests, -http.StatusTooManyRequests:
			return fmt.Errorf("%w: upstream code %d", ErrBilibiliRateLimited, code)
		case http.StatusNotFound, -http.StatusNotFound:
			if strings.HasSuffix(req.URL.Path, "/data/arc/stat") {
				return ErrBilibiliContentMissing
			}
		}
		return fmt.Errorf("bilibili upstream code %d", code)
	}
	if len(envelope.Data) == 0 || bytes.Equal(envelope.Data, []byte("null")) {
		return errors.New("bilibili response data is missing")
	}
	if err := json.Unmarshal(envelope.Data, target); err != nil {
		return errors.New("bilibili response data is invalid")
	}
	return nil
}

func bilibiliSignatureHeaders(clientID string, body []byte, timestamp int64, nonce string) map[string]string {
	digest := md5.Sum(body)
	return map[string]string{
		"x-bili-accesskeyid":       clientID,
		"x-bili-content-md5":       hex.EncodeToString(digest[:]),
		"x-bili-timestamp":         strconv.FormatInt(timestamp, 10),
		"x-bili-signature-method":  "HMAC-SHA256",
		"x-bili-signature-nonce":   nonce,
		"x-bili-signature-version": "2.0",
	}
}

func signBilibiliHeaders(headers map[string]string, secret string) string {
	keys := make([]string, 0, len(headers))
	normalized := make(map[string]string, len(headers))
	for key, value := range headers {
		if strings.HasPrefix(strings.ToLower(key), "x-bili-") {
			lower := strings.ToLower(key)
			keys = append(keys, lower)
			normalized[lower] = value
		}
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+":"+normalized[key])
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(mac.Sum(nil))
}

func randomBilibiliNonce() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

type bilibiliInt64 int64

func (v *bilibiliInt64) UnmarshalJSON(raw []byte) error {
	trimmed := strings.Trim(string(raw), "\"")
	if trimmed == "" || trimmed == "null" {
		*v = 0
		return nil
	}
	parsed, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil {
		return err
	}
	*v = bilibiliInt64(parsed)
	return nil
}
