package provider

import (
	"context"
	"io"
)

const (
	ErrorInvalidRequest = "invalid_request"
	ErrorUnauthorized   = "unauthorized"
	ErrorNotFound       = "not_found"
	ErrorRateLimited    = "rate_limited"
	ErrorTimeout        = "timeout"
	ErrorConflict       = "conflict"
	ErrorInternal       = "internal"
)

type CreateKnowledgeBaseRequest struct {
	Name        string
	Description string
}

type ProviderKnowledgeBase struct {
	ExternalID string
}

type DocumentFile struct {
	Name     string
	Size     int64
	MIMEType string
	Reader   io.Reader
}

type DocumentStatus string

const (
	DocumentProcessing DocumentStatus = "processing"
	DocumentReady      DocumentStatus = "ready"
	DocumentFailed     DocumentStatus = "failed"
)

type ProviderDocument struct {
	ExternalID   string
	Name         string
	Size         int64
	MIMEType     string
	Status       DocumentStatus
	ErrorMessage string
}

type SearchRequest struct {
	ExternalKnowledgeBaseID string
	Query                   string
	TopK                    int
}

type SearchChunk struct {
	Text         string   `json:"text"`
	DocumentName string   `json:"document_name"`
	SourceID     string   `json:"source_id"`
	Section      string   `json:"section,omitempty"`
	Score        *float64 `json:"score,omitempty"`
}

type SearchResult struct {
	Chunks []SearchChunk `json:"chunks"`
}

func EmptySearchResult() SearchResult {
	return SearchResult{Chunks: []SearchChunk{}}
}

type ProviderError struct {
	Code            string
	Retryable       bool
	Operation       string
	HTTPStatus      int
	ProviderCode    string
	ProviderMessage string
	RequestID       string
	Cause           error
}

func (e *ProviderError) Error() string {
	if e == nil || e.Code == "" {
		return ErrorInternal
	}
	return e.Code
}

func (e *ProviderError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

type KnowledgeProvider interface {
	CreateKnowledgeBase(context.Context, CreateKnowledgeBaseRequest) (ProviderKnowledgeBase, error)
	DeleteKnowledgeBase(context.Context, string) error
	UploadDocument(context.Context, string, DocumentFile) (ProviderDocument, error)
	ListDocuments(context.Context, string) ([]ProviderDocument, error)
	DeleteDocument(context.Context, string, string) error
	Search(context.Context, SearchRequest) (SearchResult, error)
}
