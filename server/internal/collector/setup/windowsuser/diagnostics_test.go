package windowsuser

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestDiagnosticsWriterWritesReadableLogAndRedactsToken(t *testing.T) {
	writer, err := NewDiagnosticsWriter(t.TempDir(), func() time.Time {
		return time.Date(2026, 7, 6, 10, 11, 12, 0, time.Local)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()

	writer.Step("配置", "复用已有配置 collector_token=secret_token collector_id=collector_1")
	writer.Step("配置JSON", `{"collector_token":"json_secret","CollectorToken":"go_secret","collectorToken":"camel_secret"}`)
	writer.Step("配置结构体", "CollectorToken=struct_secret")
	writer.Step("计划任务", "已创建 ClaweeCollector")

	bodyBytes, err := os.ReadFile(writer.Path())
	if err != nil {
		t.Fatal(err)
	}
	body := string(bodyBytes)
	for _, leaked := range []string{"secret_token", "json_secret", "go_secret", "camel_secret", "struct_secret"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("diagnostics leaked token %q:\n%s", leaked, body)
		}
	}
	for _, leaked := range []string{"collector_token", "CollectorToken", "collectorToken"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("diagnostics leaked token field %q:\n%s", leaked, body)
		}
	}
	for _, want := range []string{"配置", "计划任务", "<redacted_token_field>", "<redacted>", "ClaweeCollector"} {
		if !strings.Contains(body, want) {
			t.Fatalf("diagnostics missing %q:\n%s", want, body)
		}
	}
}
