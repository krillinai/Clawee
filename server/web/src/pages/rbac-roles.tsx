import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Shield, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAdminPermission } from "@/components/admin-permissions";
import { RolePermissionPicker } from "@/components/role-permission-picker";
import { ConfirmDialog, DataTableShell, ErrorAlert, ModalShell, PageHeader, PageShell, TableStateRow } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createRole, listPermissions, listRoles, permissions, removeRole, updateRole, type Role } from "@/lib/rbac-api";
import { APIError } from "@/lib/api";
import { trimInput } from "@/lib/text";

type RoleForm = { roleId: string; name: string; permissionCodes: string[] };
const emptyForm: RoleForm = { roleId: "", name: "", permissionCodes: [] };

export function RBACRolesPage() {
  const canCreate = useAdminPermission(permissions.rbacRoleCreate);
  const canUpdate = useAdminPermission(permissions.rbacRoleUpdate);
  const canDelete = useAdminPermission(permissions.rbacRoleDelete);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<RoleForm>(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Role | null>(null);
  const rolesQuery = useQuery({ queryKey: ["rbac", "roles"], queryFn: listRoles });
  const [searchParams, setSearchParams] = useSearchParams();
  const managedRole = rolesQuery.data?.find((role) => role.roleId === form.roleId)?.departmentId;
  useEffect(() => {
    const role = rolesQuery.data?.find((item) => item.roleId === searchParams.get("edit"));
    if (!role || !canUpdate || role.isSystem) return;
    setForm({roleId: role.roleId, name: role.name, permissionCodes: role.permissionCodes});
    setFormOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("edit");
    setSearchParams(next, {replace: true});
  }, [rolesQuery.data, searchParams, setSearchParams, canUpdate]);
  const permissionsQuery = useQuery({ queryKey: ["rbac", "permissions"], queryFn: listPermissions });

  const saveMutation = useMutation({
    mutationFn: () => form.roleId
      ? updateRole({ roleId: form.roleId, name: managedRole ? form.name : trimInput(form.name), permissionCodes: form.permissionCodes })
      : createRole({ name: trimInput(form.name), permissionCodes: form.permissionCodes }),
    onSuccess: async () => {
      setFormOpen(false);
      setForm(emptyForm);
      await queryClient.invalidateQueries({ queryKey: ["rbac", "roles"] });
    }
  });
  const deleteMutation = useMutation({
    mutationFn: (role: Role) => removeRole(role.roleId),
    onSuccess: async () => {
      setDeleteTarget(null);
      await queryClient.invalidateQueries({ queryKey: ["rbac", "roles"] });
    }
  });

  function openCreate() {
    saveMutation.reset();
    setForm(emptyForm);
    setFormOpen(true);
  }
  function openEdit(role: Role) {
    saveMutation.reset();
    setForm({ roleId: role.roleId, name: role.name, permissionCodes: role.permissionCodes });
    setFormOpen(true);
  }
  function closeForm() {
    if (saveMutation.isPending) return;
    setFormOpen(false);
    setForm(emptyForm);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimInput(form.name)) return;
    saveMutation.mutate();
  }

  const roles = rolesQuery.data ?? [];
  const catalog = permissionsQuery.data ?? [];
  return (
    <PageShell>
      <PageHeader
        title="角色管理"
        actions={canCreate ? <Button onClick={openCreate}><Plus data-icon="inline-start" />创建角色</Button> : undefined}
      >
        管理后台自定义角色及其权限。系统管理员角色始终拥有完整权限，不可编辑或删除。
      </PageHeader>
      {rolesQuery.isError ? <ErrorAlert>{rolesQuery.error.message}</ErrorAlert> : null}
      <DataTableShell dense minWidth={900}>
        <TableHeader>
          <TableRow>
            <TableHead>角色</TableHead>
            <TableHead>编码</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>权限数</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rolesQuery.isLoading ? <TableStateRow colSpan={5}>角色加载中</TableStateRow> : null}
          {!rolesQuery.isLoading && !rolesQuery.isError && roles.length === 0 ? <TableStateRow colSpan={5}>暂无角色</TableStateRow> : null}
          {roles.map((role) => (
            <TableRow key={role.roleId}>
              <TableCell><div className="flex items-center gap-2"><Shield aria-hidden="true" className="size-4 text-muted-foreground" /><strong>{role.name}</strong></div></TableCell>
              <TableCell className="font-mono text-xs">{role.code}</TableCell>
              <TableCell><Badge variant={role.isSystem ? "default" : "muted"}>{role.isSystem ? "系统内置" : role.departmentId ? role.departmentRoleType === "manager" ? "部门管理员" : "部门默认" : "自定义"}</Badge></TableCell>
              <TableCell>{role.permissionCodes.length}</TableCell>
              <TableCell className="text-right">
                {(canUpdate || canDelete) && !role.isSystem ? (
                  <div className="flex justify-end gap-2">
                    {canUpdate ? <Button onClick={() => openEdit(role)} size="sm" variant="outline">编辑</Button> : null}
                    {canDelete && !role.departmentId ? <Button aria-label={`删除 ${role.name}`} onClick={() => setDeleteTarget(role)} size="icon" variant="destructive"><Trash2 /></Button> : null}
                  </div>
                ) : <span className="text-xs text-muted-foreground">只读</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DataTableShell>

      <ModalShell open={formOpen} onClose={closeForm} contextLabel="角色权限" title={form.roleId ? "编辑角色" : "创建角色"} subtitle="角色权限在保存后的下一次后台请求立即生效。">
        <form onSubmit={submit}>
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="role-name">角色名称</FieldLabel>
              <Input
                id="role-name" aria-label="角色名称" readOnly={Boolean(managedRole)} maxLength={100} required value={form.name}
                onChange={(event) => {
                  const name = event.currentTarget.value;
                  event.currentTarget.setCustomValidity(name && !trimInput(name) ? "角色名称不能只包含空格或不可见字符" : "");
                  setForm((current) => ({ ...current, name }));
                }}
                onInvalid={(event) => {
                  if (event.currentTarget.validity.valueMissing) event.currentTarget.setCustomValidity("请输入角色名称");
                }}
              />
            </Field>
            <RolePermissionPicker catalog={catalog} selectedCodes={form.permissionCodes} onChange={(permissionCodes) => setForm((current) => ({...current, permissionCodes}))} />
            {saveMutation.isError ? <ErrorAlert>{saveMutation.error instanceof APIError && saveMutation.error.message === "rbac role code already exists" ? "角色创建冲突，请重试" : saveMutation.error.message}</ErrorAlert> : null}
            <Field className="justify-end" orientation="horizontal">
              <Button disabled={saveMutation.isPending} onClick={closeForm} type="button" variant="outline">取消</Button>
              <Button disabled={saveMutation.isPending} type="submit">保存角色</Button>
            </Field>
          </FieldGroup>
        </form>
      </ModalShell>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除角色"
        description={deleteTarget ? `确认删除角色“${deleteTarget.name}”？已绑定账号的角色必须先解除绑定。` : ""}
        confirmLabel="删除"
        variant="destructive"
        pending={deleteMutation.isPending}
        error={deleteMutation.isError ? deleteMutation.error.message : undefined}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
      />
    </PageShell>
  );
}
