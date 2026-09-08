package knowledge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/krillinai/Clawee/server/internal/knowledge/provider"
)

type Service struct {
	store    Store
	provider provider.KnowledgeProvider
	clock    func() time.Time
	logger   *zap.Logger
}

func NewService(store Store, p provider.KnowledgeProvider, loggers ...*zap.Logger) *Service {
	logger := zap.NewNop()
	if len(loggers) > 0 && loggers[0] != nil {
		logger = loggers[0]
	}
	return &Service{store: store, provider: p, clock: func() time.Time { return time.Now().UTC() }, logger: logger}
}

func (s *Service) Store() Store { return s.store }

func (s *Service) CreateKnowledgeBase(ctx context.Context, input CreateKnowledgeBaseInput) (KnowledgeBase, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if input.Name == "" || len([]rune(input.Name)) > 100 || len([]rune(input.Description)) > 1000 || s.provider == nil {
		return KnowledgeBase{}, ErrInvalidRequest
	}
	now := s.clock()
	kb := KnowledgeBase{KnowledgeBaseID: newID("kb"), Name: input.Name, Description: input.Description, ProviderType: ProviderBailian, Status: KnowledgeBaseCreating, CreatedBy: input.CreatedBy, CreatedAt: now, UpdatedAt: now}
	created, err := s.store.CreateKnowledgeBase(ctx, kb)
	if err != nil {
		return KnowledgeBase{}, err
	}
	providerCtx, cancel := context.WithTimeout(ctx, KnowledgeOperationTimeout)
	defer cancel()
	external, err := s.provider.CreateKnowledgeBase(providerCtx, provider.CreateKnowledgeBaseRequest{Name: input.Name, Description: input.Description})
	if err != nil {
		created.Status = KnowledgeBaseCreateFailed
		created.ErrorMessage = providerErrorCode(err)
		operationErr := fmt.Errorf("%w: %s", ErrProvider, created.ErrorMessage)
		if created.ErrorMessage == provider.ErrorConflict {
			operationErr = fmt.Errorf("%w: %s", ErrConflict, created.ErrorMessage)
		}
		updated, updateErr := s.store.UpdateKnowledgeBase(context.Background(), created, KnowledgeBaseCreating)
		if updateErr != nil {
			return created, errors.Join(operationErr, updateErr)
		}
		return updated, operationErr
	}
	created.Status = KnowledgeBaseActive
	created.ExternalKnowledgeBaseID = strings.TrimSpace(external.ExternalID)
	created.ErrorMessage = ""
	if created.ExternalKnowledgeBaseID == "" {
		created.Status = KnowledgeBaseCreateFailed
		created.ErrorMessage = provider.ErrorInternal
		updated, _ := s.store.UpdateKnowledgeBase(context.Background(), created, KnowledgeBaseCreating)
		return updated, fmt.Errorf("%w: %s", ErrProvider, provider.ErrorInternal)
	}
	updated, err := s.store.UpdateKnowledgeBase(ctx, created, KnowledgeBaseCreating)
	if err != nil {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), KnowledgeOperationTimeout)
		defer cleanupCancel()
		cleanupErr := s.provider.DeleteKnowledgeBase(cleanupCtx, created.ExternalKnowledgeBaseID)
		s.logCompensation("knowledge_base", created.KnowledgeBaseID, cleanupErr)
		return created, err
	}
	return updated, nil
}

func (s *Service) ListKnowledgeBases(ctx context.Context) ([]KnowledgeBase, error) {
	return s.store.ListKnowledgeBases(ctx)
}
func (s *Service) GetKnowledgeBase(ctx context.Context, id string) (KnowledgeBase, error) {
	return s.store.GetKnowledgeBase(ctx, id)
}

func (s *Service) UpdateKnowledgeBase(ctx context.Context, input UpdateKnowledgeBaseInput) (KnowledgeBase, error) {
	input.KnowledgeBaseID = strings.TrimSpace(input.KnowledgeBaseID)
	if input.KnowledgeBaseID == "" || (input.Name == nil && input.Description == nil) {
		return KnowledgeBase{}, ErrInvalidRequest
	}
	kb, err := s.store.GetKnowledgeBase(ctx, input.KnowledgeBaseID)
	if err != nil {
		return KnowledgeBase{}, err
	}
	if input.Name != nil {
		name := strings.TrimSpace(*input.Name)
		if name == "" || len([]rune(name)) > 100 {
			return KnowledgeBase{}, ErrInvalidRequest
		}
		kb.Name = name
	}
	if input.Description != nil {
		description := strings.TrimSpace(*input.Description)
		if len([]rune(description)) > 1000 {
			return KnowledgeBase{}, ErrInvalidRequest
		}
		kb.Description = description
	}
	return s.store.UpdateKnowledgeBase(ctx, kb, kb.Status)
}

func (s *Service) UploadDocument(ctx context.Context, input UploadDocumentInput) (Document, error) {
	if strings.TrimSpace(input.KnowledgeBaseID) == "" || strings.TrimSpace(input.Name) == "" || input.SizeBytes <= 0 || input.Reader == nil || s.provider == nil {
		return Document{}, ErrInvalidRequest
	}
	kb, err := s.store.GetKnowledgeBase(ctx, input.KnowledgeBaseID)
	if err != nil {
		return Document{}, err
	}
	if kb.Status != KnowledgeBaseActive || kb.ExternalKnowledgeBaseID == "" {
		return Document{}, ErrConflict
	}
	now := s.clock()
	doc := Document{DocumentID: newID("doc"), KnowledgeBaseID: kb.KnowledgeBaseID, Name: input.Name, SizeBytes: input.SizeBytes, MIMEType: input.MIMEType, Status: DocumentUploading, UploadedBy: input.UploadedBy, CreatedAt: now, UpdatedAt: now}
	created, err := s.store.CreateDocument(ctx, doc)
	if err != nil {
		return Document{}, err
	}
	providerCtx, cancel := context.WithTimeout(ctx, DocumentUploadTimeout)
	defer cancel()
	external, err := s.provider.UploadDocument(providerCtx, kb.ExternalKnowledgeBaseID, provider.DocumentFile{Name: input.Name, Size: input.SizeBytes, MIMEType: input.MIMEType, Reader: input.Reader})
	if err != nil {
		created.Status = DocumentFailed
		created.ErrorMessage = providerErrorCode(err)
		updated, updateErr := s.store.UpdateDocument(context.Background(), created, DocumentUploading)
		if updateErr != nil {
			return created, errors.Join(fmt.Errorf("%w: %s", ErrProvider, created.ErrorMessage), updateErr)
		}
		return updated, fmt.Errorf("%w: %s", ErrProvider, created.ErrorMessage)
	}
	created.ExternalDocumentID = strings.TrimSpace(external.ExternalID)
	created.ErrorMessage = ""
	created.Status = documentStatus(external.Status)
	providerContractErr := false
	if created.ExternalDocumentID == "" {
		created.Status = DocumentFailed
		created.ErrorMessage = provider.ErrorInternal
		providerContractErr = true
	}
	updated, err := s.store.UpdateDocument(ctx, created, DocumentUploading)
	if err != nil && created.ExternalDocumentID != "" {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), KnowledgeOperationTimeout)
		defer cleanupCancel()
		cleanupErr := s.provider.DeleteDocument(cleanupCtx, kb.ExternalKnowledgeBaseID, created.ExternalDocumentID)
		s.logCompensation("document", created.DocumentID, cleanupErr)
	}
	if err == nil && providerContractErr {
		return updated, fmt.Errorf("%w: %s", ErrProvider, provider.ErrorInternal)
	}
	return updated, err
}

func (s *Service) ListDocuments(ctx context.Context, kbID string) ([]Document, error) {
	if _, err := s.store.GetKnowledgeBase(ctx, kbID); err != nil {
		return nil, err
	}
	return s.store.ListDocuments(ctx, kbID)
}

func (s *Service) SyncDocuments(ctx context.Context, kbID string) ([]Document, error) {
	kb, err := s.store.GetKnowledgeBase(ctx, kbID)
	if err != nil {
		return nil, err
	}
	if kb.Status != KnowledgeBaseActive || kb.ExternalKnowledgeBaseID == "" {
		return nil, ErrConflict
	}
	providerCtx, cancel := context.WithTimeout(ctx, KnowledgeOperationTimeout)
	defer cancel()
	items, err := s.provider.ListDocuments(providerCtx, kb.ExternalKnowledgeBaseID)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrProvider, providerErrorCode(err))
	}
	lifecycle, ok := s.store.(lifecycleStore)
	if !ok {
		return nil, errors.New("knowledge lifecycle store is not configured")
	}
	if err := lifecycle.SyncDocuments(ctx, kbID, items, s.clock()); err != nil {
		return nil, err
	}
	return s.store.ListDocuments(ctx, kbID)
}

func (s *Service) DeleteKnowledgeBase(ctx context.Context, id string) error {
	lifecycle, ok := s.store.(lifecycleStore)
	if !ok {
		return errors.New("knowledge lifecycle store is not configured")
	}
	kb, err := lifecycle.BeginKnowledgeBaseDelete(ctx, id, s.clock())
	if err != nil {
		return err
	}
	if kb.Status == KnowledgeBaseDeleted || kb.DeletedAt != nil {
		return nil
	}
	if kb.ExternalKnowledgeBaseID != "" {
		providerCtx, cancel := context.WithTimeout(ctx, KnowledgeOperationTimeout)
		defer cancel()
		if err := s.provider.DeleteKnowledgeBase(providerCtx, kb.ExternalKnowledgeBaseID); err != nil {
			kb.Status = KnowledgeBaseDeleteFailed
			kb.ErrorMessage = providerErrorCode(err)
			_, _ = s.store.UpdateKnowledgeBase(context.Background(), kb, KnowledgeBaseDeleting)
			return fmt.Errorf("%w: %s", ErrProvider, kb.ErrorMessage)
		}
	}
	return lifecycle.CompleteKnowledgeBaseDelete(ctx, id, s.clock())
}

func (s *Service) DeleteDocument(ctx context.Context, kbID, id string) error {
	lifecycle, ok := s.store.(lifecycleStore)
	if !ok {
		return errors.New("knowledge lifecycle store is not configured")
	}
	kb, doc, err := lifecycle.BeginDocumentDelete(ctx, kbID, id, s.clock())
	if err != nil {
		return err
	}
	if doc.Status == DocumentDeleted || doc.DeletedAt != nil {
		return nil
	}
	if doc.ExternalDocumentID != "" && kb.ExternalKnowledgeBaseID != "" {
		providerCtx, cancel := context.WithTimeout(ctx, KnowledgeOperationTimeout)
		defer cancel()
		if err := s.provider.DeleteDocument(providerCtx, kb.ExternalKnowledgeBaseID, doc.ExternalDocumentID); err != nil {
			if s.documentDeleteTargetMissing(providerCtx, kb.ExternalKnowledgeBaseID, doc.ExternalDocumentID, err) {
				return lifecycle.CompleteDocumentDelete(ctx, kbID, id, s.clock())
			}
			doc.Status = DocumentDeleteFailed
			doc.ErrorMessage = providerErrorCode(err)
			_, _ = s.store.UpdateDocument(context.Background(), doc, DocumentDeleting)
			return fmt.Errorf("%w: %s", ErrProvider, doc.ErrorMessage)
		}
	}
	return lifecycle.CompleteDocumentDelete(ctx, kbID, id, s.clock())
}

func (s *Service) documentDeleteTargetMissing(ctx context.Context, externalKnowledgeBaseID, externalDocumentID string, deleteErr error) bool {
	var providerErr *provider.ProviderError
	if !errors.As(deleteErr, &providerErr) {
		return false
	}
	if providerErr.Code == provider.ErrorNotFound {
		return true
	}
	if providerErr.Code != provider.ErrorInvalidRequest {
		return false
	}
	items, err := s.provider.ListDocuments(ctx, externalKnowledgeBaseID)
	if err != nil {
		return providerErrorCode(err) == provider.ErrorNotFound || providerErrorCode(err) == provider.ErrorInvalidRequest
	}
	for _, item := range items {
		if item.ExternalID == externalDocumentID {
			return false
		}
	}
	return true
}

func providerErrorCode(err error) string {
	var providerErr *provider.ProviderError
	if errors.As(err, &providerErr) {
		return providerErr.Error()
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return provider.ErrorTimeout
	}
	return provider.ErrorInternal
}

func (s *Service) logCompensation(objectType, objectID string, err error) {
	code := ""
	if err != nil {
		code = providerErrorCode(err)
	}
	s.logger.Error("knowledge provider compensation after local persistence failure",
		zap.String("object_type", objectType),
		zap.String("object_id", objectID),
		zap.Bool("compensation_failed", err != nil),
		zap.String("provider_error_code", code),
	)
}
func documentStatus(status provider.DocumentStatus) string {
	if status == provider.DocumentReady {
		return DocumentReady
	}
	if status == provider.DocumentFailed {
		return DocumentFailed
	}
	return DocumentProcessing
}
func newID(prefix string) string {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return prefix + "_" + hex.EncodeToString(raw[:])
}
