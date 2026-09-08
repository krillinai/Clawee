package knowledge

import (
	"context"
	"errors"
	"testing"
	"time"
)

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
