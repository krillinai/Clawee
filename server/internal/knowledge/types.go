package knowledge

import (
	"errors"
	"fmt"
	"io"
	"time"
)

const (
	ProviderBailian    = "bailian"
	AdapterServerID    = "knowledge-adapter"
	SearchUpstreamName = "search"

	KnowledgeBaseCreating     = "creating"
	KnowledgeBaseActive       = "active"
	KnowledgeBaseCreateFailed = "create_failed"
	KnowledgeBaseDeleting     = "deleting"
	KnowledgeBaseDeleteFailed = "delete_failed"
	KnowledgeBaseDeleted      = "deleted"

	DocumentUploading    = "uploading"
	DocumentProcessing   = "processing"
	DocumentReady        = "ready"
	DocumentFailed       = "failed"
	DocumentDeleting     = "deleting"
	DocumentDeleteFailed = "delete_failed"
	DocumentDeleted      = "deleted"

	MaxDocumentSize           = 50 << 20
	KnowledgeOperationTimeout = 30 * time.Second
	DocumentUploadTimeout     = 5 * time.Minute
	MaxConcurrentSearches     = 5
)

var (
	ErrInvalidRequest                     = errors.New("invalid knowledge request")
	ErrNotFound                           = errors.New("knowledge object not found")
	ErrConflict                           = errors.New("knowledge operation conflict")
	ErrProvider                           = errors.New("knowledge provider error")
	ErrKnowledgeBaseHasAccountGrants      = fmt.Errorf("%w: knowledge base has account grants", ErrConflict)
	ErrKnowledgeBaseHasUploadingDocuments = fmt.Errorf("%w: knowledge base has uploading documents", ErrConflict)
	ErrKnowledgeBaseCreating              = fmt.Errorf("%w: knowledge base is creating", ErrConflict)
)

type KnowledgeBase struct {
	KnowledgeBaseID         string     `json:"knowledge_base_id"`
	Name                    string     `json:"name"`
	Description             string     `json:"description"`
	ProviderType            string     `json:"provider_type"`
	ExternalKnowledgeBaseID string     `json:"-"`
	Status                  string     `json:"status"`
	ErrorMessage            string     `json:"error_message"`
	DocumentCount           int        `json:"document_count"`
	CreatedBy               string     `json:"created_by"`
	CreatedAt               time.Time  `json:"created_at"`
	UpdatedAt               time.Time  `json:"updated_at"`
	DeletedAt               *time.Time `json:"-"`
}

type Binding struct {
	KnowledgeBaseID         string
	KnowledgeBaseName       string
	ProviderType            string
	ExternalKnowledgeBaseID string
	ErrorCode               string
}

type Document struct {
	DocumentID         string     `json:"document_id"`
	KnowledgeBaseID    string     `json:"knowledge_base_id"`
	Name               string     `json:"name"`
	SizeBytes          int64      `json:"size_bytes"`
	MIMEType           string     `json:"mime_type"`
	ExternalDocumentID string     `json:"-"`
	Status             string     `json:"status"`
	ErrorMessage       string     `json:"error_message"`
	UploadedBy         string     `json:"uploaded_by"`
	CreatedAt          time.Time  `json:"created_at"`
	UpdatedAt          time.Time  `json:"updated_at"`
	DeletedAt          *time.Time `json:"-"`
}

type CreateKnowledgeBaseInput struct {
	Name        string
	Description string
	CreatedBy   string
}

type UpdateKnowledgeBaseInput struct {
	KnowledgeBaseID string
	Name            *string
	Description     *string
}

type UploadDocumentInput struct {
	KnowledgeBaseID string
	Name            string
	SizeBytes       int64
	MIMEType        string
	Reader          io.Reader
	UploadedBy      string
}
