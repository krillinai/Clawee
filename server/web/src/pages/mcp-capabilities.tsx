import { ExternalLink, Eye, Trash2 } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";

import {
  BooleanBadge,
  ConfirmDialog,
  DataTableShell,
  DetailDrawer,
  EmptyState,
  ErrorAlert,
  FilterRow,
  FilterSearchField,
  FilterSelect,
  JsonTabs,
  KeyValueList,
  LoadingState,
  MetricCard,
  ModalShell,
  PageHeader,
  PageShell,
  ResourceItem,
  ResourceList,
  TableStateRow
} from "@/components/governance-ui";
import { useAdminPermission } from "@/components/admin-permissions";
import { CopyButton } from "@/components/copy-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import {
  deleteMCPCapability,
  listMCPCapabilities,
  listMCPGrants,
  listMCPUpstreamServers,
  renameMCPCapability,
  updateMCPCapabilityGates,
  updateMCPCapabilityStatus,
  type MCPCapability,
  type MCPGrant,
  type MCPUpstreamServer
} from "@/lib/mcp-admin-api";
import {
  deriveCapabilityRows,
  filterCapabilities,
  formatDateTime,
  mcpStatusLabel,
  mcpStatusVariant,
  riskLevelLabel,
  validateExposedName,
  type CapabilityRowView
} from "@/lib/mcp-admin-ui";
import { readQueryParam, updateQueryParams } from "@/lib/url-state";
import { permissions } from "@/lib/rbac-api";

const capabilitiesQueryKey = ["mcp-capabilities"] as const;
const upstreamServersQueryKey = ["mcp-upstream-servers"] as const;
const grantsQueryKey = ["mcp-grants"] as const;
const statusOptions = ["all", "active", "pending", "disabled", "missing"] as const;
const grantOptions = ["all", "with_grants", "without_grants"] as const;
const missingButGrantedOptions = ["all", "yes", "no"] as const;
const grantBlockMessage = "已有授权，请先删除授权，或后续通过别名能力处理。";
const activeRenameConfirmMessage = "请输入当前 exposed_name 以确认 rename。";

type RenameState = {
  capability: CapabilityRowView;
  value: string;
  confirmation: string;
  error: string | null;
};

type GatesDraft = {
  capability: CapabilityRowView;
  approvalRequired: boolean;
  confirmRequired: boolean;
};

export function MCPCapabilitiesPage() {
  const canManage = useAdminPermission(permissions.mcpCapabilityManage);
  const canReadUpstreams = useAdminPermission(permissions.mcpUpstreamRead);
  const canReadGrants = useAdminPermission(permissions.mcpGrantRead);
  const canReadAudits = useAdminPermission(permissions.mcpAuditRead);
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = readQueryParam(location.search, "q") ?? "";
  const status = readQueryParam(location.search, "status") ?? "all";
  const server = readQueryParam(location.search, "server_id") ?? "all";
  const domain = readQueryParam(location.search, "domain") ?? "all";
  const type = readQueryParam(location.search, "type") ?? "all";
  const riskLevel = readQueryParam(location.search, "risk_level") ?? "all";
  const hasGrants = readQueryParam(location.search, "has_grants") ?? "all";
  const missingButGranted = readQueryParam(location.search, "missing_but_granted") ?? "all";
  const [selectedCapabilityID, setSelectedCapabilityID] = useState<string | null>(null);
  const [renameState, setRenameState] = useState<RenameState | null>(null);
  const [gatesDraft, setGatesDraft] = useState<GatesDraft | null>(null);
  const [capabilityToDelete, setCapabilityToDelete] = useState<CapabilityRowView | null>(null);

  const capabilitiesQuery = useQuery({
    queryKey: capabilitiesQueryKey,
    queryFn: () => listMCPCapabilities()
  });
  const serversQuery = useQuery({
    queryKey: upstreamServersQueryKey,
    queryFn: () => listMCPUpstreamServers(),
    enabled: canReadUpstreams
  });
  const grantsQuery = useQuery({
    queryKey: grantsQueryKey,
    queryFn: () => listMCPGrants(),
    enabled: canReadGrants
  });

  const capabilities = capabilitiesQuery.data ?? [];
  const servers = serversQuery.data ?? [];
  const grants = grantsQuery.data ?? [];
  const serverByID = useMemo(() => new Map(servers.map((item) => [item.id, item])), [servers]);
  const rows = useMemo(() => deriveCapabilityRows(capabilities, grants), [capabilities, grants]);
  const filteredRows = useMemo(
    () =>
      filterCapabilityRows(rows, {
        query,
        status: status === "all" ? undefined : status,
        upstreamServerId: server === "all" ? undefined : server,
        domain: domain === "all" ? undefined : domain,
        type: type === "all" ? undefined : type,
        riskLevel: riskLevel === "all" ? undefined : riskLevel,
        hasGrants: hasGrants === "all" ? undefined : hasGrants,
        missingButGranted: missingButGranted === "all" ? undefined : missingButGranted
      })
    ,
    [domain, hasGrants, missingButGranted, query, riskLevel, rows, server, status, type]
  );
  const selectedCapability = rows.find((row) => row.id === selectedCapabilityID) ?? null;
  const pendingGateChanges = gatesDraft ? gateChanges(gatesDraft.capability, gatesDraft) : [];
  const domainOptions = useMemo(
    () => uniqueOptions([...servers.map((item) => item.domain), ...capabilities.map((item) => item.exposedName.split(".")[0] ?? "")]),
    [capabilities, servers]
  );
  const typeOptions = useMemo(() => uniqueOptions(capabilities.map((item) => item.type)), [capabilities]);
  const riskOptions = useMemo(() => uniqueOptions(capabilities.map((item) => item.riskLevel)), [capabilities]);
  const isLoading = capabilitiesQuery.isLoading || (canReadUpstreams && serversQuery.isLoading) || (canReadGrants && grantsQuery.isLoading);
  const hasLoadError = capabilitiesQuery.isError || serversQuery.isError || grantsQuery.isError;

  const statusMutation = useMutation({
    mutationFn: ({ exposedName, nextStatus }: { exposedName: string; nextStatus: string }) =>
      updateMCPCapabilityStatus(exposedName, nextStatus),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: capabilitiesQueryKey });
    }
  });

  const renameMutation = useMutation({
    mutationFn: ({ exposedName, nextExposedName }: { exposedName: string; nextExposedName: string }) =>
      renameMCPCapability(exposedName, nextExposedName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: capabilitiesQueryKey });
      queryClient.invalidateQueries({ queryKey: grantsQueryKey });
      setRenameState(null);
    },
    onError: (error) => {
      setRenameState((current) => (current ? { ...current, error: error.message } : current));
    }
  });

  const gatesMutation = useMutation({
    mutationFn: ({
      capabilityId,
      approvalRequired,
      confirmRequired
    }: {
      capabilityId: string;
      approvalRequired: boolean;
      confirmRequired: boolean;
    }) => updateMCPCapabilityGates(capabilityId, { approvalRequired, confirmRequired }),
    onSuccess: (capability) => {
      queryClient.invalidateQueries({ queryKey: capabilitiesQueryKey });
      setSelectedCapabilityID(capability.id);
      setGatesDraft(null);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (capabilityId: string) => deleteMCPCapability(capabilityId),
    onSuccess: (_, capabilityId) => {
      queryClient.invalidateQueries({ queryKey: capabilitiesQueryKey });
      queryClient.invalidateQueries({ queryKey: grantsQueryKey });
      setSelectedCapabilityID((current) => current === capabilityId ? null : current);
      setCapabilityToDelete(null);
    }
  });

  function updateFilter(next: {
    q?: string;
    status?: string;
    server_id?: string;
    domain?: string;
    type?: string;
    risk_level?: string;
    has_grants?: string;
    missing_but_granted?: string;
  }) {
    const updates: Record<string, string | null> = {};
    if ("q" in next) updates.q = next.q ?? null;
    if ("status" in next) updates.status = next.status === "all" ? null : next.status ?? null;
    if ("server_id" in next) updates.server_id = next.server_id === "all" ? null : next.server_id ?? null;
    if ("domain" in next) updates.domain = next.domain === "all" ? null : next.domain ?? null;
    if ("type" in next) updates.type = next.type === "all" ? null : next.type ?? null;
    if ("risk_level" in next) updates.risk_level = next.risk_level === "all" ? null : next.risk_level ?? null;
    if ("has_grants" in next) updates.has_grants = next.has_grants === "all" ? null : next.has_grants ?? null;
    if ("missing_but_granted" in next) {
      updates.missing_but_granted = next.missing_but_granted === "all" ? null : next.missing_but_granted ?? null;
    }

    navigate({
      pathname: location.pathname,
      search: updateQueryParams(location.search, updates)
    });
  }

  function openRename(capability: CapabilityRowView) {
    if (!canOpenRename(capability)) return;
    renameMutation.reset();
    setRenameState({ capability, value: capability.exposedName, confirmation: "", error: null });
  }

  function closeRename() {
    if (renameMutation.isPending) return;
    setRenameState(null);
  }

  function requestGateSave(draft: GatesDraft) {
    const changes = gateChanges(draft.capability, draft);
    if (changes.length === 0) return;
    gatesMutation.reset();
    setGatesDraft(draft);
  }

  function closeGatesConfirm() {
    if (gatesMutation.isPending) return;
    setGatesDraft(null);
  }

  function submitGates() {
    if (!gatesDraft) return;
    gatesMutation.mutate({
      capabilityId: gatesDraft.capability.id,
      approvalRequired: gatesDraft.approvalRequired,
      confirmRequired: gatesDraft.confirmRequired
    });
  }

  function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameState) return;

    const nextExposedName = renameState.value.trim();
    const validationError = validateExposedName(nextExposedName);
    if (validationError) {
      setRenameState({ ...renameState, error: validationError });
      return;
    }
    if (renameState.capability.status === "active" && renameState.capability.grantCount > 0) {
      setRenameState({ ...renameState, error: grantBlockMessage });
      return;
    }
    if (
      renameState.capability.status === "active" &&
      renameState.capability.grantCount === 0 &&
      renameState.confirmation.trim() !== renameState.capability.exposedName
    ) {
      setRenameState({ ...renameState, error: activeRenameConfirmMessage });
      return;
    }

    renameMutation.mutate({
      exposedName: renameState.capability.exposedName,
      nextExposedName
    });
  }

  return (
    <PageShell>
      <PageHeader title="能力目录">
        企业智能体可授权能力目录。能力由上游服务同步产生，本页只做治理状态、授权影响、
        结构定义和 exposed_name 管理。
      </PageHeader>

      {hasLoadError ? (
        <ErrorAlert>MCP 能力加载失败：无法加载能力、上游服务或授权数据。</ErrorAlert>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard foot="来自上游同步工具的能力" label="能力" value={isLoading ? "..." : capabilities.length} />
        <MetricCard
          foot={`${capabilities.filter((item) => item.status === "pending").length} 待审核，${
            capabilities.filter((item) => item.status === "missing").length
          } 已缺失`}
          label="待治理"
          value={isLoading ? "..." : capabilities.filter((item) => item.status !== "active").length}
        />
        <MetricCard
          foot="至少存在一条授权的能力"
          label="已有授权"
          value={isLoading ? "..." : rows.filter((row) => row.grantCount > 0).length}
        />
        <MetricCard
          foot="授权指向已不存在的能力 ID"
          label="缺失但已授权"
          value={isLoading ? "..." : rows.filter((row) => row.missingButGranted).length}
        />
      </section>

      <Card>
        <CardHeader className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle>能力列表</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              点击行查看治理字段、结构定义、关联授权与最近调用入口。
            </p>
          </div>
          <Badge variant="muted">{filteredRows.length} 条可见</Badge>
        </CardHeader>
        <CardContent>
          <FilterRow>
            <FilterSearchField
              aria-label="搜索能力"
              placeholder="搜索 exposed_name / title / upstream_name"
              value={query}
              onChange={(event) => updateFilter({ q: event.target.value })}
            />
            {canReadGrants ? <FilterSelect
              ariaLabel="筛选能力状态"
              className="sm:w-36"
              value={status}
              onChange={(value) => updateFilter({ status: value })}
            >
              {statusOptions.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "全部状态" : mcpStatusLabel(option)}
                </option>
              ))}
            </FilterSelect> : null}
            {canReadGrants ? <FilterSelect
              ariaLabel="筛选能力上游服务"
              className="sm:w-56"
              value={server}
              onChange={(value) => updateFilter({ server_id: value })}
            >
              <option value="all">全部上游服务</option>
              {servers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </FilterSelect> : null}
            <FilterSelect
              ariaLabel="筛选能力领域"
              className="sm:w-36"
              value={domain}
              onChange={(value) => updateFilter({ domain: value })}
            >
              <option value="all">全部领域</option>
              {domainOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              ariaLabel="筛选能力类型"
              className="sm:w-32"
              value={type}
              onChange={(value) => updateFilter({ type: value })}
            >
              <option value="all">全部类型</option>
              {typeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              ariaLabel="筛选能力风险等级"
              className="sm:w-36"
              value={riskLevel}
              onChange={(value) => updateFilter({ risk_level: value })}
            >
              <option value="all">全部风险</option>
              {riskOptions.map((option) => (
                <option key={option} value={option}>
                  {riskLevelLabel(option)}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              ariaLabel="筛选能力授权"
              className="sm:w-40"
              value={hasGrants}
              onChange={(value) => updateFilter({ has_grants: value })}
            >
              <option value="all">全部授权</option>
              {grantOptions.slice(1).map((option) => (
                <option key={option} value={option}>
                  {option === "with_grants" ? "已有授权" : "无授权"}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              ariaLabel="筛选缺失但已授权能力"
              className="sm:w-44"
              value={missingButGranted}
              onChange={(value) => updateFilter({ missing_but_granted: value })}
            >
              <option value="all">全部缺失授权</option>
              {missingButGrantedOptions.slice(1).map((option) => (
                <option key={option} value={option}>
                  {option === "yes" ? "是" : "否"}
                </option>
              ))}
            </FilterSelect>
          </FilterRow>

          <DataTableShell dense minWidth={1840}>
            <TableHeader>
              <TableRow className="bg-background font-mono text-xs text-muted-foreground hover:bg-background">
                {[
                  "暴露名称",
                  "类型",
                  "上游服务",
                  "上游名称",
                  "标题",
                  "状态",
                  "结构哈希",
                  "版本",
                  "风险等级",
                  "只读",
                  "破坏性",
                  "需要审批",
                  "需要确认",
                  "授权数",
                  "最近同步时间",
                  "操作"
                ].map((heading) => (
                  <TableHead className="border-b border-border px-3 py-3 font-medium" key={heading}>
                    {heading}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableStateRow colSpan={16}>
                  <LoadingState label="正在加载 MCP 能力" />
                </TableStateRow>
              ) : null}
              {!isLoading && hasLoadError ? (
                <TableStateRow colSpan={16} tone="danger">
                  <ErrorAlert>能力加载失败。</ErrorAlert>
                </TableStateRow>
              ) : null}
              {!isLoading && !hasLoadError && filteredRows.length === 0 ? (
                <TableStateRow colSpan={16}>
                  <EmptyState title="暂无匹配的能力。" />
                </TableStateRow>
              ) : null}
              {!isLoading && !hasLoadError
                ? filteredRows.map((capability) => (
                    <TableRow className={capability.missingButGranted ? "bg-warning/5" : undefined} key={capability.id}>
                      <TableCell className="max-w-[260px] border-b border-border px-3 py-3 font-mono text-xs">
                        <span className="block truncate" title={capability.exposedName}>
                          {capability.exposedName}
                        </span>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{capability.type || "-"}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">
                        {serverLabel(serverByID, capability.upstreamServerId)}
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{capability.upstreamName || "-"}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3">{capability.title || "-"}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <Badge variant={mcpStatusVariant(capability.status || (capability.missingButGranted ? "missing" : "unknown"))}>
                          {capability.missingButGranted
                            ? "已缺失但仍有授权"
                            : mcpStatusLabel(capability.status || "unknown")}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[160px] border-b border-border px-3 py-3 font-mono text-xs">
                        <span className="block truncate" title={capability.schemaHash || ""}>
                          {capability.schemaHash || "-"}
                        </span>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{capability.version || "-"}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3 text-xs">{riskLevelLabel(capability.riskLevel)}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <BooleanBadge value={capability.readOnly} />
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <BooleanBadge trueVariant="danger" value={capability.destructive} />
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <BooleanBadge trueVariant="warning" value={capability.approvalRequired} />
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <BooleanBadge trueVariant="warning" value={capability.confirmRequired} />
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{capability.grantCount}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{formatDateTime(capability.lastSyncedAt)}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <div className="flex items-center gap-2 whitespace-nowrap">
                          <Button
                            aria-label={`查看 ${capability.exposedName} 详情`}
                            onClick={() => setSelectedCapabilityID(capability.id)}
                            size="sm"
                            variant="secondary"
                          >
                            <Eye aria-hidden="true" />
                            详情
                          </Button>
                          {canManage && capability.status === "pending" ? (
                            <Button
                              disabled={statusMutation.isPending}
                              onClick={() => {
                                statusMutation.mutate({
                                  exposedName: capability.exposedName,
                                  nextStatus: "active"
                                });
                              }}
                              size="sm"
                              variant="primary"
                            >
                              启用
                            </Button>
                          ) : null}
                          {canManage && capability.status === "active" ? (
                            <Button
                              disabled={statusMutation.isPending}
                              onClick={() => {
                                statusMutation.mutate({
                                  exposedName: capability.exposedName,
                                  nextStatus: "disabled"
                                });
                              }}
                              size="sm"
                              variant="secondary"
                            >
                              禁用
                            </Button>
                          ) : null}
                          {canManage && canOpenRename(capability) ? (
                            <Button
                              onClick={() => openRename(capability)}
                              size="sm"
                              variant="secondary"
                            >
                              编辑
                            </Button>
                          ) : null}
                          {canManage && capability.status === "missing" ? (
                            <Button
                              onClick={() => {
                                deleteMutation.reset();
                                setCapabilityToDelete(capability);
                              }}
                              size="sm"
                              variant="destructive"
                            >
                              <Trash2 aria-hidden="true" data-icon="inline-start" />
                              删除
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                : null}
            </TableBody>
          </DataTableShell>
          {statusMutation.isError ? (
            <div className="mt-3">
              <ErrorAlert>{statusMutation.error.message}</ErrorAlert>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <CapabilityDrawer
        canManage={canManage}
        canReadAudits={canReadAudits}
        canReadGrants={canReadGrants}
        capability={selectedCapability}
        gatesError={gatesMutation.isError ? gatesMutation.error.message : null}
        gatesPending={gatesMutation.isPending}
        onClose={() => setSelectedCapabilityID(null)}
        onSaveGates={requestGateSave}
        server={selectedCapability ? serverByID.get(selectedCapability.upstreamServerId || "") : undefined}
      />

      <ConfirmDialog
        confirmLabel={deleteMutation.isPending ? "删除中..." : "确认删除"}
        description={
          capabilityToDelete
            ? `确认删除能力“${capabilityToDelete.exposedName}”？删除后无法恢复${
                capabilityToDelete.grantCount > 0 ? `，并会一并删除 ${capabilityToDelete.grantCount} 条关联授权` : ""
              }。`
            : ""
        }
        error={deleteMutation.isError ? deleteMutation.error.message : undefined}
        onClose={() => {
          if (!deleteMutation.isPending) setCapabilityToDelete(null);
        }}
        onConfirm={() => {
          if (capabilityToDelete) deleteMutation.mutate(capabilityToDelete.id);
        }}
        open={Boolean(capabilityToDelete)}
        pending={deleteMutation.isPending}
        title="删除已缺失能力"
        variant="destructive"
      />

      <ModalShell
        contextLabel="MCP 网关"
        onClose={closeRename}
        open={Boolean(renameState)}
        subtitle="待审核能力可直接编辑；正常且无授权时可改名；已有授权的正常能力需要先处理授权。"
        title="编辑暴露名称"
      >
        {renameState ? (
          <form className="grid gap-4" onSubmit={submitRename}>
            <KeyValueList
              items={[
                { label: "current", value: renameState.capability.exposedName },
                { label: "status", value: renameState.capability.status || "-" },
                { label: "grants", value: renameState.capability.grantCount }
              ]}
            />
            <FormField label="新的 exposed_name">
              <Input
                aria-label="新的 exposed_name"
                value={renameState.value}
                onChange={(event) => setRenameState({ ...renameState, value: event.target.value, error: null })}
              />
            </FormField>
            {renameState.capability.status === "active" && renameState.capability.grantCount === 0 ? (
              <>
                <Alert variant="warning">
                  <AlertDescription>
                    <p>active 能力改名会改变智能体调用入口。请输入当前 exposed_name 以确认 rename。</p>
                  </AlertDescription>
                </Alert>
                <FormField label="确认当前 exposed_name">
                  <Input
                    aria-label="确认当前 exposed_name"
                    value={renameState.confirmation}
                    onChange={(event) => setRenameState({ ...renameState, confirmation: event.target.value, error: null })}
                  />
                </FormField>
              </>
            ) : null}
            {renameState.error ? (
              <ErrorAlert>{renameState.error}</ErrorAlert>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button disabled={renameMutation.isPending} onClick={closeRename} variant="secondary">
                取消
              </Button>
              <Button disabled={renameMutation.isPending} type="submit" variant="primary">
                {renameMutation.isPending ? "保存中..." : "保存 rename"}
              </Button>
            </div>
          </form>
        ) : null}
      </ModalShell>

      <ModalShell
        contextLabel="MCP 网关"
        onClose={closeGatesConfirm}
        open={Boolean(gatesDraft)}
        subtitle="门禁策略会改变智能体调用能力时是否进入审批或确认流程。"
        title="确认保存门禁策略"
      >
        {gatesDraft ? (
          <div className="grid gap-4">
            <KeyValueList
              items={[
                { label: "capability_id", value: gatesDraft.capability.id },
                { label: "exposed_name", value: gatesDraft.capability.exposedName },
                { label: "status", value: gatesDraft.capability.status || "-" }
              ]}
            />
            <Alert variant="warning">
              <AlertDescription className="grid gap-2 font-mono text-xs">
                {pendingGateChanges.map((change) => (
                  <div key={change}>{change}</div>
                ))}
              </AlertDescription>
            </Alert>
            {gatesMutation.isError ? (
              <ErrorAlert>{gatesMutation.error.message}</ErrorAlert>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button disabled={gatesMutation.isPending} onClick={closeGatesConfirm} variant="secondary">
                取消
              </Button>
              <Button disabled={gatesMutation.isPending} onClick={submitGates} variant="destructive">
                {gatesMutation.isPending ? "保存中..." : "确认保存"}
              </Button>
            </div>
          </div>
        ) : null}
      </ModalShell>
    </PageShell>
  );
}

function CapabilityDrawer({
  canManage,
  canReadAudits,
  canReadGrants,
  capability,
  gatesError,
  gatesPending,
  server,
  onSaveGates,
  onClose
}: {
  canManage: boolean;
  canReadAudits: boolean;
  canReadGrants: boolean;
  capability: CapabilityRowView | null;
  gatesError: string | null;
  gatesPending: boolean;
  server?: MCPUpstreamServer;
  onSaveGates: (draft: GatesDraft) => void;
  onClose: () => void;
}) {
  const agentDisplayMetadata = capability && server
    ? resolveAgentDisplayMetadata(capability, server)
    : null;
  const relatedGrantsQuery = useQuery({
    enabled: canReadGrants && Boolean(capability?.id),
    queryKey: ["mcp-grants", { capability_id: capability?.id }],
    queryFn: () => listMCPGrants({ capabilityId: capability?.id })
  });

  return (
    <DetailDrawer
      contextLabel="能力详情"
      onClose={onClose}
      open={Boolean(capability)}
      subtitle={capability ? `${capability.type || "-"} · ${server?.name || capability.upstreamServerId || "-"}` : ""}
      title={capability?.exposedName || ""}
    >
      {capability ? (
        <>
          <Card>
            <CardHeader className="flex flex-row items-start justify-between">
              <CardTitle>原始元数据与治理</CardTitle>
              <Badge variant="muted">Collector</Badge>
            </CardHeader>
            <CardContent>
              <KeyValueList
                items={[
                  { label: "capability_id", value: capability.id },
                  { label: "upstream_server_id", value: capability.upstreamServerId || "-" },
                  { label: "type", value: capability.type || "-" },
                  { label: "upstream_name", value: capability.upstreamName || "-" },
                  { label: "exposed_name", value: capability.exposedName },
                  { label: "title", value: capability.title || "-" },
                  { label: "description", value: capability.description || "-" },
                  { label: "schema_hash", value: capability.schemaHash || "-" },
                  { label: "version", value: capability.version || "-" },
                  { label: "status", value: capability.status || (capability.missingButGranted ? "missing_but_granted" : "-") },
                  { label: "risk_level", value: capability.riskLevel || "-" },
                  { label: "read_only", value: formatBool(capability.readOnly) },
                  { label: "destructive", value: formatBool(capability.destructive) },
                  { label: "idempotent", value: formatBool(capability.idempotent) },
                  { label: "approval_required", value: formatBool(capability.approvalRequired) },
                  { label: "confirm_required", value: formatBool(capability.confirmRequired) },
                  { label: "confirm_template", value: capability.confirmTemplate || "-" }
                ]}
              />
            </CardContent>
          </Card>

          {capability.upstreamName === "codex.ask" && agentDisplayMetadata ? (
            <Card>
              <CardHeader className="flex flex-row items-start justify-between">
                <CardTitle>对 Agent 展示预览</CardTitle>
                <Badge variant="secondary">codex.ask</Badge>
              </CardHeader>
              <CardContent>
                <KeyValueList
                  items={[
                    { label: "title", value: agentDisplayMetadata.title || "-" },
                    { label: "description", value: agentDisplayMetadata.description || "-" }
                  ]}
                />
              </CardContent>
            </Card>
          ) : null}

          {canManage ? <CapabilityGateSettings
            capability={capability}
            error={gatesError}
            isPending={gatesPending}
            key={capability.id}
            onSave={onSaveGates}
          /> : null}

          <Card>
            <CardHeader>
              <CardTitle>结构定义</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="[&_pre]:max-h-[360px]">
                <JsonTabs
                  tabs={[
                    { id: "input_schema", label: "input_schema", value: capability.inputSchema ?? {} },
                    { id: "output_schema", label: "output_schema", value: capability.outputSchema ?? {} },
                    { id: "annotations", label: "annotations", value: capability.annotations ?? {} }
                  ]}
                />
              </div>
            </CardContent>
          </Card>

          {canReadGrants ? <Card>
            <CardHeader className="flex flex-row items-start justify-between">
              <div>
                <CardTitle>关联授权</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">展示当前能力关联的授权。</p>
              </div>
              <Badge variant={capability.grantCount > 0 ? "success" : "muted"}>{capability.grantCount} 条授权</Badge>
            </CardHeader>
            <CardContent>
              {relatedGrantsQuery.isLoading ? <LoadingState label="..." /> : null}
              {relatedGrantsQuery.isError ? (
                <ErrorAlert>{relatedGrantsQuery.error.message}</ErrorAlert>
              ) : null}
              {!relatedGrantsQuery.isLoading && !relatedGrantsQuery.isError ? (
                <GrantList grants={relatedGrantsQuery.data ?? capability.grants} />
              ) : null}
            </CardContent>
          </Card> : null}

          {canReadAudits ? <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to={`/admin/mcp/audits?tool=${encodeURIComponent(capability.exposedName)}`}>
                最近调用
                <ExternalLink aria-hidden="true" />
              </Link>
            </Button>
          </div> : null}
        </>
      ) : null}
    </DetailDrawer>
  );
}

function resolveAgentDisplayMetadata(capability: CapabilityRowView, server: MCPUpstreamServer) {
  const serverName = server.name.trim();
  if (capability.upstreamName !== "codex.ask" || !serverName) {
    return { title: capability.title, description: capability.description };
  }

  const routingDescription = server.routingDescription?.trim() ?? "";
  return {
    title: `委派给${serverName}`,
    description: `将任务委派给${serverName}。${routingDescription}`
  };
}

function CapabilityGateSettings({
  capability,
  error,
  isPending,
  onSave
}: {
  capability: CapabilityRowView;
  error: string | null;
  isPending: boolean;
  onSave: (draft: GatesDraft) => void;
}) {
  const [approvalRequired, setApprovalRequired] = useState(Boolean(capability.approvalRequired));
  const [confirmRequired, setConfirmRequired] = useState(Boolean(capability.confirmRequired));
  const hasChanges =
    approvalRequired !== Boolean(capability.approvalRequired) || confirmRequired !== Boolean(capability.confirmRequired);

  return (
    <Card>
      <CardHeader>
        <CardTitle>门禁策略</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          门禁策略会在能力被调用时生效；非 active 能力可预先配置。
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <BooleanSwitch
            checked={approvalRequired}
            label="approval_required"
            onChange={setApprovalRequired}
          />
          <BooleanSwitch
            checked={confirmRequired}
            label="confirm_required"
            onChange={setConfirmRequired}
          />
        </div>
        {error ? (
          <ErrorAlert>{error}</ErrorAlert>
        ) : null}
        <div className="flex justify-end">
          <Button
            disabled={!hasChanges || isPending}
            onClick={() => onSave({ capability, approvalRequired, confirmRequired })}
            variant="primary"
          >
            {isPending ? "保存中..." : "保存门禁策略"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function GrantList({ grants }: { grants: MCPGrant[] }) {
  if (grants.length === 0) {
    return <EmptyState title="暂无关联授权。" />;
  }

  return (
    <ResourceList>
      {grants.map((grant) => (
        <ResourceItem
          key={grant.id}
          meta={`账户 ${compactGrantAgentID(grant.userId)} · 创建人 ${grant.createdBy || "-"}`}
          title={grantTypeLabel(grant.grantType)}
        >
          <div className="grid gap-2 text-xs">
            <span>有效期：{grant.expiresAt ? formatDateTime(grant.expiresAt) : "永不过期"}</span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-medium text-foreground">技术 ID</span>
              <code className="min-w-0 flex-1 truncate font-mono" title={grant.id}>{grant.id}</code>
              <CopyButton
                aria-label={`复制授权 ID ${grant.id}`}
                label="复制 ID"
                size="sm"
                value={grant.id}
                variant="outline"
              />
            </div>
          </div>
        </ResourceItem>
      ))}
    </ResourceList>
  );
}

function grantTypeLabel(grantType: string): string {
  if (grantType === "tool") return "工具授权";
  if (grantType === "server") return "上游服务授权";
  return "授权";
}

function compactGrantAgentID(agentID: string): string {
  if (agentID.length <= 36) return agentID;
  return `${agentID.slice(0, 18)}…${agentID.slice(-12)}`;
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Label className="grid gap-2 text-sm">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      {children}
    </Label>
  );
}

function BooleanSwitch({
  checked,
  label,
  onChange
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Card className="shadow-none">
      <Label className="flex items-center justify-between gap-3 p-4">
        <span>
          <span className="block font-mono text-xs text-foreground">{label}</span>
          <span className="mt-1 block font-mono text-xs text-muted-foreground">{checked ? "true" : "false"}</span>
        </span>
        <input
          aria-label={label}
          checked={checked}
          className="h-4 w-4"
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
      </Label>
    </Card>
  );
}

function filterCapabilityRows(
  rows: CapabilityRowView[],
  filters: {
    query?: string;
    status?: string;
    upstreamServerId?: string;
    domain?: string;
    type?: string;
    riskLevel?: string;
    hasGrants?: string;
    missingButGranted?: string;
  }
) {
  const completeRows = rows.filter((row): row is CapabilityRowView & MCPCapability => !row.missingButGranted && Boolean(row.status));
  const completeIDs = new Set(
    filterCapabilities(completeRows, {
      query: filters.query,
      status: filters.status,
      upstreamServerId: filters.upstreamServerId,
      domain: filters.domain,
      type: filters.type,
      riskLevel: filters.riskLevel
    }).map((row) => row.id)
  );
  const query = filters.query?.trim().toLowerCase() ?? "";

  return rows.filter((row) => {
    const matchesComplete = !row.missingButGranted && completeIDs.has(row.id);
    const matchesMissingButGranted =
      row.missingButGranted &&
      (!query || row.id.toLowerCase().includes(query) || row.exposedName.toLowerCase().includes(query)) &&
      !filters.status &&
      !filters.upstreamServerId &&
      !filters.domain &&
      !filters.type &&
      !filters.riskLevel;

    return (
      (matchesComplete || matchesMissingButGranted) &&
      (!filters.hasGrants ||
        (filters.hasGrants === "with_grants" ? row.grantCount > 0 : row.grantCount === 0)) &&
      (!filters.missingButGranted ||
        (filters.missingButGranted === "yes" ? row.missingButGranted : !row.missingButGranted))
    );
  });
}

function canOpenRename(capability: CapabilityRowView) {
  return capability.status === "pending" || capability.status === "active";
}

function gateChanges(capability: CapabilityRowView, draft: Pick<GatesDraft, "approvalRequired" | "confirmRequired">) {
  const changes: string[] = [];
  if (Boolean(capability.approvalRequired) !== draft.approvalRequired) {
    changes.push(`approval_required: ${formatBool(capability.approvalRequired)} -> ${formatBool(draft.approvalRequired)}`);
  }
  if (Boolean(capability.confirmRequired) !== draft.confirmRequired) {
    changes.push(`confirm_required: ${formatBool(capability.confirmRequired)} -> ${formatBool(draft.confirmRequired)}`);
  }
  return changes;
}

function serverLabel(serverByID: Map<string, MCPUpstreamServer>, serverId?: string) {
  if (!serverId) return "-";
  const server = serverByID.get(serverId);
  return server?.name || serverId;
}

function formatBool(value?: boolean) {
  if (value === undefined) return "-";
  return value ? "true" : "false";
}

function uniqueOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}
