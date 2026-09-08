package sub2api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/activity"
)

const (
	timezone         = "Asia/Shanghai"
	maxResponseBytes = 2 << 20
	apiKeyPageSize   = 100
)

type Config struct {
	BaseURL            string
	AdminAPIKey        string
	OrganizationUserID int64
}

type Client struct {
	baseURL            string
	adminAPIKey        string
	organizationUserID int64
	httpClient         *http.Client
	location           *time.Location
}

type usageValues struct {
	Requests            *int64 `json:"requests"`
	InputTokens         *int64 `json:"input_tokens"`
	OutputTokens        *int64 `json:"output_tokens"`
	CacheCreationTokens *int64 `json:"cache_creation_tokens"`
	CacheReadTokens     *int64 `json:"cache_read_tokens"`
	TotalTokens         *int64 `json:"total_tokens"`
}

type trendPoint struct {
	Date string `json:"date"`
	usageValues
}

type modelUsage struct {
	Model string `json:"model"`
	usageValues
}

type snapshotData struct {
	GeneratedAt string       `json:"generated_at"`
	StartDate   string       `json:"start_date"`
	EndDate     string       `json:"end_date"`
	Granularity string       `json:"granularity"`
	Trend       []trendPoint `json:"trend"`
	Models      []modelUsage `json:"models"`
}

type apiKey struct {
	ID   int64
	Name string
}

type apiKeyUsage struct {
	Requests int64
	Tokens   int64
}

func NewClient(cfg Config) (*Client, error) {
	baseURL := strings.TrimSpace(cfg.BaseURL)
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed == nil || !parsed.IsAbs() || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errors.New("sub2api base_url must be an absolute HTTP(S) URL without user info or fragment")
	}
	adminAPIKey := strings.TrimSpace(cfg.AdminAPIKey)
	if adminAPIKey == "" {
		return nil, errors.New("sub2api admin_api_key must not be empty")
	}
	if cfg.OrganizationUserID <= 0 {
		return nil, errors.New("sub2api organization_user_id must be greater than zero")
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return nil, errors.New("load sub2api timezone")
	}
	return &Client{
		baseURL:            strings.TrimRight(baseURL, "/"),
		adminAPIKey:        adminAPIKey,
		organizationUserID: cfg.OrganizationUserID,
		location:           location,
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errors.New("sub2api redirects are disabled")
			},
		},
	}, nil
}

func (c *Client) Snapshot(ctx context.Context, input activity.SnapshotRequest) (activity.Snapshot, error) {
	start, end, err := validateRequest(input, c.location)
	if err != nil {
		return activity.Snapshot{}, invalidResponse()
	}
	endpoint, err := url.Parse(c.baseURL + "/api/v1/admin/dashboard/snapshot-v2")
	if err != nil {
		return activity.Snapshot{}, unavailable()
	}
	query := endpoint.Query()
	query.Set("user_id", strconv.FormatInt(c.organizationUserID, 10))
	query.Set("start_date", input.StartDate)
	query.Set("end_date", input.EndDate)
	query.Set("timezone", timezone)
	query.Set("granularity", input.Granularity)
	query.Set("include_stats", "false")
	query.Set("include_trend", "true")
	query.Set("include_model_stats", "true")
	query.Set("include_group_stats", "false")
	query.Set("include_users_trend", "false")
	endpoint.RawQuery = query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return activity.Snapshot{}, unavailable()
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("x-api-key", c.adminAPIKey)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return activity.Snapshot{}, unavailable()
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return activity.Snapshot{}, unavailable()
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return activity.Snapshot{}, invalidResponse()
	}
	var envelope struct {
		Code *int          `json:"code"`
		Data *snapshotData `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Code == nil || *envelope.Code != 0 || envelope.Data == nil {
		return activity.Snapshot{}, invalidResponse()
	}
	data := envelope.Data
	generatedAt, err := time.Parse(time.RFC3339, data.GeneratedAt)
	if err != nil || generatedAt.IsZero() || data.StartDate != input.StartDate || data.EndDate != input.EndDate || data.Granularity != input.Granularity || data.Trend == nil || data.Models == nil {
		return activity.Snapshot{}, invalidResponse()
	}

	trend := make([]activity.TrendPoint, 0, len(data.Trend))
	seen := make(map[int64]struct{}, len(data.Trend))
	for _, raw := range data.Trend {
		bucket, err := parseBucket(raw.Date, input.Granularity, c.location)
		if err != nil || bucket.Before(start) || bucket.After(end) {
			return activity.Snapshot{}, invalidResponse()
		}
		if _, exists := seen[bucket.Unix()]; exists {
			return activity.Snapshot{}, invalidResponse()
		}
		seen[bucket.Unix()] = struct{}{}
		usage, err := convertUsage(raw.usageValues)
		if err != nil {
			return activity.Snapshot{}, invalidResponse()
		}
		trend = append(trend, activity.TrendPoint{BucketStart: bucket, Usage: usage})
	}

	models := make([]activity.ModelUsage, 0, len(data.Models))
	var modelTotal int64
	for _, raw := range data.Models {
		if strings.TrimSpace(raw.Model) == "" {
			return activity.Snapshot{}, invalidResponse()
		}
		usage, err := convertUsage(raw.usageValues)
		if err != nil || modelTotal > math.MaxInt64-usage.TotalTokens {
			return activity.Snapshot{}, invalidResponse()
		}
		modelTotal += usage.TotalTokens
		models = append(models, activity.ModelUsage{Model: raw.Model, Requests: *raw.Requests, Usage: usage})
	}
	for index := range models {
		if modelTotal > 0 {
			models[index].Share = float64(models[index].TotalTokens) / float64(modelTotal)
		}
	}
	ranking, err := c.tokenUsageRanking(ctx, input)
	if err != nil {
		return activity.Snapshot{}, err
	}
	return activity.Snapshot{GeneratedAt: generatedAt, Trend: trend, Models: models, TokenUsageRanking: ranking}, nil
}

func (c *Client) tokenUsageRanking(ctx context.Context, input activity.SnapshotRequest) ([]activity.TokenUsageRank, error) {
	keys, err := c.listOrganizationAPIKeys(ctx)
	if err != nil {
		return nil, err
	}
	type aggregate struct {
		id       int64
		name     string
		requests int64
		tokens   int64
	}
	values := make([]aggregate, 0, len(keys))
	for _, key := range keys {
		usage, err := c.getAPIKeyUsage(ctx, input, key.ID)
		if err != nil {
			return nil, err
		}
		if usage.Requests == 0 && usage.Tokens == 0 {
			continue
		}
		values = append(values, aggregate{id: key.ID, name: key.Name, requests: usage.Requests, tokens: usage.Tokens})
	}
	sort.Slice(values, func(i, j int) bool {
		if values[i].tokens == values[j].tokens {
			return values[i].id < values[j].id
		}
		return values[i].tokens > values[j].tokens
	})
	if len(values) > 50 {
		values = values[:50]
	}
	ranking := make([]activity.TokenUsageRank, 0, len(values))
	for index, value := range values {
		name := value.name
		if name == "" {
			name = "未命名 API Key"
		}
		ranking = append(ranking, activity.TokenUsageRank{Rank: index + 1, Name: name, Requests: value.requests, TotalTokens: value.tokens})
	}
	return ranking, nil
}

func (c *Client) listOrganizationAPIKeys(ctx context.Context) ([]apiKey, error) {
	keys := make([]apiKey, 0)
	seen := make(map[int64]struct{})
	for page := 1; ; page++ {
		endpoint, err := url.Parse(c.baseURL + "/api/v1/admin/users/" + strconv.FormatInt(c.organizationUserID, 10) + "/api-keys")
		if err != nil {
			return nil, unavailable()
		}
		query := endpoint.Query()
		query.Set("page", strconv.Itoa(page))
		query.Set("page_size", strconv.Itoa(apiKeyPageSize))
		endpoint.RawQuery = query.Encode()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
		if err != nil {
			return nil, unavailable()
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("x-api-key", c.adminAPIKey)
		resp, err := c.httpClient.Do(req)
		if err != nil {
			return nil, unavailable()
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
		closeErr := resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, unavailable()
		}
		if readErr != nil || closeErr != nil || len(body) > maxResponseBytes {
			return nil, invalidResponse()
		}
		var envelope struct {
			Code *int `json:"code"`
			Data *struct {
				Items []struct {
					ID     *int64  `json:"id"`
					UserID *int64  `json:"user_id"`
					Name   *string `json:"name"`
				} `json:"items"`
				Total    *int64 `json:"total"`
				Page     *int   `json:"page"`
				PageSize *int   `json:"page_size"`
				Pages    *int   `json:"pages"`
			} `json:"data"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil || envelope.Code == nil || *envelope.Code != 0 || envelope.Data == nil || envelope.Data.Items == nil || envelope.Data.Total == nil || envelope.Data.Page == nil || envelope.Data.PageSize == nil || envelope.Data.Pages == nil {
			return nil, invalidResponse()
		}
		data := envelope.Data
		if *data.Total < 0 || *data.Page != page || *data.PageSize != apiKeyPageSize || *data.Pages < 1 {
			return nil, invalidResponse()
		}
		expectedPages := 1
		if *data.Total > 0 {
			expectedPages = int((*data.Total-1)/int64(apiKeyPageSize) + 1)
		}
		if *data.Pages != expectedPages {
			return nil, invalidResponse()
		}
		for _, item := range data.Items {
			if item.ID == nil || item.UserID == nil || item.Name == nil || *item.ID <= 0 || *item.UserID != c.organizationUserID {
				return nil, invalidResponse()
			}
			if _, exists := seen[*item.ID]; exists {
				return nil, invalidResponse()
			}
			seen[*item.ID] = struct{}{}
			keys = append(keys, apiKey{ID: *item.ID, Name: strings.TrimSpace(*item.Name)})
		}
		if page == *data.Pages {
			if int64(len(keys)) != *data.Total {
				return nil, invalidResponse()
			}
			return keys, nil
		}
	}
}

func (c *Client) getAPIKeyUsage(ctx context.Context, input activity.SnapshotRequest, apiKeyID int64) (apiKeyUsage, error) {
	endpoint, err := url.Parse(c.baseURL + "/api/v1/admin/usage/stats")
	if err != nil {
		return apiKeyUsage{}, unavailable()
	}
	query := endpoint.Query()
	query.Set("user_id", strconv.FormatInt(c.organizationUserID, 10))
	query.Set("api_key_id", strconv.FormatInt(apiKeyID, 10))
	query.Set("start_date", input.StartDate)
	query.Set("end_date", input.EndDate)
	query.Set("timezone", timezone)
	endpoint.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return apiKeyUsage{}, unavailable()
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("x-api-key", c.adminAPIKey)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return apiKeyUsage{}, unavailable()
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return apiKeyUsage{}, unavailable()
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return apiKeyUsage{}, invalidResponse()
	}
	var envelope struct {
		Code *int `json:"code"`
		Data *struct {
			Requests *int64 `json:"total_requests"`
			Tokens   *int64 `json:"total_tokens"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Code == nil || *envelope.Code != 0 || envelope.Data == nil || envelope.Data.Requests == nil || envelope.Data.Tokens == nil || *envelope.Data.Requests < 0 || *envelope.Data.Tokens < 0 {
		return apiKeyUsage{}, invalidResponse()
	}
	return apiKeyUsage{Requests: *envelope.Data.Requests, Tokens: *envelope.Data.Tokens}, nil
}

func validateRequest(input activity.SnapshotRequest, location *time.Location) (time.Time, time.Time, error) {
	if input.Granularity != "hour" && input.Granularity != "day" {
		return time.Time{}, time.Time{}, errors.New("invalid granularity")
	}
	start, err := time.ParseInLocation("2006-01-02", input.StartDate, location)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	end, err := time.ParseInLocation("2006-01-02", input.EndDate, location)
	if err != nil || end.Before(start) {
		return time.Time{}, time.Time{}, errors.New("invalid date range")
	}
	return start, end.AddDate(0, 0, 1).Add(-time.Nanosecond), nil
}

func parseBucket(value, granularity string, location *time.Location) (time.Time, error) {
	layout := "2006-01-02"
	if granularity == "hour" {
		layout = "2006-01-02 15:04"
	}
	bucket, err := time.ParseInLocation(layout, value, location)
	if err != nil || (granularity == "hour" && bucket.Minute() != 0) {
		return time.Time{}, errors.New("invalid bucket")
	}
	return bucket, nil
}

func convertUsage(raw usageValues) (activity.Usage, error) {
	if raw.Requests == nil || raw.InputTokens == nil || raw.OutputTokens == nil || raw.CacheCreationTokens == nil || raw.CacheReadTokens == nil || raw.TotalTokens == nil {
		return activity.Usage{}, errors.New("missing usage")
	}
	if *raw.Requests < 0 || *raw.InputTokens < 0 || *raw.OutputTokens < 0 || *raw.CacheCreationTokens < 0 || *raw.CacheReadTokens < 0 || *raw.TotalTokens < 0 {
		return activity.Usage{}, errors.New("negative usage")
	}
	input := *raw.InputTokens
	for _, value := range []int64{*raw.CacheReadTokens, *raw.CacheCreationTokens} {
		if input > math.MaxInt64-value {
			return activity.Usage{}, errors.New("usage overflow")
		}
		input += value
	}
	if input > math.MaxInt64-*raw.OutputTokens {
		return activity.Usage{}, errors.New("usage overflow")
	}
	cached := *raw.CacheReadTokens + *raw.CacheCreationTokens
	return activity.Usage{InputTokens: input, CachedInputTokens: cached, OutputTokens: *raw.OutputTokens, TotalTokens: input + *raw.OutputTokens}, nil
}

func unavailable() error {
	return &activity.UpstreamError{Code: "billing_unavailable"}
}

func invalidResponse() error {
	return &activity.UpstreamError{Code: "billing_invalid_response"}
}
