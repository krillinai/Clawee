import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { GitMerge, KeyRound, Pencil, Plus, Shield } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAdminPermission } from "@/components/admin-permissions";
import { DataTableShell, ErrorAlert, MetricCard, ModalShell, PageHeader, TableStateRow } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Account, AccountStatus } from "@/lib/accounts-api";
import { createAccount, listAccounts, mergeAccounts, resetAccountPassword, updateAccountName, updateAccountStatus } from "@/lib/accounts-api";
import { mcpStatusLabel } from "@/lib/mcp-admin-ui";
import { assignAccountRole, listAccountRoles, listRoles, permissions, removeAccountRole } from "@/lib/rbac-api";

const accountsKey = ["accounts"] as const;

export function UsersPage() {
  const canCreateAccount = useAdminPermission(permissions.accountCreate);
  const canUpdateAccountName = useAdminPermission(permissions.accountUpdateName);
  const canUpdateAccountStatus = useAdminPermission(permissions.accountUpdateStatus);
  const canResetAccountPassword = useAdminPermission(permissions.accountResetPassword);
  const canMergeAccounts = useAdminPermission(permissions.accountMerge);
  const canReadRoles = useAdminPermission(permissions.rbacRead);
  const canUpdateAccountRoles = useAdminPermission(permissions.rbacAccountRoleUpdate);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ email: "", name: "", password: "", status: "active" as AccountStatus });
  const [nameAccount, setNameAccount] = useState<Account | null>(null);
  const [accountName, setAccountName] = useState("");
  const [passwordAccount, setPasswordAccount] = useState<Account | null>(null);
  const [password, setPassword] = useState("");
  const [roleAccount, setRoleAccount] = useState<Account | null>(null);
  const [selectedRoleIDs, setSelectedRoleIDs] = useState<string[]>([]);
  const [mergeAccount, setMergeAccount] = useState<Account | null>(null);
  const [mergeTargetUserID, setMergeTargetUserID] = useState("");
  const [mergeReason, setMergeReason] = useState("");

  const accountsQuery = useQuery({ queryKey: accountsKey, queryFn: listAccounts });
  const rolesQuery = useQuery({ queryKey: ["rbac", "roles"], queryFn: listRoles, enabled: canReadRoles });
  const assignedRolesQuery = useQuery({
    queryKey: ["rbac", "account-roles", roleAccount?.userId],
    queryFn: () => listAccountRoles(roleAccount?.userId ?? ""),
    enabled: Boolean(roleAccount)
  });
  useEffect(() => {
    setSelectedRoleIDs((assignedRolesQuery.data ?? []).map((role) => role.roleId));
  }, [assignedRolesQuery.data]);

  const createMutation = useMutation({
    mutationFn: () => createAccount({
      email: createForm.email.trim(), name: createForm.name.trim(),
      password: createForm.password, status: createForm.status
    }),
    onSuccess: async () => {
      setCreateOpen(false);
      setCreateForm({ email: "", name: "", password: "", status: "active" });
      await queryClient.invalidateQueries({ queryKey: accountsKey });
    }
  });
  const statusMutation = useMutation({
    mutationFn: ({ account, status }: { account: Account; status: AccountStatus }) => updateAccountStatus(account.userId, status),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: accountsKey })
  });
  const nameMutation = useMutation({
    mutationFn: () => updateAccountName(nameAccount?.userId ?? "", accountName.trim()),
    onSuccess: async () => {
      setNameAccount(null);
      setAccountName("");
      await queryClient.invalidateQueries({ queryKey: accountsKey });
    }
  });
  const passwordMutation = useMutation({
    mutationFn: () => resetAccountPassword(passwordAccount?.userId ?? "", password),
    onSuccess: () => {
      setPasswordAccount(null);
      setPassword("");
    }
  });
  const roleMutation = useMutation({
    mutationFn: async () => {
      if (!roleAccount) return;
      const current = new Set((assignedRolesQuery.data ?? []).map((role) => role.roleId));
      const selected = new Set(selectedRoleIDs);
      await Promise.all([
        ...selectedRoleIDs.filter((roleID) => !current.has(roleID)).map((roleID) => assignAccountRole(roleAccount.userId, roleID)),
        ...(assignedRolesQuery.data ?? []).filter((role) => !selected.has(role.roleId)).map((role) => removeAccountRole(roleAccount.userId, role.roleId))
      ]);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["rbac", "account-roles", roleAccount?.userId] });
      setRoleAccount(null);
    }
  });
  const mergeMutation = useMutation({
    mutationFn: () => mergeAccounts({
      sourceUserId: mergeAccount?.userId ?? "",
      targetUserId: mergeTargetUserID,
      reason: mergeReason.trim()
    }),
    onSuccess: async () => {
      setMergeAccount(null);
      setMergeTargetUserID("");
      setMergeReason("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: accountsKey }),
        queryClient.invalidateQueries({ queryKey: ["mcp-agents"] }),
        queryClient.invalidateQueries({ queryKey: ["office-agent-activity"] }),
        queryClient.invalidateQueries({ queryKey: ["rbac"] })
      ]);
    }
  });

  const accounts = accountsQuery.data ?? [];
  const metrics = {
    total: accounts.length,
    active: accounts.filter((account) => account.status === "active").length,
    disabled: accounts.filter((account) => account.status === "disabled").length,
    boundAgents: accounts.filter((account) => account.agent).length
  };
  const activeMergeTargets = accounts.filter((account) => account.status === "active" && account.userId !== mergeAccount?.userId);

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createForm.name.trim()) return;
    createMutation.mutate();
  }
  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length >= 8) passwordMutation.mutate();
  }
  function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accountName.trim() && accountName.trim() !== nameAccount?.name) nameMutation.mutate();
  }
  function openMerge(account: Account) {
    mergeMutation.reset();
    setMergeAccount(account);
    setMergeTargetUserID(activeMergeTargets[0]?.userId ?? accounts.find((item) => item.status === "active")?.userId ?? "");
    setMergeReason("");
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="账号管理"
        actions={canCreateAccount ? <Button onClick={() => setCreateOpen(true)}><Plus data-icon="inline-start" />新增账号</Button> : undefined}
      >
        管理账号昵称、状态、密码和后台角色。所有启用账号都可使用前台应用，后台访问由角色权限单独决定。
      </PageHeader>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="账号总数" value={accountsQuery.isLoading ? "..." : metrics.total} />
        <MetricCard label="启用" value={accountsQuery.isLoading ? "..." : metrics.active} />
        <MetricCard label="停用" value={accountsQuery.isLoading ? "..." : metrics.disabled} />
        <MetricCard label="已绑定 Agent" value={accountsQuery.isLoading ? "..." : metrics.boundAgents} />
      </section>

      {accountsQuery.isError ? <ErrorAlert>{accountsQuery.error.message}</ErrorAlert> : null}
      {statusMutation.isError ? <ErrorAlert>{statusMutation.error.message}</ErrorAlert> : null}
      <DataTableShell dense minWidth={1100}>
        <TableHeader>
          <TableRow>
            <TableHead>账号</TableHead>
            <TableHead>后台角色</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>绑定 Agent</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accountsQuery.isLoading ? <TableStateRow colSpan={5}>账号加载中</TableStateRow> : null}
          {!accountsQuery.isLoading && !accountsQuery.isError && accounts.length === 0 ? <TableStateRow colSpan={5}>暂无账号</TableStateRow> : null}
          {accounts.map((account) => (
            <TableRow key={account.userId}>
              <TableCell><div className="flex flex-col gap-1"><strong>{account.email}</strong><span className="text-xs text-muted-foreground">{account.name || "-"}</span></div></TableCell>
              <TableCell><AccountRolesCell accountID={account.userId} canRead={canReadRoles} /></TableCell>
              <TableCell><Badge variant={account.status === "active" ? "default" : "muted"}>{account.status === "active" ? "启用" : "停用"}</Badge></TableCell>
              <TableCell>{account.agent ? <div className="flex flex-col gap-1"><span className="font-mono text-xs">{account.agent.agentId}</span><span className="text-xs text-muted-foreground">{mcpStatusLabel(account.agent.status)}</span></div> : <span className="text-muted-foreground">未绑定</span>}</TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  {canUpdateAccountRoles && canReadRoles ? <Button onClick={() => setRoleAccount(account)} size="sm" variant="outline"><Shield data-icon="inline-start" />角色</Button> : null}
                  {canUpdateAccountName ? <Button onClick={() => { setNameAccount(account); setAccountName(account.name); nameMutation.reset(); }} size="sm" variant="outline"><Pencil data-icon="inline-start" />修改昵称</Button> : null}
                  {canResetAccountPassword ? <Button onClick={() => { setPasswordAccount(account); setPassword(""); }} size="sm" variant="outline"><KeyRound data-icon="inline-start" />重置密码</Button> : null}
                  {canMergeAccounts && account.status === "disabled" ? <Button onClick={() => openMerge(account)} size="sm" variant="outline"><GitMerge data-icon="inline-start" />合并</Button> : null}
                  {canUpdateAccountStatus ? (
                    <Button
                      disabled={statusMutation.isPending}
                      onClick={() => statusMutation.mutate({ account, status: account.status === "active" ? "disabled" : "active" })}
                      size="sm"
                      variant={account.status === "active" ? "destructive" : "secondary"}
                    >
                      {account.status === "active" ? "禁用" : "启用"}
                    </Button>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DataTableShell>

      <ModalShell open={createOpen} onClose={() => setCreateOpen(false)} contextLabel="账号" title="新增账号">
        <form onSubmit={submitCreate}>
          <FieldGroup>
            <Field><FieldLabel htmlFor="account-email">邮箱</FieldLabel><Input id="account-email" aria-label="邮箱" required type="email" value={createForm.email} onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))} /></Field>
            <Field><FieldLabel htmlFor="account-name">名称</FieldLabel><Input id="account-name" aria-label="名称" required value={createForm.name} onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))} /></Field>
            <Field><FieldLabel htmlFor="account-password">初始密码</FieldLabel><Input id="account-password" aria-label="初始密码" minLength={8} required type="password" value={createForm.password} onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))} /></Field>
            <Field><FieldLabel htmlFor="account-status">状态</FieldLabel><NativeSelect id="account-status" aria-label="状态" value={createForm.status} onChange={(event) => setCreateForm((current) => ({ ...current, status: event.target.value as AccountStatus }))}><option value="active">启用</option><option value="disabled">停用</option></NativeSelect></Field>
            {createMutation.isError ? <ErrorAlert>{createMutation.error.message}</ErrorAlert> : null}
            <Field className="justify-end" orientation="horizontal"><Button onClick={() => setCreateOpen(false)} type="button" variant="outline">取消</Button><Button disabled={createMutation.isPending || !createForm.name.trim()} type="submit">创建账号</Button></Field>
          </FieldGroup>
        </form>
      </ModalShell>

      <ModalShell open={Boolean(nameAccount)} onClose={() => setNameAccount(null)} contextLabel="账号" title="修改账户昵称" subtitle={nameAccount?.email}>
        <form onSubmit={submitName}>
          <FieldGroup>
            <Field><FieldLabel htmlFor="account-edit-name">昵称</FieldLabel><Input id="account-edit-name" required value={accountName} onChange={(event) => setAccountName(event.target.value)} /></Field>
            {nameMutation.isError ? <ErrorAlert>{nameMutation.error.message}</ErrorAlert> : null}
            <Field className="justify-end" orientation="horizontal"><Button onClick={() => setNameAccount(null)} type="button" variant="outline">取消</Button><Button disabled={nameMutation.isPending || !accountName.trim() || accountName.trim() === nameAccount?.name} type="submit">保存昵称</Button></Field>
          </FieldGroup>
        </form>
      </ModalShell>

      <ModalShell open={Boolean(passwordAccount)} onClose={() => setPasswordAccount(null)} contextLabel="账号" title="重置密码" subtitle={passwordAccount?.email}>
        <form onSubmit={submitPassword}>
          <FieldGroup>
            <Field><FieldLabel htmlFor="new-password">新密码</FieldLabel><Input id="new-password" aria-label="新密码" minLength={8} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /><FieldDescription>至少 8 位，保存后该账号现有会话失效。</FieldDescription></Field>
            {passwordMutation.isError ? <ErrorAlert>{passwordMutation.error.message}</ErrorAlert> : null}
            <Field className="justify-end" orientation="horizontal"><Button onClick={() => setPasswordAccount(null)} type="button" variant="outline">取消</Button><Button disabled={passwordMutation.isPending || password.length < 8} type="submit">确认重置</Button></Field>
          </FieldGroup>
        </form>
      </ModalShell>

      <ModalShell open={Boolean(roleAccount)} onClose={() => setRoleAccount(null)} contextLabel="角色权限" title="管理后台角色" subtitle={roleAccount?.email}>
        <FieldGroup data-slot="checkbox-group">
          {assignedRolesQuery.isLoading || rolesQuery.isLoading ? <span className="text-sm text-muted-foreground">角色加载中</span> : null}
          {(rolesQuery.data ?? []).map((role) => (
            <Field key={role.roleId} orientation="horizontal">
              <Checkbox id={`account-role-${role.roleId}`} checked={selectedRoleIDs.includes(role.roleId)} onCheckedChange={(checked) => setSelectedRoleIDs((current) => checked === true ? [...new Set([...current, role.roleId])] : current.filter((item) => item !== role.roleId))} />
              <FieldContent><FieldLabel htmlFor={`account-role-${role.roleId}`}>{role.name}</FieldLabel><FieldDescription>{role.code}{role.isSystem ? " · 系统内置" : ""}</FieldDescription></FieldContent>
            </Field>
          ))}
          {roleMutation.isError ? <ErrorAlert>{roleMutation.error.message}</ErrorAlert> : null}
          <Field className="justify-end" orientation="horizontal"><Button onClick={() => setRoleAccount(null)} variant="outline">取消</Button><Button disabled={roleMutation.isPending} onClick={() => roleMutation.mutate()}>保存角色</Button></Field>
        </FieldGroup>
      </ModalShell>

      <ModalShell open={Boolean(mergeAccount)} onClose={() => setMergeAccount(null)} contextLabel="账号治理" title="合并账号" subtitle={mergeAccount?.email}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (mergeTargetUserID && mergeReason.trim()) mergeMutation.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="account-merge-target">目标账号</FieldLabel>
              <NativeSelect id="account-merge-target" value={mergeTargetUserID} onChange={(event) => setMergeTargetUserID(event.target.value)}>
                <option value="">选择启用账号</option>
                {activeMergeTargets.map((account) => <option key={account.userId} value={account.userId}>{account.name || account.email} ({account.email})</option>)}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="account-merge-reason">合并原因</FieldLabel>
              <Input id="account-merge-reason" maxLength={500} required value={mergeReason} onChange={(event) => setMergeReason(event.target.value)} />
              <FieldDescription>源账号将被删除；现有 MCP Token 和 Agent 授权保持不变，目标账号将立即继承。</FieldDescription>
            </Field>
            {mergeMutation.isError ? <ErrorAlert>{mergeMutation.error.message}</ErrorAlert> : null}
            <Field className="justify-end" orientation="horizontal">
              <Button onClick={() => setMergeAccount(null)} type="button" variant="outline">取消</Button>
              <Button disabled={mergeMutation.isPending || !mergeTargetUserID || !mergeReason.trim()} type="submit">确认合并</Button>
            </Field>
          </FieldGroup>
        </form>
      </ModalShell>
    </div>
  );
}

function AccountRolesCell({ accountID, canRead }: { accountID: string; canRead: boolean }) {
  const query = useQuery({ queryKey: ["rbac", "account-roles", accountID], queryFn: () => listAccountRoles(accountID), enabled: canRead });
  if (!canRead) return <span className="text-xs text-muted-foreground">-</span>;
  if (query.isLoading) return <span className="text-xs text-muted-foreground">加载中</span>;
  if (query.isError || !query.data?.length) return <span className="text-xs text-muted-foreground">无后台角色</span>;
  return <div className="flex flex-wrap gap-1">{query.data.map((role) => <Badge key={role.roleId} variant={role.isSystem ? "default" : "muted"}>{role.roleName}</Badge>)}</div>;
}
