package mcpgateway

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestArgumentsHashIsStable(t *testing.T) {
	left, err := ArgumentsHash(JSONMap{"b": 2, "a": 1})
	if err != nil {
		t.Fatalf("left hash: %v", err)
	}
	right, err := ArgumentsHash(JSONMap{"a": 1, "b": 2})
	if err != nil {
		t.Fatalf("right hash: %v", err)
	}

	if left == "" || right == "" {
		t.Fatal("hash is empty")
	}
	if left != right {
		t.Fatalf("hash mismatch: %s != %s", left, right)
	}
	if !strings.HasPrefix(left, "sha256:") {
		t.Fatalf("hash prefix = %q, want sha256:", left)
	}
}

func TestBuildGateSummaryUsesSchemaLabelsAndMasksSensitiveValues(t *testing.T) {
	capability := Capability{
		ExposedName: "crm.customer.update",
		Title:       "更新客户",
		RiskLevel:   "high",
		Destructive: true,
		ReadOnly:    false,
		InputSchema: JSONMap{
			"type": "object",
			"properties": JSONMap{
				"phone":        JSONMap{"type": "string", "title": "手机号"},
				"email":        JSONMap{"type": "string", "title": "邮箱"},
				"access_token": JSONMap{"type": "string", "title": "访问令牌"},
				"profile":      JSONMap{"type": "object", "title": "客户资料"},
			},
		},
	}
	arguments := JSONMap{
		"phone":        "13800001234",
		"email":        "user@example.com",
		"access_token": "token-value",
		"profile":      JSONMap{"tier": "gold", "active": true},
	}

	summary := BuildGateSummary(capability, arguments)

	if summary.System != "crm" {
		t.Fatalf("System = %q, want crm", summary.System)
	}
	if summary.Action != "更新客户" {
		t.Fatalf("Action = %q, want capability title", summary.Action)
	}
	if summary.Tool != "crm.customer.update" {
		t.Fatalf("Tool = %q, want exposed name", summary.Tool)
	}
	if !summary.Destructive {
		t.Fatal("Destructive = false, want true")
	}
	if summary.ReadOnly {
		t.Fatal("ReadOnly = true, want false")
	}
	if summary.RiskLevel != "high" {
		t.Fatalf("RiskLevel = %q, want high", summary.RiskLevel)
	}

	params := parametersByPath(summary.Parameters)
	assertGateParameter(t, params["phone"], "phone", "手机号", "138****1234", true)
	assertGateParameter(t, params["email"], "email", "邮箱", "u***@example.com", true)
	assertGateParameter(t, params["access_token"], "access_token", "访问令牌", "******", true)
	assertGateParameter(t, params["profile"], "profile", "客户资料", `{"active":true,"tier":"gold"}`, false)

	paths := make([]string, 0, len(summary.Parameters))
	for _, parameter := range summary.Parameters {
		paths = append(paths, parameter.Path)
	}
	wantPaths := []string{"access_token", "email", "phone", "profile"}
	for i, want := range wantPaths {
		if paths[i] != want {
			t.Fatalf("parameter paths = %v, want %v", paths, wantPaths)
		}
	}

	assertRiskContains(t, summary.Risks, "destructive")
	assertRiskContains(t, summary.Risks, "not read-only")
	assertRiskContains(t, summary.Risks, "high")
}

func TestBuildGateSummaryMasksNestedSensitiveValues(t *testing.T) {
	summary := BuildGateSummary(Capability{ExposedName: "crm.customer.update"}, JSONMap{
		"profile": JSONMap{
			"email":         "user@example.com",
			"api_key":       "api-key-value",
			"authorization": "Bearer token-value",
			"nested": JSONMap{
				"private_key": "private-key-value",
			},
		},
	})
	params := parametersByPath(summary.Parameters)
	profile := params["profile"].Value

	for _, leaked := range []string{"user@example.com", "api-key-value", "Bearer token-value", "private-key-value"} {
		if strings.Contains(profile, leaked) {
			t.Fatalf("profile value leaked %q: %s", leaked, profile)
		}
	}
	if !strings.Contains(profile, `"email":"u***@example.com"`) {
		t.Fatalf("profile value missing masked email: %s", profile)
	}
	if strings.Count(profile, "******") < 3 {
		t.Fatalf("profile value = %s, want nested secrets masked", profile)
	}
}

func TestBuildGateSummaryTruncatesUTF8Safely(t *testing.T) {
	summary := BuildGateSummary(Capability{ExposedName: "crm.customer.update"}, JSONMap{
		"note": strings.Repeat("客户", 150),
	})
	params := parametersByPath(summary.Parameters)
	if !utf8.ValidString(params["note"].Value) {
		t.Fatalf("truncated value is not valid UTF-8: %q", params["note"].Value)
	}
	if !strings.HasSuffix(params["note"].Value, "...") {
		t.Fatalf("truncated value = %q, want ellipsis suffix", params["note"].Value)
	}
}

func TestBuildGateSummaryMasksUnicodeEmailSafely(t *testing.T) {
	summary := BuildGateSummary(Capability{ExposedName: "crm.customer.update"}, JSONMap{
		"email": "用户@example.com",
	})
	params := parametersByPath(summary.Parameters)
	if !utf8.ValidString(params["email"].Value) {
		t.Fatalf("masked email is not valid UTF-8: %q", params["email"].Value)
	}
	if params["email"].Value != "用***@example.com" {
		t.Fatalf("masked email = %q, want unicode-safe mask", params["email"].Value)
	}
}

func TestBuildGateSummarySetsObjectField(t *testing.T) {
	tests := []struct {
		name      string
		cap       Capability
		arguments JSONMap
		want      string
	}{
		{
			name:      "id key",
			cap:       Capability{ExposedName: "crm.customer.update"},
			arguments: JSONMap{"customer_id": "C1024"},
			want:      "customer/C1024",
		},
		{
			name:      "_no key",
			cap:       Capability{ExposedName: "erp.payment.submit"},
			arguments: JSONMap{"payment_no": "PAY-20260529-018"},
			want:      "payment/PAY-20260529-018",
		},
		{
			name:      "_code key",
			cap:       Capability{ExposedName: "wms.inventory.check"},
			arguments: JSONMap{"product_code": "SKU-88421"},
			want:      "inventory/SKU-88421",
		},
		{
			name:      "bare id key",
			cap:       Capability{ExposedName: "crm.lead.convert"},
			arguments: JSONMap{"id": "LEAD-500"},
			want:      "lead/LEAD-500",
		},
		{
			name:      "prefers id-like key over non-sensitive string",
			cap:       Capability{ExposedName: "crm.order.cancel"},
			arguments: JSONMap{"note": "reason text", "order_id": "ORD-300"},
			want:      "order/ORD-300",
		},
		{
			name:      "non-sensitive string fallback",
			cap:       Capability{ExposedName: "crm.customer.search"},
			arguments: JSONMap{"keyword": "acme"},
			want:      "customer/acme",
		},
		{
			name:      "skips sensitive id-like keys",
			cap:       Capability{ExposedName: "ops.session.revoke"},
			arguments: JSONMap{"token_id": "secret-token-id", "reason": "manual revoke"},
			want:      "session/manual revoke",
		},
		{
			name:      "truncates object id",
			cap:       Capability{ExposedName: "crm.case.update"},
			arguments: JSONMap{"case_id": strings.Repeat("A", 240)},
			want:      "case/" + strings.Repeat("A", maxGateValueLength) + "...",
		},
		{
			name:      "no arguments returns resource only",
			cap:       Capability{ExposedName: "crm.customer.list"},
			arguments: JSONMap{},
			want:      "customer",
		},
		{
			name:      "single-segment name returns empty",
			cap:       Capability{ExposedName: "health"},
			arguments: JSONMap{"id": "1"},
			want:      "",
		},
		{
			name:      "empty name returns empty",
			cap:       Capability{},
			arguments: JSONMap{"id": "1"},
			want:      "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			summary := BuildGateSummary(tc.cap, tc.arguments)
			if summary.Object != tc.want {
				t.Fatalf("Object = %q, want %q", summary.Object, tc.want)
			}
		})
	}
}

func TestArgumentsHashReturnsMarshalErrors(t *testing.T) {
	if _, err := ArgumentsHash(JSONMap{"bad": math.NaN()}); err == nil {
		t.Fatal("ArgumentsHash error = nil, want marshal error")
	}
	if _, err := json.Marshal(JSONMap{"bad": math.NaN()}); err == nil {
		t.Fatal("test setup expected json marshal error")
	}
}

func parametersByPath(parameters []GateParameter) map[string]GateParameter {
	byPath := make(map[string]GateParameter, len(parameters))
	for _, parameter := range parameters {
		byPath[parameter.Path] = parameter
	}
	return byPath
}

func assertGateParameter(t *testing.T, got GateParameter, path, label, value string, sensitive bool) {
	t.Helper()
	if got.Path != path {
		t.Fatalf("%s Path = %q, want %q", path, got.Path, path)
	}
	if got.Label != label {
		t.Fatalf("%s Label = %q, want %q", path, got.Label, label)
	}
	if got.Value != value {
		t.Fatalf("%s Value = %q, want %q", path, got.Value, value)
	}
	if got.Sensitive != sensitive {
		t.Fatalf("%s Sensitive = %v, want %v", path, got.Sensitive, sensitive)
	}
}

func assertRiskContains(t *testing.T, risks []string, want string) {
	t.Helper()
	for _, risk := range risks {
		if strings.Contains(strings.ToLower(risk), want) {
			return
		}
	}
	t.Fatalf("risks %v do not contain %q", risks, want)
}
