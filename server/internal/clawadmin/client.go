package clawadmin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/activity"
)

const maxResponseBytes = 1 << 20

var ErrUnavailable = errors.New("claw-admin unavailable")

type ModelConfiguration struct {
	BaseURL           string `json:"base_url"`
	APIKey            string `json:"api_key"`
	Model             string `json:"model"`
	CredentialVersion int    `json:"credential_version"`
}

type AccountReference struct {
	ID    string `json:"account_id"`
	Name  string `json:"account_name"`
	Email string `json:"account_email"`
}

type BillingUsage struct {
	Requests          int64   `json:"requests"`
	InputTokens       int64   `json:"input_tokens"`
	CachedInputTokens int64   `json:"cached_input_tokens"`
	OutputTokens      int64   `json:"output_tokens"`
	TotalTokens       int64   `json:"total_tokens"`
	ActualCostCNY     float64 `json:"actual_cost_cny"`
}

type BillingTrendPoint struct {
	BucketStart time.Time `json:"bucket_start"`
	BillingUsage
}

type BillingModelUsage struct {
	Model string `json:"model"`
	BillingUsage
}

type BillingTokenUsageRank struct {
	Rank        int    `json:"rank"`
	Name        string `json:"name"`
	Requests    int64  `json:"requests"`
	TotalTokens int64  `json:"total_tokens"`
}

type BillingSnapshot struct {
	Currency          string                  `json:"currency"`
	ExchangeRate      float64                 `json:"exchange_rate"`
	BalanceCNY        float64                 `json:"balance_cny"`
	StartDate         string                  `json:"start_date"`
	EndDate           string                  `json:"end_date"`
	Granularity       string                  `json:"granularity"`
	GeneratedAt       time.Time               `json:"generated_at"`
	Stats             BillingUsage            `json:"stats"`
	Trend             []BillingTrendPoint     `json:"trend"`
	Models            []BillingModelUsage     `json:"models"`
	TokenUsageRanking []BillingTokenUsageRank `json:"token_usage_ranking"`
}

type RechargeSession struct {
	RechargeURL string    `json:"recharge_url"`
	ExpiresAt   time.Time `json:"expires_at"`
}

type RechargeOrder struct {
	OrderNo           string     `json:"order_no"`
	AmountCents       int64      `json:"amount_cents"`
	Currency          string     `json:"currency"`
	Channel           string     `json:"channel"`
	Status            string     `json:"status"`
	PaymentStatus     string     `json:"payment_status"`
	FulfillmentStatus string     `json:"fulfillment_status"`
	CreatedAt         time.Time  `json:"created_at"`
	PaidAt            *time.Time `json:"paid_at"`
	FulfilledAt       *time.Time `json:"fulfilled_at"`
}

type RechargeOrderPage struct {
	Items    []RechargeOrder `json:"items"`
	Page     int             `json:"page"`
	PageSize int             `json:"page_size"`
	Total    int64           `json:"total"`
}

type Client struct {
	baseURL              string
	deploymentCredential string
	httpClient           *http.Client
}

func NewClient(baseURL, deploymentCredential string, timeout time.Duration) *Client {
	return &Client{
		baseURL:              strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		deploymentCredential: strings.TrimSpace(deploymentCredential),
		httpClient: &http.Client{
			Timeout: timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errors.New("claw-admin redirects are disabled")
			},
		},
	}
}

func (c *Client) Configured() bool {
	return c != nil && c.httpClient != nil && c.baseURL != "" && c.deploymentCredential != ""
}

func (c *Client) EnsureModelConfiguration(ctx context.Context, account AccountReference) (ModelConfiguration, error) {
	account.ID = strings.TrimSpace(account.ID)
	account.Name = strings.TrimSpace(account.Name)
	account.Email = strings.ToLower(strings.TrimSpace(account.Email))
	if !c.Configured() || account.ID == "" || account.Email == "" {
		return ModelConfiguration{}, ErrUnavailable
	}
	payload, err := json.Marshal(account)
	if err != nil {
		return ModelConfiguration{}, ErrUnavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/v1/deployment/model-credentials/ensure", bytes.NewReader(payload))
	if err != nil {
		return ModelConfiguration{}, ErrUnavailable
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.deploymentCredential)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return ModelConfiguration{}, ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ModelConfiguration{}, ErrUnavailable
	}
	var envelope struct {
		Error int32              `json:"error"`
		Data  ModelConfiguration `json:"data"`
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes))
	if err := decoder.Decode(&envelope); err != nil || envelope.Error != 0 {
		return ModelConfiguration{}, ErrUnavailable
	}
	configuration := envelope.Data
	modelURL, parseErr := url.Parse(strings.TrimSpace(configuration.BaseURL))
	if parseErr != nil || !validModelURL(modelURL) || strings.TrimSpace(configuration.APIKey) == "" || strings.TrimSpace(configuration.Model) == "" || configuration.CredentialVersion <= 0 {
		return ModelConfiguration{}, ErrUnavailable
	}
	return configuration, nil
}

func (c *Client) DisableModelCredential(ctx context.Context, accountID string) error {
	accountID = strings.TrimSpace(accountID)
	if !c.Configured() || accountID == "" {
		return ErrUnavailable
	}
	payload, err := json.Marshal(map[string]string{"account_id": accountID})
	if err != nil {
		return ErrUnavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/v1/deployment/model-credentials/disable", bytes.NewReader(payload))
	if err != nil {
		return ErrUnavailable
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.deploymentCredential)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ErrUnavailable
	}
	return nil
}

func (c *Client) Snapshot(ctx context.Context, input activity.SnapshotRequest) (activity.Snapshot, error) {
	snapshot, err := c.getBillingSnapshot(ctx, input.StartDate, input.EndDate, input.Granularity)
	if err != nil {
		return activity.Snapshot{}, &activity.UpstreamError{Code: "billing_unavailable"}
	}
	trend := make([]activity.TrendPoint, 0, len(snapshot.Trend))
	for _, point := range snapshot.Trend {
		inputTokens := point.InputTokens + point.CachedInputTokens
		trend = append(trend, activity.TrendPoint{BucketStart: point.BucketStart, Usage: activity.Usage{
			InputTokens: inputTokens, CachedInputTokens: point.CachedInputTokens,
			OutputTokens: point.OutputTokens, TotalTokens: point.TotalTokens,
		}})
	}
	models := make([]activity.ModelUsage, 0, len(snapshot.Models))
	var modelTotal int64
	for _, model := range snapshot.Models {
		if modelTotal > math.MaxInt64-model.TotalTokens {
			return activity.Snapshot{}, &activity.UpstreamError{Code: "billing_invalid_response"}
		}
		modelTotal += model.TotalTokens
		models = append(models, activity.ModelUsage{Model: model.Model, Requests: model.Requests, Usage: activity.Usage{
			InputTokens: model.InputTokens + model.CachedInputTokens, CachedInputTokens: model.CachedInputTokens,
			OutputTokens: model.OutputTokens, TotalTokens: model.TotalTokens,
		}})
	}
	for index := range models {
		if modelTotal > 0 {
			models[index].Share = float64(models[index].TotalTokens) / float64(modelTotal)
		}
	}
	ranking := make([]activity.TokenUsageRank, 0, len(snapshot.TokenUsageRanking))
	for _, item := range snapshot.TokenUsageRanking {
		ranking = append(ranking, activity.TokenUsageRank{Rank: item.Rank, Name: strings.TrimSpace(item.Name), Requests: item.Requests, TotalTokens: item.TotalTokens})
	}
	return activity.Snapshot{GeneratedAt: snapshot.GeneratedAt, Trend: trend, Models: models, TokenUsageRanking: ranking}, nil
}

func (c *Client) GetBillingOverview(ctx context.Context, requestedRange string) (BillingSnapshot, error) {
	location, _ := time.LoadLocation("Asia/Shanghai")
	now := time.Now().In(location)
	end := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, location)
	start := end
	granularity := "hour"
	switch strings.TrimSpace(requestedRange) {
	case "", activity.Range7Days:
		start, granularity = end.AddDate(0, 0, -6), "day"
	case activity.RangeToday:
	case activity.Range30Days:
		start, granularity = end.AddDate(0, 0, -29), "day"
	default:
		return BillingSnapshot{}, errors.New("invalid billing range")
	}
	return c.getBillingSnapshot(ctx, start.Format("2006-01-02"), end.Format("2006-01-02"), granularity)
}

func (c *Client) CreateRechargeSession(ctx context.Context) (RechargeSession, error) {
	if !c.Configured() {
		return RechargeSession{}, ErrUnavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/v1/deployment/recharge-sessions", nil)
	if err != nil {
		return RechargeSession{}, ErrUnavailable
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.deploymentCredential)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return RechargeSession{}, ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return RechargeSession{}, ErrUnavailable
	}
	var envelope struct {
		Error int32           `json:"error"`
		Data  RechargeSession `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&envelope); err != nil || envelope.Error != 0 {
		return RechargeSession{}, ErrUnavailable
	}
	result := envelope.Data
	parsed, err := url.Parse(result.RechargeURL)
	if err != nil || !validRechargeURL(parsed) || result.ExpiresAt.IsZero() || !result.ExpiresAt.After(time.Now()) {
		return RechargeSession{}, ErrUnavailable
	}
	return result, nil
}

func (c *Client) ListRechargeOrders(ctx context.Context, page, pageSize int) (RechargeOrderPage, error) {
	if !c.Configured() || page <= 0 || pageSize <= 0 || pageSize > 100 {
		return RechargeOrderPage{}, ErrUnavailable
	}
	endpoint, err := url.Parse(c.baseURL + "/api/v1/deployment/recharge-orders")
	if err != nil {
		return RechargeOrderPage{}, ErrUnavailable
	}
	query := endpoint.Query()
	query.Set("page", strconv.Itoa(page))
	query.Set("page_size", strconv.Itoa(pageSize))
	endpoint.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return RechargeOrderPage{}, ErrUnavailable
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.deploymentCredential)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return RechargeOrderPage{}, ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return RechargeOrderPage{}, ErrUnavailable
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return RechargeOrderPage{}, ErrUnavailable
	}
	var envelope struct {
		Error int32             `json:"error"`
		Data  RechargeOrderPage `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Error != 0 {
		return RechargeOrderPage{}, ErrUnavailable
	}
	result := envelope.Data
	if result.Page != page || result.PageSize != pageSize || result.Total < 0 {
		return RechargeOrderPage{}, ErrUnavailable
	}
	if result.Items == nil {
		result.Items = []RechargeOrder{}
	}
	for _, order := range result.Items {
		if strings.TrimSpace(order.OrderNo) == "" || order.AmountCents <= 0 || order.Currency != "CNY" || order.CreatedAt.IsZero() ||
			!validRechargeOrderChannel(order.Channel) || !validRechargeOrderStatus(order.Status) ||
			!validRechargePaymentStatus(order.PaymentStatus) || !validRechargeFulfillmentStatus(order.FulfillmentStatus) {
			return RechargeOrderPage{}, ErrUnavailable
		}
	}
	return result, nil
}

func validRechargeOrderChannel(value string) bool {
	return value == "alipay" || value == "manual"
}

func validRechargeOrderStatus(value string) bool {
	switch value {
	case "pending_payment", "crediting", "succeeded", "credit_failed", "cancelled", "refunding", "refunded", "refund_failed":
		return true
	default:
		return false
	}
}

func validRechargePaymentStatus(value string) bool {
	return value == "pending" || value == "paid" || value == "cancelled" || value == "refunded"
}

func validRechargeFulfillmentStatus(value string) bool {
	switch value {
	case "pending", "processing", "succeeded", "failed", "refunding", "refunded", "refund_failed":
		return true
	default:
		return false
	}
}

func validRechargeURL(parsed *url.URL) bool {
	if parsed == nil || !parsed.IsAbs() || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return false
	}
	if parsed.Scheme == "https" {
		return true
	}
	if parsed.Scheme != "http" {
		return false
	}
	host := parsed.Hostname()
	return host == "localhost" || net.ParseIP(host).IsLoopback()
}

func validModelURL(parsed *url.URL) bool {
	return parsed != nil && parsed.IsAbs() && parsed.Host != "" && parsed.User == nil && parsed.Fragment == "" && (parsed.Scheme == "https" || parsed.Scheme == "http")
}

func (c *Client) getBillingSnapshot(ctx context.Context, startDate, endDate, granularity string) (BillingSnapshot, error) {
	if !c.Configured() {
		return BillingSnapshot{}, ErrUnavailable
	}
	endpoint, err := url.Parse(c.baseURL + "/api/v1/deployment/billing/snapshot")
	if err != nil {
		return BillingSnapshot{}, ErrUnavailable
	}
	query := endpoint.Query()
	query.Set("start_date", startDate)
	query.Set("end_date", endDate)
	query.Set("granularity", granularity)
	endpoint.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return BillingSnapshot{}, ErrUnavailable
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.deploymentCredential)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return BillingSnapshot{}, ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return BillingSnapshot{}, ErrUnavailable
	}
	var envelope struct {
		Error int32           `json:"error"`
		Data  BillingSnapshot `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&envelope); err != nil || envelope.Error != 0 {
		return BillingSnapshot{}, ErrUnavailable
	}
	result := envelope.Data
	if result.Currency != "CNY" || result.ExchangeRate <= 0 || math.IsNaN(result.ExchangeRate) || math.IsInf(result.ExchangeRate, 0) || result.BalanceCNY < 0 || math.IsNaN(result.BalanceCNY) || math.IsInf(result.BalanceCNY, 0) || result.StartDate != startDate || result.EndDate != endDate || result.Granularity != granularity || result.GeneratedAt.IsZero() || result.Trend == nil || result.Models == nil || result.TokenUsageRanking == nil {
		return BillingSnapshot{}, ErrUnavailable
	}
	if err := validateBillingSnapshot(result); err != nil {
		return BillingSnapshot{}, ErrUnavailable
	}
	return result, nil
}

func validateBillingSnapshot(snapshot BillingSnapshot) error {
	location, _ := time.LoadLocation("Asia/Shanghai")
	start, err := time.ParseInLocation("2006-01-02", snapshot.StartDate, location)
	if err != nil {
		return ErrUnavailable
	}
	end, err := time.ParseInLocation("2006-01-02", snapshot.EndDate, location)
	if err != nil || end.Before(start) {
		return ErrUnavailable
	}
	seen := make(map[int64]struct{}, len(snapshot.Trend))
	total := BillingUsage{}
	for _, point := range snapshot.Trend {
		bucket := point.BucketStart.In(location)
		if bucket.Before(start) || !bucket.Before(end.AddDate(0, 0, 1)) || (snapshot.Granularity == "hour" && (bucket.Minute() != 0 || bucket.Second() != 0)) {
			return ErrUnavailable
		}
		if _, exists := seen[bucket.Unix()]; exists {
			return ErrUnavailable
		}
		seen[bucket.Unix()] = struct{}{}
		if err := validateBillingUsage(point.BillingUsage); err != nil || addBillingUsage(&total, point.BillingUsage) != nil {
			return ErrUnavailable
		}
	}
	if !equalBillingUsage(total, snapshot.Stats) {
		return ErrUnavailable
	}
	for _, model := range snapshot.Models {
		if strings.TrimSpace(model.Model) == "" || validateBillingUsage(model.BillingUsage) != nil {
			return ErrUnavailable
		}
	}
	if len(snapshot.TokenUsageRanking) > 50 {
		return ErrUnavailable
	}
	for index, item := range snapshot.TokenUsageRanking {
		if item.Rank != index+1 || strings.TrimSpace(item.Name) == "" || item.Requests < 0 || item.TotalTokens < 0 || (index > 0 && snapshot.TokenUsageRanking[index-1].TotalTokens < item.TotalTokens) {
			return ErrUnavailable
		}
	}
	return nil
}

func validateBillingUsage(usage BillingUsage) error {
	if usage.Requests < 0 || usage.InputTokens < 0 || usage.CachedInputTokens < 0 || usage.OutputTokens < 0 || usage.TotalTokens < 0 || usage.ActualCostCNY < 0 || math.IsNaN(usage.ActualCostCNY) || math.IsInf(usage.ActualCostCNY, 0) {
		return ErrUnavailable
	}
	total := usage.InputTokens
	for _, value := range []int64{usage.CachedInputTokens, usage.OutputTokens} {
		if total > math.MaxInt64-value {
			return ErrUnavailable
		}
		total += value
	}
	if total != usage.TotalTokens {
		return ErrUnavailable
	}
	return nil
}

func addBillingUsage(target *BillingUsage, value BillingUsage) error {
	for _, pair := range [][2]int64{{target.Requests, value.Requests}, {target.InputTokens, value.InputTokens}, {target.CachedInputTokens, value.CachedInputTokens}, {target.OutputTokens, value.OutputTokens}, {target.TotalTokens, value.TotalTokens}} {
		if pair[0] > math.MaxInt64-pair[1] {
			return ErrUnavailable
		}
	}
	target.Requests += value.Requests
	target.InputTokens += value.InputTokens
	target.CachedInputTokens += value.CachedInputTokens
	target.OutputTokens += value.OutputTokens
	target.TotalTokens += value.TotalTokens
	target.ActualCostCNY += value.ActualCostCNY
	if math.IsInf(target.ActualCostCNY, 0) || math.IsNaN(target.ActualCostCNY) {
		return ErrUnavailable
	}
	return nil
}

func equalBillingUsage(left, right BillingUsage) bool {
	return left.Requests == right.Requests && left.InputTokens == right.InputTokens && left.CachedInputTokens == right.CachedInputTokens && left.OutputTokens == right.OutputTokens && left.TotalTokens == right.TotalTokens && math.Abs(left.ActualCostCNY-right.ActualCostCNY) < 0.0001
}
