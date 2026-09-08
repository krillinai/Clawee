package report

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

const (
	maxAttempts            = 3
	initialRetryWait       = 100 * time.Millisecond
	nonJSONBodyPlaceholder = "<non-json body redacted>"
)

type Config struct {
	BaseURL        string
	CollectorToken string
	HTTPClient     *http.Client
	Logger         Logger
	Observer       Observer
}

type Client struct {
	baseURL  string
	token    string
	http     *http.Client
	logger   Logger
	observer Observer
}

type Logger interface {
	Info(string, ...any)
	Warn(string, ...any)
}

type Observer interface {
	RecordReport(ReportRecord)
}

type ObserverFunc func(ReportRecord)

func (fn ObserverFunc) RecordReport(record ReportRecord) {
	fn(record)
}

type ReportRecord struct {
	ChainID        string
	Kind           string
	Path           string
	RawRequest     []byte
	ResponseStatus int
	Error          string
	Duration       time.Duration
}

type StatusError struct {
	Endpoint   string
	StatusCode int
	Code       string
	Message    string
}

func (e *StatusError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("collector report %s returned status %d: %s", e.Endpoint, e.StatusCode, e.Code)
	}
	return fmt.Sprintf("collector report %s returned status %d", e.Endpoint, e.StatusCode)
}

func (e *StatusError) HTTPStatusCode() int {
	return e.StatusCode
}

func NewClient(cfg Config) *Client {
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	requestLogger := cfg.Logger
	if requestLogger == nil {
		requestLogger = slog.Default()
	}
	return &Client{
		baseURL:  strings.TrimRight(cfg.BaseURL, "/"),
		token:    cfg.CollectorToken,
		http:     httpClient,
		logger:   requestLogger,
		observer: cfg.Observer,
	}
}

func (c *Client) PostHeartbeat(req collectorapi.HeartbeatRequest) error {
	return c.post("heartbeat", "", "/api/v1/collector/heartbeat", req)
}

func (c *Client) PostHeartbeatSilently(req collectorapi.HeartbeatRequest) error {
	return c.postSilently("heartbeat", "", "/api/v1/collector/heartbeat", req)
}

func (c *Client) PostEvents(req collectorapi.EventsRequest) error {
	return c.PostEventsWithChain("", req)
}

func (c *Client) PostEventsWithChain(chainID string, req collectorapi.EventsRequest) error {
	return c.post("events", chainID, "/api/v1/collector/events", req)
}

func (c *Client) RegisterCollector(req collectorapi.RegistrationRequest) (collectorapi.RegistrationResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return collectorapi.RegistrationResponse{}, err
	}

	var lastErr error
	wait := initialRetryWait
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		resp, err := c.registerOnce(body)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if !isRetryableError(err) || attempt == maxAttempts {
			return collectorapi.RegistrationResponse{}, err
		}
		time.Sleep(wait)
		wait *= 2
	}
	return collectorapi.RegistrationResponse{}, lastErr
}

func (c *Client) post(kind string, chainID string, endpoint string, payload any) error {
	return c.postWithLogging(kind, chainID, endpoint, payload, true)
}

func (c *Client) postSilently(kind string, chainID string, endpoint string, payload any) error {
	return c.postWithLogging(kind, chainID, endpoint, payload, false)
}

func (c *Client) postWithLogging(kind string, chainID string, endpoint string, payload any, logRequest bool) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	var lastErr error
	var lastStatus int
	startedAt := time.Now()
	wait := initialRetryWait
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		status, err := c.postOnce(endpoint, body, logRequest)
		lastStatus = status
		if err == nil {
			c.recordReport(ReportRecord{
				ChainID:        chainID,
				Kind:           kind,
				Path:           endpoint,
				RawRequest:     body,
				ResponseStatus: status,
				Duration:       time.Since(startedAt),
			})
			return nil
		}
		lastErr = err
		if !isRetryableError(err) || attempt == maxAttempts {
			c.recordReport(ReportRecord{
				ChainID:        chainID,
				Kind:           kind,
				Path:           endpoint,
				RawRequest:     body,
				ResponseStatus: lastStatus,
				Error:          err.Error(),
				Duration:       time.Since(startedAt),
			})
			return err
		}
		time.Sleep(wait)
		wait *= 2
	}
	c.recordReport(ReportRecord{
		ChainID:        chainID,
		Kind:           kind,
		Path:           endpoint,
		RawRequest:     body,
		ResponseStatus: lastStatus,
		Error:          lastErr.Error(),
		Duration:       time.Since(startedAt),
	})
	return lastErr
}

func (c *Client) postOnce(endpoint string, body []byte, logRequest bool) (int, error) {
	req, err := http.NewRequest(http.MethodPost, c.baseURL+endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	if logRequest {
		c.logRequest(req, endpoint, body)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		if logRequest {
			c.logger.Warn("collector request error", "endpoint", endpoint, "error", err)
		}
		return 0, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, err
	}
	if logRequest {
		c.logger.Info("collector response", "endpoint", endpoint, "status_code", resp.StatusCode, "body", sanitizeJSONBody(respBody))
	}

	if resp.StatusCode == http.StatusAccepted {
		return resp.StatusCode, nil
	}

	statusErr := &StatusError{
		Endpoint:   endpoint,
		StatusCode: resp.StatusCode,
	}
	var errorResp collectorapi.ErrorResponse
	if err := json.NewDecoder(bytes.NewReader(respBody)).Decode(&errorResp); err == nil {
		statusErr.Code = errorResp.Error.Code
		statusErr.Message = errorResp.Error.Message
	}
	return resp.StatusCode, statusErr
}

func (c *Client) recordReport(record ReportRecord) {
	if c.observer == nil {
		return
	}
	record.RawRequest = append([]byte(nil), record.RawRequest...)
	c.observer.RecordReport(record)
}

func (c *Client) registerOnce(body []byte) (collectorapi.RegistrationResponse, error) {
	endpoint := "/api/v1/collector/register"
	req, err := http.NewRequest(http.MethodPost, c.baseURL+endpoint, bytes.NewReader(body))
	if err != nil {
		return collectorapi.RegistrationResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	c.logRequest(req, endpoint, body)

	resp, err := c.http.Do(req)
	if err != nil {
		c.logger.Warn("collector request error", "endpoint", endpoint, "error", err)
		return collectorapi.RegistrationResponse{}, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return collectorapi.RegistrationResponse{}, err
	}
	c.logger.Info("collector response", "endpoint", endpoint, "status_code", resp.StatusCode, "body", sanitizeJSONBody(respBody))

	if resp.StatusCode == http.StatusCreated {
		var registrationResp collectorapi.RegistrationResponse
		if err := json.NewDecoder(bytes.NewReader(respBody)).Decode(&registrationResp); err != nil {
			return collectorapi.RegistrationResponse{}, err
		}
		return registrationResp, nil
	}

	statusErr := &StatusError{
		Endpoint:   endpoint,
		StatusCode: resp.StatusCode,
	}
	var errorResp collectorapi.ErrorResponse
	if err := json.NewDecoder(bytes.NewReader(respBody)).Decode(&errorResp); err == nil {
		statusErr.Code = errorResp.Error.Code
		statusErr.Message = errorResp.Error.Message
	}
	return collectorapi.RegistrationResponse{}, statusErr
}

func (c *Client) logRequest(req *http.Request, endpoint string, body []byte) {
	c.logger.Info("collector request", "method", req.Method, "endpoint", endpoint, "headers", sanitizedHeaders(req.Header), "body", sanitizeJSONBody(body))
}

func sanitizedHeaders(headers http.Header) map[string][]string {
	safe := make(map[string][]string, len(headers))
	for key, values := range headers {
		if strings.EqualFold(key, "Authorization") {
			safe[key] = []string{"<redacted>"}
			continue
		}
		safe[key] = append([]string(nil), values...)
	}
	return safe
}

func sanitizeJSONBody(body []byte) string {
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return nonJSONBodyPlaceholder
	}
	redactJSONValue(value)
	safeBody, err := json.Marshal(value)
	if err != nil {
		return nonJSONBodyPlaceholder
	}
	return string(safeBody)
}

func redactJSONValue(value any) {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			switch key {
			case "registration_code", "collector_token":
				typed[key] = "<redacted>"
			default:
				redactJSONValue(child)
			}
		}
	case []any:
		for _, child := range typed {
			redactJSONValue(child)
		}
	}
}

func isRetryableError(err error) bool {
	statusErr, ok := err.(*StatusError)
	if !ok {
		return false
	}
	return statusErr.StatusCode == http.StatusTooManyRequests ||
		(statusErr.StatusCode >= http.StatusInternalServerError && statusErr.StatusCode <= 599)
}
