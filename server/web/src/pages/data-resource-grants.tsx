import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, Eye, FolderOpen, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

import {
  DataTableShell,
  EmptyState,
  ErrorAlert,
  FilterRow,
  FilterSearchField,
  PageHeader,
  PageShell,
  TableStateRow
} from "@/components/governance-ui";
import { useAdminPermission } from "@/components/admin-permissions";
import { MemberAuthorizationDrawer, type MemberAuthorizationAdapter } from "@/components/member-authorization";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  createDataResourceGrant,
  listDataResourceGrantMemberCandidates,
  listDataResourceGrantMembers,
  listDataResourceTypes,
  removeDataResourceGrant,
  replaceDataResourceGrant,
  searchDataResourceGrantResources,
  type DataResourceGrantResource,
  type DataResourceType
} from "@/lib/data-resource-grants-api";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { permissions } from "@/lib/rbac-api";

const pageSize = 20;

function resourceTypeLabel(resourceType: DataResourceType) {
  return resourceType.resourceType === "shared_space" ? "网盘空间" : resourceType.name;
}

export function DataResourceGrantsPage() {
  const canManage = useAdminPermission(permissions.dataResourceGrantManage);
  const queryClient = useQueryClient();
  const [resourceType, setResourceType] = useState<DataResourceType["resourceType"]>("shared_space");
  const [resourceQuery, setResourceQuery] = useState("");
  const [resourcePage, setResourcePage] = useState(1);
  const [selectedResource, setSelectedResource] = useState<DataResourceGrantResource | null>(null);

  const resourceTypesQuery = useQuery({ queryKey: ["data-resource-grants", "resource-types"], queryFn: listDataResourceTypes });
  const resourcesQuery = useQuery({
    queryKey: ["data-resource-grants", "resources", resourceType, resourceQuery, resourcePage],
    queryFn: () => searchDataResourceGrantResources({ resourceType, query: resourceQuery, page: resourcePage, pageSize }),
    placeholderData: (previous) => previous
  });
  const resourceTypes = resourceTypesQuery.data ?? [];
  const resources = resourcesQuery.data?.items ?? [];
  const resourceTotal = resourcesQuery.data?.meta.total ?? 0;
  const authorizationTarget = selectedResource
    ? resources.find((item) => item.resourceType === selectedResource.resourceType && item.resourceId === selectedResource.resourceId) ?? selectedResource
    : null;
  const authorizationAdapter = useMemo<MemberAuthorizationAdapter>(() => ({
    queryKey: `data-resource-grant-members-${authorizationTarget?.resourceType ?? "none"}`,
    listMembers: ({ query, cursor }) => listDataResourceGrantMembers({
      resourceType: authorizationTarget?.resourceType ?? "",
      resourceId: authorizationTarget?.resourceId ?? "",
      query,
      cursor
    }),
    listCandidates: ({ query, cursor }) => listDataResourceGrantMemberCandidates({
      resourceType: authorizationTarget?.resourceType ?? "",
      resourceId: authorizationTarget?.resourceId ?? "",
      query,
      cursor
    }),
    addMember: ({ userId, actions }) => createDataResourceGrant({
      userId,
      resourceType: authorizationTarget?.resourceType ?? "",
      resourceId: authorizationTarget?.resourceId ?? "",
      actions
    }),
    updateMember: ({ userId, actions }) => replaceDataResourceGrant({
      userId,
      resourceType: authorizationTarget?.resourceType ?? "",
      resourceId: authorizationTarget?.resourceId ?? "",
      actions
    }),
    removeMember: (userId) => removeDataResourceGrant({
      userId,
      resourceType: authorizationTarget?.resourceType ?? "",
      resourceId: authorizationTarget?.resourceId ?? ""
    })
  }), [authorizationTarget?.resourceId, authorizationTarget?.resourceType]);

  function changeResourceType(value: string) {
    if (!resourceTypes.some((item) => item.resourceType === value)) return;
    setResourceType(value);
    setResourceQuery("");
    setResourcePage(1);
    closeDetails();
  }

  function openDetails(resource: DataResourceGrantResource) {
    setSelectedResource(resource);
  }

  function closeDetails() {
    setSelectedResource(null);
  }

  function refreshAuthorizationSummary() {
    void queryClient.invalidateQueries({ queryKey: ["data-resource-grants"] });
    void queryClient.invalidateQueries({ queryKey: ["app-data-views"] });
  }

  return (
    <PageShell>
      <PageHeader title="数据权限">
        按数据资源查看可授权权限，并管理账户的数据访问范围。
      </PageHeader>

      {resourceTypesQuery.isError ? <ErrorAlert>{resourceTypesQuery.error.message}</ErrorAlert> : null}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <Card className="h-fit shadow-none">
          <CardHeader className="border-b p-4">
            <CardTitle className="text-base">数据资源类型</CardTitle>
          </CardHeader>
          <CardContent className="p-2">
            <ToggleGroup
              aria-label="选择数据资源类型"
              className="flex-col items-stretch"
              onValueChange={changeResourceType}
              type="single"
              value={resourceType}
              variant="outline"
            >
              {resourceTypes.map((item) => (
                <ToggleGroupItem className="h-auto min-h-16 justify-start px-3 py-2 text-left" key={item.resourceType} value={item.resourceType}>
                  {item.resourceType === "shared_space" ? <FolderOpen aria-hidden="true" /> : <BookOpenText aria-hidden="true" />}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{resourceTypeLabel(item)}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {item.resourceCount} 个数据资源 · {item.actionCount} 个 Action
                    </span>
                  </span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {resourceTypesQuery.isLoading ? <p className="p-3 text-sm text-muted-foreground">正在加载数据资源类型...</p> : null}
          </CardContent>
        </Card>

        <section className="min-w-0" aria-label="数据资源">
          <FilterRow>
            <FilterSearchField
              aria-label="搜索数据资源"
              onChange={(event) => { setResourceQuery(event.target.value); setResourcePage(1); }}
              placeholder="按资源名称或 resource_id 搜索"
              value={resourceQuery}
            />
            <Badge variant="secondary">共 {resourceTotal} 个数据资源</Badge>
          </FilterRow>
          <DataTableShell fixedLayout minWidth={920}>
            <colgroup>
              <col className="w-[30%]" />
              <col className="w-[15%]" />
              <col className="w-[15%]" />
              <col className="w-[11%]" />
              <col className="w-[16%]" />
              <col className="w-[13%]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>数据资源</TableHead>
                <TableHead>resource_type</TableHead>
                <TableHead>可授权 Action</TableHead>
                <TableHead className="text-center">被授权用户</TableHead>
                <TableHead className="whitespace-nowrap">更新时间</TableHead>
                <TableHead className="whitespace-nowrap text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resourcesQuery.isLoading ? <TableStateRow colSpan={6}>正在加载数据资源...</TableStateRow> : null}
              {resourcesQuery.isError ? <TableStateRow colSpan={6} tone="danger">{resourcesQuery.error.message}</TableStateRow> : null}
              {!resourcesQuery.isLoading && !resourcesQuery.isError && resources.length === 0 ? (
                <TableRow><TableCell colSpan={6}><EmptyState title="暂无数据资源" description="当前资源类型下没有已登记的数据资源。" /></TableCell></TableRow>
              ) : null}
              {resources.map((resource) => (
                <TableRow key={`${resource.resourceType}:${resource.resourceId}`}>
                  <TableCell className="min-w-0">
                    <div className="truncate font-medium" title={resource.name}>{resource.name}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground" title={resource.resourceId}>{resource.resourceId}</div>
                  </TableCell>
                  <TableCell className="min-w-0"><code className="block truncate font-mono text-xs" title={resource.resourceType}>{resource.resourceType}</code></TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {resource.availableActions.map((action) => <Badge key={action.action} title={action.name} variant="muted">{action.action}</Badge>)}
                    </div>
                  </TableCell>
                  <TableCell className="text-center font-mono">{resource.userCount}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{formatDateTime(resource.updatedAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <Button onClick={() => openDetails(resource)} size="sm" variant="outline">
                      {canManage ? <ShieldCheck data-icon="inline-start" aria-hidden="true" /> : <Eye data-icon="inline-start" aria-hidden="true" />}
                      {canManage ? "管理授权" : "查看授权"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTableShell>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button disabled={resourcePage <= 1 || resourcesQuery.isFetching} onClick={() => setResourcePage((page) => page - 1)} variant="outline">上一页</Button>
            <span className="min-w-20 text-center text-sm text-muted-foreground">第 {resourcePage} 页</span>
            <Button disabled={resourcePage * pageSize >= resourceTotal || resourcesQuery.isFetching} onClick={() => setResourcePage((page) => page + 1)} variant="outline">下一页</Button>
          </div>
        </section>
      </div>

      <MemberAuthorizationDrawer
        adapter={authorizationAdapter}
        canManage={canManage}
        memberCount={authorizationTarget?.userCount}
        onChanged={refreshAuthorizationSummary}
        onClose={closeDetails}
        open={Boolean(selectedResource)}
        permissions={(authorizationTarget?.availableActions ?? []).map((action) => ({
          value: action.action,
          label: action.name,
          description: action.description || undefined,
          required: action.required,
          defaultChecked: action.defaultChecked
        }))}
        resourceId={authorizationTarget?.resourceId ?? ""}
        resourceLabel={resourceTypes.find((item) => item.resourceType === authorizationTarget?.resourceType)?.name ?? "数据资源"}
        resourceName={authorizationTarget?.name ?? ""}
      />
    </PageShell>
  );
}
