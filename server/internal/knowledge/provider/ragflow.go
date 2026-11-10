package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/config"
)

type RAGFlowConfig struct {
	BaseURL        string
	APIKey         string
	EmbeddingModel string
	RerankID       string
	HTTPClient     *http.Client
	Logger         *zap.Logger
}

type RAGFlowProvider struct {
	baseURL        *url.URL
	apiKey         string
	embeddingModel string
	rerankID       string
	httpClient     *http.Client
	logger         *zap.Logger
}

var _ KnowledgeProvider = (*RAGFlowProvider)(nil)

func NewRAGFlowProvider(cfg RAGFlowConfig) (*RAGFlowProvider, error) {
	base, err := config.NormalizeRAGFlowBaseURL(cfg.BaseURL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		return nil, errors.New("RAGFlow API Key 不能为空")
	}
	parsed, _ := url.Parse(base)
	client := http.Client{Timeout: 5 * time.Minute}
	if cfg.HTTPClient != nil {
		client = *cfg.HTTPClient
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	logger := cfg.Logger
	if logger == nil {
		logger = zap.NewNop()
	}
	return &RAGFlowProvider{baseURL: parsed, apiKey: strings.TrimSpace(cfg.APIKey), embeddingModel: strings.TrimSpace(cfg.EmbeddingModel), rerankID: strings.TrimSpace(cfg.RerankID), httpClient: &client, logger: logger}, nil
}

func (p *RAGFlowProvider) endpoint(parts ...string) *url.URL {
	// 每个 ID 作为一个路径段转义，避免上游 ID 改变目标路由。
	result := *p.baseURL
	escaped := "/api/v1"
	for _, part := range parts {
		escaped += "/" + url.PathEscape(part)
	}
	result.Path, _ = url.PathUnescape(escaped)
	result.RawPath = escaped
	return &result
}

type ragflowEnvelope struct {
	Code *int            `json:"code"`
	Data json.RawMessage `json:"data"`
}

func ragflowError(operation, code string) *ProviderError {
	return &ProviderError{Operation: operation, Code: code}
}

func (p *RAGFlowProvider) request(ctx context.Context, operation, method string, endpoint *url.URL, body io.Reader, contentType string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return ragflowError(operation, ErrorInternal)
	}
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := p.httpClient.Do(req)
	if err != nil {
		code := ErrorInternal
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code = ErrorTimeout
		}
		return &ProviderError{Code: code, Operation: operation, Retryable: true}
	}
	defer resp.Body.Close()
	var envelope ragflowEnvelope
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 64<<20))
	decodeErr := decoder.Decode(&envelope)
	var extra any
	if decodeErr == nil {
		if trailingErr := decoder.Decode(&extra); trailingErr != io.EOF {
			decodeErr = trailingErr
			if decodeErr == nil {
				decodeErr = errors.New("响应包含多余内容")
			}
		}
	}
	if decodeErr != nil && (errors.Is(decodeErr, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded)) {
		return &ProviderError{Code: ErrorTimeout, Operation: operation, HTTPStatus: resp.StatusCode, Retryable: true}
	}
	code := ErrorInternal
	retryable := false
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		code = ErrorUnauthorized
	case resp.StatusCode == http.StatusTooManyRequests:
		code, retryable = ErrorRateLimited, true
	case resp.StatusCode >= 500:
		retryable = true
	case resp.StatusCode == http.StatusBadRequest:
		code = ErrorInvalidRequest
	case decodeErr == nil && envelope.Code != nil:
		switch *envelope.Code {
		case 108, 109:
			code = ErrorUnauthorized
		case 101:
			code = ErrorInvalidRequest
		case 105:
			retryable = true
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || decodeErr != nil || envelope.Code == nil || *envelope.Code != 0 {
		providerCode := ""
		if envelope.Code != nil {
			providerCode = strconv.Itoa(*envelope.Code)
		}
		return &ProviderError{Code: code, Operation: operation, HTTPStatus: resp.StatusCode, ProviderCode: providerCode, Retryable: retryable}
	}
	if out != nil && (len(envelope.Data) == 0 || bytes.Equal(bytes.TrimSpace(envelope.Data), []byte("null")) || json.Unmarshal(envelope.Data, out) != nil) {
		return &ProviderError{Code: ErrorInternal, Operation: operation, HTTPStatus: resp.StatusCode}
	}
	return nil
}

func (p *RAGFlowProvider) jsonRequest(ctx context.Context, operation, method string, endpoint *url.URL, body any, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return ragflowError(operation, ErrorInvalidRequest)
		}
		reader = bytes.NewReader(raw)
	}
	return p.request(ctx, operation, method, endpoint, reader, "application/json", out)
}

func (p *RAGFlowProvider) CreateKnowledgeBase(ctx context.Context, req CreateKnowledgeBaseRequest) (ProviderKnowledgeBase, error) {
	const operation = "create_dataset"
	if strings.TrimSpace(req.Name) == "" || !utf8.ValidString(req.Name) {
		return ProviderKnowledgeBase{}, ragflowError(operation, ErrorInvalidRequest)
	}
	for _, char := range req.Name {
		if char > 0xffff {
			return ProviderKnowledgeBase{}, ragflowError(operation, ErrorInvalidRequest)
		}
	}
	body := map[string]any{"name": req.Name, "language": "Chinese", "parse_type": 1, "parser_id": "general", "permission": "me"}
	if p.embeddingModel != "" {
		body["embedding_model"] = p.embeddingModel
	}
	var data struct {
		ID string `json:"id"`
	}
	if err := p.jsonRequest(ctx, operation, http.MethodPost, p.endpoint("datasets"), body, &data); err != nil {
		p.logUncertain(operation, err)
		return ProviderKnowledgeBase{}, err
	}
	if strings.TrimSpace(data.ID) == "" {
		return ProviderKnowledgeBase{}, ragflowError(operation, ErrorInternal)
	}
	return ProviderKnowledgeBase{ExternalID: data.ID}, nil
}

func (p *RAGFlowProvider) UploadDocument(ctx context.Context, datasetID string, file DocumentFile) (ProviderDocument, error) {
	const operation = "upload_document"
	if strings.TrimSpace(datasetID) == "" || strings.TrimSpace(file.Name) == "" || file.Reader == nil {
		return ProviderDocument{}, ragflowError(operation, ErrorInvalidRequest)
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", file.Name)
	if err == nil {
		_, err = io.Copy(part, file.Reader)
	}
	if err != nil {
		return ProviderDocument{}, ragflowError(operation, ErrorInvalidRequest)
	}
	if err := writer.Close(); err != nil {
		return ProviderDocument{}, ragflowError(operation, ErrorInternal)
	}
	var docs []ragflowDocument
	if err := p.request(ctx, operation, http.MethodPost, p.endpoint("datasets", datasetID, "documents"), &body, writer.FormDataContentType(), &docs); err != nil {
		p.logUncertain(operation, err)
		return ProviderDocument{}, err
	}
	if len(docs) != 1 || strings.TrimSpace(docs[0].ID) == "" {
		return ProviderDocument{}, ragflowError(operation, ErrorInternal)
	}
	docID := docs[0].ID
	if err := p.jsonRequest(ctx, "start_parsing", http.MethodPost, p.endpoint("datasets", datasetID, "chunks"), map[string]any{"document_ids": []string{docID}}, nil); err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cleanupErr := p.DeleteDocument(cleanupCtx, datasetID, docID)
		code := ""
		if cleanupErr != nil {
			code = ErrorInternal
			var typed *ProviderError
			if errors.As(cleanupErr, &typed) {
				code = typed.Code
			}
		}
		p.logger.Error("RAGFlow 解析启动失败后的补偿", zap.String("operation", "cleanup_uploaded_document"), zap.String("dataset_id", datasetID), zap.String("document_id", docID), zap.String("provider_error_code", code), zap.Bool("compensation_failed", cleanupErr != nil))
		return ProviderDocument{}, err
	}
	return ProviderDocument{ExternalID: docID, Name: file.Name, Size: file.Size, MIMEType: file.MIMEType, Status: DocumentProcessing}, nil
}

func (p *RAGFlowProvider) logUncertain(operation string, err error) {
	var typed *ProviderError
	if errors.As(err, &typed) && typed.Retryable {
		p.logger.Warn("RAGFlow 写入结果待核对", zap.String("operation", operation), zap.String("provider_error_code", typed.Code))
	}
}

type ragflowDocument struct {
	ID          string          `json:"id"`
	DatasetID   string          `json:"dataset_id"`
	Name        string          `json:"name"`
	Size        int64           `json:"size"`
	Run         json.RawMessage `json:"run"`
	ProgressMsg json.RawMessage `json:"progress_msg"`
}

func ragflowDocumentStatus(raw json.RawMessage) (DocumentStatus, string) {
	value := strings.TrimSpace(string(raw))
	if strings.HasPrefix(value, "\"") {
		if json.Unmarshal(raw, &value) != nil {
			value = ""
		}
	}
	switch value {
	case "UNSTART", "0", "RUNNING", "1", "SCHEDULE", "5":
		return DocumentProcessing, ""
	case "DONE", "3":
		return DocumentReady, ""
	case "FAIL", "4":
		return DocumentFailed, "文档处理失败"
	case "CANCEL", "2":
		return DocumentFailed, "文档处理已取消"
	default:
		return DocumentFailed, "无法识别文档处理状态"
	}
}

func (p *RAGFlowProvider) ListDocuments(ctx context.Context, datasetID string) ([]ProviderDocument, error) {
	const operation = "list_documents"
	if strings.TrimSpace(datasetID) == "" {
		return nil, ragflowError(operation, ErrorInvalidRequest)
	}
	items := []ProviderDocument{}
	seen := map[string]bool{}
	for page := 1; ; page++ {
		endpoint := p.endpoint("datasets", datasetID, "documents")
		endpoint.RawQuery = url.Values{"page": {strconv.Itoa(page)}, "page_size": {"100"}, "orderby": {"create_time"}, "desc": {"false"}}.Encode()
		var data struct {
			Docs *[]ragflowDocument `json:"docs"`
		}
		if err := p.jsonRequest(ctx, operation, http.MethodGet, endpoint, nil, &data); err != nil {
			return nil, err
		}
		if data.Docs == nil {
			return nil, ragflowError(operation, ErrorInternal)
		}
		if len(*data.Docs) == 0 {
			return items, nil
		}
		added := 0
		for _, doc := range *data.Docs {
			if strings.TrimSpace(doc.ID) == "" || (doc.DatasetID != "" && doc.DatasetID != datasetID) {
				return nil, ragflowError(operation, ErrorInternal)
			}
			if seen[doc.ID] {
				continue
			}
			seen[doc.ID] = true
			added++
			status, message := ragflowDocumentStatus(doc.Run)
			items = append(items, ProviderDocument{ExternalID: doc.ID, Name: doc.Name, Size: doc.Size, Status: status, ErrorMessage: message})
		}
		if added == 0 {
			return nil, ragflowError(operation, ErrorInternal)
		}
	}
}

func (p *RAGFlowProvider) Search(ctx context.Context, req SearchRequest) (SearchResult, error) {
	const operation = "retrieval"
	if strings.TrimSpace(req.ExternalKnowledgeBaseID) == "" || strings.TrimSpace(req.Query) == "" || req.TopK < 1 || req.TopK > 20 {
		return EmptySearchResult(), ragflowError(operation, ErrorInvalidRequest)
	}
	body := map[string]any{"question": req.Query, "dataset_ids": []string{req.ExternalKnowledgeBaseID}, "page": 1, "page_size": req.TopK, "highlight": false, "use_kg": false, "include_knowledge_compilation": false}
	if p.rerankID != "" {
		body["rerank_id"] = p.rerankID
	}
	var data struct {
		Chunks *[]struct {
			ID              string   `json:"id"`
			DatasetID       string   `json:"dataset_id"`
			DocumentID      string   `json:"document_id"`
			Content         string   `json:"content"`
			DocumentKeyword string   `json:"document_keyword"`
			Similarity      *float64 `json:"similarity"`
		} `json:"chunks"`
		DocAggs []struct {
			DocumentID string `json:"document_id"`
			DocName    string `json:"doc_name"`
		} `json:"doc_aggs"`
	}
	if err := p.jsonRequest(ctx, operation, http.MethodPost, p.endpoint("retrieval"), body, &data); err != nil {
		return EmptySearchResult(), err
	}
	if data.Chunks == nil {
		return EmptySearchResult(), ragflowError(operation, ErrorInternal)
	}
	names := map[string]string{}
	for _, doc := range data.DocAggs {
		names[doc.DocumentID] = doc.DocName
	}
	result := EmptySearchResult()
	for _, chunk := range *data.Chunks {
		if chunk.DatasetID != "" && chunk.DatasetID != req.ExternalKnowledgeBaseID {
			return EmptySearchResult(), ragflowError(operation, ErrorInternal)
		}
		if strings.TrimSpace(chunk.ID) == "" || strings.TrimSpace(chunk.Content) == "" {
			continue
		}
		if chunk.Similarity != nil && (math.IsNaN(*chunk.Similarity) || math.IsInf(*chunk.Similarity, 0)) {
			return EmptySearchResult(), ragflowError(operation, ErrorInternal)
		}
		name := chunk.DocumentKeyword
		if strings.TrimSpace(name) == "" {
			name = names[chunk.DocumentID]
		}
		if strings.TrimSpace(name) == "" {
			name = "未命名文档"
		}
		result.Chunks = append(result.Chunks, SearchChunk{Text: chunk.Content, DocumentName: name, SourceID: chunk.ID, Score: chunk.Similarity})
	}
	if len(result.Chunks) > req.TopK {
		result.Chunks = result.Chunks[:req.TopK]
	}
	return result, nil
}

func (p *RAGFlowProvider) DeleteKnowledgeBase(ctx context.Context, datasetID string) error {
	const operation = "delete_dataset"
	if strings.TrimSpace(datasetID) == "" {
		return ragflowError(operation, ErrorInvalidRequest)
	}
	err := p.jsonRequest(ctx, operation, http.MethodDelete, p.endpoint("datasets"), map[string]any{"ids": []string{datasetID}}, nil)
	if err == nil {
		return nil
	}
	if missing, confirmErr := p.datasetMissing(ctx, datasetID); confirmErr == nil && missing {
		return nil
	}
	return ragflowDeleteError(err)
}

func (p *RAGFlowProvider) datasetMissing(ctx context.Context, datasetID string) (bool, error) {
	endpoint := p.endpoint("datasets")
	endpoint.RawQuery = url.Values{"id": {datasetID}}.Encode()
	var datasets []struct {
		ID string `json:"id"`
	}
	if err := p.jsonRequest(ctx, "confirm_dataset", http.MethodGet, endpoint, nil, &datasets); err != nil {
		return false, err
	}
	for _, dataset := range datasets {
		if dataset.ID != datasetID {
			return false, ragflowError("confirm_dataset", ErrorInternal)
		}
	}
	return len(datasets) == 0, nil
}

func (p *RAGFlowProvider) DeleteDocument(ctx context.Context, datasetID, documentID string) error {
	const operation = "delete_document"
	if strings.TrimSpace(datasetID) == "" || strings.TrimSpace(documentID) == "" {
		return ragflowError(operation, ErrorInvalidRequest)
	}
	err := p.jsonRequest(ctx, operation, http.MethodDelete, p.endpoint("datasets", datasetID, "documents"), map[string]any{"ids": []string{documentID}}, nil)
	if err == nil {
		return nil
	}
	endpoint := p.endpoint("datasets", datasetID, "documents")
	endpoint.RawQuery = url.Values{"id": {documentID}, "page": {"1"}, "page_size": {"100"}}.Encode()
	var data struct {
		Docs *[]ragflowDocument `json:"docs"`
	}
	confirmErr := p.jsonRequest(ctx, "confirm_document", http.MethodGet, endpoint, nil, &data)
	if confirmErr == nil && data.Docs != nil {
		valid := true
		for _, doc := range *data.Docs {
			if doc.ID != documentID || (doc.DatasetID != "" && doc.DatasetID != datasetID) {
				valid = false
			}
		}
		if valid && len(*data.Docs) == 0 {
			return nil
		}
	}
	if confirmErr != nil {
		if missing, datasetErr := p.datasetMissing(ctx, datasetID); datasetErr == nil && missing {
			return nil
		}
	}
	return ragflowDeleteError(err)
}

// Service 保留百炼 invalid_request 的历史缺失判断，RAGFlow 只接受精确查询确认。
func ragflowDeleteError(err error) error {
	var typed *ProviderError
	if errors.As(err, &typed) && typed.Code == ErrorInvalidRequest {
		copy := *typed
		copy.Code = ErrorInternal
		return &copy
	}
	return err
}
