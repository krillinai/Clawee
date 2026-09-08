import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";

import { EmptyState, ErrorAlert, LoadingState, PageHeader, PageShell } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { listPermissions, type Permission } from "@/lib/rbac-api";
import { buildPermissionTree, permissionGroupLabel, type PermissionGroupNode } from "@/lib/rbac-permission-tree";

export function RBACPermissionsPage() {
  const query = useQuery({ queryKey: ["rbac", "permissions"], queryFn: listPermissions });
  const items = query.data ?? [];
  const groups = buildPermissionTree(items);

  return (
    <PageShell>
      <PageHeader title="权限目录">
        后台权限节点由代码目录统一维护。角色只能从当前目录中选择权限，不能在线新增、删除或改名。
      </PageHeader>
      {query.isError ? <ErrorAlert>{query.error.message}</ErrorAlert> : null}
      {!query.isError ? (
        <Card className="min-w-0 shadow-none">
          <CardHeader className="flex-row items-center justify-between gap-3 border-b p-4">
            <CardTitle className="text-base">目录结构</CardTitle>
            <div className="flex min-w-14 justify-end">
              {query.isLoading ? <Skeleton className="h-5 w-12" /> : <Badge variant="secondary">{items.length} 项</Badge>}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {query.isLoading ? <div className="p-4"><LoadingState label="权限目录加载中" /></div> : null}
            {!query.isLoading && items.length === 0 ? <div className="p-4"><EmptyState title="暂无权限节点" /></div> : null}
            {groups.length > 0 ? (
              <ul className="divide-y divide-border" aria-label="权限目录">
                {groups.map((group) => <PermissionGroup key={group.key} node={group} depth={0} />)}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </PageShell>
  );
}

function PermissionGroup({ node, depth }: { node: PermissionGroupNode; depth: number }) {
  const label = permissionGroupLabel(node);

  return (
    <li>
      <Collapsible defaultOpen={depth === 0}>
        <div className="flex items-center gap-2 pr-3">
          <CollapsibleTrigger asChild>
            <Button
              aria-label={label}
              className="group h-auto min-h-11 min-w-0 flex-1 justify-start px-3 py-2.5 text-left"
              variant="ghost"
            >
              <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" data-icon="inline-start" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </Button>
          </CollapsibleTrigger>
          <Badge variant="muted">{node.count} 项</Badge>
        </div>
        <CollapsibleContent>
          <div className="ml-5 border-l border-border pl-2">
            {node.children.length > 0 ? (
              <ul>
                {node.children.map((child) => <PermissionGroup key={child.key} node={child} depth={depth + 1} />)}
              </ul>
            ) : null}
            {node.permissions.length > 0 ? (
              <ul className="divide-y divide-border">
                {node.permissions.map((permission) => <PermissionLeaf key={permission.code} permission={permission} />)}
              </ul>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function PermissionLeaf({ permission }: { permission: Permission }) {
  return (
    <li className="grid min-w-0 gap-2 px-3 py-3 sm:grid-cols-[minmax(200px,260px)_minmax(180px,360px)_auto] sm:items-center sm:justify-start sm:gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{permission.name}</p>
        <code className="block break-all font-mono text-xs text-muted-foreground">{permission.code}</code>
      </div>
      <p className="min-w-0 text-sm text-muted-foreground">{permission.description}</p>
      <Badge className="w-fit" variant={permission.action === "manage" ? "default" : "muted"}>
        {permissionActionLabel(permission.action)}
      </Badge>
    </li>
  );
}

function permissionActionLabel(action: string) {
  if (action === "manage") return "管理";
  if (action === "merge") return "合并";
  if (action === "transfer") return "迁移";
  return "查看";
}
