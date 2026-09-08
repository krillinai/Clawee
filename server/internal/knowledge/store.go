package knowledge

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/krillinai/Clawee/server/internal/knowledge/provider"
)

type Store interface {
	CreateKnowledgeBase(context.Context, KnowledgeBase) (KnowledgeBase, error)
	GetKnowledgeBase(context.Context, string) (KnowledgeBase, error)
	ListKnowledgeBases(context.Context) ([]KnowledgeBase, error)
	UpdateKnowledgeBase(context.Context, KnowledgeBase, string) (KnowledgeBase, error)
	CreateDocument(context.Context, Document) (Document, error)
	GetDocument(context.Context, string, string) (Document, error)
	ListDocuments(context.Context, string) ([]Document, error)
	UpdateDocument(context.Context, Document, string) (Document, error)
}

type lifecycleStore interface {
	BeginKnowledgeBaseDelete(context.Context, string, time.Time) (KnowledgeBase, error)
	CompleteKnowledgeBaseDelete(context.Context, string, time.Time) error
	BeginDocumentDelete(context.Context, string, string, time.Time) (KnowledgeBase, Document, error)
	CompleteDocumentDelete(context.Context, string, string, time.Time) error
	SyncDocuments(context.Context, string, []provider.ProviderDocument, time.Time) error
}

type MemoryStore struct {
	mu        sync.Mutex
	bases     map[string]KnowledgeBase
	documents map[string]Document
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{bases: map[string]KnowledgeBase{}, documents: map[string]Document{}}
}

func (s *MemoryStore) CreateKnowledgeBase(ctx context.Context, kb KnowledgeBase) (KnowledgeBase, error) {
	if err := ctx.Err(); err != nil {
		return KnowledgeBase{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, item := range s.bases {
		if item.DeletedAt == nil && item.Name == kb.Name {
			return KnowledgeBase{}, ErrConflict
		}
	}
	s.bases[kb.KnowledgeBaseID] = kb
	return kb, nil
}

func (s *MemoryStore) GetKnowledgeBase(ctx context.Context, id string) (KnowledgeBase, error) {
	if err := ctx.Err(); err != nil {
		return KnowledgeBase{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	kb, ok := s.bases[id]
	if !ok || kb.DeletedAt != nil {
		return KnowledgeBase{}, ErrNotFound
	}
	kb.DocumentCount = s.documentCount(id)
	return kb, nil
}

func (s *MemoryStore) ListKnowledgeBases(ctx context.Context) ([]KnowledgeBase, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []KnowledgeBase{}
	for _, kb := range s.bases {
		if kb.DeletedAt == nil {
			kb.DocumentCount = s.documentCount(kb.KnowledgeBaseID)
			out = append(out, kb)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

func (s *MemoryStore) UpdateKnowledgeBase(ctx context.Context, kb KnowledgeBase, expected string) (KnowledgeBase, error) {
	if err := ctx.Err(); err != nil {
		return KnowledgeBase{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.bases[kb.KnowledgeBaseID]
	if !ok || current.Status != expected {
		return KnowledgeBase{}, ErrConflict
	}
	for id, item := range s.bases {
		if id != kb.KnowledgeBaseID && item.DeletedAt == nil && item.Name == kb.Name {
			return KnowledgeBase{}, ErrConflict
		}
	}
	kb.UpdatedAt = time.Now().UTC()
	s.bases[kb.KnowledgeBaseID] = kb
	return kb, nil
}

func (s *MemoryStore) CreateDocument(ctx context.Context, doc Document) (Document, error) {
	if err := ctx.Err(); err != nil {
		return Document{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	kb, ok := s.bases[doc.KnowledgeBaseID]
	if !ok || kb.Status != KnowledgeBaseActive || kb.DeletedAt != nil {
		return Document{}, ErrConflict
	}
	s.documents[doc.DocumentID] = doc
	return doc, nil
}

func (s *MemoryStore) GetDocument(ctx context.Context, kbID, id string) (Document, error) {
	if err := ctx.Err(); err != nil {
		return Document{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, ok := s.documents[id]
	if !ok || doc.KnowledgeBaseID != kbID || doc.DeletedAt != nil {
		return Document{}, ErrNotFound
	}
	return doc, nil
}

func (s *MemoryStore) ListDocuments(ctx context.Context, kbID string) ([]Document, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Document{}
	for _, doc := range s.documents {
		if doc.KnowledgeBaseID == kbID && doc.DeletedAt == nil {
			out = append(out, doc)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

func (s *MemoryStore) UpdateDocument(ctx context.Context, doc Document, expected string) (Document, error) {
	if err := ctx.Err(); err != nil {
		return Document{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.documents[doc.DocumentID]
	if !ok || current.Status != expected {
		return Document{}, ErrConflict
	}
	doc.UpdatedAt = time.Now().UTC()
	s.documents[doc.DocumentID] = doc
	return doc, nil
}

func (s *MemoryStore) documentCount(kbID string) int {
	count := 0
	for _, doc := range s.documents {
		if doc.KnowledgeBaseID == kbID && doc.DeletedAt == nil {
			count++
		}
	}
	return count
}

func (s *MemoryStore) BeginKnowledgeBaseDelete(ctx context.Context, id string, now time.Time) (KnowledgeBase, error) {
	if err := ctx.Err(); err != nil {
		return KnowledgeBase{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	kb, ok := s.bases[id]
	if !ok {
		return KnowledgeBase{}, ErrNotFound
	}
	if kb.DeletedAt != nil || kb.Status == KnowledgeBaseDeleted {
		return kb, nil
	}
	if kb.Status == KnowledgeBaseCreating && kb.ExternalKnowledgeBaseID == "" && now.Sub(kb.UpdatedAt) < KnowledgeOperationTimeout {
		return KnowledgeBase{}, ErrKnowledgeBaseCreating
	}
	for _, doc := range s.documents {
		if doc.KnowledgeBaseID == id && doc.DeletedAt == nil && doc.Status == DocumentUploading {
			return KnowledgeBase{}, ErrKnowledgeBaseHasUploadingDocuments
		}
	}
	kb.Status = KnowledgeBaseDeleting
	kb.UpdatedAt = now
	s.bases[id] = kb
	return kb, nil
}

func (s *MemoryStore) CompleteKnowledgeBaseDelete(ctx context.Context, id string, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	kb, ok := s.bases[id]
	if !ok {
		return ErrNotFound
	}
	kb.Status = KnowledgeBaseDeleted
	kb.DeletedAt = &now
	kb.UpdatedAt = now
	s.bases[id] = kb
	for key, doc := range s.documents {
		if doc.KnowledgeBaseID == id && doc.DeletedAt == nil {
			doc.Status = DocumentDeleted
			doc.DeletedAt = &now
			doc.UpdatedAt = now
			s.documents[key] = doc
		}
	}
	return nil
}

func (s *MemoryStore) BeginDocumentDelete(ctx context.Context, kbID, id string, now time.Time) (KnowledgeBase, Document, error) {
	if err := ctx.Err(); err != nil {
		return KnowledgeBase{}, Document{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	kb, ok := s.bases[kbID]
	if !ok {
		return KnowledgeBase{}, Document{}, ErrNotFound
	}
	doc, ok := s.documents[id]
	if !ok || doc.KnowledgeBaseID != kbID {
		return KnowledgeBase{}, Document{}, ErrNotFound
	}
	if doc.DeletedAt != nil || doc.Status == DocumentDeleted {
		return kb, doc, nil
	}
	if kb.DeletedAt != nil || kb.Status == KnowledgeBaseDeleted {
		return KnowledgeBase{}, Document{}, ErrConflict
	}
	if doc.Status == DocumentUploading && doc.ExternalDocumentID == "" && now.Sub(doc.UpdatedAt) < DocumentUploadTimeout {
		return KnowledgeBase{}, Document{}, ErrConflict
	}
	doc.Status = DocumentDeleting
	doc.UpdatedAt = now
	s.documents[id] = doc
	return kb, doc, nil
}

func (s *MemoryStore) CompleteDocumentDelete(ctx context.Context, kbID, id string, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, ok := s.documents[id]
	if !ok || doc.KnowledgeBaseID != kbID {
		return ErrNotFound
	}
	doc.Status = DocumentDeleted
	doc.DeletedAt = &now
	doc.UpdatedAt = now
	s.documents[id] = doc
	return nil
}

func (s *MemoryStore) SyncDocuments(ctx context.Context, kbID string, providerDocs []provider.ProviderDocument, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	byID := map[string]provider.ProviderDocument{}
	for _, item := range providerDocs {
		byID[item.ExternalID] = item
	}
	for key, doc := range s.documents {
		item, ok := byID[doc.ExternalDocumentID]
		if !ok || doc.KnowledgeBaseID != kbID || doc.Status == DocumentDeleting || doc.Status == DocumentDeleted || doc.DeletedAt != nil {
			continue
		}
		doc.Status = documentStatus(item.Status)
		doc.ErrorMessage = item.ErrorMessage
		doc.UpdatedAt = now
		s.documents[key] = doc
	}
	return nil
}
