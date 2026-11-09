import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Eye, FileUp, Trash2, Upload } from "lucide-react";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useAdminPermission } from "@/components/admin-permissions";
import {
  ConfirmDialog,
  DataTableShell,
  EmptyState,
  ErrorAlert,
  FilterRow,
  FilterSearchField,
  LoadingState,
  ModalShell,
  PageHeader,
  PageShell,
  SuccessAlert,
  TableStateRow
} from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { APIError } from "@/lib/api";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { permissions } from "@/lib/rbac-api";
import { SharedFilePreview } from "./shared-file-preview";
import {
  deleteSharedFile,
  getSharedSpace,
  listSharedFiles,
  sharedFileDownloadURL,
  SharedFileAPIError,
  uploadSharedFile,
  type SharedFile
} from "@/lib/shared-files-api";

type UploadForm = {
  mode: "create" | "replace";
  logicalPath: string;
  expectedRevision?: number;
  files: File[];
};

type UploadItemResult = {
  fileName: string;
  success: boolean;
  created?: boolean;
  revision?: number;
  errorMessage?: string;
};

type UploadOutcome =
  | { mode: "replace"; result: Awaited<ReturnType<typeof uploadSharedFile>> }
  | { mode: "create"; items: UploadItemResult[] };

export function SharedSpaceFilesPage() {
  const canDownload = useAdminPermission(permissions.sharedFilesDownload);
  const canUpload = useAdminPermission(permissions.sharedFilesUpload);
  const canDelete = useAdminPermission(permissions.sharedFilesDelete);
  const [searchParams] = useSearchParams();
  const spaceId = searchParams.get("space_id") ?? "";
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [logicalPathPrefix, setLogicalPathPrefix] = useState(searchParams.get("logical_path_prefix") ?? "");
  const [cursor, setCursor] = useState("");
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [uploadForm, setUploadForm] = useState<UploadForm | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<SharedFile | null>(null);
  const [fileToDelete, setFileToDelete] = useState<SharedFile | null>(null);

  useEffect(() => { setPreviewFile(null); }, [spaceId, canDownload]);

  const spaceQuery = useQuery({
    queryKey: ["shared-space", spaceId],
    queryFn: () => getSharedSpace(spaceId),
    enabled: Boolean(spaceId)
  });
  const filesKey = ["shared-space-files", spaceId, query, logicalPathPrefix, cursor] as const;
  const filesQuery = useQuery({
    queryKey: filesKey,
    queryFn: () => listSharedFiles({ spaceId, query, logicalPathPrefix, cursor }),
    enabled: Boolean(spaceId),
    placeholderData: (previous) => previous
  });
  const files = filesQuery.data?.items ?? [];

  const uploadMutation = useMutation({
    mutationFn: async (value: UploadForm): Promise<UploadOutcome> => {
      if (value.mode === "replace") {
        return {
          mode: "replace",
          result: await uploadSharedFile({
            spaceId,
            logicalPath: value.logicalPath,
            file: value.files[0] as File,
            expectedRevision: value.expectedRevision
          })
        };
      }
      const items: UploadItemResult[] = [];
      for (const [index, file] of value.files.entries()) {
        setUploadProgress({ current: index + 1, total: value.files.length });
        const logicalPath = value.files.length === 1 ? value.logicalPath : file.name;
        try {
          const result = await uploadSharedFile({
            spaceId,
            logicalPath,
            file,
            expectedRevision: value.expectedRevision
          });
          items.push({ fileName: result.fileName, success: true, created: result.created, revision: result.revision });
        } catch (error) {
          items.push({ fileName: file.name, success: false, errorMessage: error instanceof Error ? error.message : "上传失败" });
        }
      }
      return { mode: "create", items };
    },
    onSuccess: (outcome) => {
      if (outcome.mode === "replace") {
        setUploadForm(null);
        setNotice(outcome.result.created ? `文件“${outcome.result.fileName}”已上传` : `文件“${outcome.result.fileName}”已更新至 revision ${outcome.result.revision}`);
      } else {
        const successCount = outcome.items.filter((item) => item.success).length;
        if (successCount === outcome.items.length) {
          setUploadForm(null);
          if (outcome.items.length === 1) {
            const [item] = outcome.items;
            setNotice(item.created ? `文件“${item.fileName}”已上传` : `文件“${item.fileName}”已更新至 revision ${item.revision}`);
          } else {
            setNotice(`已上传 ${successCount} 个文件`);
          }
        } else {
          setNotice(successCount > 0 ? `已上传 ${successCount} 个文件` : null);
        }
      }
      if (outcome.mode === "replace" || outcome.items.some((item) => item.success)) {
        void queryClient.invalidateQueries({ queryKey: ["shared-space-files", spaceId] });
        void queryClient.invalidateQueries({ queryKey: ["shared-space", spaceId] });
        void queryClient.invalidateQueries({ queryKey: ["shared-spaces"] });
      }
    },
    onError: (error) => {
      if (error instanceof SharedFileAPIError && error.code === "revision_conflict") {
        void queryClient.invalidateQueries({ queryKey: ["shared-space-files", spaceId] });
      }
    },
    onSettled: () => { setUploadProgress(null); }
  });

  const deleteMutation = useMutation({
    mutationFn: (file: SharedFile) => deleteSharedFile({ spaceId, fileId: file.fileId, expectedRevision: file.revision }),
    onSuccess: (_result, file) => {
      setFileToDelete(null);
      setNotice(`文件“${file.fileName}”已永久删除`);
      void queryClient.invalidateQueries({ queryKey: ["shared-space-files", spaceId] });
      void queryClient.invalidateQueries({ queryKey: ["shared-space", spaceId] });
      void queryClient.invalidateQueries({ queryKey: ["shared-spaces"] });
    },
    onError: (error) => {
      if (error instanceof APIError && error.code === "revision_conflict") {
        void queryClient.invalidateQueries({ queryKey: ["shared-space-files", spaceId] });
        void queryClient.invalidateQueries({ queryKey: ["shared-space", spaceId] });
        void queryClient.invalidateQueries({ queryKey: ["shared-spaces"] });
      }
    }
  });

  function openUpload() {
    uploadMutation.reset();
    setUploadProgress(null);
    setNotice(null);
    setUploadForm({ mode: "create", logicalPath: "", files: [] });
  }

  function openReplace(file: SharedFile) {
    uploadMutation.reset();
    setUploadProgress(null);
    setNotice(null);
    setUploadForm({ mode: "replace", logicalPath: file.logicalPath, expectedRevision: file.revision, files: [] });
  }

  function openDelete(file: SharedFile) {
    deleteMutation.reset();
    setNotice(null);
    setFileToDelete(file);
  }

  function closeDelete() {
    if (deleteMutation.isPending) return;
    deleteMutation.reset();
    setFileToDelete(null);
  }

  function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!uploadForm || uploadMutation.isPending || uploadMutation.data?.mode === "create") return;
    if (uploadForm.files.length === 0) return;
    if (uploadForm.mode === "replace" && uploadForm.files.length !== 1) return;
    if (uploadForm.mode === "create" && uploadForm.files.length === 1 && !uploadForm.logicalPath.trim()) return;
    uploadMutation.mutate(uploadForm);
  }

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    setUploadForm((value) => {
      if (!value) return value;
      if (value.mode === "replace") return { ...value, files: files.slice(0, 1) };
      return { ...value, files, logicalPath: files.length === 1 && !value.logicalPath ? files[0]?.name ?? "" : value.logicalPath };
    });
  }

  function resetFilePage() {
    setCursor("");
    setCursorHistory([]);
  }

  const uploadFiles = uploadForm?.files ?? [];
  const isMultiUpload = uploadForm?.mode === "create" && uploadFiles.length > 1;
  const uploadResults = uploadMutation.data?.mode === "create" ? uploadMutation.data.items : null;
  const showUploadResults = Boolean(uploadResults?.some((item) => !item.success));
  const canSubmitUpload = uploadForm !== null && !uploadMutation.isPending && !showUploadResults && (
    uploadForm.mode === "replace"
      ? uploadForm.files.length === 1 && Boolean(uploadForm.logicalPath.trim())
      : uploadForm.files.length > 1 || Boolean(uploadForm.logicalPath.trim())
  );

  return (
    <PageShell>
      <PageHeader
        actions={(
          <>
            <Button asChild variant="outline">
              <Link to={`/admin/shared-files${spaceQuery.data?.personalOwnerUserId ? `?personal_owner_user_id=${encodeURIComponent(spaceQuery.data.personalOwnerUserId)}` : ""}`}>
                <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                返回网盘
              </Link>
            </Button>
            {canUpload && spaceQuery.data ? (
              <Button onClick={openUpload}>
                <Upload data-icon="inline-start" aria-hidden="true" />
                上传文件
              </Button>
            ) : null}
          </>
        )}
        title={spaceQuery.data ? `${spaceQuery.data.name}文件` : "共享空间文件"}
      >
        {spaceQuery.data?.description || "查看和维护当前共享空间中的文件。"}
      </PageHeader>

      {spaceQuery.isLoading ? <LoadingState label="正在加载共享空间" /> : null}
      {spaceQuery.isError ? <ErrorAlert>{spaceQuery.error.message}</ErrorAlert> : null}
      {!spaceId ? <ErrorAlert>缺少共享空间 ID，请返回网盘列表重新选择。</ErrorAlert> : null}

      {spaceQuery.data ? (
        <div className="grid gap-6">
          <section className="flex flex-wrap items-center gap-2" aria-label="共享空间摘要">
            {spaceQuery.data.personalOwnerUserId ? <Badge variant="outline">个人空间 · {spaceQuery.data.personalOwnerName || spaceQuery.data.personalOwnerEmail || spaceQuery.data.personalOwnerUserId}</Badge> : null}
            <Badge variant="muted">{spaceQuery.data.fileCount} 个文件</Badge>
            <Badge variant="outline">{formatBytes(spaceQuery.data.sizeBytes)}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{spaceQuery.data.spaceId}</span>
          </section>

          {notice ? <SuccessAlert>{notice}</SuccessAlert> : null}
          {!canDownload ? <p className="text-sm text-muted-foreground" role="status">当前账号无下载权限，仅可查看文件信息。请联系管理员开通预览与下载权限。</p> : null}

          <section className="grid gap-3" aria-labelledby="shared-file-list-title">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-base font-semibold" id="shared-file-list-title">文件列表</h2>
                <p className="mt-1 text-xs text-muted-foreground">按文件名、逻辑路径和 revision 查看当前版本。</p>
              </div>
              <Badge className="self-start" variant="muted">{files.length} 条记录</Badge>
            </div>

            <FilterRow compact>
              <FilterSearchField
                aria-label="搜索空间文件"
                placeholder="搜索文件 ID 或文件名"
                value={query}
                onChange={(event) => { setQuery(event.target.value); resetFilePage(); }}
              />
              <Input
                aria-label="筛选逻辑路径前缀"
                className="max-w-64"
                placeholder="路径前缀，如 docs/"
                value={logicalPathPrefix}
                onChange={(event) => { setLogicalPathPrefix(event.target.value); resetFilePage(); }}
              />
            </FilterRow>

            <DataTableShell dense minWidth={840}>
              <TableHeader>
                <TableRow>
                  <TableHead>文件</TableHead>
                  <TableHead>大小</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>Revision</TableHead>
                  <TableHead>最近更新</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filesQuery.isLoading ? <TableStateRow colSpan={6}>正在加载文件...</TableStateRow> : null}
                {filesQuery.isError ? <TableStateRow colSpan={6} tone="danger">{filesQuery.error.message}</TableStateRow> : null}
                {!filesQuery.isLoading && !filesQuery.isError && files.length === 0 ? (
                  <TableStateRow colSpan={6}><EmptyState title="暂无文件" description={canUpload ? "点击上传文件后，可在这里查看当前版本。" : "当前共享空间中暂无文件。"} /></TableStateRow>
                ) : null}
                {!filesQuery.isLoading && !filesQuery.isError ? files.map((file) => (
                  <TableRow key={file.fileId}>
                    <TableCell>
                      <div className="font-medium">{file.fileName}</div>
                      <div className="max-w-80 truncate font-mono text-xs text-muted-foreground">{file.logicalPath}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{formatBytes(file.sizeBytes)}</TableCell>
                    <TableCell className="max-w-40 truncate text-xs">{file.contentType}</TableCell>
                    <TableCell className="font-mono">{file.revision}</TableCell>
                    <TableCell>
                      <div className="text-sm">{file.updatedByUserName || "-"}</div>
                      <div className="font-mono text-xs text-muted-foreground">{formatDateTime(file.updatedAt)}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      {canDownload || canUpload || canDelete ? <div className="flex justify-end gap-1">
                        {canDownload ? <Button aria-label={`预览文件 ${file.fileName}`} title="预览" size="icon" variant="ghost" onClick={() => setPreviewFile(file)}><Eye aria-hidden="true" /></Button> : null}
                        {canDownload ? <Button asChild size="sm" variant="ghost">
                          <a aria-label={`下载文件 ${file.fileName}`} href={sharedFileDownloadURL(file.fileId)}>
                            <Download data-icon="inline-start" aria-hidden="true" />
                            下载
                          </a>
                        </Button> : null}
                        {canUpload ? <Button aria-label={`上传新版本 ${file.fileName}`} size="sm" variant="outline" onClick={() => openReplace(file)}>
                          <FileUp data-icon="inline-start" aria-hidden="true" />
                          新版本
                        </Button> : null}
                        {canDelete ? <Button aria-label={`删除文件 ${file.fileName}`} title="删除" size="icon" variant="ghost" onClick={() => openDelete(file)}>
                          <Trash2 aria-hidden="true" />
                        </Button> : null}
                      </div> : null}
                    </TableCell>
                  </TableRow>
                )) : null}
              </TableBody>
            </DataTableShell>

            <div className="flex justify-end gap-2">
              <Button disabled={cursorHistory.length === 0 || filesQuery.isFetching} variant="outline" onClick={() => setCursorHistory((items) => { const next = [...items]; setCursor(next.pop() ?? ""); return next; })}>上一页</Button>
              <Button disabled={!filesQuery.data?.meta.has_next || filesQuery.isFetching} variant="outline" onClick={() => { const next = filesQuery.data?.meta.next_cursor; if (next) { setCursorHistory((items) => [...items, cursor]); setCursor(next); } }}>下一页</Button>
            </div>
          </section>
        </div>
      ) : null}

      {previewFile && canDownload && previewFile.spaceId === spaceId ? <SharedFilePreview key={previewFile.fileId} file={previewFile} onClose={() => setPreviewFile(null)} /> : null}
      <ModalShell
        open={Boolean(uploadForm)}
        title={uploadForm?.mode === "replace" ? "上传文件新版本" : "上传文件"}
        subtitle={uploadForm?.mode === "replace" ? `将按 revision ${uploadForm.expectedRevision ?? "-"} 校验并替换当前内容。` : "文件将保存到当前共享空间。"}
        onClose={() => !uploadMutation.isPending && setUploadForm(null)}
      >
        <form className="flex flex-col gap-4" onSubmit={submitUpload}>
          {uploadMutation.isError ? <ErrorAlert>{uploadMutation.error.message}</ErrorAlert> : null}
          {showUploadResults && uploadResults ? (
            <ul aria-label="上传结果" className="grid gap-2">
              {uploadResults.map((item, index) => (
                <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm" key={`${item.fileName}-${index}`}>
                  <span className="min-w-0 break-all font-medium">{item.fileName}</span>
                  {item.success ? <Badge variant="success">成功</Badge> : <span className="min-w-0 break-all text-destructive">失败：{item.errorMessage}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="shared-file-input">本地文件</FieldLabel>
                <Input id="shared-file-input" multiple={uploadForm?.mode === "create"} required type="file" onChange={chooseFiles} />
                <FieldDescription>单文件最大 1 GiB。</FieldDescription>
              </Field>
              {isMultiUpload ? (
                <div className="grid gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">已选文件</p>
                    <span className="text-xs text-muted-foreground">{uploadFiles.length} 个文件</span>
                  </div>
                  <p className="text-sm text-muted-foreground">多选时按各自文件名保存到当前空间根目录。</p>
                  <ul className="grid gap-1">
                    {uploadFiles.map((file, index) => (
                      <li className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm" key={`${file.name}-${index}`}>
                        <span className="min-w-0 break-all">{file.name}</span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatBytes(file.size)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <Field>
                  <FieldLabel htmlFor="shared-file-logical-path">逻辑路径</FieldLabel>
                  <Input id="shared-file-logical-path" maxLength={512} readOnly={uploadForm?.mode === "replace"} required value={uploadForm?.logicalPath ?? ""} onChange={(event) => setUploadForm((value) => value ? { ...value, logicalPath: event.target.value } : value)} />
                  <FieldDescription>{uploadForm?.mode === "replace" ? "上传新版本时不改变原逻辑路径。" : "使用 / 组织层级，例如 docs/design.md。"}</FieldDescription>
                </Field>
              )}
            </FieldGroup>
          )}
          {uploadMutation.isPending && uploadProgress && uploadProgress.total > 1 ? <p className="text-sm text-muted-foreground" role="status">正在上传 {uploadProgress.current}/{uploadProgress.total}</p> : null}
          <div className="flex justify-end gap-2">
            {showUploadResults ? (
              <Button type="button" onClick={() => setUploadForm(null)}>关闭</Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => setUploadForm(null)} disabled={uploadMutation.isPending}>取消</Button>
                <Button type="submit" disabled={!canSubmitUpload}>
                  <Upload data-icon="inline-start" aria-hidden="true" />
                  {uploadMutation.isPending ? "上传中..." : "上传"}
                </Button>
              </>
            )}
          </div>
        </form>
      </ModalShell>
      <ConfirmDialog
        confirmLabel={deleteMutation.isPending ? "删除中..." : "永久删除"}
        description={fileToDelete ? `将永久删除文件“${fileToDelete.fileName}”（${fileToDelete.logicalPath}，revision ${fileToDelete.revision}）。文件删除后不可恢复，提交前请确认 revision 与文件列表一致。` : ""}
        error={deleteMutation.isError ? deleteFailureMessage(deleteMutation.error) : undefined}
        onClose={closeDelete}
        onConfirm={() => fileToDelete && deleteMutation.mutate(fileToDelete)}
        open={Boolean(fileToDelete)}
        pending={deleteMutation.isPending}
        title="删除文件"
        variant="destructive"
      />
    </PageShell>
  );
}

function deleteFailureMessage(error: Error) {
  if (error instanceof APIError && error.code === "revision_conflict") {
    return "文件版本已变化，已刷新文件列表；请确认最新 revision 后重试。";
  }
  return error.message;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let index = -1;
  do { size /= 1024; index += 1; } while (size >= 1024 && index < units.length - 1);
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}
