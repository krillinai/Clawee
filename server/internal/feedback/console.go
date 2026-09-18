package feedback

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/krillinai/Clawee/server/internal/buildinfo"
)

const consoleFeedbackOrigin = "https://gateway.clawee.work/api/v1/feedback"

type ConsoleError struct {
	At      string `json:"at"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Stack   string `json:"stack"`
	Method  string `json:"method"`
	Path    string `json:"path"`
	Status  int    `json:"status"`
}

type ConsoleInput struct {
	ClientID          string         `json:"client_feedback_id"`
	RecoveryToken     string         `json:"recovery_token"`
	StatusToken       string         `json:"status_token"`
	Description       string         `json:"description"`
	OccurredAt        string         `json:"occurred_at"`
	ReproductionSteps string         `json:"reproduction_steps"`
	SnapshotAt        string         `json:"snapshot_at"`
	ConfirmedAt       string         `json:"confirmed_at"`
	Page              string         `json:"page"`
	UserAgent         string         `json:"user_agent"`
	Language          string         `json:"language"`
	Errors            []ConsoleError `json:"errors"`
	DroppedErrors     int            `json:"dropped_errors"`
	Confirmed         bool           `json:"confirmed"`
	AcceptPartial     bool           `json:"accept_partial"`
}

type ConsoleScreenshot struct {
	ContentType string
	Data        []byte
}

type ConsoleReceipt struct {
	ReportID      string `json:"report_id"`
	DisplayNumber string `json:"display_number"`
	UploadState   string `json:"upload_state"`
	SecurityState string `json:"security_state"`
}

var consolePagePattern = regexp.MustCompile(`^/admin(?:/[a-zA-Z0-9_-]+)*$`)
var consolePrivateKeyPattern = regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`)
var consoleSecretValuePattern = regexp.MustCompile(`(?i)(?:[a-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)[a-z0-9_-]*)["\s]*[:=]["\s]*(?:bearer\s+)?[^\s"',}\]]+`)
var consoleBearerPattern = regexp.MustCompile(`(?i)\bbearer\s+[a-z0-9._~+/-]+=*`)
var consoleURLPattern = regexp.MustCompile(`https?://[^\s"'<>]+`)
var consoleHomePattern = regexp.MustCompile(`(?i)(?:/Users/[^/\s"']+|/home/[^/\s"']+|[a-z]:\\Users\\[^\\\s"']+)`)

// 复用中心秘密识别规则；浏览器地址不保留内部域名、查询参数和片段。
func RedactConsoleText(value string) string {
	value = consolePrivateKeyPattern.ReplaceAllString(value, "[REDACTED]")
	value = consoleURLPattern.ReplaceAllString(value, "[URL]")
	value = consoleSecretValuePattern.ReplaceAllString(value, "[REDACTED]")
	value = consoleBearerPattern.ReplaceAllString(value, "Bearer [REDACTED]")
	value = consoleHomePattern.ReplaceAllString(value, "[USER_HOME]")
	return secretPattern.ReplaceAllString(value, "[REDACTED]")
}

func prepareConsoleFeedback(input ConsoleInput, screenshots []ConsoleScreenshot) (CreateInput, [][]byte, error) {
	var in CreateInput
	if !input.Confirmed || !input.AcceptPartial || !IDPattern.MatchString(input.ClientID) || len(input.ClientID) > 64 || !consolePagePattern.MatchString(input.Page) || len(input.Page) > 256 || len(input.UserAgent) > 1024 || len(input.Language) > 128 || len(input.Errors) > 50 || input.DroppedErrors < 0 || len(screenshots) > 5 || strings.TrimSpace(input.Description) == "" || utf8.RuneCountInString(input.Description) > 10000 || utf8.RuneCountInString(input.ReproductionSteps) > 10000 {
		return in, nil, fail(400, "feedback_invalid_request")
	}
	in = CreateInput{ClientID: input.ClientID, RecoveryToken: input.RecoveryToken, StatusToken: input.StatusToken, Description: RedactConsoleText(input.Description), OccurredAt: input.OccurredAt, ReproductionSteps: RedactConsoleText(input.ReproductionSteps), SourceClaim: map[string]string{"customer_label": "管理后台（自报）"}, Environment: map[string]string{"app_version": buildinfo.Version, "build_sha": buildinfo.Commit, "platform": "browser", "connection_status": "admin_console"}}
	in.Consent.PolicyVersion = 1
	in.Consent.ConfirmedAt = input.ConfirmedAt
	m := Manifest{SchemaVersion: 1, SnapshotAt: input.SnapshotAt, ThreadID: "admin_" + input.ClientID, RunIDs: []string{}, RuntimeThreadIDs: []string{}, Completeness: "partial", RedactionPolicyVersion: 1, MissingItems: []string{"conversation:unavailable", "desktop:unavailable", "gateway_logs:not_collected", "browser:current_session_only"}, Warnings: []string{}, Watermarks: []Watermark{}, Artifacts: []Artifact{}}
	materials := [][]byte{}
	add := func(kind, source, name, mime string, data []byte, count int64) {
		id := "admin_" + input.ClientID + "_" + source
		m.Artifacts = append(m.Artifacts, Artifact{ID: id, Kind: kind, Source: source, Name: name, ContentType: mime, Size: int64(len(data)), SHA256: Hash(data), RecordCount: count, PartIndex: 1})
		materials = append(materials, data)
		if kind != "screenshot" {
			m.Watermarks = append(m.Watermarks, Watermark{Source: source, ExpectedCount: count, ExportedCount: count, Boundary: "browser_snapshot"})
		}
	}
	env, _ := json.Marshal(map[string]string{"page": RedactConsoleText(input.Page), "user_agent": RedactConsoleText(input.UserAgent), "language": RedactConsoleText(input.Language), "app_version": buildinfo.Version})
	add("environment", "browser_environment", "environment.ndjson", "application/x-ndjson", append(env, '\n'), 1)
	diag, _ := json.Marshal(map[string]any{"source": "admin_console", "error_count": len(input.Errors), "dropped_errors": input.DroppedErrors})
	add("diagnostics", "browser_diagnostics", "diagnostics.ndjson", "application/x-ndjson", append(diag, '\n'), 1)
	if input.DroppedErrors > 0 {
		m.MissingItems = append(m.MissingItems, "browser_errors:truncated")
	}
	var logs bytes.Buffer
	for _, entry := range input.Errors {
		if len(entry.At) > 64 || len(entry.Kind) > 64 || len(entry.Message) > 8192 || len(entry.Stack) > 16384 || len(entry.Method) > 16 || len(entry.Path) > 256 || entry.Status < 0 || entry.Status > 599 {
			return in, nil, fail(400, "feedback_invalid_request")
		}
		if _, err := time.Parse(time.RFC3339Nano, entry.At); err != nil {
			return in, nil, fail(400, "feedback_invalid_request")
		}
		if entry.Kind != "web_error" && entry.Kind != "unhandled_rejection" && entry.Kind != "network_error" && entry.Kind != "http_error" {
			return in, nil, fail(400, "feedback_invalid_request")
		}
		if entry.Method != "" && entry.Method != "GET" && entry.Method != "POST" && entry.Method != "PUT" && entry.Method != "PATCH" && entry.Method != "DELETE" {
			return in, nil, fail(400, "feedback_invalid_request")
		}
		entry.Message = RedactConsoleText(entry.Message)
		entry.Stack = RedactConsoleText(entry.Stack)
		entry.Path = RedactConsoleText(strings.SplitN(strings.SplitN(entry.Path, "?", 2)[0], "#", 2)[0])
		b, _ := json.Marshal(entry)
		logs.Write(b)
		logs.WriteByte('\n')
	}
	if len(input.Errors) > 0 {
		add("logs", "browser_errors", "browser-errors.ndjson", "application/x-ndjson", logs.Bytes(), int64(len(input.Errors)))
	}
	for index, screenshot := range screenshots {
		if len(screenshot.Data) > 10<<20 || (screenshot.ContentType != "image/png" && screenshot.ContentType != "image/jpeg" && screenshot.ContentType != "image/webp") {
			return in, nil, fail(400, "feedback_invalid_image")
		}
		cfg, format, err := image.DecodeConfig(bytes.NewReader(screenshot.Data))
		if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > 25000000 || "image/"+format != screenshot.ContentType {
			return in, nil, fail(400, "feedback_invalid_image")
		}
		if _, _, err = image.Decode(bytes.NewReader(screenshot.Data)); err != nil {
			return in, nil, fail(400, "feedback_invalid_image")
		}
		source := "screenshot_" + strconv.Itoa(index+1)
		add("screenshot", source, source, screenshot.ContentType, screenshot.Data, 0)
	}
	in.Manifest, _ = json.Marshal(m)
	_, _, _, _, err := validate(in)
	return in, materials, err
}

// 同一浏览器快照重复提交复用创建幂等契约，不另建队列或存储原始材料。
func SubmitConsoleFeedback(ctx context.Context, input ConsoleInput, screenshots []ConsoleScreenshot, client *http.Client, allowed func() bool) (ConsoleReceipt, error) {
	in, materials, err := prepareConsoleFeedback(input, screenshots)
	if err != nil {
		return ConsoleReceipt{}, err
	}
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	request := func(method, path, credential, mime string, body []byte) (json.RawMessage, error) {
		if allowed != nil && !allowed() {
			return nil, fail(403, "feedback_policy_disabled")
		}
		req, err := http.NewRequestWithContext(ctx, method, consoleFeedbackOrigin+path, bytes.NewReader(body))
		if err != nil {
			return nil, fail(503, "feedback_unavailable")
		}
		req.Header.Set("Content-Type", mime)
		if credential != "" {
			req.Header.Set("Authorization", "Bearer "+credential)
		}
		if method == http.MethodPut {
			req.Header.Set("X-Content-SHA256", Hash(body))
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, fail(503, "feedback_unavailable")
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
		if err != nil || len(data) > 2<<20 {
			return nil, fail(503, "feedback_unavailable")
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			status := resp.StatusCode
			if status < 400 || status > 599 {
				status = 503
			}
			return nil, fail(status, "feedback_centre_request_failed")
		}
		var envelope struct {
			Data json.RawMessage `json:"data"`
		}
		if json.Unmarshal(data, &envelope) != nil || len(envelope.Data) == 0 {
			return nil, fail(503, "feedback_unavailable")
		}
		return envelope.Data, nil
	}
	body, _ := json.Marshal(in)
	data, err := request(http.MethodPost, "/reports", "", "application/json", body)
	var progress struct {
		ConsoleReceipt
		UploadToken string   `json:"upload_token"`
		Received    []string `json:"received_artifact_ids"`
	}
	if err != nil {
		return ConsoleReceipt{}, err
	}
	if json.Unmarshal(data, &progress) != nil || !IDPattern.MatchString(progress.ReportID) {
		return ConsoleReceipt{}, fail(503, "feedback_unavailable")
	}
	if progress.UploadState == "ready" {
		return progress.ConsoleReceipt, nil
	}
	if progress.UploadToken == "" {
		return ConsoleReceipt{}, fail(503, "feedback_unavailable")
	}
	var m Manifest
	_ = json.Unmarshal(in.Manifest, &m)
	for index, artifact := range m.Artifacts {
		received := false
		for _, id := range progress.Received {
			if id == artifact.ID {
				received = true
				break
			}
		}
		if received {
			continue
		}
		if _, err = request(http.MethodPut, "/reports/"+progress.ReportID+"/artifacts/"+artifact.ID, progress.UploadToken, artifact.ContentType, materials[index]); err != nil {
			return ConsoleReceipt{}, err
		}
	}
	mh, _ := CanonicalHash(in.Manifest)
	body, _ = json.Marshal(map[string]any{"manifest_sha256": mh, "accept_partial": true})
	data, err = request(http.MethodPost, "/reports/"+progress.ReportID+"/submit", progress.UploadToken, "application/json", body)
	if err != nil {
		return ConsoleReceipt{}, err
	}
	var receipt ConsoleReceipt
	if json.Unmarshal(data, &receipt) != nil || receipt.ReportID != progress.ReportID || receipt.UploadState != "ready" {
		return ConsoleReceipt{}, fail(503, "feedback_unavailable")
	}
	return receipt, nil
}
