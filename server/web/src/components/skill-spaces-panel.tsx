import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Edit3, Settings2, UserPlus } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import { DataTableShell, DetailDrawer, EmptyState, ErrorAlert, LoadingState, ModalShell, TableStateRow } from "@/components/governance-ui";
import { MemberAuthorizationDrawer, type MemberAuthorizationAdapter } from "@/components/member-authorization";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  addSkillSpaceMember,
  createSkillSpace,
  listSkillSpaceCandidates,
  listSkillSpaceMembers,
  listSkillSpaces,
  listSkillSpaceApproverCandidates,
  setSkillSpaceApprover,
  removeSkillSpaceMember,
  updateSkillSpace,
  updateSkillSpaceMember,
  type SkillSpace
} from "@/lib/skillhub-api";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { trimInput } from "@/lib/text";

export function SkillSpacesPanel({
  canCreate,
  canCreateMembers,
  canDeleteMembers,
  canUpdate,
  canUpdateMembers,
  onOpenSpace
}: {
  canCreate: boolean;
  canCreateMembers: boolean;
  canDeleteMembers: boolean;
  canUpdate: boolean;
  canUpdateMembers: boolean;
  onOpenSpace: (spaceId: string) => void;
}) {
  const queryClient = useQueryClient();
  const spacesQuery = useQuery({ queryKey: ["skill-spaces"], queryFn: listSkillSpaces });
  const [editing, setEditing] = useState<SkillSpace | null | undefined>(undefined);
  const [authorizationId, setAuthorizationId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [approverTarget, setApproverTarget] = useState<SkillSpace | null>(null);
  const [approverUserId, setApproverUserId] = useState("none");
  const [approvalEnabled, setApprovalEnabled] = useState(false);
  const candidatesQuery = useQuery({ queryKey: ["skill-space-approver-candidates"], queryFn: listSkillSpaceApproverCandidates, enabled: Boolean(approverTarget) });
  const approverMutation = useMutation({
    mutationFn: () => setSkillSpaceApprover(approverTarget!.spaceId, approvalEnabled ? approverUserId : ""),
    onSuccess: () => {
      setApproverTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["skill-spaces"] });
      void queryClient.invalidateQueries({ queryKey: ["skill"] });
    }
  });

  const saveMutation = useMutation({
    mutationFn: () => editing
      ? updateSkillSpace({ spaceId: editing.spaceId, name: trimInput(name), description: trimInput(description) })
      : createSkillSpace({ name: trimInput(name), description: trimInput(description) }),
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
    if (trimInput(name)) saveMutation.mutate();
  }

  return <section aria-label="技能空间" className="grid gap-5">
    {canCreate ? (
      <div className="flex justify-end">
        <Button onClick={() => openEditor(null)} variant="primary"><UserPlus data-icon="inline-start" aria-hidden="true" />新建空间</Button>
      </div>
    ) : null}
    <DataTableShell minWidth={860}>
      <TableHeader><TableRow><TableHead className="min-w-72">空间</TableHead><TableHead className="min-w-32">审批人</TableHead><TableHead className="w-24 text-right">成员</TableHead><TableHead className="w-24 text-right">技能</TableHead><TableHead className="w-24 text-right">已发布</TableHead><TableHead className="w-52">更新时间</TableHead><TableHead className="min-w-72 text-right">操作</TableHead></TableRow></TableHeader>
      <TableBody>
        {spacesQuery.isLoading ? <TableStateRow colSpan={7}><LoadingState label="正在加载技能空间" /></TableStateRow> : null}
        {spacesQuery.isError ? <TableStateRow colSpan={7} tone="danger"><ErrorAlert>技能空间加载失败</ErrorAlert></TableStateRow> : null}
        {!spacesQuery.isLoading && !spacesQuery.isError && spaces.length === 0 ? <TableStateRow colSpan={7}><EmptyState title="暂无技能空间" /></TableStateRow> : null}
        {spaces.map((space) => <TableRow key={space.spaceId}>
          <TableCell><div className="text-sm font-medium leading-5">{space.name}</div><div className="mt-0.5 max-w-96 truncate text-[13px] leading-5 text-muted-foreground">{space.description || "-"}</div></TableCell>
          <TableCell>{space.approverUserId ? space.approverName || space.approverUserId : "无需审批"}</TableCell>
          <TableCell className="text-right font-mono text-sm">{space.memberCount}</TableCell><TableCell className="text-right font-mono text-sm">{space.skillCount}</TableCell><TableCell className="text-right font-mono text-sm">{space.publishedCount}</TableCell>
          <TableCell className="font-mono text-[13px] text-muted-foreground">{formatDateTime(space.updatedAt)}</TableCell>
          <TableCell className="text-right"><div className="flex justify-end gap-2"><Button aria-label={`查看 ${space.name} Skill`} onClick={() => onOpenSpace(space.spaceId)} size="sm" variant="secondary">查看 Skill</Button><Button aria-label={`管理${space.name}成员授权`} onClick={() => setAuthorizationId(space.spaceId)} size="sm" variant="secondary">成员授权</Button>{canUpdate ? <><Button aria-label={`设置 ${space.name}`} onClick={() => { setApproverTarget(space); setApprovalEnabled(Boolean(space.approverUserId)); setApproverUserId(space.approverUserId || "none"); approverMutation.reset(); }} size="sm" variant="secondary"><Settings2 data-icon="inline-start" aria-hidden="true" />设置</Button><Button aria-label={`编辑 ${space.name}`} onClick={() => openEditor(space)} size="sm" variant="secondary"><Edit3 data-icon="inline-start" aria-hidden="true" />编辑</Button></> : null}</div></TableCell>
        </TableRow>)}
      </TableBody>
    </DataTableShell>

    <ModalShell open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? "编辑技能空间" : "新建技能空间"} contextLabel="技能中心">
      <form onSubmit={submitSpace}><FieldGroup><Field><FieldLabel htmlFor="skill-space-name">空间名称</FieldLabel><Input id="skill-space-name" maxLength={100} required value={name} onChange={(event) => setName(event.target.value)} /></Field><Field><FieldLabel htmlFor="skill-space-description">说明</FieldLabel><Textarea id="skill-space-description" maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>{saveMutation.isError ? <ErrorAlert>保存失败：{errorText(saveMutation.error)}</ErrorAlert> : null}<Field className="justify-end" orientation="horizontal"><Button type="button" variant="outline" onClick={() => setEditing(undefined)}>取消</Button><Button disabled={saveMutation.isPending || !trimInput(name)} type="submit" variant="primary">保存</Button></Field></FieldGroup></form>
    </ModalShell>

    <DetailDrawer open={Boolean(approverTarget)} onClose={() => { if (!approverMutation.isPending) setApproverTarget(null); }} title="空间设置" subtitle={approverTarget?.name ?? ""} contextLabel="技能中心">
      <form onSubmit={(event) => { event.preventDefault(); approverMutation.mutate(); }}>
        <FieldGroup>
          <Field orientation="horizontal"><Checkbox id="skill-space-approval" checked={approvalEnabled} onCheckedChange={(checked) => setApprovalEnabled(checked === true)} /><FieldLabel htmlFor="skill-space-approval">开启审批</FieldLabel></Field>
          {approvalEnabled ? <Field><FieldLabel htmlFor="skill-space-approver">空间技能审批人</FieldLabel>
            <Select value={approverUserId} onValueChange={setApproverUserId}>
              <SelectTrigger id="skill-space-approver" disabled={candidatesQuery.isLoading || candidatesQuery.isError}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">请选择审批人</SelectItem>
                {approverTarget?.approverUserId && !candidatesQuery.data?.some((candidate) => candidate.userId === approverTarget.approverUserId) ? <SelectItem value={approverTarget.approverUserId} disabled>{approverTarget.approverName || approverTarget.approverUserId}（不可用）</SelectItem> : null}
                {candidatesQuery.data?.map((candidate) => <SelectItem key={candidate.userId} value={candidate.userId}>{candidate.name} · {candidate.email}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field> : null}
          {approvalEnabled && candidatesQuery.isError ? <ErrorAlert>审批人列表加载失败</ErrorAlert> : null}
          {approverMutation.isError ? <ErrorAlert>保存失败：{errorText(approverMutation.error)}</ErrorAlert> : null}
          <Field className="justify-end" orientation="horizontal"><Button disabled={approverMutation.isPending} type="button" variant="outline" onClick={() => setApproverTarget(null)}>取消</Button><Button disabled={approverMutation.isPending || (approvalEnabled && (approverUserId === "none" || candidatesQuery.isLoading || candidatesQuery.isError))} type="submit" variant="primary">保存</Button></Field>
        </FieldGroup>
      </form>
    </DetailDrawer>

    <MemberAuthorizationDrawer
      adapter={authorizationAdapter}
      canAdd={canCreateMembers}
      canRemove={canDeleteMembers}
      canUpdate={canUpdateMembers}
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
