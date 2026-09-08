package provider

import (
	"errors"
	"strings"
	"testing"

	"github.com/alibabacloud-go/tea/dara"
	"github.com/alibabacloud-go/tea/tea"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

func TestBailianStatusMapping(t *testing.T) {
	tests := map[string]DocumentStatus{"FINISH": DocumentReady, "RUNNING": DocumentProcessing, "DOC_PARSING": DocumentProcessing, "INSERT_ERROR": DocumentFailed, "PARSE_FAILED": DocumentFailed}
	for input, want := range tests {
		if got := mapBailianDocumentStatus(input); got != want {
			t.Fatalf("mapBailianDocumentStatus(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestNormalizedProviderMessageOnlyMarksFailedDocuments(t *testing.T) {
	if got := normalizedProviderMessage(DocumentReady, "success"); got != "" {
		t.Fatalf("ready document message = %q", got)
	}
	if got := normalizedProviderMessage(DocumentProcessing, "processing"); got != "" {
		t.Fatalf("processing document message = %q", got)
	}
	if got := normalizedProviderMessage(DocumentFailed, "parse error"); got != "provider_processing_failed" {
		t.Fatalf("failed document message = %q", got)
	}
}

func TestProviderNameFitsBailianLimit(t *testing.T) {
	got := providerName("这是一个超过百炼二十字符限制的企业知识库名称用于测试")
	if len([]rune(got)) > 20 {
		t.Fatalf("provider name = %q", got)
	}
	if providerName("公司制度库") != "公司制度库" {
		t.Fatal("short names should remain unchanged")
	}
}

func TestBailianErrorClassification(t *testing.T) {
	for input, want := range map[string]string{"Index.Forbidden": ErrorUnauthorized, "NOT AUTHORIZED": ErrorUnauthorized, "AccessDenied": ErrorUnauthorized, "Index.IndexNameAlreadyExists": ErrorConflict, "DataCenter.Throttling": ErrorRateLimited, "InvalidParameter": ErrorInvalidRequest, "Index.NotFound": ErrorNotFound, "Index.NotExist": ErrorNotFound, "index does not exist": ErrorNotFound} {
		if got := classifyBailianCode(input); got != want {
			t.Fatalf("classifyBailianCode(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestNormalizeBailianSDKErrorPreservesDiagnosticDetails(t *testing.T) {
	status := 403
	code := "AccessDenied"
	message := "RAM user is not authorized"
	raw := &tea.SDKError{StatusCode: &status, Code: &code, Message: &message, Data: dara.String(`{"RequestId":"req-provider-1"}`)}

	err := normalizeBailianErrorForOperation("create_index", raw)
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) {
		t.Fatalf("error = %T, want *ProviderError", err)
	}
	if providerErr.Code != ErrorUnauthorized || providerErr.Operation != "create_index" || providerErr.HTTPStatus != 403 || providerErr.ProviderCode != code || providerErr.ProviderMessage != message || providerErr.RequestID != "req-provider-1" {
		t.Fatalf("provider error = %#v", providerErr)
	}
}

func TestBailianProviderLogsSafeDiagnosticDetails(t *testing.T) {
	core, observed := observer.New(zapcore.ErrorLevel)
	p := &BailianProvider{logger: zap.New(core)}
	err := &ProviderError{
		Code: ErrorInternal, Operation: "create_index", HTTPStatus: 400,
		ProviderCode: "InvalidParameter", ProviderMessage: "invalid model", RequestID: "req-provider-2",
		Cause: errors.New("secret signed request"),
	}

	p.logProviderError(err)

	entries := observed.All()
	if len(entries) != 1 {
		t.Fatalf("log entries = %d, want 1", len(entries))
	}
	fields := entries[0].ContextMap()
	if fields["operation"] != "create_index" || fields["provider_code"] != "InvalidParameter" || fields["provider_request_id"] != "req-provider-2" || fields["http_status"] != int64(400) {
		t.Fatalf("log fields = %#v", fields)
	}
	if strings.Contains(entries[0].Message+fields["provider_message"].(string), "secret signed request") {
		t.Fatalf("log leaked provider cause: %#v", entries[0])
	}
}

func TestBailianResponseErrorKeepsProviderFailureWithoutData(t *testing.T) {
	core, observed := observer.New(zapcore.ErrorLevel)
	p := &BailianProvider{logger: zap.New(core)}

	err := p.responseError("create_index", false, "InvalidParameter", "unsupported embedding model", "req-provider-3")
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) || providerErr.ProviderCode != "InvalidParameter" || providerErr.RequestID != "req-provider-3" {
		t.Fatalf("provider error = %#v", err)
	}
	entries := observed.All()
	if len(entries) != 1 || entries[0].ContextMap()["provider_message"] != "unsupported embedding model" {
		t.Fatalf("log entries = %#v", entries)
	}
}

func TestBailianCreateIndexDefaults(t *testing.T) {
	req := newCreateIndexRequest(CreateKnowledgeBaseRequest{Name: "公司制度", Description: "制度文档"}, "category-1")
	if dara.StringValue(req.SourceType) != "DATA_CENTER_CATEGORY" || dara.StringValue(req.StructureType) != "unstructured" || dara.StringValue(req.SinkType) != "BUILT_IN" {
		t.Fatalf("storage defaults = %#v", req)
	}
	if dara.StringValue(req.EmbeddingModelName) != "text-embedding-v4" || dara.StringValue(req.RerankModelName) != "qwen3-rerank" || dara.BoolValue(req.EnableRewrite) {
		t.Fatalf("model defaults = %#v", req)
	}
	if len(req.CategoryIds) != 1 || dara.StringValue(req.CategoryIds[0]) != "category-1" {
		t.Fatalf("category defaults = %#v", req.CategoryIds)
	}
}

func TestBailianRuntimeDisablesAutomaticRetry(t *testing.T) {
	runtime := noRetryRuntime()
	if dara.BoolValue(runtime.Autoretry) || dara.IntValue(runtime.MaxAttempts) != 1 {
		t.Fatalf("runtime = %#v", runtime)
	}
}

func TestSelectNewBailianDocumentUsesIndexDocumentID(t *testing.T) {
	items := []bailianIndexDocument{
		{document: ProviderDocument{ExternalID: "doc_old", Name: "guide.pdf", Size: 10}},
		{document: ProviderDocument{ExternalID: "doc_new", Name: "guide.pdf", Size: 10, Status: DocumentProcessing}},
	}
	document, ok := selectNewBailianDocument(items, map[string]struct{}{"doc_old": {}}, "guide.pdf", 10)
	if !ok || document.ExternalID != "doc_new" {
		t.Fatalf("document = %#v, ok = %v", document, ok)
	}
}

func TestBailianDocumentNameRestoresMultiDotAndUppercaseExtensions(t *testing.T) {
	for _, test := range []struct {
		name, documentType, want string
	}{
		{name: "policy.v2", documentType: "pdf", want: "policy.v2.pdf"},
		{name: "GUIDE.PDF", documentType: "pdf", want: "GUIDE.PDF"},
		{name: "report", documentType: "EXCEL", want: "report.xlsx"},
	} {
		if got := bailianDocumentName(test.name, test.documentType); got != test.want {
			t.Fatalf("bailianDocumentName(%q, %q) = %q, want %q", test.name, test.documentType, got, test.want)
		}
	}
	items := []bailianIndexDocument{{document: ProviderDocument{ExternalID: "doc_new", Name: "GUIDE.pdf", Size: 10}}}
	if _, ok := selectNewBailianDocument(items, nil, "guide.PDF", 10); !ok {
		t.Fatal("case-insensitive document name did not match")
	}
}
