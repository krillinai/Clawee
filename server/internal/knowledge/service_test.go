package knowledge

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"

	"github.com/krillinai/Clawee/server/internal/knowledge/provider"
)

func TestCreateKnowledgeBaseTransitionsToActive(t *testing.T) {
	store := NewMemoryStore()
	p := &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "idx_1"}}
	service := NewService(store, p, ProviderBailian)

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
	service := NewService(store, p, ProviderBailian)

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
	service := NewService(store, p, ProviderBailian)

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
	service := NewService(store, &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "idx_1"}}, ProviderBailian)
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
	service := NewService(store, &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "idx_1"}}, ProviderBailian)
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
	service := NewService(store, &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "idx_1"}}, ProviderBailian)
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
	service := NewService(NewMemoryStore(), &fakeProvider{}, ProviderBailian)
	_, err := service.UpdateKnowledgeBase(context.Background(), UpdateKnowledgeBaseInput{KnowledgeBaseID: "kb_1"})
	if !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("UpdateKnowledgeBase() error = %v, want ErrInvalidRequest", err)
	}
}

func TestUploadDocumentStoresProviderMapping(t *testing.T) {
	store := NewMemoryStore()
	p := &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "idx_1"}, uploaded: provider.ProviderDocument{ExternalID: "file_1", Status: provider.DocumentProcessing}}
	service := NewService(store, p, ProviderBailian)
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
	service := NewService(store, p, ProviderBailian)
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
	service := NewService(store, p, ProviderBailian, zap.New(core))

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
	service := NewService(store, p, ProviderBailian)
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
	service := NewService(store, p, ProviderBailian)
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
	service := NewService(store, p, ProviderBailian)
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
	service := NewService(store, p, ProviderBailian)
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
	listCalls         int
	onList            func(context.Context) error
	uploadErr         error
}

func (p *fakeProvider) CreateKnowledgeBase(context.Context, provider.CreateKnowledgeBaseRequest) (provider.ProviderKnowledgeBase, error) {
	return p.created, p.createErr
}
func (p *fakeProvider) DeleteKnowledgeBase(context.Context, string) error { return p.deleteErr }
func (p *fakeProvider) UploadDocument(context.Context, string, provider.DocumentFile) (provider.ProviderDocument, error) {
	return p.uploaded, p.uploadErr
}
func (p *fakeProvider) ListDocuments(ctx context.Context, _ string) ([]provider.ProviderDocument, error) {
	p.listCalls++
	if p.onList != nil {
		if err := p.onList(ctx); err != nil {
			return nil, err
		}
	}
	return p.listed, p.listErr
}
func (p *fakeProvider) DeleteDocument(context.Context, string, string) error {
	return p.documentDeleteErr
}
func (p *fakeProvider) Search(context.Context, provider.SearchRequest) (provider.SearchResult, error) {
	return provider.EmptySearchResult(), nil
}

func TestRAGFlowListRefreshesOnlyProcessingAndPreservesFailure(t *testing.T) {
	ctx := context.Background()
	for _, kind := range []string{ProviderBailian, ProviderRAGFlow} {
		for _, mode := range []string{"ready", "missing", "error"} {
			t.Run(kind+"/"+mode, func(t *testing.T) {
				p := &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "dataset"}, uploaded: provider.ProviderDocument{ExternalID: "external-doc", Status: provider.DocumentProcessing}, listed: []provider.ProviderDocument{{ExternalID: "external-doc", Status: provider.DocumentReady}, {ExternalID: "unregistered", Status: provider.DocumentReady}}}
				p.onList = func(ctx context.Context) error {
					deadline, ok := ctx.Deadline()
					if !ok || time.Until(deadline) > DocumentListRefreshTimeout || time.Until(deadline) < 9*time.Second {
						t.Errorf("刷新预算不符合10秒: %v", deadline)
					}
					return nil
				}
				if mode == "missing" {
					p.listed = nil
				}
				if mode == "error" {
					p.listErr = &provider.ProviderError{Code: provider.ErrorTimeout}
				}
				store := NewMemoryStore()
				svc := NewService(store, p, kind)
				kb, err := svc.CreateKnowledgeBase(ctx, CreateKnowledgeBaseInput{Name: "合成库"})
				if err != nil {
					t.Fatal(err)
				}
				if kb.ProviderType != kind {
					t.Fatalf("归属=%s", kb.ProviderType)
				}
				doc, err := svc.UploadDocument(ctx, UploadDocumentInput{KnowledgeBaseID: kb.KnowledgeBaseID, Name: "fixture.txt", SizeBytes: 1, Reader: strings.NewReader("x")})
				if err != nil {
					t.Fatal(err)
				}
				docs, err := svc.ListDocuments(ctx, kb.KnowledgeBaseID)
				if kind == ProviderBailian {
					if err != nil || docs[0].Status != DocumentProcessing || p.listCalls != 0 {
						t.Fatalf("百炼列表行为被改变: %+v %v", docs, err)
					}
					return
				}
				if mode == "error" {
					if !errors.Is(err, ErrProvider) {
						t.Fatal(err)
					}
					stored, _ := store.GetDocument(ctx, kb.KnowledgeBaseID, doc.DocumentID)
					if stored.Status != DocumentProcessing {
						t.Fatal("同步失败修改了本地状态")
					}
					return
				}
				if err != nil || len(docs) != 1 || p.listCalls != 1 {
					t.Fatalf("docs=%+v err=%v calls=%d", docs, err, p.listCalls)
				}
				if mode == "ready" && docs[0].Status != DocumentReady {
					t.Fatalf("未更新ready: %+v", docs)
				}
				if mode == "missing" && (docs[0].Status != DocumentFailed || docs[0].ErrorMessage != "外部文档不存在") {
					t.Fatalf("未标记缺失: %+v", docs)
				}
				if _, err := svc.ListDocuments(ctx, kb.KnowledgeBaseID); err != nil || p.listCalls != 1 {
					t.Fatalf("无processing不应刷新: %v calls=%d", err, p.listCalls)
				}
			})
		}
	}
}

func TestRAGFlowOperationsRejectOtherProviderBeforeMutation(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	p := &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "bailian-id"}, uploaded: provider.ProviderDocument{ExternalID: "bailian-doc", Status: provider.DocumentProcessing}}
	legacy := NewService(store, p, ProviderBailian)
	kb, _ := legacy.CreateKnowledgeBase(ctx, CreateKnowledgeBaseInput{Name: "百炼库"})
	doc, _ := legacy.UploadDocument(ctx, UploadDocumentInput{KnowledgeBaseID: kb.KnowledgeBaseID, Name: "fixture.txt", SizeBytes: 1, Reader: strings.NewReader("x")})
	svc := NewService(store, p, ProviderRAGFlow)
	for _, op := range []func() error{
		func() error { _, err := svc.SyncDocuments(ctx, kb.KnowledgeBaseID); return err },
		func() error {
			_, err := svc.UploadDocument(ctx, UploadDocumentInput{KnowledgeBaseID: kb.KnowledgeBaseID, Name: "fixture.txt", SizeBytes: 1, Reader: strings.NewReader("x")})
			return err
		},
		func() error { return svc.DeleteKnowledgeBase(ctx, kb.KnowledgeBaseID) },
		func() error { return svc.DeleteDocument(ctx, kb.KnowledgeBaseID, doc.DocumentID) },
	} {
		if err := op(); !errors.Is(err, ErrConflict) {
			t.Fatalf("error=%v", err)
		}
	}
	stored, _ := store.GetKnowledgeBase(ctx, kb.KnowledgeBaseID)
	storedDoc, _ := store.GetDocument(ctx, kb.KnowledgeBaseID, doc.DocumentID)
	if stored.Status != KnowledgeBaseActive || storedDoc.Status != DocumentProcessing || p.listCalls != 0 {
		t.Fatal("类型冲突导致生命周期变化或远端请求")
	}
	if _, err := svc.CreateKnowledgeBase(ctx, CreateKnowledgeBaseInput{Name: "库😀"}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("非法字符=%v", err)
	}
}

func TestRAGFlowUploadFailureKeepsControlledFailedRecord(t *testing.T) {
	ctx := context.Background()
	p := &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "dataset"}, uploadErr: &provider.ProviderError{Code: provider.ErrorInternal, ProviderMessage: "vendor-secret"}}
	svc := NewService(NewMemoryStore(), p, ProviderRAGFlow)
	kb, _ := svc.CreateKnowledgeBase(ctx, CreateKnowledgeBaseInput{Name: "合成库"})
	doc, err := svc.UploadDocument(ctx, UploadDocumentInput{KnowledgeBaseID: kb.KnowledgeBaseID, Name: "fixture.txt", SizeBytes: 1, Reader: strings.NewReader("x")})
	if !errors.Is(err, ErrProvider) || doc.Status != DocumentFailed || doc.ErrorMessage != provider.ErrorInternal || doc.ExternalDocumentID != "" {
		t.Fatalf("doc=%+v err=%v", doc, err)
	}
}

func TestRAGFlowSyncDoesNotMarkConcurrentUploadMissing(t *testing.T) {
	ctx := context.Background()
	p := &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "dataset"}, uploaded: provider.ProviderDocument{ExternalID: "old-doc", Status: provider.DocumentProcessing}, listed: []provider.ProviderDocument{{ExternalID: "old-doc", Status: provider.DocumentReady}}}
	svc := NewService(NewMemoryStore(), p, ProviderRAGFlow)
	kb, err := svc.CreateKnowledgeBase(ctx, CreateKnowledgeBaseInput{Name: "合成库"})
	if err != nil {
		t.Fatal(err)
	}
	upload := func() Document {
		doc, err := svc.UploadDocument(ctx, UploadDocumentInput{KnowledgeBaseID: kb.KnowledgeBaseID, Name: "fixture.txt", SizeBytes: 1, Reader: strings.NewReader("x")})
		if err != nil {
			t.Fatal(err)
		}
		return doc
	}
	upload()
	p.uploaded.ExternalID = "new-doc"
	var added Document
	p.onList = func(context.Context) error { added = upload(); return nil }
	if _, err := svc.ListDocuments(ctx, kb.KnowledgeBaseID); err != nil {
		t.Fatal(err)
	}
	doc, err := svc.Store().GetDocument(ctx, kb.KnowledgeBaseID, added.DocumentID)
	if err != nil || doc.Status != DocumentProcessing {
		t.Fatalf("并发上传被误标缺失: %+v %v", doc, err)
	}
	p.onList = nil
	p.listed = append(p.listed, provider.ProviderDocument{ExternalID: "new-doc", Status: provider.DocumentReady})
	docs, err := svc.ListDocuments(ctx, kb.KnowledgeBaseID)
	if err != nil || len(docs) != 2 || p.listCalls != 2 {
		t.Fatalf("不能继续刷新: %+v %v", docs, err)
	}
	for _, doc := range docs {
		if doc.Status != DocumentReady {
			t.Fatalf("状态=%+v", doc)
		}
	}
}
