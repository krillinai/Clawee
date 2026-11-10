package knowledge

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/krillinai/Clawee/server/internal/knowledge/provider"
)

func TestMemorySyncOnlyUpdatesRegisteredLiveDocuments(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	now := time.Now().UTC()
	store.CreateKnowledgeBase(ctx, KnowledgeBase{KnowledgeBaseID: "kb", Name: "合成库", ProviderType: ProviderRAGFlow, Status: KnowledgeBaseActive})
	for _, status := range []string{DocumentProcessing, DocumentDeleting, DocumentDeleted} {
		doc := Document{DocumentID: status, KnowledgeBaseID: "kb", ExternalDocumentID: status, Status: status}
		if status == DocumentDeleted {
			doc.DeletedAt = &now
		}
		if _, err := store.CreateDocument(ctx, doc); err != nil {
			t.Fatal(err)
		}
	}
	items := []provider.ProviderDocument{{ExternalID: DocumentProcessing, Status: provider.DocumentReady}, {ExternalID: DocumentDeleting, Status: provider.DocumentReady}, {ExternalID: DocumentDeleted, Status: provider.DocumentReady}, {ExternalID: "external-only", Status: provider.DocumentReady}}
	if err := store.SyncDocuments(ctx, "kb", items, now); err != nil {
		t.Fatal(err)
	}
	docs, _ := store.ListDocuments(ctx, "kb")
	if len(docs) != 2 {
		t.Fatalf("同步导入或恢复了文档: %+v", docs)
	}
	for _, doc := range docs {
		if doc.DocumentID == DocumentProcessing && doc.Status != DocumentReady || doc.DocumentID == DocumentDeleting && doc.Status != DocumentDeleting {
			t.Fatalf("状态=%+v", doc)
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	cancel()
	if err := store.SyncDocuments(ctx, "kb", []provider.ProviderDocument{{ExternalID: DocumentProcessing, Status: provider.DocumentFailed}}, now); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	doc, _ := store.GetDocument(context.Background(), "kb", DocumentProcessing)
	if doc.Status != DocumentReady {
		t.Fatal("取消后写入了部分状态")
	}
}

func TestMemoryStoreOnlyCleansStuckCreatingKnowledgeBaseAfterTimeout(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	started := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	_, err := store.CreateKnowledgeBase(ctx, KnowledgeBase{KnowledgeBaseID: "kb-1", Name: "制度", Status: KnowledgeBaseCreating, CreatedAt: started, UpdatedAt: started})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.BeginKnowledgeBaseDelete(ctx, "kb-1", started.Add(KnowledgeOperationTimeout-time.Second)); !errors.Is(err, ErrKnowledgeBaseCreating) {
		t.Fatalf("early delete error = %v", err)
	}
	if _, err := store.BeginKnowledgeBaseDelete(ctx, "kb-1", started.Add(KnowledgeOperationTimeout)); err != nil {
		t.Fatalf("timed out delete error = %v", err)
	}
}

func TestMemoryStoreOnlyCleansStuckUploadingDocumentAfterTimeout(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	started := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	_, err := store.CreateKnowledgeBase(ctx, KnowledgeBase{KnowledgeBaseID: "kb-1", Name: "制度", Status: KnowledgeBaseActive, ExternalKnowledgeBaseID: "provider-kb", CreatedAt: started, UpdatedAt: started})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.CreateDocument(ctx, Document{DocumentID: "doc-1", KnowledgeBaseID: "kb-1", Name: "guide.md", Status: DocumentUploading, CreatedAt: started, UpdatedAt: started})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.BeginKnowledgeBaseDelete(ctx, "kb-1", started.Add(time.Second)); !errors.Is(err, ErrKnowledgeBaseHasUploadingDocuments) {
		t.Fatalf("knowledge base delete error = %v", err)
	}
	if _, _, err := store.BeginDocumentDelete(ctx, "kb-1", "doc-1", started.Add(DocumentUploadTimeout-time.Second)); !errors.Is(err, ErrConflict) {
		t.Fatalf("early delete error = %v", err)
	}
	if _, _, err := store.BeginDocumentDelete(ctx, "kb-1", "doc-1", started.Add(DocumentUploadTimeout)); err != nil {
		t.Fatalf("timed out delete error = %v", err)
	}
}
