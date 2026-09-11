import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ConfirmDialog,
  DataTableShell,
  DetailDrawer,
  EmptyState,
  ErrorAlert,
  FilterRow,
  FilterSearchField,
  LoadingState,
  ModalShell,
  SuccessAlert,
  TableStateRow
} from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/mcp-admin-ui";

export type AuthorizationMember = {
  userId: string;
  name: string;
  email: string;
  accountStatus: string;
  actions: string[];
  updatedAt: string;
};

export type AuthorizationCandidate = {
  userId: string;
  name: string;
  email: string;
};

export type AuthorizationPage<T> = {
  items: T[];
  meta: { next_cursor: string; has_next: boolean };
};

export type AuthorizationPermission = {
  value: string;
  label: string;
  description?: string;
  required?: boolean;
  defaultChecked?: boolean;
};

export type MemberAuthorizationAdapter = {
  queryKey: string;
  listMembers: (input: { query: string; cursor: string }) => Promise<AuthorizationPage<AuthorizationMember>>;
  listCandidates: (input: { query: string; cursor: string }) => Promise<AuthorizationPage<AuthorizationCandidate>>;
  addMember: (input: { userId: string; actions: string[] }) => Promise<unknown>;
  updateMember: (input: { userId: string; actions: string[] }) => Promise<unknown>;
  removeMember: (userId: string) => Promise<unknown>;
};

export function MemberAuthorizationDrawer({
  open,
  resourceId,
  resourceName,
  resourceLabel,
  memberCount,
  canAdd,
  canUpdate,
  canRemove,
  permissions,
  adapter,
  onClose,
  onChanged
}: {
  open: boolean;
  resourceId: string;
  resourceName: string;
  resourceLabel: string;
  memberCount?: number;
  canAdd: boolean;
  canUpdate: boolean;
  canRemove: boolean;
  permissions: AuthorizationPermission[];
  adapter: MemberAuthorizationAdapter;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const hasActions = canAdd || canUpdate || canRemove;
  const queryClient = useQueryClient();
  const [memberQuery, setMemberQuery] = useState("");
  const debouncedMemberQuery = useDebouncedValue(memberQuery, 300);
  const [memberCursor, setMemberCursor] = useState("");
  const [memberCursorHistory, setMemberCursorHistory] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [candidateOpen, setCandidateOpen] = useState(false);
  const [candidateQuery, setCandidateQuery] = useState("");
  const debouncedCandidateQuery = useDebouncedValue(candidateQuery, 300);
  const [candidateCursor, setCandidateCursor] = useState("");
  const [candidateCursorHistory, setCandidateCursorHistory] = useState<string[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<Record<string, AuthorizationCandidate>>({});
  const [formActions, setFormActions] = useState<string[]>(defaultActions(permissions));
  const [memberToEdit, setMemberToEdit] = useState<AuthorizationMember | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<AuthorizationMember | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setMemberQuery("");
    setMemberCursor("");
    setMemberCursorHistory([]);
    setAddOpen(false);
    setMemberToEdit(null);
    setMemberToRemove(null);
    setNotice(null);
  }, [resourceId]);

  const membersQuery = useQuery({
    queryKey: [adapter.queryKey, resourceId, debouncedMemberQuery, memberCursor],
    queryFn: () => adapter.listMembers({ query: debouncedMemberQuery, cursor: memberCursor }),
    enabled: open && Boolean(resourceId),
    placeholderData: (previous) => previous
  });
  const candidatesQuery = useQuery({
    queryKey: [`${adapter.queryKey}-candidates`, resourceId, debouncedCandidateQuery, candidateCursor],
    queryFn: () => adapter.listCandidates({ query: debouncedCandidateQuery, cursor: candidateCursor }),
    enabled: open && addOpen && Boolean(resourceId),
    placeholderData: (previous) => previous
  });
  const members = membersQuery.data?.items ?? [];
  const candidates = candidatesQuery.data?.items ?? [];
  const selectedCandidateList = useMemo(() => Object.values(selectedCandidates), [selectedCandidates]);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: [adapter.queryKey, resourceId] });
    void queryClient.invalidateQueries({ queryKey: [`${adapter.queryKey}-candidates`, resourceId] });
    onChanged?.();
  }

  const addMutation = useMutation({
    mutationFn: async (input: { candidates: AuthorizationCandidate[]; actions: string[] }) => {
      for (const candidate of input.candidates) {
        await adapter.addMember({ userId: candidate.userId, actions: orderedActions(permissions, input.actions) });
      }
    },
    onSuccess: (_result, input) => {
      setAddOpen(false);
      setCandidateOpen(false);
      setSelectedCandidates({});
      setNotice(`已添加 ${input.candidates.length} 位成员`);
      refresh();
    }
  });
  const updateMutation = useMutation({
    mutationFn: (input: { member: AuthorizationMember; actions: string[] }) => adapter.updateMember({ userId: input.member.userId, actions: orderedActions(permissions, input.actions) }),
    onSuccess: (_result, input) => {
      setMemberToEdit(null);
      setNotice(`“${input.member.name || input.member.email || input.member.userId}”的权限已更新`);
      refresh();
    }
  });
  const removeMutation = useMutation({
    mutationFn: (member: AuthorizationMember) => adapter.removeMember(member.userId),
    onSuccess: (_result, member) => {
      setMemberToRemove(null);
      setNotice(`“${member.name || member.email || member.userId}”的成员授权已删除`);
      refresh();
    }
  });

  function openAdd() {
    addMutation.reset();
    setSelectedCandidates({});
    setCandidateQuery("");
    setCandidateCursor("");
    setCandidateCursorHistory([]);
    setFormActions(defaultActions(permissions));
    setAddOpen(true);
  }

  function openEdit(member: AuthorizationMember) {
    updateMutation.reset();
    setFormActions(member.actions);
    setMemberToEdit(member);
  }

  function toggleCandidate(candidate: AuthorizationCandidate) {
    setSelectedCandidates((current) => {
      const next = { ...current };
      if (next[candidate.userId]) delete next[candidate.userId];
      else next[candidate.userId] = candidate;
      return next;
    });
  }

  function toggleAction(action: string, checked: boolean) {
    setFormActions((current) => checked
      ? current.includes(action) ? current : [...current, action]
      : current.filter((item) => item !== action));
  }

  function closeDrawer() {
    if (addMutation.isPending || updateMutation.isPending || removeMutation.isPending) return;
    setAddOpen(false);
    setMemberToEdit(null);
    setMemberToRemove(null);
    onClose();
  }

  return (
    <>
      <DetailDrawer
        contextLabel="成员授权"
        onClose={closeDrawer}
        open={open}
        subtitle={`${resourceLabel} · 账户权限管理`}
        title={resourceName || "成员授权"}
        titleAction={<Badge variant="muted">{memberCount ?? members.length} 位成员</Badge>}
      >
        {notice ? <SuccessAlert>{notice}</SuccessAlert> : null}
        <FilterRow compact>
          <FilterSearchField
            aria-label="搜索授权成员"
            placeholder="搜索姓名、邮箱或账号 ID"
            value={memberQuery}
            onChange={(event) => {
              setMemberQuery(event.target.value);
              setMemberCursor("");
              setMemberCursorHistory([]);
            }}
          />
          {canAdd ? (
            <Button onClick={openAdd} size="sm">
              <Plus data-icon="inline-start" aria-hidden="true" />
              添加成员授权
            </Button>
          ) : null}
        </FilterRow>
        <DataTableShell dense minWidth={620}>
          <TableHeader>
            <TableRow>
              <TableHead>账户</TableHead>
              <TableHead>权限</TableHead>
              <TableHead>更新时间</TableHead>
              {hasActions ? <TableHead className="text-right">操作</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {membersQuery.isLoading ? <TableStateRow colSpan={hasActions ? 4 : 3}><LoadingState label="正在加载授权成员" /></TableStateRow> : null}
            {membersQuery.isError ? <TableStateRow colSpan={hasActions ? 4 : 3} tone="danger"><ErrorAlert>成员授权加载失败：{errorText(membersQuery.error)}</ErrorAlert></TableStateRow> : null}
            {!membersQuery.isLoading && !membersQuery.isError && members.length === 0 ? (
              <TableStateRow colSpan={hasActions ? 4 : 3}>
                <EmptyState title={memberQuery ? "暂无匹配成员" : "暂无成员授权"} description={memberQuery ? "请调整搜索条件。" : "添加成员后即可配置当前资源的访问权限。"} />
              </TableStateRow>
            ) : null}
            {!membersQuery.isError ? members.map((member) => (
              <TableRow key={member.userId}>
                <TableCell className="max-w-64">
                  <span className="block truncate font-medium" title={member.name || member.email}>{member.name || member.email || member.userId}</span>
                  <span className="block truncate text-xs text-muted-foreground" title={member.email}>{member.email || "-"}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground" title={member.userId}>{member.userId}</span>
                </TableCell>
                <TableCell><div className="flex flex-wrap gap-1">{member.actions.map((action) => <Badge key={action} variant="muted">{permissionLabel(permissions, action)}</Badge>)}</div></TableCell>
                <TableCell className="font-mono text-xs">{formatDateTime(member.updatedAt)}</TableCell>
                {hasActions ? (
                  <TableCell className="text-right">
                    <TooltipProvider delayDuration={150}>
                      <div className="flex justify-end gap-1">
                        {canUpdate ? <Tooltip>
                          <TooltipTrigger asChild><Button aria-label={`编辑${member.name || member.userId}成员授权`} onClick={() => openEdit(member)} size="icon" variant="ghost"><Pencil aria-hidden="true" /></Button></TooltipTrigger>
                          <TooltipContent>编辑权限</TooltipContent>
                        </Tooltip> : null}
                        {canRemove ? <Tooltip>
                          <TooltipTrigger asChild><Button aria-label={`删除${member.name || member.userId}成员授权`} onClick={() => { removeMutation.reset(); setMemberToRemove(member); }} size="icon" variant="ghost"><Trash2 aria-hidden="true" /></Button></TooltipTrigger>
                          <TooltipContent>删除授权</TooltipContent>
                        </Tooltip> : null}
                      </div>
                    </TooltipProvider>
                  </TableCell>
                ) : null}
              </TableRow>
            )) : null}
          </TableBody>
        </DataTableShell>
        <PageButtons
          currentCursor={memberCursor}
          cursorHistory={memberCursorHistory}
          fetching={membersQuery.isFetching}
          hasNext={Boolean(membersQuery.data?.meta.has_next)}
          nextCursor={membersQuery.data?.meta.next_cursor ?? ""}
          setCursor={setMemberCursor}
          setCursorHistory={setMemberCursorHistory}
        />
      </DetailDrawer>

      <ModalShell open={addOpen} title="添加成员授权" subtitle={`为所选账户配置“${resourceName}”的访问权限。`} onClose={() => !addMutation.isPending && setAddOpen(false)}>
        <form className="flex flex-col gap-5" onSubmit={(event) => {
          event.preventDefault();
          if (selectedCandidateList.length > 0) addMutation.mutate({ candidates: selectedCandidateList, actions: formActions });
        }}>
          {addMutation.isError ? <ErrorAlert>添加失败：{errorText(addMutation.error)}</ErrorAlert> : null}
          {candidatesQuery.isError ? <ErrorAlert>候选成员加载失败：{errorText(candidatesQuery.error)}</ErrorAlert> : null}
          <FieldGroup>
            <Field>
              <FieldLabel>成员</FieldLabel>
              <Popover open={candidateOpen} onOpenChange={setCandidateOpen}>
                <PopoverTrigger asChild>
                  <Button aria-label="选择授权成员" className="w-full justify-between" disabled={addMutation.isPending} variant="outline">
                    {selectedCandidateList.length > 0 ? `已选择 ${selectedCandidateList.length} 位成员` : "搜索并选择成员"}
                    <ChevronsUpDown data-icon="inline-end" aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
                  <Command shouldFilter={false}>
                    <CommandInput aria-label="搜索候选成员" placeholder="搜索姓名、邮箱或账号 ID" value={candidateQuery} onValueChange={(value) => {
                      setCandidateQuery(value);
                      setCandidateCursor("");
                      setCandidateCursorHistory([]);
                    }} />
                    <CommandList className="max-h-72">
                      <CommandEmpty>{candidatesQuery.isFetching ? "正在查询成员..." : "没有匹配的可添加成员"}</CommandEmpty>
                      <CommandGroup heading="可添加成员">
                        {candidates.map((candidate) => {
                          const selected = Boolean(selectedCandidates[candidate.userId]);
                          return (
                            <CommandItem key={candidate.userId} onSelect={() => toggleCandidate(candidate)} value={candidate.userId}>
                              <Checkbox aria-hidden="true" checked={selected} className="pointer-events-none" tabIndex={-1} />
                              <div className="min-w-0 flex-1">
                                <span className="block truncate font-medium">{candidate.name || candidate.email || candidate.userId}</span>
                                <span className="block truncate text-xs text-muted-foreground">{candidate.email} · {candidate.userId}</span>
                              </div>
                              {selected ? <Check aria-hidden="true" /> : null}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                    <div className="flex items-center justify-between border-t p-2">
                      <span className="text-xs text-muted-foreground">已选 {selectedCandidateList.length} 位</span>
                      <PageButtons
                        compact
                        currentCursor={candidateCursor}
                        cursorHistory={candidateCursorHistory}
                        fetching={candidatesQuery.isFetching}
                        hasNext={Boolean(candidatesQuery.data?.meta.has_next)}
                        nextCursor={candidatesQuery.data?.meta.next_cursor ?? ""}
                        setCursor={setCandidateCursor}
                        setCursorHistory={setCandidateCursorHistory}
                      />
                    </div>
                  </Command>
                </PopoverContent>
              </Popover>
              <FieldDescription>成员邮箱完整显示，可跨搜索和分页继续选择。</FieldDescription>
            </Field>
            <PermissionFields actions={formActions} disabled={addMutation.isPending} permissions={permissions} onToggle={toggleAction} />
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button disabled={addMutation.isPending} onClick={() => setAddOpen(false)} type="button" variant="outline">取消</Button>
            <Button disabled={addMutation.isPending || selectedCandidateList.length === 0} type="submit">{selectedCandidateList.length > 0 ? `添加 ${selectedCandidateList.length} 位成员` : "添加成员"}</Button>
          </div>
        </form>
      </ModalShell>

      <ModalShell open={Boolean(memberToEdit)} title="编辑成员授权" subtitle={memberToEdit ? `${memberToEdit.name || memberToEdit.email || memberToEdit.userId} · ${memberToEdit.email}` : undefined} onClose={() => !updateMutation.isPending && setMemberToEdit(null)}>
        <form className="flex flex-col gap-5" onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (memberToEdit) updateMutation.mutate({ member: memberToEdit, actions: formActions });
        }}>
          {updateMutation.isError ? <ErrorAlert>更新失败：{errorText(updateMutation.error)}</ErrorAlert> : null}
          <FieldGroup>
            <Field>
              <FieldLabel>账号 ID</FieldLabel>
              <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">{memberToEdit?.userId}</div>
            </Field>
            <PermissionFields actions={formActions} disabled={updateMutation.isPending} permissions={permissions} onToggle={toggleAction} />
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button disabled={updateMutation.isPending} onClick={() => setMemberToEdit(null)} type="button" variant="outline">取消</Button>
            <Button disabled={updateMutation.isPending} type="submit">保存</Button>
          </div>
        </form>
      </ModalShell>

      <ConfirmDialog
        confirmLabel={removeMutation.isPending ? "删除中..." : "确认删除"}
        description={`删除后，“${memberToRemove?.name || memberToRemove?.email || "该成员"}”将失去当前${resourceLabel}的访问权限。`}
        error={removeMutation.isError ? `删除失败：${errorText(removeMutation.error)}` : undefined}
        onClose={() => !removeMutation.isPending && setMemberToRemove(null)}
        onConfirm={() => memberToRemove && removeMutation.mutate(memberToRemove)}
        open={Boolean(memberToRemove)}
        pending={removeMutation.isPending}
        title="删除成员授权"
        variant="destructive"
      />
    </>
  );
}

function PermissionFields({ actions, permissions, disabled, onToggle }: {
  actions: string[];
  permissions: AuthorizationPermission[];
  disabled: boolean;
  onToggle: (action: string, checked: boolean) => void;
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">权限</FieldLegend>
      <FieldGroup className="gap-3" data-slot="checkbox-group">
        {permissions.map((permission) => (
          <Field data-disabled={permission.required || disabled || undefined} key={permission.value} orientation="horizontal">
            <Checkbox
              checked={permission.required || actions.includes(permission.value)}
              disabled={permission.required || disabled}
              id={`member-permission-${permission.value}`}
              onCheckedChange={(checked) => onToggle(permission.value, checked === true)}
            />
            <FieldContent>
              <FieldLabel className="font-normal" htmlFor={`member-permission-${permission.value}`}>{permission.label}</FieldLabel>
              {permission.description ? <FieldDescription>{permission.description}</FieldDescription> : null}
            </FieldContent>
          </Field>
        ))}
      </FieldGroup>
    </FieldSet>
  );
}

function PageButtons({ currentCursor, cursorHistory, fetching, hasNext, nextCursor, setCursor, setCursorHistory, compact = false }: {
  currentCursor: string;
  cursorHistory: string[];
  fetching: boolean;
  hasNext: boolean;
  nextCursor: string;
  setCursor: (value: string) => void;
  setCursorHistory: React.Dispatch<React.SetStateAction<string[]>>;
  compact?: boolean;
}) {
  if (cursorHistory.length === 0 && !hasNext) return null;
  return (
    <div className="flex justify-end gap-2">
      <Button disabled={cursorHistory.length === 0 || fetching} onClick={() => setCursorHistory((current) => {
        const next = [...current];
        setCursor(next.pop() ?? "");
        return next;
      })} size={compact ? "sm" : undefined} variant="outline">上一页</Button>
      <Button disabled={!hasNext || fetching} onClick={() => {
        if (!nextCursor) return;
        setCursorHistory((current) => [...current, currentCursor]);
        setCursor(nextCursor);
      }} size={compact ? "sm" : undefined} variant="outline">下一页</Button>
    </div>
  );
}

function defaultActions(permissions: AuthorizationPermission[]) {
  return permissions.filter((permission) => permission.required || permission.defaultChecked).map((permission) => permission.value);
}

function orderedActions(permissions: AuthorizationPermission[], actions: string[]) {
  return permissions.filter((permission) => permission.required || actions.includes(permission.value)).map((permission) => permission.value);
}

function permissionLabel(permissions: AuthorizationPermission[], action: string) {
  return permissions.find((permission) => permission.value === action)?.label ?? action;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "请求失败";
}

function useDebouncedValue(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}
