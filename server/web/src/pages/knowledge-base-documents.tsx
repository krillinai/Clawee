import { ArrowLeft, RefreshCw, Trash2, Upload } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";

import {
  ConfirmDialog,
  DataTableShell,
  EmptyState,
  ErrorAlert,
  LoadingState,
  ModalShell,
  PageHeader,
  PageShell,
  SuccessAlert,
  TableStateRow
} from "@/components/governance-ui";
import { useAdminPermission } from "@/components/admin-permissions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  deleteKnowledgeDocument,
  listKnowledgeBases,
  listKnowledgeDocuments,
  syncKnowledgeDocuments,
  uploadKnowledgeDocument,
  type KnowledgeDocument
} from "@/lib/knowledge-api";
import { knowledgeStatusPresentation } from "@/lib/knowledge-ui";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { permissions } from "@/lib/rbac-api";

const knowledgeBasesKey = ["knowledge-bases"] as const;

export function KnowledgeBaseDocumentsPage() {
  const canUpload = useAdminPermission(permissions.knowledgeDocumentUpload);
  const canSync = useAdminPermission(permissions.knowledgeDocumentSync);
  const canDelete = useAdminPermission(permissions.knowledgeDocumentDelete);
  const [searchParams] = useSearchParams();
  const knowledgeBaseId = searchParams.get("knowledge_base_id") ?? "";
  const queryClient = useQueryClient();
  const autoSyncedKnowledgeBasesRef = useRef(new Set<string>());
  const [file, setFile] = useState<File | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [documentToDelete, setDocumentToDelete] = useState<KnowledgeDocument | null>(null);

  const basesQuery = useQuery({ queryKey: knowledgeBasesKey, queryFn: listKnowledgeBases });
  const knowledgeBase = basesQuery.data?.find((item) => item.knowledgeBaseId === knowledgeBaseId) ?? null;
  const isActive = knowledgeBase?.status === "active";
  const documentsKey = ["knowledge-documents", knowledgeBaseId] as const;
  const documentsQuery = useQuery({
    queryKey: documentsKey,
    queryFn: () => listKnowledgeDocuments(knowledgeBaseId),
    enabled: Boolean(knowledgeBase)
  });
  const documents = documentsQuery.data ?? [];

  const uploadMutation = useMutation({
    mutationFn: () => {
      if (!knowledgeBaseId || !file) throw new Error("请选择要上传的文档");
      return uploadKnowledgeDocument(knowledgeBaseId, file);
    },
    onSuccess: () => {
      setFile(null);
      setUploadOpen(false);
      setNotice("文档上传成功");
      void queryClient.invalidateQueries({ queryKey: documentsKey });
      void queryClient.invalidateQueries({ queryKey: knowledgeBasesKey });
    }
  });
  const syncMutation = useMutation({
    mutationFn: () => syncKnowledgeDocuments(knowledgeBaseId),
    onSuccess: (items) => {
      queryClient.setQueryData(documentsKey, items);
      setNotice("文档状态同步成功");
      void queryClient.invalidateQueries({ queryKey: knowledgeBasesKey });
    }
  });
  const deleteMutation = useMutation({
    mutationFn: (item: KnowledgeDocument) => deleteKnowledgeDocument(item.knowledgeBaseId, item.documentId),
    onSuccess: (_result, item) => {
      setDocumentToDelete(null);
      setNotice(`文档“${item.name}”已删除`);
      void queryClient.invalidateQueries({ queryKey: documentsKey });
      void queryClient.invalidateQueries({ queryKey: knowledgeBasesKey });
    }
  });

  useEffect(() => {
    if (!canSync || !isActive || !documentsQuery.isSuccess || uploadMutation.isPending || syncMutation.isPending) return;
    if (!documents.some((item) => item.status === "processing")) return;
    if (autoSyncedKnowledgeBasesRef.current.has(knowledgeBaseId)) return;

    autoSyncedKnowledgeBasesRef.current.add(knowledgeBaseId);
    syncMutation.mutate();
  }, [canSync, documents, documentsQuery.isSuccess, isActive, knowledgeBaseId, syncMutation, uploadMutation.isPending]);

  function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isActive || !file || uploadMutation.isPending || syncMutation.isPending) return;
    uploadMutation.reset();
    setNotice(null);
    uploadMutation.mutate();
  }

  function openUpload() {
    uploadMutation.reset();
    setNotice(null);
    setFile(null);
    setUploadOpen(true);
  }

  function closeUpload() {
    if (uploadMutation.isPending) return;
    setUploadOpen(false);
    setFile(null);
    uploadMutation.reset();
  }

  function runSync() {
    if (!isActive || syncMutation.isPending || uploadMutation.isPending) return;
    syncMutation.reset();
    setNotice(null);
    syncMutation.mutate();
  }

  function openDelete(item: KnowledgeDocument) {
    deleteMutation.reset();
    setDocumentToDelete(item);
  }

  function closeDelete() {
    if (deleteMutation.isPending) return;
    setDocumentToDelete(null);
    deleteMutation.reset();
  }

  return (
    <PageShell>
      <PageHeader
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/admin/knowledge-bases">
                <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                返回知识库
              </Link>
            </Button>
            {canSync ? <Button
              disabled={!isActive || syncMutation.isPending || uploadMutation.isPending}
              onClick={runSync}
              variant="secondary"
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              {syncMutation.isPending ? "同步中..." : "同步状态"}
            </Button> : null}
            {canUpload && knowledgeBase ? (
              <Button
                disabled={!isActive || syncMutation.isPending || uploadMutation.isPending}
                onClick={openUpload}
              >
                <Upload data-icon="inline-start" aria-hidden="true" />
                上传文档
              </Button>
            ) : null}
          </>
        }
        title={knowledgeBase ? `${knowledgeBase.name}文档` : "知识库文档"}
      >
        {knowledgeBase?.description || "集中上传、同步和维护当前知识库中的企业文档。"}
      </PageHeader>

      {basesQuery.isLoading ? <LoadingState label="正在加载知识库" /> : null}
      {basesQuery.isError ? (
        <ErrorAlert>知识库加载失败：{errorMessage(basesQuery.error)}。请稍后重试。</ErrorAlert>
      ) : null}
      {!basesQuery.isLoading && !basesQuery.isError && !knowledgeBase ? (
        <ErrorAlert>未找到知识库“{knowledgeBaseId}”，请返回知识库列表重新选择。</ErrorAlert>
      ) : null}

      {knowledgeBase ? (
        <div className="grid gap-6">
          <section className="flex flex-wrap items-center gap-2" aria-label="知识库摘要">
            <KnowledgeStatusBadge value={knowledgeBase.status} />
            <Badge variant="muted">{documents.length} 个文档</Badge>
            <Badge variant="outline">{knowledgeBase.providerType}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{knowledgeBase.knowledgeBaseId}</span>
          </section>

          {!isActive ? (
            <Alert variant="muted">
              <AlertTitle>文档操作不可用</AlertTitle>
              <AlertDescription>
                当前状态为“{knowledgeStatusPresentation(knowledgeBase.status).label}”，只有“可用”状态的知识库可以上传文档或同步状态。
              </AlertDescription>
            </Alert>
          ) : null}

          {syncMutation.isError ? (
            <ErrorAlert>同步失败：{errorMessage(syncMutation.error)}。本地状态未变更，请检查 Provider 后重试。</ErrorAlert>
          ) : null}
          {notice ? <SuccessAlert>{notice}</SuccessAlert> : null}

          <section className="grid gap-3" aria-labelledby="knowledge-document-list-title">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-base font-semibold" id="knowledge-document-list-title">文档列表</h2>
                <p className="mt-1 text-xs text-muted-foreground">查看解析状态、上传人和最近更新时间。</p>
              </div>
              <Badge className="self-start" variant="muted">{documents.length} 条记录</Badge>
            </div>

            <DataTableShell dense minWidth={760}>
              <TableHeader>
                <TableRow>
                  <TableHead>文档</TableHead>
                  <TableHead>大小</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>上传人</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documentsQuery.isLoading ? (
                  <TableStateRow colSpan={6}><LoadingState label="正在加载知识库文档" /></TableStateRow>
                ) : null}
                {documentsQuery.isError ? (
                  <TableStateRow colSpan={6} tone="danger">
                    <ErrorAlert>文档加载失败：{errorMessage(documentsQuery.error)}。请稍后重试。</ErrorAlert>
                  </TableStateRow>
                ) : null}
                {!documentsQuery.isLoading && !documentsQuery.isError && documents.length === 0 ? (
                  <TableStateRow colSpan={6}>
                    <EmptyState title="暂无文档" description="选择文件并上传后，可在这里查看处理状态。" />
                  </TableStateRow>
                ) : null}
                {!documentsQuery.isLoading && !documentsQuery.isError
                  ? documents.map((item) => (
                      <TableRow key={item.documentId}>
                        <TableCell className="max-w-80">
                          <span className="block truncate font-medium" title={item.name}>{item.name}</span>
                          {item.errorMessage ? (
                            <p className="mt-1 max-w-80 break-words text-xs text-destructive" title={item.errorMessage}>
                              {item.errorMessage}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{formatBytes(item.sizeBytes)}</TableCell>
                        <TableCell><KnowledgeStatusBadge value={item.status} /></TableCell>
                        <TableCell className="font-mono text-xs">{item.uploadedBy || "-"}</TableCell>
                        <TableCell className="font-mono text-xs">{formatDateTime(item.updatedAt)}</TableCell>
                        <TableCell className="text-right">
                          {canDelete ? <Button
                            aria-label={`删除文档 ${item.name}`}
                            onClick={() => openDelete(item)}
                            size="icon"
                            variant="ghost"
                          >
                            <Trash2 aria-hidden="true" />
                          </Button> : null}
                        </TableCell>
                      </TableRow>
                    ))
                  : null}
              </TableBody>
            </DataTableShell>
          </section>
        </div>
      ) : null}

      <ModalShell
        open={uploadOpen}
        title="上传文档"
        subtitle="支持 PDF、DOCX、XLSX、Markdown、TXT 和 CSV，单文件最大 50 MiB。"
        onClose={closeUpload}
      >
        <form className="flex flex-col gap-4" onSubmit={submitUpload}>
          {uploadMutation.isError ? (
            <ErrorAlert>上传失败：{errorMessage(uploadMutation.error)}。请检查文件格式和大小后重试。</ErrorAlert>
          ) : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="knowledge-document-file">本地文档</FieldLabel>
              <Input
                accept=".pdf,.docx,.xlsx,.md,.txt,.csv"
                aria-describedby="knowledge-document-file-description"
                aria-label="选择知识库文档"
                disabled={uploadMutation.isPending || syncMutation.isPending}
                id="knowledge-document-file"
                onChange={(event) => {
                  uploadMutation.reset();
                  setNotice(null);
                  setFile(event.target.files?.[0] ?? null);
                }}
                required
                type="file"
              />
              <FieldDescription id="knowledge-document-file-description">
                文档上传后由底层知识库服务解析并建立索引。
              </FieldDescription>
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button disabled={uploadMutation.isPending} onClick={closeUpload} type="button" variant="outline">取消</Button>
            <Button disabled={!file || uploadMutation.isPending || syncMutation.isPending} type="submit">
              <Upload data-icon="inline-start" aria-hidden="true" />
              {uploadMutation.isPending ? "上传中..." : "上传"}
            </Button>
          </div>
        </form>
      </ModalShell>

      <ConfirmDialog
        cancelLabel="取消"
        confirmLabel={deleteMutation.isPending ? "删除中..." : "确认删除"}
        description="删除后该文档将不再参与检索。"
        error={deleteMutation.error ? `删除失败：${errorMessage(deleteMutation.error)}。请处理冲突后重试。` : undefined}
        onClose={closeDelete}
        onConfirm={() => documentToDelete && deleteMutation.mutate(documentToDelete)}
        open={Boolean(documentToDelete)}
        pending={deleteMutation.isPending}
        title="删除文档"
        variant="destructive"
      />
    </PageShell>
  );
}

function KnowledgeStatusBadge({ value }: { value: string }) {
  const presentation = knowledgeStatusPresentation(value);
  return <Badge title={value} variant={presentation.variant}>{presentation.label}</Badge>;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
