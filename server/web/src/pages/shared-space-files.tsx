import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, FileUp, Upload } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useAdminPermission } from "@/components/admin-permissions";
import {
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
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { permissions } from "@/lib/rbac-api";
import {
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
  file: File | null;
};

export function SharedSpaceFilesPage() {
  const canManage = useAdminPermission(permissions.sharedFilesManage);
  const [searchParams] = useSearchParams();
  const spaceId = searchParams.get("space_id") ?? "";
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [logicalPathPrefix, setLogicalPathPrefix] = useState("");
  const [cursor, setCursor] = useState("");
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [uploadForm, setUploadForm] = useState<UploadForm | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    mutationFn: (value: UploadForm) => uploadSharedFile({
      spaceId,
      logicalPath: value.logicalPath.trim(),
      file: value.file as File,
      expectedRevision: value.expectedRevision
    }),
    onSuccess: (result) => {
      setUploadForm(null);
      setNotice(result.created ? `文件“${result.fileName}”已上传` : `文件“${result.fileName}”已更新至 revision ${result.revision}`);
      void queryClient.invalidateQueries({ queryKey: ["shared-space-files", spaceId] });
      void queryClient.invalidateQueries({ queryKey: ["shared-space", spaceId] });
      void queryClient.invalidateQueries({ queryKey: ["shared-spaces"] });
    },
    onError: (error) => {
      if (error instanceof SharedFileAPIError && error.code === "revision_conflict") {
        void queryClient.invalidateQueries({ queryKey: ["shared-space-files", spaceId] });
      }
    }
  });

  function openUpload() {
    uploadMutation.reset();
    setNotice(null);
    setUploadForm({ mode: "create", logicalPath: "", file: null });
  }

  function openReplace(file: SharedFile) {
    uploadMutation.reset();
    setNotice(null);
    setUploadForm({ mode: "replace", logicalPath: file.logicalPath, expectedRevision: file.revision, file: null });
  }

  function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!uploadForm?.file || !uploadForm.logicalPath.trim() || uploadMutation.isPending) return;
    uploadMutation.mutate(uploadForm);
  }

  function resetFilePage() {
    setCursor("");
    setCursorHistory([]);
  }

  return (
    <PageShell>
      <PageHeader
        actions={(
          <>
            <Button asChild variant="outline">
              <Link to="/admin/shared-files">
                <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                返回网盘
              </Link>
            </Button>
            {canManage && spaceQuery.data ? (
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
            <Badge variant="muted">{spaceQuery.data.fileCount} 个文件</Badge>
            <Badge variant="outline">{formatBytes(spaceQuery.data.sizeBytes)}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{spaceQuery.data.spaceId}</span>
          </section>

          {notice ? <SuccessAlert>{notice}</SuccessAlert> : null}

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
                  <TableStateRow colSpan={6}><EmptyState title="暂无文件" description={canManage ? "点击上传文件后，可在这里查看当前版本。" : "当前共享空间中暂无文件。"} /></TableStateRow>
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
                      {canManage ? <div className="flex justify-end gap-1">
                        <Button asChild size="sm" variant="ghost">
                          <a aria-label={`下载文件 ${file.fileName}`} href={sharedFileDownloadURL(file.fileId)}>
                            <Download data-icon="inline-start" aria-hidden="true" />
                            下载
                          </a>
                        </Button>
                        <Button aria-label={`上传新版本 ${file.fileName}`} size="sm" variant="outline" onClick={() => openReplace(file)}>
                          <FileUp data-icon="inline-start" aria-hidden="true" />
                          新版本
                        </Button>
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

      <ModalShell
        open={Boolean(uploadForm)}
        title={uploadForm?.mode === "replace" ? "上传文件新版本" : "上传文件"}
        subtitle={uploadForm?.mode === "replace" ? `将按 revision ${uploadForm.expectedRevision ?? "-"} 校验并替换当前内容。` : "文件将保存到当前共享空间。"}
        onClose={() => !uploadMutation.isPending && setUploadForm(null)}
      >
        <form className="flex flex-col gap-4" onSubmit={submitUpload}>
          {uploadMutation.isError ? <ErrorAlert>{uploadMutation.error.message}</ErrorAlert> : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="shared-file-input">本地文件</FieldLabel>
              <Input id="shared-file-input" required type="file" onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                setUploadForm((value) => value ? { ...value, file, logicalPath: value.mode === "create" && !value.logicalPath ? file?.name ?? "" : value.logicalPath } : value);
              }} />
              <FieldDescription>单文件最大 1 GiB。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="shared-file-logical-path">逻辑路径</FieldLabel>
              <Input id="shared-file-logical-path" maxLength={512} readOnly={uploadForm?.mode === "replace"} required value={uploadForm?.logicalPath ?? ""} onChange={(event) => setUploadForm((value) => value ? { ...value, logicalPath: event.target.value } : value)} />
              <FieldDescription>{uploadForm?.mode === "replace" ? "上传新版本时不改变原逻辑路径。" : "使用 / 组织层级，例如 docs/design.md。"}</FieldDescription>
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setUploadForm(null)} disabled={uploadMutation.isPending}>取消</Button>
            <Button type="submit" disabled={uploadMutation.isPending || !uploadForm?.file || !uploadForm.logicalPath.trim()}>
              <Upload data-icon="inline-start" aria-hidden="true" />
              {uploadMutation.isPending ? "上传中..." : "上传"}
            </Button>
          </div>
        </form>
      </ModalShell>
    </PageShell>
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let index = -1;
  do { size /= 1024; index += 1; } while (size >= 1024 && index < units.length - 1);
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}
