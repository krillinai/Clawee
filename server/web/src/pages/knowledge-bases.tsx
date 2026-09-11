import { Pencil, Plus, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import {
  ConfirmDialog,
  DataTableShell,
  DetailDrawer,
  EmptyState,
  ErrorAlert,
  FilterRow,
  FilterSearchField,
  FilterSelect,
  KeyValueList,
  LoadingState,
  ModalShell,
  PageHeader,
  PageShell,
  SuccessAlert,
  TableStateRow
} from "@/components/governance-ui";
import { useAdminPermission } from "@/components/admin-permissions";
import { MemberAuthorizationDrawer, type MemberAuthorizationAdapter } from "@/components/member-authorization";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  createKnowledgeAccountGrant,
  createKnowledgeBase,
  deleteKnowledgeBase,
  listKnowledgeBases,
  listKnowledgeMemberCandidates,
  listKnowledgeMembers,
  removeKnowledgeAccountGrant,
  replaceKnowledgeAccountGrant,
  updateKnowledgeBase,
  type DataResourceGrant,
  type KnowledgeBase
} from "@/lib/knowledge-api";
import { APIError } from "@/lib/api";
import { knowledgeBaseStatusOptions, knowledgeStatusPresentation } from "@/lib/knowledge-ui";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { permissions } from "@/lib/rbac-api";

const knowledgeBasesKey = ["knowledge-bases"] as const;

type KnowledgeBaseEditForm = {
  knowledgeBaseId: string;
  name: string;
  description: string;
  originalName: string;
  originalDescription: string;
};

export function KnowledgeBasesPage() {
  const canCreate = useAdminPermission(permissions.knowledgeCreate);
  const canUpdate = useAdminPermission(permissions.knowledgeUpdate);
  const canDelete = useAdminPermission(permissions.knowledgeDelete);
  const canCreateMembers = useAdminPermission(permissions.knowledgeMemberCreate);
  const canUpdateMembers = useAdminPermission(permissions.knowledgeMemberUpdate);
  const canDeleteMembers = useAdminPermission(permissions.knowledgeMemberDelete);
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [authorizationId, setAuthorizationId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [editForm, setEditForm] = useState<KnowledgeBaseEditForm | null>(null);
  const [confirmState, setConfirmState] = useState<KnowledgeBase | null>(null);
  const [pageNotice, setPageNotice] = useState<string | null>(null);

  const basesQuery = useQuery({ queryKey: knowledgeBasesKey, queryFn: listKnowledgeBases });
  const bases = basesQuery.data ?? [];
  const selected = bases.find((item) => item.knowledgeBaseId === selectedId) ?? null;
  const authorizationTarget = bases.find((item) => item.knowledgeBaseId === authorizationId) ?? null;
  const authorizationAdapter = useMemo<MemberAuthorizationAdapter>(() => ({
    queryKey: "knowledge-member-authorizations",
    listMembers: ({ query }) => listKnowledgeMembers(authorizationId ?? "", query),
    listCandidates: ({ query }) => listKnowledgeMemberCandidates(authorizationId ?? "", query),
    addMember: ({ userId, actions }) => createKnowledgeAccountGrant({
      userId,
      knowledgeBaseId: authorizationId ?? "",
      actions: actions as DataResourceGrant["action"][]
    }),
    updateMember: ({ userId, actions }) => replaceKnowledgeAccountGrant({
      userId,
      knowledgeBaseId: authorizationId ?? "",
      actions: actions as DataResourceGrant["action"][]
    }),
    removeMember: (userId) => removeKnowledgeAccountGrant(userId, authorizationId ?? "")
  }), [authorizationId]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return bases.filter((item) => {
      const matchesStatus = status === "all" || item.status === status;
      const matchesQuery =
        !normalized ||
        [item.name, item.description, item.providerType, item.status, item.createdBy]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      return matchesStatus && matchesQuery;
    });
  }, [bases, query, status]);
  const editDirty = editForm !== null && (
    editForm.name.trim() !== editForm.originalName ||
    editForm.description.trim() !== editForm.originalDescription
  );

  const createMutation = useMutation({
    mutationFn: () => createKnowledgeBase({ name: name.trim(), description: description.trim() }),
    onSuccess: (item) => {
      setCreateOpen(false);
      setName("");
      setDescription("");
      setSelectedId(item.knowledgeBaseId);
      setPageNotice(`知识库“${item.name}”创建成功`);
      void queryClient.invalidateQueries({ queryKey: knowledgeBasesKey });
    }
  });
  const updateMutation = useMutation({
    mutationFn: (form: KnowledgeBaseEditForm) => updateKnowledgeBase({
      knowledgeBaseId: form.knowledgeBaseId,
      name: form.name.trim(),
      description: form.description.trim()
    }),
    onSuccess: (item) => {
      setEditForm(null);
      setSelectedId(item.knowledgeBaseId);
      setPageNotice(`知识库“${item.name}”已更新`);
      queryClient.setQueryData<KnowledgeBase[]>(knowledgeBasesKey, (current) => (
        current?.map((existing) => existing.knowledgeBaseId === item.knowledgeBaseId ? item : existing)
      ));
      void queryClient.invalidateQueries({ queryKey: knowledgeBasesKey });
    }
  });
  const deleteBaseMutation = useMutation({
    mutationFn: (item: KnowledgeBase) => deleteKnowledgeBase(item.knowledgeBaseId),
    onSuccess: (_result, item) => {
      setConfirmState(null);
      setSelectedId(null);
      setPageNotice(`知识库“${item.name}”已删除`);
      void queryClient.invalidateQueries({ queryKey: knowledgeBasesKey });
    }
  });
  function openCreate() {
    createMutation.reset();
    setName("");
    setDescription("");
    setPageNotice(null);
    setCreateOpen(true);
  }

  function closeCreate() {
    if (createMutation.isPending) return;
    createMutation.reset();
    setName("");
    setDescription("");
    setCreateOpen(false);
  }

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createMutation.isPending || !name.trim()) return;
    createMutation.mutate();
  }

  function openDetails(item: KnowledgeBase) {
    setSelectedId(item.knowledgeBaseId);
  }

  function closeDetails() {
    setSelectedId(null);
    setEditForm(null);
  }

  function openEditKnowledgeBase(item: KnowledgeBase) {
    updateMutation.reset();
    setPageNotice(null);
    setEditForm({
      knowledgeBaseId: item.knowledgeBaseId,
      name: item.name,
      description: item.description,
      originalName: item.name,
      originalDescription: item.description
    });
  }

  function closeEditKnowledgeBase() {
    if (updateMutation.isPending) return;
    updateMutation.reset();
    setEditForm(null);
  }

  function submitEditKnowledgeBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editForm || updateMutation.isPending || !editForm.name.trim() || !editDirty) return;
    updateMutation.mutate(editForm);
  }

  function openDelete(next: KnowledgeBase) {
    deleteBaseMutation.reset();
    setConfirmState(next);
  }

  function closeDelete() {
    if (deleteBaseMutation.isPending) return;
    setConfirmState(null);
    deleteBaseMutation.reset();
  }

  function confirmDelete() {
    if (deleteBaseMutation.isPending || !confirmState) return;
    deleteBaseMutation.mutate(confirmState);
  }

  return (
    <PageShell>
      <PageHeader
        actions={canCreate ? (
          <Button onClick={openCreate} variant="primary">
            <Plus data-icon="inline-start" aria-hidden="true" />
            创建知识库
          </Button>
        ) : undefined}
        title="知识库"
      >
        统一管理企业知识库、文档状态和 Agent 授权范围。Gateway 负责身份、权限和审计，文档解析与索引由底层知识库服务完成。
      </PageHeader>

      {pageNotice ? <SuccessAlert>{pageNotice}</SuccessAlert> : null}

      <section className="grid gap-3" aria-labelledby="knowledge-base-list-title">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-base font-semibold" id="knowledge-base-list-title">知识库列表</h2>
            <p className="mt-1 text-xs text-muted-foreground">按更新时间倒序展示当前项目管理的逻辑知识库。</p>
          </div>
          <Badge className="self-start" variant="muted">{filtered.length} 条可见</Badge>
        </div>

        <FilterRow compact>
          <FilterSearchField
            aria-label="搜索知识库"
            placeholder="搜索名称 / 说明 / 创建人"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <FilterSelect ariaLabel="筛选知识库状态" className="sm:w-40" value={status} onChange={setStatus}>
            <option value="all">全部状态</option>
            {knowledgeBaseStatusOptions.map((value) => (
              <option key={value} value={value}>{knowledgeStatusPresentation(value).label}</option>
            ))}
          </FilterSelect>
        </FilterRow>

        <DataTableShell dense minWidth={980}>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>说明</TableHead>
              <TableHead>底层类型</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>文档数</TableHead>
              <TableHead>创建人</TableHead>
              <TableHead>更新时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {basesQuery.isLoading ? (
              <TableStateRow colSpan={8}><LoadingState label="正在加载知识库" /></TableStateRow>
            ) : null}
            {basesQuery.isError ? (
              <TableStateRow colSpan={8} tone="danger">
                <ErrorAlert>知识库加载失败：{errorMessage(basesQuery.error)}。请稍后重试。</ErrorAlert>
              </TableStateRow>
            ) : null}
            {!basesQuery.isLoading && !basesQuery.isError && filtered.length === 0 ? (
              <TableStateRow colSpan={8}>
                <EmptyState
                  title={bases.length === 0 ? "暂无知识库" : "暂无匹配的知识库"}
                  description={bases.length === 0 ? "创建知识库后即可上传并管理企业文档。" : "请调整搜索词或状态筛选。"}
                />
              </TableStateRow>
            ) : null}
            {!basesQuery.isLoading && !basesQuery.isError
              ? filtered.map((item) => (
                  <TableRow
                    data-state={selectedId === item.knowledgeBaseId ? "selected" : undefined}
                    key={item.knowledgeBaseId}
                  >
                    <TableCell className="max-w-56 font-medium">
                      <span className="block truncate" title={item.name}>{item.name}</span>
                    </TableCell>
                    <TableCell className="max-w-72 text-muted-foreground">
                      <span className="block truncate" title={item.description || undefined}>{item.description || "-"}</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{item.providerType}</TableCell>
                    <TableCell><KnowledgeStatusBadge value={item.status} /></TableCell>
                    <TableCell className="font-mono text-xs">{item.documentCount}</TableCell>
                    <TableCell className="font-mono text-xs">{item.createdBy || "-"}</TableCell>
                    <TableCell className="font-mono text-xs">{formatDateTime(item.updatedAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button asChild size="sm" variant="secondary">
                          <Link
                            aria-label={`管理${item.name}文档`}
                            to={`/admin/knowledge-bases/documents?knowledge_base_id=${encodeURIComponent(item.knowledgeBaseId)}`}
                          >
                            管理文档
                          </Link>
                        </Button>
                        <Button
                          aria-label={`管理${item.name}成员授权`}
                          onClick={() => setAuthorizationId(item.knowledgeBaseId)}
                          size="sm"
                          variant="secondary"
                        >
                          成员授权
                        </Button>
                        <Button
                          aria-label={`查看${item.name}详情`}
                          onClick={() => openDetails(item)}
                          size="sm"
                          variant="secondary"
                        >
                          查看详情
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              : null}
          </TableBody>
        </DataTableShell>
      </section>

      <DetailDrawer
        contextLabel="知识库详情"
        onClose={closeDetails}
        open={Boolean(selected)}
        subtitle={selected?.description || selected?.knowledgeBaseId || ""}
        title={selected?.name || "知识库"}
        titleAction={selected ? <KnowledgeStatusBadge value={selected.status} /> : undefined}
      >
        {selected ? (
          <>
            {canUpdate || canDelete ? <Card className="shadow-none">
              <CardHeader className="flex-row items-start justify-between gap-4">
                <div className="grid gap-1.5">
                  <CardTitle>基础信息</CardTitle>
                  <CardDescription>当前项目维护逻辑知识库与底层 Provider 的固定绑定。</CardDescription>
                </div>
                {canUpdate ? <Button
                  aria-label="编辑知识库基础信息"
                  onClick={() => openEditKnowledgeBase(selected)}
                  size="sm"
                  variant="secondary"
                >
                  <Pencil data-icon="inline-start" aria-hidden="true" />
                  编辑
                </Button> : null}
              </CardHeader>
              <CardContent className="grid gap-4">
                <KeyValueList
                  labelWidth={104}
                  items={[
                    { label: "知识库 ID", value: selected.knowledgeBaseId },
                    { label: "底层类型", value: selected.providerType },
                    { label: "创建人", value: selected.createdBy || "-" },
                    { label: "创建时间", value: formatDateTime(selected.createdAt) },
                    { label: "更新时间", value: formatDateTime(selected.updatedAt) },
                    { label: "文档数量", value: selected.documentCount }
                  ]}
                />
                {selected.errorMessage ? (
                  <ErrorAlert>知识库当前不可用：{selected.errorMessage}。请检查底层知识库服务后重试。</ErrorAlert>
                ) : null}
              </CardContent>
            </Card> : null}

            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>删除知识库</CardTitle>
                <CardDescription>删除前请先撤销有效授权。删除成功后，该知识库及其文档将不再参与检索。</CardDescription>
              </CardHeader>
              <CardFooter className="justify-end">
                {canDelete ? <Button onClick={() => openDelete(selected)} size="sm" variant="destructive">
                  <Trash2 data-icon="inline-start" aria-hidden="true" />
                  删除知识库
                </Button> : null}
              </CardFooter>
            </Card>
          </>
        ) : null}
      </DetailDrawer>

      <MemberAuthorizationDrawer
        adapter={authorizationAdapter}
        canAdd={canCreateMembers}
        canRemove={canDeleteMembers}
        canUpdate={canUpdateMembers}
        onClose={() => setAuthorizationId(null)}
        open={Boolean(authorizationTarget)}
        permissions={[
          { value: "read", label: "查看知识库与文档", required: true },
          { value: "upload", label: "上传文档" },
          { value: "mcp", label: "MCP 调用", description: "允许该账户下已获得相关 MCP Tool 授权的 Agent 调用此知识库。" }
        ]}
        resourceId={authorizationTarget?.knowledgeBaseId ?? ""}
        resourceLabel="知识库"
        resourceName={authorizationTarget?.name ?? ""}
      />

      <ModalShell
        contentClassName="max-w-[507px]"
        contextLabel="企业知识"
        onClose={closeEditKnowledgeBase}
        open={Boolean(editForm)}
        subtitle={editForm?.knowledgeBaseId}
        title="编辑知识库"
      >
        {editForm ? (
          <form onSubmit={submitEditKnowledgeBase}>
            <FieldGroup>
              <Field data-invalid={!editForm.name.trim()}>
                <FieldLabel htmlFor="knowledge-edit-name">名称</FieldLabel>
                <Input
                  aria-describedby="knowledge-edit-name-description"
                  aria-invalid={!editForm.name.trim()}
                  aria-label="知识库名称"
                  id="knowledge-edit-name"
                  maxLength={100}
                  required
                  value={editForm.name}
                  onChange={(event) => setEditForm((current) => current ? { ...current, name: event.target.value } : current)}
                />
                <FieldDescription id="knowledge-edit-name-description">必填，最多 100 字</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="knowledge-edit-description">说明</FieldLabel>
                <Textarea
                  aria-describedby="knowledge-edit-description-description"
                  aria-label="知识库说明"
                  id="knowledge-edit-description"
                  maxLength={1000}
                  value={editForm.description}
                  onChange={(event) => setEditForm((current) => current ? { ...current, description: event.target.value } : current)}
                />
                <FieldDescription id="knowledge-edit-description-description">可选，最多 1000 字</FieldDescription>
              </Field>
              {updateMutation.isError ? (
                <ErrorAlert>保存失败：{errorMessage(updateMutation.error)}。请检查名称和说明后重试。</ErrorAlert>
              ) : null}
              <Field className="flex-wrap justify-end" orientation="horizontal">
                <Button disabled={updateMutation.isPending} onClick={closeEditKnowledgeBase} type="button" variant="outline">取消</Button>
                <Button disabled={updateMutation.isPending || !editForm.name.trim() || !editDirty} type="submit" variant="primary">
                  {updateMutation.isPending ? "保存中..." : "保存"}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        ) : null}
      </ModalShell>

      <ModalShell
        contentClassName="max-w-[507px]"
        contextLabel="企业知识"
        onClose={closeCreate}
        open={createOpen}
        subtitle="创建后由 Gateway 固定绑定底层知识库，Agent 不能自行修改知识库范围。"
        title="创建知识库"
      >
        <form onSubmit={submitCreate}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="knowledge-name">名称</FieldLabel>
              <Input
                aria-describedby="knowledge-name-description"
                aria-label="知识库名称"
                id="knowledge-name"
                maxLength={100}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <FieldDescription id="knowledge-name-description">必填，最多 100 字</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="knowledge-description">说明</FieldLabel>
              <Textarea
                aria-describedby="knowledge-description-description"
                aria-label="知识库说明"
                id="knowledge-description"
                maxLength={1000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <FieldDescription id="knowledge-description-description">可选，最多 1000 字</FieldDescription>
            </Field>
            {createMutation.isError ? (
              <ErrorAlert>创建失败：{errorMessage(createMutation.error)}。请检查名称和说明后重试。</ErrorAlert>
            ) : null}
            <Field className="flex-wrap justify-end" orientation="horizontal">
              <Button disabled={createMutation.isPending} onClick={closeCreate} type="button" variant="outline">取消</Button>
              <Button disabled={createMutation.isPending || !name.trim()} type="submit" variant="primary">
                {createMutation.isPending ? "创建中..." : "创建"}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </ModalShell>

      <ConfirmDialog
        cancelLabel="取消"
        confirmLabel={deleteBaseMutation.isPending ? "删除中..." : "确认删除"}
        description="删除后知识库及其文档将不再可用。"
        error={deleteBaseMutation.error ? knowledgeDeleteError(deleteBaseMutation.error) : undefined}
        onClose={closeDelete}
        onConfirm={confirmDelete}
        open={Boolean(confirmState)}
        pending={deleteBaseMutation.isPending}
        title="删除知识库"
        variant="destructive"
      />
    </PageShell>
  );
}

function KnowledgeStatusBadge({ value }: { value: string }) {
  const presentation = knowledgeStatusPresentation(value);
  return <Badge title={value} variant={presentation.variant}>{presentation.label}</Badge>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function knowledgeDeleteError(error: unknown) {
  const reasons = error instanceof APIError
    ? error.details.flatMap((detail) => typeof detail.reason === "string" ? [detail.reason] : [])
    : [];
  return (
    <div className="grid gap-1">
      <span>删除失败：{errorMessage(error)}。</span>
      {reasons.map((reason) => <span key={reason}>具体原因：{reason}</span>)}
      {reasons.length === 0 ? <span>请处理冲突后重试。</span> : null}
    </div>
  );
}
