package feedback

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/sharedfiles"
)

type consoleTestTransport func(*http.Request) (*http.Response, error)

func (fn consoleTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

func consoleTestInput() ConsoleInput {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	return ConsoleInput{ClientID: "console_test0001", RecoveryToken: strings.Repeat("a", 43), StatusToken: strings.Repeat("b", 43), Description: "管理后台加载异常", OccurredAt: now, SnapshotAt: now, ConfirmedAt: now, Page: "/admin/accounts", UserAgent: "test browser", Language: "zh-CN", Confirmed: true, AcceptPartial: true, Errors: []ConsoleError{{At: now, Kind: "web_error", Message: "失败 password=private123 access_token=token123", Stack: "at https://private.example/app.js?token=secret#frag /Users/alice/project/app.js"}}}
}

func TestConsoleFeedbackSnapshotAndRedaction(t *testing.T) {
	input := consoleTestInput()
	input.Description += " sk-testsecretvalue Authorization: Bearer bearer-secret"
	input.DroppedErrors = 1
	in, materials, err := prepareConsoleFeedback(input, nil)
	if err != nil {
		t.Fatal(err)
	}
	var m Manifest
	_ = json.Unmarshal(in.Manifest, &m)
	if m.Completeness != "partial" || len(m.MissingItems) != 5 || len(m.Artifacts) != 3 || in.Consent.ConfirmedAt != input.ConfirmedAt {
		t.Fatalf("incorrect snapshot: %#v", m)
	}
	all := in.Description + string(bytes.Join(materials, nil))
	for _, secret := range []string{"sk-testsecretvalue", "private123", "token123", "bearer-secret", "private.example", "?token=", "/Users/alice"} {
		if strings.Contains(all, secret) {
			t.Fatalf("secret was not redacted: %s", secret)
		}
	}
	for index, a := range m.Artifacts {
		if a.SHA256 != Hash(materials[index]) || a.Size != int64(len(materials[index])) || a.PartIndex != 1 {
			t.Fatal("material/manifest mismatch")
		}
	}
	_, second, err := prepareConsoleFeedback(input, nil)
	if err != nil || !bytes.Equal(bytes.Join(materials, nil), bytes.Join(second, nil)) {
		t.Fatal("snapshot was not stable")
	}
}

func TestConsoleFeedbackRejectsInvalidInputBeforeNetworking(t *testing.T) {
	mutations := []func(*ConsoleInput){
		func(in *ConsoleInput) { in.Confirmed = false },
		func(in *ConsoleInput) { in.AcceptPartial = false },
		func(in *ConsoleInput) { in.Description = "" },
		func(in *ConsoleInput) { in.ClientID = "../credentials" },
		func(in *ConsoleInput) { in.Page = "/admin?token=secret" },
		func(in *ConsoleInput) { in.RecoveryToken = "admin-account-token" },
		func(in *ConsoleInput) { in.ConfirmedAt = "invalid" },
		func(in *ConsoleInput) { in.Errors = make([]ConsoleError, 51) },
	}
	client := &http.Client{Transport: consoleTestTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid input must not be sent")
		return nil, nil
	})}
	for _, mutate := range mutations {
		input := consoleTestInput()
		mutate(&input)
		if _, err := SubmitConsoleFeedback(context.Background(), input, nil, client, nil); err == nil {
			t.Fatal("invalid input accepted")
		}
	}
	for _, screenshot := range []ConsoleScreenshot{{ContentType: "image/svg+xml", Data: []byte("<svg/>")}, {ContentType: "image/png", Data: []byte("<html/>")}} {
		if _, err := SubmitConsoleFeedback(context.Background(), consoleTestInput(), []ConsoleScreenshot{screenshot}, client, nil); err == nil {
			t.Fatal("invalid image accepted")
		}
	}
}

func TestConsoleFeedbackRetryUsesExistingCentreProtocol(t *testing.T) {
	for _, lostAt := range []string{"create", "upload", "submit"} {
		t.Run(lostAt, func(t *testing.T) {
			store := NewMemoryStore()
			storage, _ := sharedfiles.NewFileSystemStorage(t.TempDir())
			centre := NewService(store, storage, nil, 0)
			first := true
			creations := 0
			uploads := 0
			submits := 0
			var firstBody []byte
			client := &http.Client{Transport: consoleTestTransport(func(req *http.Request) (*http.Response, error) {
				if req.URL.Scheme != "https" || req.URL.Host != "gateway.clawee.work" || req.Header.Get("Cookie") != "" || req.Header.Get("X-Feedback-Deployment-Token") != "" {
					t.Fatal("unsafe centre target or credentials")
				}
				var data any
				var err error
				stage := ""
				path := strings.TrimPrefix(req.URL.Path, "/api/v1/feedback/")
				if path == "reports" {
					stage = "create"
					creations++
					body, _ := io.ReadAll(req.Body)
					if firstBody == nil {
						firstBody = body
					} else if !bytes.Equal(firstBody, body) {
						t.Fatal("retry changed authorised snapshot")
					}
					var in CreateInput
					_ = json.Unmarshal(body, &in)
					data, _, err = centre.Create(req.Context(), in, "test", "")
				} else {
					parts := strings.Split(path, "/")
					credential := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
					if req.Method == http.MethodPut {
						stage = "upload"
						uploads++
						_, err = centre.Upload(req.Context(), parts[1], parts[3], credential, req.Header.Get("Content-Type"), req.Header.Get("X-Content-SHA256"), req.ContentLength, req.Body)
						data = map[string]bool{"received": err == nil}
					} else if parts[2] == "submit" {
						stage = "submit"
						submits++
						var body struct {
							Hash    string `json:"manifest_sha256"`
							Partial bool   `json:"accept_partial"`
						}
						_ = json.NewDecoder(req.Body).Decode(&body)
						data, err = centre.Submit(req.Context(), parts[1], credential, body.Hash, body.Partial)
					} else {
						t.Fatalf("unexpected path: %s", path)
					}
				}
				if err != nil {
					t.Fatal(err)
				}
				if stage == lostAt && first {
					first = false
					return nil, errors.New("response lost")
				}
				body, _ := json.Marshal(map[string]any{"data": data})
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(body)), Request: req}, nil
			})}
			input := consoleTestInput()
			var imageData bytes.Buffer
			_ = png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 1, 1)))
			images := []ConsoleScreenshot{{ContentType: "image/png", Data: imageData.Bytes()}}
			if _, err := SubmitConsoleFeedback(context.Background(), input, images, client, nil); err == nil {
				t.Fatal("first lost response must fail")
			}
			receipt, err := SubmitConsoleFeedback(context.Background(), input, images, client, nil)
			if err != nil || receipt.UploadState != "ready" || receipt.SecurityState != "normal" || creations != 2 || uploads != 4 || submits != 1 {
				t.Fatalf("retry failed: %#v %v counts %d %d %d", receipt, err, creations, uploads, submits)
			}
			if len(store.reports) != 1 {
				t.Fatal("retry created duplicate report")
			}
		})
	}
}

func TestConsoleFeedbackPolicyChangePausesFurtherRequests(t *testing.T) {
	allowed := true
	requests := 0
	client := &http.Client{Transport: consoleTestTransport(func(req *http.Request) (*http.Response, error) {
		requests++
		allowed = false
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"data":{"report_id":"fb_test0001","upload_token":"upload-only","upload_state":"uploading"}}`)), Header: http.Header{}}, nil
	})}
	_, err := SubmitConsoleFeedback(context.Background(), consoleTestInput(), nil, client, func() bool { return allowed })
	status, code := HTTPError(err)
	if requests != 1 || status != 403 || code != "feedback_policy_disabled" {
		t.Fatalf("policy not respected: requests=%d err=%v", requests, err)
	}
}
