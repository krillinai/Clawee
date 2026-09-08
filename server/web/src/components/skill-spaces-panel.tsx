import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Edit3, UserPlus } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import { DataTableShell, EmptyState, ErrorAlert, LoadingState, ModalShell, TableStateRow } from "@/components/governance-ui";
import { MemberAuthorizationDrawer, type MemberAuthorizationAdapter } from "@/components/member-authorization";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  addSkillSpaceMember,
  createSkillSpace,
  listSkillSpaceCandidates,
  listSkillSpaceMembers,
  listSkillSpaces,
  removeSkillSpaceMember,
  updateSkillSpace,
  updateSkillSpaceMember,
  type SkillSpace
} from "@/lib/skillhub-api";
import { formatDateTime } from "@/lib/mcp-admin-ui";

export function SkillSpacesPanel({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const spacesQuery = useQuery({ queryKey: ["skill-spaces"], queryFn: listSkillSpaces });
  const [editing, setEditing] = useState<SkillSpace | null | undefined>(undefined);
  const [authorizationId, setAuthorizationId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const saveMutation = useMutation({
    mutationFn: () => editing
      ? updateSkillSpace({ spaceId: editing.spaceId, name, description })
      : createSkillSpace({ name, description }),
    onSuccess: () => {
      setEditing(undefined);
      void queryClient.invalidateQueries({ queryKey: ["skill-spaces"] });
    }
  });
  const spaces = spacesQuery.data ?? [];
  const authorizationTarget = spaces.find((space) => space.spaceId === authorizationId) ?? null;
  const authorizationAdapter = useMemo<MemberAuthorizationAdapter>(() => ({
    queryKey: "skill-space-member-authorizations",
    listMembers: async ({ query }) => ({
      items: await listSkillSpaceMembers(authorizationId ?? "", query),
      meta: { next_cursor: "", has_next: false }
    }),
    listCandidates: async ({ query }) => ({
      items: await listSkillSpaceCandidates(authorizationId ?? "", query),
      meta: { next_cursor: "", has_next: false }
    }),
    addMember: ({ userId, actions }) => addSkillSpaceMember({ spaceId: authorizationId ?? "", userId, actions: actions as Array<"read" | "write"> }),
    updateMember: ({ userId, actions }) => updateSkillSpaceMember({ spaceId: authorizationId ?? "", userId, actions: actions as Array<"read" | "write"> }),
    removeMember: (userId) => removeSkillSpaceMember({ spaceId: authorizationId ?? "", userId })
  }), [authorizationId]);

  function openEditor(space: SkillSpace | null) {
    setEditing(space);
    setName(space?.name ?? "");
    setDescription(space?.description ?? "");
    saveMutation.reset();
  }

  function submitSpace(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) saveMutation.mutate();
  }

  return <section aria-label="技能空间" className="grid gap-5">
    {canManage ? (
      <div className="flex justify-end">
        <Button onClick={() => openEditor(null)} variant="primary"><UserPlus data-icon="inline-start" aria-hidden="true" />新建空间</Button>
      </div>
    ) : null}
    <DataTableShell minWidth={860}>
      <TableHeader><TableRow><TableHead className="min-w-72">空间</TableHead><TableHead className="w-24 text-right">成员</TableHead><TableHead className="w-24 text-right">技能</TableHead><TableHead className="w-24 text-right">已发布</TableHead><TableHead className="w-52">更新时间</TableHead><TableHead className="w-40 text-right">操作</TableHead></TableRow></TableHeader>
      <TableBody>
        {spacesQuery.isLoading ? <TableStateRow colSpan={6}><LoadingState label="正在加载技能空间" /></TableStateRow> : null}
        {spacesQuery.isError ? <TableStateRow colSpan={6} tone="danger"><ErrorAlert>技能空间加载失败</ErrorAlert></TableStateRow> : null}
        {!spacesQuery.isLoading && !spacesQuery.isError && spaces.length === 0 ? <TableStateRow colSpan={6}><EmptyState title="暂无技能空间" /></TableStateRow> : null}
        {spaces.map((space) => <TableRow key={space.spaceId}>
          <TableCell><div className="text-sm font-medium leading-5">{space.name}</div><div className="mt-0.5 max-w-96 truncate text-[13px] leading-5 text-muted-foreground">{space.description || "-"}</div></TableCell>
          <TableCell className="text-right font-mono text-sm">{space.memberCount}</TableCell><TableCell className="text-right font-mono text-sm">{space.skillCount}</TableCell><TableCell className="text-right font-mono text-sm">{space.publishedCount}</TableCell>
          <TableCell className="font-mono text-[13px] text-muted-foreground">{formatDateTime(space.updatedAt)}</TableCell>
          <TableCell className="text-right"><div className="flex justify-end gap-2"><Button aria-label={`管理${space.name}成员授权`} onClick={() => setAuthorizationId(space.spaceId)} size="sm" variant="secondary">成员授权</Button>{canManage ? <Button aria-label={`编辑 ${space.name}`} onClick={() => openEditor(space)} size="sm" variant="secondary"><Edit3 data-icon="inline-start" aria-hidden="true" />编辑</Button> : null}</div></TableCell>
        </TableRow>)}
      </TableBody>
    </DataTableShell>

    <ModalShell open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? "编辑技能空间" : "新建技能空间"} contextLabel="技能中心">
      <form onSubmit={submitSpace}><FieldGroup><Field><FieldLabel htmlFor="skill-space-name">空间名称</FieldLabel><Input id="skill-space-name" maxLength={100} required value={name} onChange={(event) => setName(event.target.value)} /></Field><Field><FieldLabel htmlFor="skill-space-description">说明</FieldLabel><Textarea id="skill-space-description" maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>{saveMutation.isError ? <ErrorAlert>保存失败：{errorText(saveMutation.error)}</ErrorAlert> : null}<Field className="justify-end" orientation="horizontal"><Button type="button" variant="outline" onClick={() => setEditing(undefined)}>取消</Button><Button disabled={saveMutation.isPending || !name.trim()} type="submit" variant="primary">保存</Button></Field></FieldGroup></form>
    </ModalShell>

    <MemberAuthorizationDrawer
      adapter={authorizationAdapter}
      canManage={canManage}
      memberCount={authorizationTarget?.memberCount}
      onChanged={() => void queryClient.invalidateQueries({ queryKey: ["skill-spaces"] })}
      onClose={() => setAuthorizationId(null)}
      open={Boolean(authorizationTarget)}
      permissions={[
        { value: "read", label: "查看空间与技能", required: true },
        { value: "write", label: "上传技能", defaultChecked: true }
      ]}
      resourceId={authorizationTarget?.spaceId ?? ""}
      resourceLabel="技能空间"
      resourceName={authorizationTarget?.name ?? ""}
    />
  </section>;
}

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
