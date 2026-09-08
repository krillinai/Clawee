package knowledge

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"

	"github.com/krillinai/Clawee/server/internal/knowledge/provider"
)

func TestCreateKnowledgeBaseTransitionsToActive(t *testing.T) {
	store := NewMemoryStore()
	p := &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "idx_1"}}
	service := NewService(store, p)

	got, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{
		Name: " 公司制度库 ", Description: "制度", CreatedBy: "usr_admin",
	})
	if err != nil {
		t.Fatalf("CreateKnowledgeBase() error = %v", err)
	}
	if got.Name != "公司制度库" || got.Status != KnowledgeBaseActive || got.ExternalKnowledgeBaseID != "idx_1" {
		t.Fatalf("knowledge base = %#v", got)
	}
}

func TestCreateKnowledgeBaseFailureIsNormalized(t *testing.T) {
	store := NewMemoryStore()
	p := &fakeProvider{createErr: &provider.ProviderError{Code: provider.ErrorRateLimited, Cause: errors.New("raw")}}
	service := NewService(store, p)

	got, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{Name: "制度库", CreatedBy: "usr_admin"})
	if !errors.Is(err, ErrProvider) {
		t.Fatalf("error = %v, want ErrProvider", err)
	}
	if got.Status != KnowledgeBaseCreateFailed || got.ErrorMessage != "rate_limited" {
		t.Fatalf("knowledge base = %#v", got)
	}
}

func TestCreateKnowledgeBaseMapsProviderNameConflict(t *testing.T) {
	store := NewMemoryStore()
	p := &fakeProvider{createErr: &provider.ProviderError{Code: provider.ErrorConflict}}
	service := NewService(store, p)

	got, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{Name: "制度库", CreatedBy: "usr_admin"})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("error = %v, want ErrConflict", err)
	}
	if got.Status != KnowledgeBaseCreateFailed || got.ErrorMessage != provider.ErrorConflict {
		t.Fatalf("knowledge base = %#v", got)
	}
}

func TestUpdateKnowledgeBaseUpdatesEditableMetadata(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(store, &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "idx_1"}})
	kb, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{Name: "制度库", Description: "旧描述", CreatedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}

	updated, err := service.UpdateKnowledgeBase(context.Background(), UpdateKnowledgeBaseInput{
		KnowledgeBaseID: kb.KnowledgeBaseID,
		Name:            stringPointer(" 新制度库 "),
		Description:     stringPointer(" 新描述 "),
	})
	if err != nil {
		t.Fatalf("UpdateKnowledgeBase() error = %v", err)
	}
	if updated.Name != "新制度库" || updated.Description != "新描述" {
		t.Fatalf("knowledge base = %#v", updated)
	}
}

func TestUpdateKnowledgeBaseSupportsPartialUpdatesAndClearingDescription(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(store, &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "idx_1"}})
	kb, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{Name: "制度库", Description: "旧描述", CreatedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}

	updated, err := service.UpdateKnowledgeBase(context.Background(), UpdateKnowledgeBaseInput{
		KnowledgeBaseID: kb.KnowledgeBaseID,
		Name:            stringPointer("新制度库"),
	})
	if err != nil {
		t.Fatalf("UpdateKnowledgeBase(name) error = %v", err)
	}
	if updated.Name != "新制度库" || updated.Description != "旧描述" {
		t.Fatalf("knowledge base after name update = %#v", updated)
	}

	updated, err = service.UpdateKnowledgeBase(context.Background(), UpdateKnowledgeBaseInput{
		KnowledgeBaseID: kb.KnowledgeBaseID,
		Description:     stringPointer(""),
	})
	if err != nil {
		t.Fatalf("UpdateKnowledgeBase(description) error = %v", err)
	}
	if updated.Name != "新制度库" || updated.Description != "" {
		t.Fatalf("knowledge base after description update = %#v", updated)
	}
}

func TestUpdateKnowledgeBaseRejectsDuplicateName(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(store, &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "idx_1"}})
	if _, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{Name: "制度库", CreatedBy: "usr_admin"}); err != nil {
		t.Fatal(err)
	}
	kb, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{Name: "产品库", CreatedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}

	_, err = service.UpdateKnowledgeBase(context.Background(), UpdateKnowledgeBaseInput{
		KnowledgeBaseID: kb.KnowledgeBaseID,
		Name:            stringPointer("制度库"),
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("UpdateKnowledgeBase() error = %v, want ErrConflict", err)
	}
}

func TestUpdateKnowledgeBaseRejectsMissingFields(t *testing.T) {
	service := NewService(NewMemoryStore(), &fakeProvider{})
	_, err := service.UpdateKnowledgeBase(context.Background(), UpdateKnowledgeBaseInput{KnowledgeBaseID: "kb_1"})
	if !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("UpdateKnowledgeBase() error = %v, want ErrInvalidRequest", err)
	}
}

func TestUploadDocumentStoresProviderMapping(t *testing.T) {
	store := NewMemoryStore()
	p := &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "idx_1"}, uploaded: provider.ProviderDocument{ExternalID: "file_1", Status: provider.DocumentProcessing}}
	service := NewService(store, p)
	kb, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{Name: "制度库", CreatedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}
	doc, err := service.UploadDocument(context.Background(), UploadDocumentInput{
		KnowledgeBaseID: kb.KnowledgeBaseID, Name: "guide.txt", SizeBytes: 5, MIMEType: "text/plain", Reader: bytes.NewReader([]byte("hello")), UploadedBy: "usr_admin",
	})
	if err != nil {
		t.Fatalf("UploadDocument() error = %v", err)
	}
	if doc.Status != DocumentProcessing || doc.ExternalDocumentID != "file_1" {
		t.Fatalf("document = %#v", doc)
	}
}

func TestUploadDocumentRejectsEmptyProviderMapping(t *testing.T) {
	store := NewMemoryStore()
	p := &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "idx_1"}, uploaded: provider.ProviderDocument{Status: provider.DocumentProcessing}}
	service := NewService(store, p)
	kb, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{Name: "制度库", CreatedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}
	doc, err := service.UploadDocument(context.Background(), UploadDocumentInput{
		KnowledgeBaseID: kb.KnowledgeBaseID, Name: "guide.txt", SizeBytes: 5, MIMEType: "text/plain", Reader: bytes.NewReader([]byte("hello")), UploadedBy: "usr_admin",
	})
	if !errors.Is(err, ErrProvider) {
		t.Fatalf("UploadDocument() error = %v, want ErrProvider", err)
	}
	if doc.Status != DocumentFailed || doc.ErrorMessage != provider.ErrorInternal {
		t.Fatalf("document = %#v", doc)
	}
}

func TestCreateKnowledgeBaseLogsNormalizedCompensationFailure(t *testing.T) {
	core, observed := observer.New(zapcore.ErrorLevel)
	store := &failingKnowledgeUpdateStore{MemoryStore: NewMemoryStore()}
	p := &fakeProvider{
		created:   provider.ProviderKnowledgeBase{ExternalID: "idx_1"},
		deleteErr: &provider.ProviderError{Code: provider.ErrorRateLimited, Cause: errors.New("secret vendor response")},
	}
	service := NewService(store, p, zap.New(core))

	if _, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{Name: "制度库", CreatedBy: "usr_admin"}); err == nil {
		t.Fatal("CreateKnowledgeBase() error = nil")
	}
	entries := observed.All()
	if len(entries) != 1 || entries[0].ContextMap()["provider_error_code"] != provider.ErrorRateLimited {
		t.Fatalf("log entries = %#v", entries)
	}
	if strings.Contains(entries[0].Message, "secret vendor response") {
		t.Fatalf("log leaked provider cause: %#v", entries[0])
	}
}

func TestDeleteOperationsAreIdempotentAfterSoftDelete(t *testing.T) {
	store := NewMemoryStore()
	p := &fakeProvider{
		created:  provider.ProviderKnowledgeBase{ExternalID: "idx_1"},
		uploaded: provider.ProviderDocument{ExternalID: "doc_1", Status: provider.DocumentProcessing},
	}
	service := NewService(store, p)
	kb, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{Name: "制度库", CreatedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}
	doc, err := service.UploadDocument(context.Background(), UploadDocumentInput{KnowledgeBaseID: kb.KnowledgeBaseID, Name: "guide.txt", SizeBytes: 5, MIMEType: "text/plain", Reader: bytes.NewReader([]byte("hello")), UploadedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteDocument(context.Background(), kb.KnowledgeBaseID, doc.DocumentID); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteDocument(context.Background(), kb.KnowledgeBaseID, doc.DocumentID); err != nil {
		t.Fatalf("repeated document delete: %v", err)
	}
	if err := service.DeleteKnowledgeBase(context.Background(), kb.KnowledgeBaseID); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteKnowledgeBase(context.Background(), kb.KnowledgeBaseID); err != nil {
		t.Fatalf("repeated knowledge base delete: %v", err)
	}
}

func TestDeleteDocumentCompletesWhenProviderTargetNoLongerExists(t *testing.T) {
	store := NewMemoryStore()
	p := &fakeProvider{
		created:  provider.ProviderKnowledgeBase{ExternalID: "idx_1"},
		uploaded: provider.ProviderDocument{ExternalID: "doc_1", Status: provider.DocumentProcessing},
	}
	service := NewService(store, p)
	kb, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{Name: "制度库", CreatedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}
	doc, err := service.UploadDocument(context.Background(), UploadDocumentInput{KnowledgeBaseID: kb.KnowledgeBaseID, Name: "guide.txt", SizeBytes: 5, MIMEType: "text/plain", Reader: bytes.NewReader([]byte("hello")), UploadedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}
	p.documentDeleteErr = &provider.ProviderError{Code: provider.ErrorNotFound}

	if err := service.DeleteDocument(context.Background(), kb.KnowledgeBaseID, doc.DocumentID); err != nil {
		t.Fatalf("DeleteDocument() error = %v", err)
	}
	if _, err := store.GetDocument(context.Background(), kb.KnowledgeBaseID, doc.DocumentID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetDocument() error = %v, want ErrNotFound", err)
	}
}

func TestDeleteDocumentCompletesWhenProviderKnowledgeBaseIsInvalid(t *testing.T) {
	store := NewMemoryStore()
	p := &fakeProvider{
		created:  provider.ProviderKnowledgeBase{ExternalID: "idx_1"},
		uploaded: provider.ProviderDocument{ExternalID: "doc_1", Status: provider.DocumentProcessing},
	}
	service := NewService(store, p)
	kb, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{Name: "制度库", CreatedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}
	doc, err := service.UploadDocument(context.Background(), UploadDocumentInput{KnowledgeBaseID: kb.KnowledgeBaseID, Name: "guide.txt", SizeBytes: 5, MIMEType: "text/plain", Reader: bytes.NewReader([]byte("hello")), UploadedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}
	p.documentDeleteErr = &provider.ProviderError{Code: provider.ErrorInvalidRequest}
	p.listErr = &provider.ProviderError{Code: provider.ErrorInvalidRequest}

	if err := service.DeleteDocument(context.Background(), kb.KnowledgeBaseID, doc.DocumentID); err != nil {
		t.Fatalf("DeleteDocument() error = %v", err)
	}
	if _, err := store.GetDocument(context.Background(), kb.KnowledgeBaseID, doc.DocumentID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetDocument() error = %v, want ErrNotFound", err)
	}
}

func TestDeleteDocumentKeepsLocalRecordWhenProviderDocumentStillExists(t *testing.T) {
	store := NewMemoryStore()
	p := &fakeProvider{
		created:  provider.ProviderKnowledgeBase{ExternalID: "idx_1"},
		uploaded: provider.ProviderDocument{ExternalID: "doc_1", Status: provider.DocumentReady},
		listed:   []provider.ProviderDocument{{ExternalID: "doc_1", Status: provider.DocumentReady}},
	}
	service := NewService(store, p)
	kb, err := service.CreateKnowledgeBase(context.Background(), CreateKnowledgeBaseInput{Name: "制度库", CreatedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}
	doc, err := service.UploadDocument(context.Background(), UploadDocumentInput{KnowledgeBaseID: kb.KnowledgeBaseID, Name: "guide.txt", SizeBytes: 5, MIMEType: "text/plain", Reader: bytes.NewReader([]byte("hello")), UploadedBy: "usr_admin"})
	if err != nil {
		t.Fatal(err)
	}
	p.documentDeleteErr = &provider.ProviderError{Code: provider.ErrorInvalidRequest}

	if err := service.DeleteDocument(context.Background(), kb.KnowledgeBaseID, doc.DocumentID); !errors.Is(err, ErrProvider) {
		t.Fatalf("DeleteDocument() error = %v, want ErrProvider", err)
	}
	stored, err := store.GetDocument(context.Background(), kb.KnowledgeBaseID, doc.DocumentID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != DocumentDeleteFailed {
		t.Fatalf("document status = %q, want %q", stored.Status, DocumentDeleteFailed)
	}
}

type failingKnowledgeUpdateStore struct{ *MemoryStore }

func (s *failingKnowledgeUpdateStore) UpdateKnowledgeBase(context.Context, KnowledgeBase, string) (KnowledgeBase, error) {
	return KnowledgeBase{}, errors.New("database unavailable")
}

func stringPointer(value string) *string { return &value }

type fakeProvider struct {
	created           provider.ProviderKnowledgeBase
	createErr         error
	uploaded          provider.ProviderDocument
	listed            []provider.ProviderDocument
	listErr           error
	deleteErr         error
	documentDeleteErr error
}

func (p *fakeProvider) CreateKnowledgeBase(context.Context, provider.CreateKnowledgeBaseRequest) (provider.ProviderKnowledgeBase, error) {
	return p.created, p.createErr
}
func (p *fakeProvider) DeleteKnowledgeBase(context.Context, string) error { return p.deleteErr }
func (p *fakeProvider) UploadDocument(context.Context, string, provider.DocumentFile) (provider.ProviderDocument, error) {
	return p.uploaded, nil
}
func (p *fakeProvider) ListDocuments(context.Context, string) ([]provider.ProviderDocument, error) {
	return p.listed, p.listErr
}
func (p *fakeProvider) DeleteDocument(context.Context, string, string) error {
	return p.documentDeleteErr
}
func (p *fakeProvider) Search(context.Context, provider.SearchRequest) (provider.SearchResult, error) {
	return provider.EmptySearchResult(), nil
}
