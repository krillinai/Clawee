package provider

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	bailian "github.com/alibabacloud-go/bailian-20231229/v2/client"
	openapi "github.com/alibabacloud-go/darabonba-openapi/v2/client"
	"github.com/alibabacloud-go/tea/dara"
	"github.com/alibabacloud-go/tea/tea"
	"go.uber.org/zap"
)

const temporaryCategoryPrefix = "claw-mcp-"

type BailianConfig struct {
	Endpoint        string
	WorkspaceID     string
	AccessKeyID     string
	AccessKeySecret string
	HTTPClient      *http.Client
	Logger          *zap.Logger
}

type BailianProvider struct {
	client      *bailian.Client
	workspaceID string
	httpClient  *http.Client
	logger      *zap.Logger
	uploadLocks sync.Map
}

func NewBailianProvider(cfg BailianConfig) (*BailianProvider, error) {
	endpoint := strings.TrimSpace(cfg.Endpoint)
	endpoint = strings.TrimPrefix(endpoint, "https://")
	endpoint = strings.TrimPrefix(endpoint, "http://")
	endpoint = strings.TrimRight(endpoint, "/")
	if endpoint == "" || strings.TrimSpace(cfg.WorkspaceID) == "" || strings.TrimSpace(cfg.AccessKeyID) == "" || strings.TrimSpace(cfg.AccessKeySecret) == "" {
		return nil, &ProviderError{Code: ErrorInvalidRequest, Cause: errors.New("incomplete bailian config")}
	}
	client, err := bailian.NewClient(&openapi.Config{
		AccessKeyId:     dara.String(cfg.AccessKeyID),
		AccessKeySecret: dara.String(cfg.AccessKeySecret),
		Endpoint:        dara.String(endpoint),
		Protocol:        dara.String("https"),
		RegionId:        dara.String("cn-beijing"),
	})
	if err != nil {
		return nil, &ProviderError{Code: ErrorInvalidRequest, Cause: err}
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 5 * time.Minute}
	}
	logger := cfg.Logger
	if logger == nil {
		logger = zap.NewNop()
	}
	return &BailianProvider{client: client, workspaceID: strings.TrimSpace(cfg.WorkspaceID), httpClient: httpClient, logger: logger}, nil
}

func (p *BailianProvider) CreateKnowledgeBase(ctx context.Context, req CreateKnowledgeBaseRequest) (ProviderKnowledgeBase, error) {
	categoryName := temporaryCategoryPrefix + shortHash(req.Name+strconv.FormatInt(time.Now().UnixNano(), 10))
	categoryResp, err := p.client.AddCategoryWithContext(ctx, dara.String(p.workspaceID), (&bailian.AddCategoryRequest{}).SetCategoryName(categoryName).SetCategoryType("UNSTRUCTURED"), nil, noRetryRuntime())
	if err != nil {
		return ProviderKnowledgeBase{}, p.sdkError("add_category", err)
	}
	if categoryResp == nil || categoryResp.Body == nil {
		return ProviderKnowledgeBase{}, p.internalError("add_category", "empty response body")
	}
	if err := p.responseError("add_category", dara.BoolValue(categoryResp.Body.Success), value(categoryResp.Body.Code), value(categoryResp.Body.Message), value(categoryResp.Body.RequestId)); err != nil {
		return ProviderKnowledgeBase{}, err
	}
	if categoryResp.Body.Data == nil {
		return ProviderKnowledgeBase{}, p.internalError("add_category", "empty response data")
	}
	categoryID := value(categoryResp.Body.Data.CategoryId)
	if categoryID == "" {
		return ProviderKnowledgeBase{}, p.internalError("add_category", "missing category id")
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		resp, err := p.client.DeleteCategoryWithContext(cleanupCtx, dara.String(categoryID), dara.String(p.workspaceID), &bailian.DeleteCategoryRequest{}, nil, noRetryRuntime())
		if err != nil {
			_ = p.sdkError("cleanup_category", err)
			return
		}
		if resp == nil || resp.Body == nil {
			_ = p.internalError("cleanup_category", "empty response body")
			return
		}
		_ = p.responseError("cleanup_category", dara.BoolValue(resp.Body.Success), value(resp.Body.Code), value(resp.Body.Message), value(resp.Body.RequestId))
	}()

	createReq := newCreateIndexRequest(req, categoryID)
	createResp, err := p.client.CreateIndexWithContext(ctx, dara.String(p.workspaceID), createReq, nil, noRetryRuntime())
	if err != nil {
		return ProviderKnowledgeBase{}, p.sdkError("create_index", err)
	}
	if createResp == nil || createResp.Body == nil {
		return ProviderKnowledgeBase{}, p.internalError("create_index", "empty response body")
	}
	if err := p.responseError("create_index", dara.BoolValue(createResp.Body.Success), value(createResp.Body.Code), value(createResp.Body.Message), value(createResp.Body.RequestId)); err != nil {
		return ProviderKnowledgeBase{}, err
	}
	if createResp.Body.Data == nil {
		return ProviderKnowledgeBase{}, p.internalError("create_index", "empty response data")
	}
	indexID := value(createResp.Body.Data.Id)
	if indexID == "" {
		return ProviderKnowledgeBase{}, p.internalError("create_index", "missing index id")
	}
	return ProviderKnowledgeBase{ExternalID: indexID}, nil
}

func (p *BailianProvider) DeleteKnowledgeBase(ctx context.Context, externalKnowledgeBaseID string) error {
	resp, err := p.client.DeleteIndexWithContext(ctx, dara.String(p.workspaceID), (&bailian.DeleteIndexRequest{}).SetIndexId(externalKnowledgeBaseID), nil, noRetryRuntime())
	if err != nil {
		return p.recordError(ignoreNotFound(normalizeBailianErrorForOperation("delete_index", err)))
	}
	if resp == nil || resp.Body == nil {
		return p.internalError("delete_index", "empty response body")
	}
	return ignoreNotFound(p.responseError("delete_index", dara.BoolValue(resp.Body.Success), value(resp.Body.Code), value(resp.Body.Message), value(resp.Body.RequestId)))
}

func (p *BailianProvider) UploadDocument(ctx context.Context, externalKnowledgeBaseID string, file DocumentFile) (ProviderDocument, error) {
	// The MVP is single-instance; per-knowledge-base serialization makes the before/after index snapshot unambiguous.
	lock := p.uploadLock(externalKnowledgeBaseID)
	lock.Lock()
	defer lock.Unlock()
	existing, err := p.listDocuments(ctx, externalKnowledgeBaseID)
	if err != nil {
		return ProviderDocument{}, err
	}
	existingIDs := make(map[string]struct{}, len(existing))
	for _, item := range existing {
		existingIDs[item.document.ExternalID] = struct{}{}
	}
	data, err := io.ReadAll(file.Reader)
	if err != nil || int64(len(data)) != file.Size {
		return ProviderDocument{}, &ProviderError{Code: ErrorInvalidRequest, Cause: err}
	}
	sum := md5.Sum(data)
	leaseReq := (&bailian.ApplyFileUploadLeaseRequest{}).
		SetCategoryType("UNSTRUCTURED").
		SetFileName(file.Name).
		SetMd5(hex.EncodeToString(sum[:])).
		SetSizeInBytes(strconv.FormatInt(file.Size, 10))
	leaseResp, err := p.client.ApplyFileUploadLeaseWithContext(ctx, dara.String("default"), dara.String(p.workspaceID), leaseReq, nil, noRetryRuntime())
	if err != nil {
		return ProviderDocument{}, p.sdkError("apply_file_upload_lease", err)
	}
	if leaseResp == nil || leaseResp.Body == nil {
		return ProviderDocument{}, p.internalError("apply_file_upload_lease", "empty response body")
	}
	if err := p.responseError("apply_file_upload_lease", dara.BoolValue(leaseResp.Body.Success), value(leaseResp.Body.Code), value(leaseResp.Body.Message), value(leaseResp.Body.RequestId)); err != nil {
		return ProviderDocument{}, err
	}
	lease := leaseResp.Body.Data
	if lease == nil || lease.Param == nil || value(lease.FileUploadLeaseId) == "" || value(lease.Param.Url) == "" {
		return ProviderDocument{}, p.internalError("apply_file_upload_lease", "missing upload lease data")
	}
	uploadReq, err := http.NewRequestWithContext(ctx, firstNonEmpty(value(lease.Param.Method), http.MethodPut), value(lease.Param.Url), bytes.NewReader(data))
	if err != nil {
		return ProviderDocument{}, p.sdkError("upload_file_content", err)
	}
	for key, val := range stringMap(lease.Param.Headers) {
		uploadReq.Header.Set(key, val)
	}
	if _, ok := uploadReq.Header["Content-Type"]; !ok && file.MIMEType != "" {
		uploadReq.Header.Set("Content-Type", file.MIMEType)
	}
	uploadResp, err := p.httpClient.Do(uploadReq)
	if err != nil {
		return ProviderDocument{}, p.sdkError("upload_file_content", err)
	}
	defer uploadResp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(uploadResp.Body, 4096))
	if uploadResp.StatusCode < 200 || uploadResp.StatusCode >= 300 {
		return ProviderDocument{}, p.recordError(&ProviderError{Code: ErrorInternal, Retryable: uploadResp.StatusCode >= 500, Operation: "upload_file_content", HTTPStatus: uploadResp.StatusCode, ProviderMessage: "object storage upload failed"})
	}
	addResp, err := p.client.AddFileWithContext(ctx, dara.String(p.workspaceID), (&bailian.AddFileRequest{}).
		SetCategoryId("default").SetCategoryType("UNSTRUCTURED").SetLeaseId(value(lease.FileUploadLeaseId)).SetParser("AUTO_SELECT"), nil, noRetryRuntime())
	if err != nil {
		return ProviderDocument{}, p.sdkError("add_file", err)
	}
	if addResp == nil || addResp.Body == nil {
		return ProviderDocument{}, p.internalError("add_file", "empty response body")
	}
	if err := p.stringResponseError("add_file", true, value(addResp.Body.Success), value(addResp.Body.Code), value(addResp.Body.Message), value(addResp.Body.RequestId)); err != nil {
		return ProviderDocument{}, err
	}
	if addResp.Body.Data == nil {
		return ProviderDocument{}, p.internalError("add_file", "empty response data")
	}
	fileID := value(addResp.Body.Data.FileId)
	if fileID == "" {
		return ProviderDocument{}, p.internalError("add_file", "missing file id")
	}
	submitResp, err := p.client.SubmitIndexAddDocumentsJobWithContext(ctx, dara.String(p.workspaceID), (&bailian.SubmitIndexAddDocumentsJobRequest{}).
		SetIndexId(externalKnowledgeBaseID).SetSourceType("DATA_CENTER_FILE").SetDocumentIds([]*string{dara.String(fileID)}), nil, noRetryRuntime())
	if err != nil {
		p.cleanupFile(fileID)
		return ProviderDocument{}, p.sdkError("submit_index_add_documents_job", err)
	}
	if submitResp == nil || submitResp.Body == nil {
		p.cleanupFile(fileID)
		return ProviderDocument{}, p.internalError("submit_index_add_documents_job", "empty response body")
	}
	if err := p.responseError("submit_index_add_documents_job", dara.BoolValue(submitResp.Body.Success), value(submitResp.Body.Code), value(submitResp.Body.Message), value(submitResp.Body.RequestId)); err != nil {
		p.cleanupFile(fileID)
		return ProviderDocument{}, err
	}
	if submitResp.Body.Data == nil || value(submitResp.Body.Data.Id) == "" {
		p.cleanupFile(fileID)
		return ProviderDocument{}, p.internalError("submit_index_add_documents_job", "missing job data")
	}
	document, err := p.waitForNewDocument(ctx, externalKnowledgeBaseID, file, existingIDs)
	if err != nil {
		p.cleanupFile(fileID)
		return ProviderDocument{}, err
	}
	return document, nil
}

func (p *BailianProvider) ListDocuments(ctx context.Context, externalKnowledgeBaseID string) ([]ProviderDocument, error) {
	items, err := p.listDocuments(ctx, externalKnowledgeBaseID)
	if err != nil {
		return nil, err
	}
	out := make([]ProviderDocument, 0, len(items))
	for _, item := range items {
		out = append(out, item.document)
	}
	return out, nil
}

type bailianIndexDocument struct {
	document ProviderDocument
}

func (p *BailianProvider) listDocuments(ctx context.Context, externalKnowledgeBaseID string) ([]bailianIndexDocument, error) {
	out := []bailianIndexDocument{}
	for page := int32(1); ; page++ {
		resp, err := p.client.ListIndexDocumentsWithContext(ctx, dara.String(p.workspaceID), (&bailian.ListIndexDocumentsRequest{}).SetIndexId(externalKnowledgeBaseID).SetPageNumber(page).SetPageSize(100), nil, noRetryRuntime())
		if err != nil {
			return nil, p.sdkError("list_index_documents", err)
		}
		if resp == nil || resp.Body == nil {
			return nil, p.internalError("list_index_documents", "empty response body")
		}
		if err := p.responseError("list_index_documents", dara.BoolValue(resp.Body.Success), value(resp.Body.Code), value(resp.Body.Message), value(resp.Body.RequestId)); err != nil {
			return nil, err
		}
		if resp.Body.Data == nil {
			return out, nil
		}
		for _, item := range resp.Body.Data.Documents {
			if item == nil || value(item.Id) == "" {
				continue
			}
			name := bailianDocumentName(value(item.Name), value(item.DocumentType))
			status := mapBailianDocumentStatus(value(item.Status))
			out = append(out, bailianIndexDocument{document: ProviderDocument{ExternalID: value(item.Id), Name: name, Size: int64(dara.Int32Value(item.Size)), MIMEType: mimeFromName(name), Status: status, ErrorMessage: normalizedProviderMessage(status, value(item.Message))}})
		}
		if int64(page)*int64(dara.Int32Value(resp.Body.Data.PageSize)) >= dara.Int64Value(resp.Body.Data.TotalCount) || len(resp.Body.Data.Documents) == 0 {
			break
		}
	}
	return out, nil
}

func (p *BailianProvider) DeleteDocument(ctx context.Context, externalKnowledgeBaseID, externalDocumentID string) error {
	resp, err := p.client.DeleteIndexDocumentWithContext(ctx, dara.String(p.workspaceID), (&bailian.DeleteIndexDocumentRequest{}).SetIndexId(externalKnowledgeBaseID).SetDocumentIds([]*string{dara.String(externalDocumentID)}), nil, noRetryRuntime())
	if err != nil {
		return p.recordError(ignoreNotFound(normalizeBailianErrorForOperation("delete_index_document", err)))
	}
	if resp == nil || resp.Body == nil {
		return p.internalError("delete_index_document", "empty response body")
	}
	if err := ignoreNotFound(p.responseError("delete_index_document", dara.BoolValue(resp.Body.Success), value(resp.Body.Code), value(resp.Body.Message), value(resp.Body.RequestId))); err != nil {
		return err
	}
	return nil
}

func (p *BailianProvider) uploadLock(externalKnowledgeBaseID string) *sync.Mutex {
	lock, _ := p.uploadLocks.LoadOrStore(externalKnowledgeBaseID, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

func (p *BailianProvider) waitForNewDocument(ctx context.Context, externalKnowledgeBaseID string, file DocumentFile, existingIDs map[string]struct{}) (ProviderDocument, error) {
	for {
		items, err := p.listDocuments(ctx, externalKnowledgeBaseID)
		if err != nil {
			return ProviderDocument{}, err
		}
		if document, ok := selectNewBailianDocument(items, existingIDs, file.Name, file.Size); ok {
			return document, nil
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ProviderDocument{}, p.sdkError("wait_for_index_document", ctx.Err())
		case <-timer.C:
		}
	}
}

func selectNewBailianDocument(items []bailianIndexDocument, existingIDs map[string]struct{}, name string, size int64) (ProviderDocument, bool) {
	for _, item := range items {
		document := item.document
		if _, exists := existingIDs[document.ExternalID]; exists {
			continue
		}
		if strings.EqualFold(document.Name, name) && document.Size == size {
			return document, true
		}
	}
	return ProviderDocument{}, false
}

func bailianDocumentName(name, documentType string) string {
	ext := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(documentType)), ".")
	if ext == "excel" {
		ext = "xlsx"
	}
	if ext == "" || strings.HasSuffix(strings.ToLower(name), "."+ext) {
		return name
	}
	return name + "." + ext
}

func (p *BailianProvider) Search(ctx context.Context, req SearchRequest) (SearchResult, error) {
	resp, err := p.client.RetrieveWithContext(ctx, dara.String(p.workspaceID), (&bailian.RetrieveRequest{}).
		SetIndexId(req.ExternalKnowledgeBaseID).SetQuery(strings.TrimSpace(req.Query)).SetRerankTopN(int32(req.TopK)).SetEnableReranking(true).SetEnableRewrite(false).SetSaveRetrieverHistory(false), nil, noRetryRuntime())
	if err != nil {
		return SearchResult{}, p.sdkError("retrieve", err)
	}
	if resp == nil || resp.Body == nil {
		return SearchResult{}, p.internalError("retrieve", "empty response body")
	}
	if err := p.responseError("retrieve", dara.BoolValue(resp.Body.Success), value(resp.Body.Code), value(resp.Body.Message), value(resp.Body.RequestId)); err != nil {
		return SearchResult{}, err
	}
	result := EmptySearchResult()
	if resp.Body.Data == nil {
		return result, nil
	}
	for _, node := range resp.Body.Data.Nodes {
		if node == nil || strings.TrimSpace(value(node.Text)) == "" {
			continue
		}
		metadata := stringMap(node.Metadata)
		documentName := firstNonEmpty(metadata["doc_name"], metadata["title"], "unknown")
		sourceID := firstNonEmpty(metadata["nid"], metadata["doc_id"], metadata["_id"])
		if sourceID == "" {
			continue
		}
		section := metadata["hier_title"]
		if section == documentName {
			section = ""
		}
		result.Chunks = append(result.Chunks, SearchChunk{Text: value(node.Text), DocumentName: documentName, SourceID: sourceID, Section: section, Score: node.Score})
	}
	return result, nil
}

func noRetryRuntime() *dara.RuntimeOptions {
	return new(dara.RuntimeOptions).SetAutoretry(false).SetMaxAttempts(1)
}

func (p *BailianProvider) cleanupKnowledgeBase(indexID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = p.DeleteKnowledgeBase(ctx, indexID)
}

func (p *BailianProvider) cleanupFile(fileID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := p.client.DeleteFileWithContext(ctx, dara.String(fileID), dara.String(p.workspaceID), &bailian.DeleteFileRequest{}, nil, noRetryRuntime()); err != nil {
		_ = p.sdkError("cleanup_file", err)
	}
}

func newCreateIndexRequest(req CreateKnowledgeBaseRequest, categoryID string) *bailian.CreateIndexRequest {
	return (&bailian.CreateIndexRequest{}).
		SetName(providerName(req.Name)).
		SetDescription(req.Description).
		SetCategoryIds([]*string{dara.String(categoryID)}).
		SetSourceType("DATA_CENTER_CATEGORY").
		SetStructureType("unstructured").
		SetSinkType("BUILT_IN").
		SetEmbeddingModelName("text-embedding-v4").
		SetRerankModelName("qwen3-rerank").
		SetEnableRewrite(false)
}

func providerName(name string) string {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) <= 20 {
		return name
	}
	runes := []rune(name)
	return string(runes[:11]) + "-" + shortHash(name)
}

func shortHash(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])[:8]
}
func mapBailianDocumentStatus(status string) DocumentStatus {
	switch strings.ToUpper(status) {
	case "FINISH":
		return DocumentReady
	case "INSERT_ERROR", "PARSE_FAILED":
		return DocumentFailed
	default:
		return DocumentProcessing
	}
}
func normalizedProviderMessage(status DocumentStatus, message string) string {
	if status != DocumentFailed || strings.TrimSpace(message) == "" {
		return ""
	}
	return "provider_processing_failed"
}
func mimeFromName(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".pdf":
		return "application/pdf"
	case ".docx":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case ".xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case ".csv":
		return "text/csv"
	case ".md":
		return "text/markdown"
	default:
		return "text/plain"
	}
}
func value(v *string) string { return strings.TrimSpace(dara.StringValue(v)) }
func firstNonEmpty(values ...string) string {
	for _, item := range values {
		if strings.TrimSpace(item) != "" {
			return strings.TrimSpace(item)
		}
	}
	return ""
}
func stringMap(value any) map[string]string {
	raw, err := json.Marshal(value)
	if err != nil {
		return map[string]string{}
	}
	var generic map[string]any
	if json.Unmarshal(raw, &generic) != nil {
		return map[string]string{}
	}
	out := map[string]string{}
	for key, item := range generic {
		if text, ok := item.(string); ok {
			out[key] = text
		}
	}
	return out
}
func checkStringSuccess(hasBody bool, success, code string) error {
	return checkBailianResponse(hasBody && strings.EqualFold(success, "true"), code)
}
func checkBailianResponse(success bool, code string) error {
	if success {
		return nil
	}
	return &ProviderError{Code: classifyBailianCode(code), Retryable: classifyBailianCode(code) == ErrorRateLimited}
}

func (p *BailianProvider) sdkError(operation string, err error) error {
	return p.recordError(normalizeBailianErrorForOperation(operation, err))
}

func (p *BailianProvider) responseError(operation string, success bool, code, message, requestID string) error {
	if success {
		return nil
	}
	normalized := classifyBailianCode(code + " " + message)
	return p.recordError(&ProviderError{
		Code:            normalized,
		Retryable:       normalized == ErrorRateLimited,
		Operation:       operation,
		ProviderCode:    code,
		ProviderMessage: safeProviderMessage(message),
		RequestID:       requestID,
	})
}

func (p *BailianProvider) stringResponseError(operation string, hasBody bool, success, code, message, requestID string) error {
	return p.responseError(operation, hasBody && strings.EqualFold(success, "true"), code, message, requestID)
}

func (p *BailianProvider) internalError(operation, message string) error {
	return p.recordError(&ProviderError{Code: ErrorInternal, Operation: operation, ProviderMessage: safeProviderMessage(message)})
}

func (p *BailianProvider) operationError(operation string, err error) error {
	if err == nil {
		return nil
	}
	var providerErr *ProviderError
	if errors.As(err, &providerErr) && providerErr.Operation != "" {
		return err
	}
	return p.recordError(normalizeBailianErrorForOperation(operation, err))
}

func (p *BailianProvider) recordError(err error) error {
	if err != nil {
		p.logProviderError(err)
	}
	return err
}

func (p *BailianProvider) logProviderError(err error) {
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) {
		return
	}
	logger := p.logger
	if logger == nil {
		logger = zap.NewNop()
	}
	fields := []zap.Field{
		zap.String("provider", "bailian"),
		zap.String("operation", providerErr.Operation),
		zap.String("error_code", providerErr.Code),
		zap.Bool("retryable", providerErr.Retryable),
	}
	if providerErr.HTTPStatus > 0 {
		fields = append(fields, zap.Int("http_status", providerErr.HTTPStatus))
	}
	if providerErr.ProviderCode != "" {
		fields = append(fields, zap.String("provider_code", providerErr.ProviderCode))
	}
	if providerErr.ProviderMessage != "" {
		fields = append(fields, zap.String("provider_message", providerErr.ProviderMessage))
	}
	if providerErr.RequestID != "" {
		fields = append(fields, zap.String("provider_request_id", providerErr.RequestID))
	}
	logger.Error("bailian api call failed", fields...)
}

func classifyBailianCode(code string) string {
	lower := strings.ToLower(code)
	switch {
	case strings.Contains(lower, "notfound") || strings.Contains(lower, "not_found") || strings.Contains(lower, "notexist") || strings.Contains(lower, "not_exist") || strings.Contains(lower, "not exist") || strings.Contains(lower, "不存在"):
		return ErrorNotFound
	case strings.Contains(lower, "alreadyexists") || strings.Contains(lower, "already_exists") || strings.Contains(lower, "already exists"):
		return ErrorConflict
	case strings.Contains(lower, "forbidden") || strings.Contains(lower, "unauthorized") || strings.Contains(lower, "not authorized") || strings.Contains(lower, "accessdenied") || strings.Contains(lower, "access_denied"):
		return ErrorUnauthorized
	case strings.Contains(lower, "thrott") || strings.Contains(lower, "rate"):
		return ErrorRateLimited
	case strings.Contains(lower, "invalid") || strings.Contains(lower, "parameter"):
		return ErrorInvalidRequest
	default:
		return ErrorInternal
	}
}
func normalizeBailianError(err error) error {
	return normalizeBailianErrorForOperation("", err)
}

func normalizeBailianErrorForOperation(operation string, err error) error {
	if err == nil {
		return nil
	}
	var providerErr *ProviderError
	if errors.As(err, &providerErr) {
		if providerErr.Operation == "" {
			providerErr.Operation = operation
		}
		return providerErr
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &ProviderError{Code: ErrorTimeout, Retryable: true, Operation: operation, Cause: err}
	}
	details := &ProviderError{Operation: operation, Cause: err}
	var sdkErr *tea.SDKError
	if errors.As(err, &sdkErr) {
		details.HTTPStatus = dara.IntValue(sdkErr.StatusCode)
		data := sdkErrorData(dara.StringValue(sdkErr.Data))
		details.ProviderCode = firstNonEmpty(value(sdkErr.Code), data["Code"], data["code"])
		details.ProviderMessage = safeProviderMessage(firstNonEmpty(value(sdkErr.Message), data["Message"], data["message"]))
		details.RequestID = firstNonEmpty(data["RequestId"], data["RequestID"], data["requestId"], data["request_id"])
	}
	text := strings.ToLower(strings.Join([]string{details.ProviderCode, details.ProviderMessage, err.Error()}, " "))
	details.Code = classifyBailianCode(text)
	switch {
	case details.HTTPStatus == http.StatusUnauthorized || details.HTTPStatus == http.StatusForbidden:
		details.Code = ErrorUnauthorized
	case details.HTTPStatus == http.StatusTooManyRequests:
		details.Code = ErrorRateLimited
	case strings.Contains(text, "timeout"):
		details.Code = ErrorTimeout
	}
	details.Retryable = details.Code == ErrorTimeout || details.Code == ErrorRateLimited || details.HTTPStatus >= 500
	return details
}

func sdkErrorData(raw string) map[string]string {
	if strings.TrimSpace(raw) == "" {
		return map[string]string{}
	}
	var generic map[string]any
	if json.Unmarshal([]byte(raw), &generic) != nil {
		return map[string]string{}
	}
	out := make(map[string]string, len(generic))
	for key, item := range generic {
		if text, ok := item.(string); ok {
			out[key] = strings.TrimSpace(text)
		}
	}
	return out
}

func safeProviderMessage(message string) string {
	message = strings.Join(strings.Fields(message), " ")
	runes := []rune(message)
	if len(runes) > 512 {
		return string(runes[:512])
	}
	return message
}
func ignoreNotFound(err error) error {
	var providerErr *ProviderError
	if errors.As(err, &providerErr) && providerErr.Code == ErrorNotFound {
		return nil
	}
	return err
}
