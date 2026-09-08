import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { useAdminPermission } from "@/components/admin-permissions";
import { MemberAuthorizationDrawer, type MemberAuthorizationAdapter } from "@/components/member-authorization";
import {
  DataTableShell,
  DetailDrawer,
  EmptyState,
  ErrorAlert,
  FilterRow,
  FilterSearchField,
  KeyValueList,
  ModalShell,
  PageHeader,
  PageShell,
  SuccessAlert,
  TableStateRow
} from "@/components/governance-ui";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { permissions } from "@/lib/rbac-api";
import {
  addSharedSpaceMember,
  createSharedSpace,
  getSharedSpace,
  listSharedSpaceCandidates,
  listSharedSpaceMembers,
  listSharedSpaces,
  removeSharedSpaceMember,
  updateSharedSpaceMember,
  updateSharedSpace,
  type SharedSpace
} from "@/lib/shared-files-api";

type SpaceForm = { mode: "create" | "edit"; spaceId: string; name: string; description: string };

export function SharedFilesPage() {
  const canManage = useAdminPermission(permissions.sharedFilesManage);
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState("");
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [authorizationId, setAuthorizationId] = useState<string | null>(null);
  const [form, setForm] = useState<SpaceForm | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastSpaces, setLastSpaces] = useState<SharedSpace[]>([]);

  const spacesQuery = useQuery({
    queryKey: ["shared-spaces", query, cursor],
    queryFn: () => listSharedSpaces({ query, cursor }),
    placeholderData: (previous) => previous
  });
  const detailQuery = useQuery({ queryKey: ["shared-space", selectedId], queryFn: () => getSharedSpace(selectedId ?? ""), enabled: Boolean(selectedId) });

  useEffect(() => { if (spacesQuery.data) setLastSpaces(spacesQuery.data.items); }, [spacesQuery.data]);

  const saveSpace = useMutation({
    mutationFn: (value: SpaceForm) => value.mode === "create"
      ? createSharedSpace({ name: value.name.trim(), description: value.description.trim() })
      : updateSharedSpace({ spaceId: value.spaceId, name: value.name.trim(), description: value.description.trim() }),
    onSuccess: (space, input) => {
      setForm(null);
      setSelectedId(space.spaceId);
      setNotice(input.mode === "create" ? `共享空间“${space.name}”创建成功` : `共享空间“${space.name}”已更新`);
      void queryClient.invalidateQueries({ queryKey: ["shared-spaces"] });
      void queryClient.invalidateQueries({ queryKey: ["shared-space", space.spaceId] });
    }
  });
  const spaces = spacesQuery.data?.items ?? lastSpaces;
  const selected = detailQuery.data ?? null;
  const authorizationTarget = spaces.find((space) => space.spaceId === authorizationId) ?? null;
  const authorizationAdapter = useMemo<MemberAuthorizationAdapter>(() => ({
    queryKey: "shared-space-member-authorizations",
    listMembers: ({ query, cursor }) => listSharedSpaceMembers({ spaceId: authorizationId ?? "", query, cursor }),
    listCandidates: ({ query, cursor }) => listSharedSpaceCandidates({ spaceId: authorizationId ?? "", query, cursor }),
    addMember: ({ userId, actions }) => addSharedSpaceMember({ spaceId: authorizationId ?? "", userId, actions: actions as Array<"read" | "write"> }),
    updateMember: ({ userId, actions }) => updateSharedSpaceMember({ spaceId: authorizationId ?? "", userId, actions: actions as Array<"read" | "write"> }),
    removeMember: (userId) => removeSharedSpaceMember({ spaceId: authorizationId ?? "", userId })
  }), [authorizationId]);

  function refreshAuthorizationSummary() {
    void queryClient.invalidateQueries({ queryKey: ["shared-space", authorizationId] });
    void queryClient.invalidateQueries({ queryKey: ["shared-spaces"] });
  }

  function submitSpace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || !form.name.trim() || saveSpace.isPending) return;
    saveSpace.mutate(form);
  }

  function openCreate() {
    saveSpace.reset(); setNotice(null); setForm({ mode: "create", spaceId: "", name: "", description: "" });
  }

  function openEdit(space: SharedSpace) {
    saveSpace.reset(); setForm({ mode: "edit", spaceId: space.spaceId, name: space.name, description: space.description });
  }

  function selectSpace(spaceId: string) {
    setSelectedId(spaceId);
  }

  function nextPage() {
    const next = spacesQuery.data?.meta.next_cursor;
    if (!next) return;
    setCursorHistory((items) => [...items, cursor]); setCursor(next);
  }

  function previousPage() {
    setCursorHistory((items) => {
      const next = [...items]; setCursor(next.pop() ?? ""); return next;
    });
  }

  return (
    <PageShell>
      <PageHeader title="网盘" actions={canManage ? <Button onClick={openCreate}><Plus data-icon="inline-start" />创建共享空间</Button> : null}>
        管理共享空间、文件和成员授权。
      </PageHeader>
      {notice ? <SuccessAlert>{notice}</SuccessAlert> : null}
      <FilterRow>
        <FilterSearchField
          aria-label="搜索共享空间"
          placeholder="按空间名称搜索"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setCursor(""); setCursorHistory([]); }}
        />
      </FilterRow>
      <DataTableShell minWidth={760}>
        <TableHeader><TableRow><TableHead>空间名称</TableHead><TableHead>成员</TableHead><TableHead>文件</TableHead><TableHead>占用空间</TableHead><TableHead>更新时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>
          {spacesQuery.isLoading ? <TableStateRow colSpan={6}>正在加载共享空间...</TableStateRow> : null}
          {spacesQuery.isError ? <TableStateRow colSpan={6} tone="danger">{spacesQuery.error.message}</TableStateRow> : null}
          {!spacesQuery.isLoading && !spacesQuery.isError && spaces.length === 0 ? (
            <TableRow><TableCell colSpan={6}><EmptyState title="暂无共享空间" description={canManage ? "创建空间后即可添加成员。" : "当前没有可查看的共享空间。"} /></TableCell></TableRow>
          ) : null}
          {spaces.map((space) => (
            <TableRow key={space.spaceId}>
              <TableCell><div className="font-medium">{space.name}</div><div className="max-w-96 truncate text-xs text-muted-foreground">{space.description || "-"}</div></TableCell>
              <TableCell className="font-mono">{space.memberCount}</TableCell><TableCell className="font-mono">{space.fileCount}</TableCell>
              <TableCell className="font-mono text-xs">{formatBytes(space.sizeBytes)}</TableCell><TableCell className="font-mono text-xs">{formatDateTime(space.updatedAt)}</TableCell>
              <TableCell className="text-right"><div className="flex justify-end gap-2">
                <Button asChild size="sm" variant="secondary"><Link aria-label={`管理${space.name}文件`} to={`/admin/shared-files/detail?space_id=${encodeURIComponent(space.spaceId)}`}>管理文件</Link></Button>
                <Button aria-label={`管理${space.name}成员授权`} size="sm" variant="secondary" onClick={() => setAuthorizationId(space.spaceId)}>成员授权</Button>
                <Button aria-label={`查看${space.name}详情`} size="sm" variant="secondary" onClick={() => selectSpace(space.spaceId)}>查看详情</Button>
              </div></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DataTableShell>
      <div className="flex justify-end gap-2">
        <Button disabled={cursorHistory.length === 0 || spacesQuery.isFetching} variant="outline" onClick={previousPage}>上一页</Button>
        <Button disabled={!spacesQuery.data?.meta.has_next || spacesQuery.isFetching} variant="outline" onClick={nextPage}>下一页</Button>
      </div>

      <DetailDrawer open={Boolean(selectedId)} title={selected?.name ?? "共享空间"} subtitle={selected?.description || "未填写空间说明"} contextLabel="空间详情" onClose={() => setSelectedId(null)} titleAction={canManage && selected ? <Button size="sm" variant="outline" onClick={() => openEdit(selected)}><Pencil data-icon="inline-start" />编辑</Button> : null}>
        {detailQuery.isError ? <ErrorAlert>{detailQuery.error.message}</ErrorAlert> : null}
        {selected ? <KeyValueList items={[
          { label: "空间名称", value: selected.name }, { label: "空间说明", value: selected.description || "-" },
          { label: "成员数量", value: selected.memberCount }, { label: "文件数量", value: selected.fileCount },
          { label: "占用空间", value: formatBytes(selected.sizeBytes) }, { label: "创建人", value: selected.createdBy || "-" },
          { label: "创建时间", value: formatDateTime(selected.createdAt) }, { label: "更新人", value: selected.updatedBy || "-" },
          { label: "空间更新时间", value: formatDateTime(selected.updatedAt) }
        ]} /> : null}
      </DetailDrawer>

      <MemberAuthorizationDrawer
        adapter={authorizationAdapter}
        canManage={canManage}
        memberCount={authorizationTarget?.memberCount}
        onChanged={refreshAuthorizationSummary}
        onClose={() => setAuthorizationId(null)}
        open={Boolean(authorizationTarget)}
        permissions={[
          { value: "read", label: "查看空间与文件", required: true },
          { value: "write", label: "上传及修改文件", defaultChecked: true }
        ]}
        resourceId={authorizationTarget?.spaceId ?? ""}
        resourceLabel="共享空间"
        resourceName={authorizationTarget?.name ?? ""}
      />

      <ModalShell open={Boolean(form)} title={form?.mode === "edit" ? "编辑共享空间" : "创建共享空间"} subtitle="空间名称大小写不敏感且不能重复。" onClose={() => !saveSpace.isPending && setForm(null)}>
        <form className="flex flex-col gap-4" onSubmit={submitSpace}>
          {saveSpace.isError ? <ErrorAlert>{saveSpace.error.message}</ErrorAlert> : null}
          <FieldGroup><Field><FieldLabel htmlFor="space-name">空间名称</FieldLabel><Input id="space-name" maxLength={100} required value={form?.name ?? ""} onChange={(event) => setForm((value) => value ? { ...value, name: event.target.value } : value)} /></Field>
          <Field><FieldLabel htmlFor="space-description">空间说明</FieldLabel><Textarea id="space-description" maxLength={500} value={form?.description ?? ""} onChange={(event) => setForm((value) => value ? { ...value, description: event.target.value } : value)} /><FieldDescription>最多 500 个字符。</FieldDescription></Field></FieldGroup>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setForm(null)} disabled={saveSpace.isPending}>取消</Button><Button type="submit" disabled={saveSpace.isPending || !form?.name.trim()}>保存</Button></div>
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
