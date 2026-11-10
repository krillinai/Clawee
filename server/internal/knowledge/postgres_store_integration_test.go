package knowledge

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/krillinai/Clawee/server/internal/knowledge/provider"
)

func openKnowledgeTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("CLAW_GATEWAY_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("CLAW_GATEWAY_TEST_DATABASE_URL 未设置，跳过隔离 PostgreSQL 测试")
	}
	parsed, err := url.Parse(dsn)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || !strings.HasSuffix(strings.TrimPrefix(parsed.Path, "/"), "_test") {
		t.Fatal("测试数据库名称必须以 _test 结尾")
	}
	ctx := context.Background()
	base, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal("测试数据库配置无效")
	}
	if err := base.Ping(ctx); err != nil {
		base.Close()
		t.Fatal("隔离测试数据库不可用")
	}
	schema := fmt.Sprintf("knowledge_%d", time.Now().UnixNano())
	if _, err := base.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		base.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = base.Exec(ctx, "DROP SCHEMA IF EXISTS "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		base.Close()
	})
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal("测试数据库配置无效")
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("创建隔离连接池失败")
	}
	t.Cleanup(pool.Close)
	// 只在独立 schema 内应用既有知识库迁移；审计表作为最小依赖夹具。
	if _, err := pool.Exec(ctx, `CREATE TABLE mcp_proxy_audit_records (id TEXT PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../db/migrations/00012_enterprise_knowledge_base.sql")
	if err != nil {
		t.Fatal(err)
	}
	up := strings.SplitN(string(raw), "-- +goose Down", 2)[0]
	if _, err := pool.Exec(ctx, up); err != nil {
		t.Fatal(err)
	}
	return pool
}

func TestPostgresRAGFlowIDsSynchronizationAndDeletionLifecycle(t *testing.T) {
	ctx := context.Background()
	store := NewPostgresStore(openKnowledgeTestPool(t))
	p := &fakeProvider{created: provider.ProviderKnowledgeBase{ExternalID: "fixture-dataset"}, uploaded: provider.ProviderDocument{ExternalID: "fixture-doc", Status: provider.DocumentProcessing}}
	svc := NewService(store, p, ProviderRAGFlow)
	kb, err := svc.CreateKnowledgeBase(ctx, CreateKnowledgeBaseInput{Name: "隔离合成库"})
	if err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetKnowledgeBase(ctx, kb.KnowledgeBaseID)
	if err != nil || stored.ProviderType != ProviderRAGFlow || stored.ExternalKnowledgeBaseID != "fixture-dataset" {
		t.Fatalf("绑定未持久化: %+v %v", stored, err)
	}
	doc, err := svc.UploadDocument(ctx, UploadDocumentInput{KnowledgeBaseID: kb.KnowledgeBaseID, Name: "fixture.txt", SizeBytes: 1, Reader: strings.NewReader("x")})
	if err != nil {
		t.Fatal(err)
	}
	if doc.ExternalDocumentID != "fixture-doc" || doc.Status != DocumentProcessing {
		t.Fatalf("文档绑定=%+v", doc)
	}
	p.listed = []provider.ProviderDocument{{ExternalID: "fixture-doc", Status: provider.DocumentReady}, {ExternalID: "external-only", Status: provider.DocumentReady}}
	docs, err := svc.ListDocuments(ctx, kb.KnowledgeBaseID)
	if err != nil || len(docs) != 1 || docs[0].Status != DocumentReady {
		t.Fatalf("同步=%+v %v", docs, err)
	}
	p.listed[0].Status = provider.DocumentFailed
	p.listed[0].ErrorMessage = "文档处理失败"
	docs, err = svc.SyncDocuments(ctx, kb.KnowledgeBaseID)
	if err != nil || docs[0].Status != DocumentFailed || docs[0].ErrorMessage != "文档处理失败" {
		t.Fatalf("失败状态=%+v %v", docs, err)
	}
	if _, _, err := store.BeginDocumentDelete(ctx, kb.KnowledgeBaseID, doc.DocumentID, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := store.SyncDocuments(ctx, kb.KnowledgeBaseID, []provider.ProviderDocument{{ExternalID: "fixture-doc", Status: provider.DocumentReady}}, time.Now()); err != nil {
		t.Fatal(err)
	}
	deleting, _ := store.GetDocument(ctx, kb.KnowledgeBaseID, doc.DocumentID)
	if deleting.Status != DocumentDeleting {
		t.Fatal("同步恢复了删除中的文档")
	}
	p.documentDeleteErr = &provider.ProviderError{Code: provider.ErrorUnauthorized}
	if err := svc.DeleteDocument(ctx, kb.KnowledgeBaseID, doc.DocumentID); !errors.Is(err, ErrProvider) {
		t.Fatal(err)
	}
	failed, _ := store.GetDocument(ctx, kb.KnowledgeBaseID, doc.DocumentID)
	if failed.Status != DocumentDeleteFailed {
		t.Fatalf("删除失败状态=%s", failed.Status)
	}
	p.documentDeleteErr = nil
	if err := svc.DeleteDocument(ctx, kb.KnowledgeBaseID, doc.DocumentID); err != nil {
		t.Fatal(err)
	}
	if err := store.SyncDocuments(ctx, kb.KnowledgeBaseID, p.listed, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetDocument(ctx, kb.KnowledgeBaseID, doc.DocumentID); !errors.Is(err, ErrNotFound) {
		t.Fatal("已删除文档被恢复")
	}
	if err := svc.DeleteKnowledgeBase(ctx, kb.KnowledgeBaseID); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteKnowledgeBase(ctx, kb.KnowledgeBaseID); err != nil {
		t.Fatal("删除应幂等", err)
	}
	if _, err := store.GetKnowledgeBase(ctx, kb.KnowledgeBaseID); !errors.Is(err, ErrNotFound) {
		t.Fatal("知识库未逻辑删除")
	}
}

func TestPostgresKnowledgeSyncRollsBackWholeSnapshot(t *testing.T) {
	ctx := context.Background()
	pool := openKnowledgeTestPool(t)
	store := NewPostgresStore(pool)
	now := time.Now().UTC()
	if _, err := store.CreateKnowledgeBase(ctx, KnowledgeBase{KnowledgeBaseID: "kb", Name: "合成库", ProviderType: ProviderRAGFlow, Status: KnowledgeBaseActive, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b"} {
		if _, err := store.CreateDocument(ctx, Document{DocumentID: id, KnowledgeBaseID: "kb", Name: id, ExternalDocumentID: id, Status: DocumentProcessing, CreatedAt: now, UpdatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE knowledge_documents ADD CONSTRAINT fixture_reject_failed CHECK (status <> 'failed')`); err != nil {
		t.Fatal(err)
	}
	err := store.SyncDocuments(ctx, "kb", []provider.ProviderDocument{{ExternalID: "a", Status: provider.DocumentReady}, {ExternalID: "b", Status: provider.DocumentFailed}}, now)
	if err == nil {
		t.Fatal("夹具应触发事务失败")
	}
	docs, err := store.ListDocuments(ctx, "kb")
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 2 {
		t.Fatalf("文档数=%d", len(docs))
	}
	for _, doc := range docs {
		if doc.Status != DocumentProcessing {
			t.Fatalf("部分结果被持久化: %+v", doc)
		}
	}
}
