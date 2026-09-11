import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { ChevronRight, Plus, Shield, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAdminPermission } from "@/components/admin-permissions";
import { ConfirmDialog, DataTableShell, ErrorAlert, ModalShell, PageHeader, PageShell, TableStateRow } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { createRole, listPermissions, listRoles, permissions, removeRole, updateRole, type Permission, type Role } from "@/lib/rbac-api";
import { buildPermissionTree, permissionGroupLabel, type PermissionGroupNode } from "@/lib/rbac-permission-tree";

type RoleForm = { roleId: string; code: string; name: string; permissionCodes: string[] };
const emptyForm: RoleForm = { roleId: "", code: "", name: "", permissionCodes: [] };

export function RBACRolesPage() {
  const canCreate = useAdminPermission(permissions.rbacRoleCreate);
  const canUpdate = useAdminPermission(permissions.rbacRoleUpdate);
  const canDelete = useAdminPermission(permissions.rbacRoleDelete);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<RoleForm>(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Role | null>(null);
  const rolesQuery = useQuery({ queryKey: ["rbac", "roles"], queryFn: listRoles });
  const permissionsQuery = useQuery({ queryKey: ["rbac", "permissions"], queryFn: listPermissions });
  const permissionTree = useMemo(() => buildPermissionTree(permissionsQuery.data ?? []), [permissionsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => form.roleId
      ? updateRole({ roleId: form.roleId, name: form.name.trim(), permissionCodes: form.permissionCodes })
      : createRole({ code: form.code.trim(), name: form.name.trim(), permissionCodes: form.permissionCodes }),
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
    setForm({ roleId: role.roleId, code: role.code, name: role.name, permissionCodes: role.permissionCodes });
    setFormOpen(true);
  }
  function closeForm() {
    if (saveMutation.isPending) return;
    setFormOpen(false);
    setForm(emptyForm);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.name.trim() || (!form.roleId && !form.code.trim())) return;
    saveMutation.mutate();
  }
  function togglePermission(code: string, checked: boolean) {
    setForm((current) => ({
      ...current,
      permissionCodes: checked
        ? [...new Set([...current.permissionCodes, code])].sort()
        : current.permissionCodes.filter((item) => item !== code)
    }));
  }
  function togglePermissionCodes(codes: string[], checked: boolean) {
    setForm((current) => {
      const permissionCodes = new Set(current.permissionCodes);
      codes.forEach((code) => {
        if (checked) permissionCodes.add(code);
        else permissionCodes.delete(code);
      });
      return { ...current, permissionCodes: [...permissionCodes].sort() };
    });
  }

  const roles = rolesQuery.data ?? [];
  const catalog = permissionsQuery.data ?? [];
  const selectedPermissionCount = catalog.filter((permission) => form.permissionCodes.includes(permission.code)).length;
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
              <TableCell><Badge variant={role.isSystem ? "default" : "muted"}>{role.isSystem ? "系统内置" : "自定义"}</Badge></TableCell>
              <TableCell>{role.permissionCodes.length}</TableCell>
              <TableCell className="text-right">
                {(canUpdate || canDelete) && !role.isSystem ? (
                  <div className="flex justify-end gap-2">
                    {canUpdate ? <Button onClick={() => openEdit(role)} size="sm" variant="outline">编辑</Button> : null}
                    {canDelete ? <Button aria-label={`删除 ${role.name}`} onClick={() => setDeleteTarget(role)} size="icon" variant="destructive"><Trash2 /></Button> : null}
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
              <FieldLabel htmlFor="role-code">角色编码</FieldLabel>
              <Input id="role-code" aria-label="角色编码" disabled={Boolean(form.roleId)} pattern="[a-z][a-z0-9_]+" required value={form.code} onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))} />
              <FieldDescription>使用小写字母、数字和下划线，创建后不可修改。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="role-name">角色名称</FieldLabel>
              <Input id="role-name" aria-label="角色名称" maxLength={100} required value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
            </Field>
            <FieldSet className="gap-3">
              <FieldLegend className="mb-0 flex w-full items-center justify-between gap-2">
                <span>权限配置</span>
                <Badge className="shrink-0" variant="secondary">已选 {selectedPermissionCount} / {catalog.length}</Badge>
              </FieldLegend>
              <div className="max-h-[min(40vh,24rem)] overflow-y-auto overscroll-contain pr-1">
                <TooltipProvider delayDuration={200}>
                  <ul aria-label="角色权限树" className="divide-y divide-border rounded-md border bg-card">
                    {permissionTree.map((node) => (
                      <RolePermissionTreeNode
                        depth={0}
                        key={node.key}
                        node={node}
                        selectedCodes={form.permissionCodes}
                        onToggleCodes={togglePermissionCodes}
                        onTogglePermission={togglePermission}
                      />
                    ))}
                  </ul>
                </TooltipProvider>
              </div>
            </FieldSet>
            {saveMutation.isError ? <ErrorAlert>{saveMutation.error.message}</ErrorAlert> : null}
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

function RolePermissionTreeNode({
  depth,
  node,
  selectedCodes,
  onToggleCodes,
  onTogglePermission
}: {
  depth: number;
  node: PermissionGroupNode;
  selectedCodes: string[];
  onToggleCodes: (codes: string[], checked: boolean) => void;
  onTogglePermission: (code: string, checked: boolean) => void;
}) {
  const label = permissionGroupLabel(node);
  const selectedCount = node.permissionCodes.filter((code) => selectedCodes.includes(code)).length;
  const checked = selectedCount === node.count ? true : selectedCount > 0 ? "indeterminate" : false;
  const groupID = `permission-tree-${node.key.replaceAll(":", "-")}`;
  const defaultOpen = selectedCount > 0 && selectedCount < node.count;

  return (
    <li>
      <Collapsible defaultOpen={defaultOpen}>
        <div className="flex items-center gap-2 pr-2">
          <Checkbox
            aria-label={`选择 ${label} 全部权限`}
            checked={checked}
            className="ml-3"
            id={groupID}
            onCheckedChange={(nextChecked) => onToggleCodes(node.permissionCodes, nextChecked === true)}
          />
          <CollapsibleTrigger asChild>
            <Button
              aria-label={`查看 ${label} 权限明细`}
              className="group h-auto min-h-11 min-w-0 flex-1 justify-start px-1 py-2 text-left"
              type="button"
              variant="ghost"
            >
              <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" data-icon="inline-start" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </TooltipTrigger>
                <TooltipContent className="font-mono">{node.key}</TooltipContent>
              </Tooltip>
            </Button>
          </CollapsibleTrigger>
          <Badge className="shrink-0 tabular-nums" variant={selectedCount > 0 ? "secondary" : "muted"}>
            {selectedCount} / {node.count}
          </Badge>
        </div>
        <CollapsibleContent className="border-t bg-muted/20">
          <div className="ml-5 border-l border-border pl-2">
            {node.children.length > 0 ? (
              <ul className="divide-y divide-border">
                {node.children.map((child) => (
                  <RolePermissionTreeNode
                    depth={depth + 1}
                    key={child.key}
                    node={child}
                    selectedCodes={selectedCodes}
                    onToggleCodes={onToggleCodes}
                    onTogglePermission={onTogglePermission}
                  />
                ))}
              </ul>
            ) : null}
            {node.permissions.length > 0 ? (
              <ul className="divide-y divide-border">
                {node.permissions.map((permission) => (
                  <RolePermissionLeaf
                    key={permission.code}
                    permission={permission}
                    selected={selectedCodes.includes(permission.code)}
                    onToggle={onTogglePermission}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function RolePermissionLeaf({
  permission,
  selected,
  onToggle
}: {
  permission: Permission;
  selected: boolean;
  onToggle: (code: string, checked: boolean) => void;
}) {
  return (
    <li>
      <Field className="px-3 py-3" orientation="horizontal">
        <Checkbox
          checked={selected}
          id={permission.code}
          onCheckedChange={(nextChecked) => onToggle(permission.code, nextChecked === true)}
        />
        <FieldContent className="gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <FieldLabel htmlFor={permission.code}>{permission.name}</FieldLabel>
            </TooltipTrigger>
            <TooltipContent className="font-mono">{permission.code}</TooltipContent>
          </Tooltip>
          <FieldDescription className="text-xs">{permission.description}</FieldDescription>
        </FieldContent>
      </Field>
    </li>
  );
}
