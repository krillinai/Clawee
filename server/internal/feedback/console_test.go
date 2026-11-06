package feedback

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"strings"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/sharedfiles"
)

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
	var manifest Manifest
	_ = json.Unmarshal(in.Manifest, &manifest)
	if manifest.Completeness != "partial" || len(manifest.MissingItems) != 5 || len(manifest.Artifacts) != 3 || in.Consent.ConfirmedAt != input.ConfirmedAt {
		t.Fatalf("incorrect snapshot: %#v", manifest)
	}
	all := in.Description + string(bytes.Join(materials, nil))
	for _, secret := range []string{"sk-testsecretvalue", "private123", "token123", "bearer-secret", "private.example", "?token=", "/Users/alice"} {
		if strings.Contains(all, secret) {
			t.Fatalf("secret was not redacted: %s", secret)
		}
	}
	for index, artifact := range manifest.Artifacts {
		if artifact.SHA256 != Hash(materials[index]) || artifact.Size != int64(len(materials[index])) || artifact.PartIndex != 1 {
			t.Fatal("material/manifest mismatch")
		}
	}
	_, second, err := prepareConsoleFeedback(input, nil)
	if err != nil || !bytes.Equal(bytes.Join(materials, nil), bytes.Join(second, nil)) {
		t.Fatal("snapshot was not stable")
	}
}

func TestConsoleFeedbackRejectsInvalidInputBeforeStorage(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(store, nil, nil, 0)
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
	for _, mutate := range mutations {
		input := consoleTestInput()
		mutate(&input)
		if _, err := service.SubmitConsoleFeedback(context.Background(), input, nil, "test"); err == nil {
			t.Fatal("invalid input accepted")
		}
	}
	for _, screenshot := range []ConsoleScreenshot{{ContentType: "image/svg+xml", Data: []byte("<svg/>")}, {ContentType: "image/png", Data: []byte("<html/>")}} {
		if _, err := service.SubmitConsoleFeedback(context.Background(), consoleTestInput(), []ConsoleScreenshot{screenshot}, "test"); err == nil {
			t.Fatal("invalid image accepted")
		}
	}
	if len(store.reports) != 0 {
		t.Fatal("invalid input was stored")
	}
}

func TestConsoleFeedbackUsesLocalServiceAndIsIdempotent(t *testing.T) {
	store := NewMemoryStore()
	storage, _ := sharedfiles.NewFileSystemStorage(t.TempDir())
	service := NewService(store, storage, nil, 0)
	var imageData bytes.Buffer
	_ = png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 1, 1)))
	input := consoleTestInput()
	images := []ConsoleScreenshot{{ContentType: "image/png", Data: imageData.Bytes()}}
	first, err := service.SubmitConsoleFeedback(context.Background(), input, images, "test")
	if err != nil || first.UploadState != "ready" || first.SecurityState != "normal" {
		t.Fatalf("local submission failed: %#v %v", first, err)
	}
	second, err := service.SubmitConsoleFeedback(context.Background(), input, images, "test")
	if err != nil || second != first || len(store.reports) != 1 {
		t.Fatalf("retry was not idempotent: %#v %v", second, err)
	}
	report, err := store.Get(first.ReportID)
	if err != nil || len(report.Artifacts) != 4 {
		t.Fatalf("local materials missing: %#v %v", report, err)
	}
}
