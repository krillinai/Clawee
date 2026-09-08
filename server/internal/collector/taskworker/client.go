package taskworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

const maxTaskResponseBytes int64 = 1 << 20

type ClientConfig struct {
	BaseURL        string
	CollectorToken string
	CollectorID    string
	DeviceID       string
	HTTPClient     *http.Client
}

type Client struct {
	baseURL     string
	token       string
	collectorID string
	deviceID    string
	http        *http.Client
}

type StatusError struct {
	StatusCode int
	Code       string
}

func (e *StatusError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("collector task request returned status %d: %s", e.StatusCode, e.Code)
	}
	return fmt.Sprintf("collector task request returned status %d", e.StatusCode)
}

func NewClient(cfg ClientConfig) *Client {
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{
		baseURL: strings.TrimRight(cfg.BaseURL, "/"), token: cfg.CollectorToken,
		collectorID: cfg.CollectorID, deviceID: cfg.DeviceID, http: httpClient,
	}
}

func (c *Client) Pull(ctx context.Context) (*collectorapi.TaskDelivery, error) {
	req := collectorapi.TaskPullRequest{
		SchemaVersion: collectorapi.TaskSchemaVersion, CollectorID: c.collectorID, DeviceID: c.deviceID,
	}
	status, body, err := c.post(ctx, "/api/v1/collector/tasks/pull", req)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNoContent {
		return nil, nil
	}
	if status != http.StatusOK {
		return nil, decodeStatusError(status, body)
	}
	var delivery collectorapi.TaskDelivery
	if err := json.Unmarshal(body, &delivery); err != nil {
		return nil, fmt.Errorf("decode collector task delivery: %w", err)
	}
	if delivery.SchemaVersion != collectorapi.TaskSchemaVersion || strings.TrimSpace(delivery.TaskID) == "" || strings.TrimSpace(delivery.ClaimID) == "" {
		return nil, fmt.Errorf("decode collector task delivery: invalid delivery")
	}
	return &delivery, nil
}

func (c *Client) Complete(ctx context.Context, result collectorapi.TaskResultRequest) error {
	result.SchemaVersion = collectorapi.TaskSchemaVersion
	result.CollectorID = c.collectorID
	result.DeviceID = c.deviceID
	status, body, err := c.post(ctx, "/api/v1/collector/tasks/result", result)
	if err != nil {
		return err
	}
	if status != http.StatusAccepted {
		return decodeStatusError(status, body)
	}
	return nil
}

func (c *Client) post(ctx context.Context, path string, value any) (int, []byte, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	limited := io.LimitReader(resp.Body, maxTaskResponseBytes+1)
	responseBody, err := io.ReadAll(limited)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	if int64(len(responseBody)) > maxTaskResponseBytes {
		return resp.StatusCode, nil, errors.New("collector task response is too large")
	}
	return resp.StatusCode, responseBody, nil
}

func decodeStatusError(status int, body []byte) error {
	statusErr := &StatusError{StatusCode: status}
	var response collectorapi.ErrorResponse
	if json.Unmarshal(body, &response) == nil {
		statusErr.Code = response.Error.Code
	}
	return statusErr
}
