package knowledge

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/krillinai/Clawee/server/internal/knowledge/provider"
)

type PostgresStore struct{ pool *pgxpool.Pool }

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore { return &PostgresStore{pool: pool} }

func (s *PostgresStore) CreateKnowledgeBase(ctx context.Context, kb KnowledgeBase) (KnowledgeBase, error) {
	_, err := s.pool.Exec(ctx, `INSERT INTO knowledge_bases
(knowledge_base_id, name, description, provider_type, external_knowledge_base_id, status, error_message, created_by, created_at, updated_at, deleted_at)
VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8,$9,$10,$11)`, kb.KnowledgeBaseID, kb.Name, kb.Description, kb.ProviderType, kb.ExternalKnowledgeBaseID, kb.Status, kb.ErrorMessage, kb.CreatedBy, kb.CreatedAt, kb.UpdatedAt, kb.DeletedAt)
	if err != nil {
		return KnowledgeBase{}, mapKnowledgeStoreError(err)
	}
	return kb, nil
}

func (s *PostgresStore) GetKnowledgeBase(ctx context.Context, id string) (KnowledgeBase, error) {
	row := s.pool.QueryRow(ctx, `SELECT kb.knowledge_base_id, kb.name, kb.description, kb.provider_type, COALESCE(kb.external_knowledge_base_id,''), kb.status, kb.error_message, kb.created_by, kb.created_at, kb.updated_at, kb.deleted_at,
COUNT(d.document_id) FILTER (WHERE d.deleted_at IS NULL)
FROM knowledge_bases kb LEFT JOIN knowledge_documents d ON d.knowledge_base_id=kb.knowledge_base_id
WHERE kb.knowledge_base_id=$1 AND kb.deleted_at IS NULL GROUP BY kb.knowledge_base_id`, id)
	return scanKnowledgeBase(row)
}

func (s *PostgresStore) ListKnowledgeBases(ctx context.Context) ([]KnowledgeBase, error) {
	rows, err := s.pool.Query(ctx, `SELECT kb.knowledge_base_id, kb.name, kb.description, kb.provider_type, COALESCE(kb.external_knowledge_base_id,''), kb.status, kb.error_message, kb.created_by, kb.created_at, kb.updated_at, kb.deleted_at,
COUNT(d.document_id) FILTER (WHERE d.deleted_at IS NULL)
FROM knowledge_bases kb LEFT JOIN knowledge_documents d ON d.knowledge_base_id=kb.knowledge_base_id
WHERE kb.deleted_at IS NULL GROUP BY kb.knowledge_base_id ORDER BY kb.updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []KnowledgeBase{}
	for rows.Next() {
		kb, err := scanKnowledgeBase(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, kb)
	}
	return out, rows.Err()
}

func (s *PostgresStore) UpdateKnowledgeBase(ctx context.Context, kb KnowledgeBase, expected string) (KnowledgeBase, error) {
	now := time.Now().UTC()
	tag, err := s.pool.Exec(ctx, `UPDATE knowledge_bases SET name=$2, description=$3, provider_type=$4, external_knowledge_base_id=NULLIF($5,''), status=$6, error_message=$7, updated_at=$8, deleted_at=$9
WHERE knowledge_base_id=$1 AND status=$10 AND deleted_at IS NULL`, kb.KnowledgeBaseID, kb.Name, kb.Description, kb.ProviderType, kb.ExternalKnowledgeBaseID, kb.Status, kb.ErrorMessage, now, kb.DeletedAt, expected)
	if err != nil {
		return KnowledgeBase{}, mapKnowledgeStoreError(err)
	}
	if tag.RowsAffected() != 1 {
		return KnowledgeBase{}, ErrConflict
	}
	return s.GetKnowledgeBase(ctx, kb.KnowledgeBaseID)
}

func (s *PostgresStore) CreateDocument(ctx context.Context, doc Document) (Document, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Document{}, err
	}
	defer tx.Rollback(ctx)
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM knowledge_bases WHERE knowledge_base_id=$1 AND deleted_at IS NULL FOR UPDATE`, doc.KnowledgeBaseID).Scan(&status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Document{}, ErrNotFound
		}
		return Document{}, err
	}
	if status != KnowledgeBaseActive {
		return Document{}, ErrConflict
	}
	_, err = tx.Exec(ctx, `INSERT INTO knowledge_documents
(document_id, knowledge_base_id, name, size_bytes, mime_type, external_document_id, status, error_message, uploaded_by, created_at, updated_at, deleted_at)
VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,$9,$10,$11,$12)`, doc.DocumentID, doc.KnowledgeBaseID, doc.Name, doc.SizeBytes, doc.MIMEType, doc.ExternalDocumentID, doc.Status, doc.ErrorMessage, doc.UploadedBy, doc.CreatedAt, doc.UpdatedAt, doc.DeletedAt)
	if err != nil {
		return Document{}, mapKnowledgeStoreError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Document{}, err
	}
	return doc, nil
}

func (s *PostgresStore) GetDocument(ctx context.Context, kbID, id string) (Document, error) {
	return scanDocument(s.pool.QueryRow(ctx, `SELECT document_id, knowledge_base_id, name, size_bytes, mime_type, COALESCE(external_document_id,''), status, error_message, uploaded_by, created_at, updated_at, deleted_at
FROM knowledge_documents WHERE knowledge_base_id=$1 AND document_id=$2 AND deleted_at IS NULL`, kbID, id))
}

func (s *PostgresStore) ListDocuments(ctx context.Context, kbID string) ([]Document, error) {
	rows, err := s.pool.Query(ctx, `SELECT document_id, knowledge_base_id, name, size_bytes, mime_type, COALESCE(external_document_id,''), status, error_message, uploaded_by, created_at, updated_at, deleted_at
FROM knowledge_documents WHERE knowledge_base_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC`, kbID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Document{}
	for rows.Next() {
		doc, err := scanDocument(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, doc)
	}
	return out, rows.Err()
}

func (s *PostgresStore) UpdateDocument(ctx context.Context, doc Document, expected string) (Document, error) {
	now := time.Now().UTC()
	tag, err := s.pool.Exec(ctx, `UPDATE knowledge_documents SET name=$3, size_bytes=$4, mime_type=$5, external_document_id=NULLIF($6,''), status=$7, error_message=$8, updated_at=$9, deleted_at=$10
WHERE knowledge_base_id=$1 AND document_id=$2 AND status=$11 AND deleted_at IS NULL`, doc.KnowledgeBaseID, doc.DocumentID, doc.Name, doc.SizeBytes, doc.MIMEType, doc.ExternalDocumentID, doc.Status, doc.ErrorMessage, now, doc.DeletedAt, expected)
	if err != nil {
		return Document{}, mapKnowledgeStoreError(err)
	}
	if tag.RowsAffected() != 1 {
		return Document{}, ErrConflict
	}
	return s.GetDocument(ctx, doc.KnowledgeBaseID, doc.DocumentID)
}

type rowScanner interface{ Scan(...any) error }

func scanKnowledgeBase(row rowScanner) (KnowledgeBase, error) {
	var kb KnowledgeBase
	err := row.Scan(&kb.KnowledgeBaseID, &kb.Name, &kb.Description, &kb.ProviderType, &kb.ExternalKnowledgeBaseID, &kb.Status, &kb.ErrorMessage, &kb.CreatedBy, &kb.CreatedAt, &kb.UpdatedAt, &kb.DeletedAt, &kb.DocumentCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return KnowledgeBase{}, ErrNotFound
	}
	return kb, err
}

func scanDocument(row rowScanner) (Document, error) {
	var doc Document
	err := row.Scan(&doc.DocumentID, &doc.KnowledgeBaseID, &doc.Name, &doc.SizeBytes, &doc.MIMEType, &doc.ExternalDocumentID, &doc.Status, &doc.ErrorMessage, &doc.UploadedBy, &doc.CreatedAt, &doc.UpdatedAt, &doc.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	return doc, err
}

func mapKnowledgeStoreError(err error) error {
	if err == nil {
		return nil
	}
	if stringsContains(err.Error(), "duplicate key") {
		return ErrConflict
	}
	return err
}

func stringsContains(value, needle string) bool {
	for i := 0; i+len(needle) <= len(value); i++ {
		if value[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func (s *PostgresStore) BeginKnowledgeBaseDelete(ctx context.Context, id string, now time.Time) (KnowledgeBase, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return KnowledgeBase{}, err
	}
	defer tx.Rollback(ctx)
	var kb KnowledgeBase
	err = tx.QueryRow(ctx, `SELECT knowledge_base_id, name, description, provider_type, COALESCE(external_knowledge_base_id,''), status, error_message, created_by, created_at, updated_at, deleted_at, 0 FROM knowledge_bases WHERE knowledge_base_id=$1 FOR UPDATE`, id).Scan(&kb.KnowledgeBaseID, &kb.Name, &kb.Description, &kb.ProviderType, &kb.ExternalKnowledgeBaseID, &kb.Status, &kb.ErrorMessage, &kb.CreatedBy, &kb.CreatedAt, &kb.UpdatedAt, &kb.DeletedAt, &kb.DocumentCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return KnowledgeBase{}, ErrNotFound
	}
	if err != nil {
		return KnowledgeBase{}, err
	}
	if kb.DeletedAt != nil || kb.Status == KnowledgeBaseDeleted {
		return kb, nil
	}
	if kb.Status == KnowledgeBaseCreating && kb.ExternalKnowledgeBaseID == "" && now.Sub(kb.UpdatedAt) < KnowledgeOperationTimeout {
		return KnowledgeBase{}, ErrKnowledgeBaseCreating
	}
	var uploads int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM knowledge_documents WHERE knowledge_base_id=$1 AND deleted_at IS NULL AND status=$2`, id, DocumentUploading).Scan(&uploads); err != nil {
		return KnowledgeBase{}, err
	}
	if uploads > 0 {
		return KnowledgeBase{}, ErrKnowledgeBaseHasUploadingDocuments
	}
	if _, err := tx.Exec(ctx, `UPDATE knowledge_bases SET status=$2,error_message='',updated_at=$3 WHERE knowledge_base_id=$1`, id, KnowledgeBaseDeleting, now); err != nil {
		return KnowledgeBase{}, err
	}
	kb.Status = KnowledgeBaseDeleting
	kb.UpdatedAt = now
	if err := tx.Commit(ctx); err != nil {
		return KnowledgeBase{}, err
	}
	return kb, nil
}

func (s *PostgresStore) CompleteKnowledgeBaseDelete(ctx context.Context, id string, now time.Time) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE knowledge_documents SET status=$2,deleted_at=$3,updated_at=$3 WHERE knowledge_base_id=$1 AND deleted_at IS NULL`, id, DocumentDeleted, now); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE knowledge_bases SET status=$2,deleted_at=$3,updated_at=$3 WHERE knowledge_base_id=$1 AND status IN ($4,$5)`, id, KnowledgeBaseDeleted, now, KnowledgeBaseDeleting, KnowledgeBaseDeleteFailed)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrConflict
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) BeginDocumentDelete(ctx context.Context, kbID, id string, now time.Time) (KnowledgeBase, Document, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return KnowledgeBase{}, Document{}, err
	}
	defer tx.Rollback(ctx)
	var kb KnowledgeBase
	err = tx.QueryRow(ctx, `SELECT knowledge_base_id,name,description,provider_type,COALESCE(external_knowledge_base_id,''),status,error_message,created_by,created_at,updated_at,deleted_at,0 FROM knowledge_bases WHERE knowledge_base_id=$1 FOR UPDATE`, kbID).Scan(&kb.KnowledgeBaseID, &kb.Name, &kb.Description, &kb.ProviderType, &kb.ExternalKnowledgeBaseID, &kb.Status, &kb.ErrorMessage, &kb.CreatedBy, &kb.CreatedAt, &kb.UpdatedAt, &kb.DeletedAt, &kb.DocumentCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return KnowledgeBase{}, Document{}, ErrNotFound
	}
	if err != nil {
		return KnowledgeBase{}, Document{}, err
	}
	var doc Document
	err = tx.QueryRow(ctx, `SELECT document_id,knowledge_base_id,name,size_bytes,mime_type,COALESCE(external_document_id,''),status,error_message,uploaded_by,created_at,updated_at,deleted_at FROM knowledge_documents WHERE knowledge_base_id=$1 AND document_id=$2 FOR UPDATE`, kbID, id).Scan(&doc.DocumentID, &doc.KnowledgeBaseID, &doc.Name, &doc.SizeBytes, &doc.MIMEType, &doc.ExternalDocumentID, &doc.Status, &doc.ErrorMessage, &doc.UploadedBy, &doc.CreatedAt, &doc.UpdatedAt, &doc.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return KnowledgeBase{}, Document{}, ErrNotFound
	}
	if err != nil {
		return KnowledgeBase{}, Document{}, err
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
	if _, err = tx.Exec(ctx, `UPDATE knowledge_documents SET status=$3,error_message='',updated_at=$4 WHERE knowledge_base_id=$1 AND document_id=$2`, kbID, id, DocumentDeleting, now); err != nil {
		return KnowledgeBase{}, Document{}, err
	}
	doc.Status = DocumentDeleting
	doc.UpdatedAt = now
	if err = tx.Commit(ctx); err != nil {
		return KnowledgeBase{}, Document{}, err
	}
	return kb, doc, nil
}

func (s *PostgresStore) CompleteDocumentDelete(ctx context.Context, kbID, id string, now time.Time) error {
	tag, err := s.pool.Exec(ctx, `UPDATE knowledge_documents SET status=$3,deleted_at=$4,updated_at=$4 WHERE knowledge_base_id=$1 AND document_id=$2 AND status IN ($5,$6)`, kbID, id, DocumentDeleted, now, DocumentDeleting, DocumentDeleteFailed)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrConflict
	}
	return nil
}

func (s *PostgresStore) SyncDocuments(ctx context.Context, kbID string, items []provider.ProviderDocument, now time.Time) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, item := range items {
		if item.ExternalID == "" {
			continue
		}
		_, err = tx.Exec(ctx, `UPDATE knowledge_documents SET status=$3,error_message=$4,updated_at=$5 WHERE knowledge_base_id=$1 AND external_document_id=$2 AND deleted_at IS NULL AND status NOT IN ($6,$7)`, kbID, item.ExternalID, documentStatus(item.Status), item.ErrorMessage, now, DocumentDeleting, DocumentDeleted)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
