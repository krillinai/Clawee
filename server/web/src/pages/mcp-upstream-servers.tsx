import { AlertTriangle, Edit3, ExternalLink, Eye, Plus, Power, PowerOff, RefreshCw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";

import {
  ConfirmDialog,
  DataTableShell,
  DetailDrawer,
  ErrorAlert,
  FilterRow,
  FilterSearchField,
  FilterSelect,
  KeyValueList,
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
import { NativeSelect } from "@/components/ui/native-select";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  createUpstreamServer,
  deleteMCPUpstreamServer,
  listMCPAudits,
  listMCPCapabilities,
  listMCPGrants,
  listMCPUpstreamServers,
  syncMCPUpstreamTools,
  updateMCPUpstreamServer,
  updateMCPUpstreamServerStatus,
  type CreateUpstreamServerInput,
  type MCPAudit,
  type MCPCapability,
  type MCPUpstreamServer
} from "@/lib/mcp-admin-api";
import {
  decisionVariant,
  filterUpstreamServers,
  formatDateTime,
  formatDuration,
  mcpStatusLabel,
  mcpStatusVariant,
  parseMCPServerConfigImport,
  parseStdioEnvJSON
} from "@/lib/mcp-admin-ui";
import { readQueryParam, updateQueryParams } from "@/lib/url-state";
import { permissions } from "@/lib/rbac-api";

const statusOptions = ["all", "active", "disabled", "sync_failed"] as const;
const transportOptions = ["streamable_http", "collector_pull", "sse", "stdio", "builtin"] as const;
const upstreamServersQueryKey = ["mcp-upstream-servers"] as const;
const capabilitiesQueryKey = ["mcp-capabilities"] as const;
const grantsQueryKey = ["mcp-grants"] as const;
const auditsQueryKey = ["mcp-audits", { limit: 200 }] as const;

type CreateServerForm = CreateUpstreamServerInput;
type ServerFormMode = "create" | "edit";
type ServerFormState = {
  mode: ServerFormMode;
  serverId: string | null;
};
type DeleteConfirmState = {
  server: MCPUpstreamServer;
  step: "requires-disable" | "confirm-delete";
};

const emptyCreateServerForm: CreateServerForm = {
  serverId: "",
  name: "",
  domain: "",
  transport: "streamable_http",
  endpoint: "",
  stdio: {
    command: "",
    args: [],
    cwd: "",
    env: {}
  },
  namespace: "",
  ownerTeam: "",
  routingDescription: "",
  collectorId: "",
  token: ""
};

export function MCPUpstreamServersPage() {
  const canManage = useAdminPermission(permissions.mcpUpstreamManage);
  const canReadCapabilities = useAdminPermission(permissions.mcpCapabilityRead);
  const canReadGrants = useAdminPermission(permissions.mcpGrantRead);
  const canReadAudits = useAdminPermission(permissions.mcpAuditRead);
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = readQueryParam(location.search, "q") ?? "";
  const status = readQueryParam(location.search, "status") ?? "all";
  const domain = readQueryParam(location.search, "domain") ?? "all";
  const transport = readQueryParam(location.search, "transport") ?? "all";
  const [selectedServerID, setSelectedServerID] = useState<string | null>(() => readQueryParam(location.search, "server_id"));
  const [serverFormState, setServerFormState] = useState<ServerFormState | null>(null);
  const [deleteConfirmState, setDeleteConfirmState] = useState<DeleteConfirmState | null>(null);
  const [createForm, setCreateForm] = useState<CreateServerForm>(emptyCreateServerForm);
  const [stdioConfigText, setStdioConfigText] = useState("");
  const [stdioArgsText, setStdioArgsText] = useState("[]");
  const [stdioEnvText, setStdioEnvText] = useState("{}");
  const [stdioFormError, setStdioFormError] = useState("");

  const serversQuery = useQuery({
    queryKey: upstreamServersQueryKey,
    queryFn: () => listMCPUpstreamServers()
  });
  const capabilitiesQuery = useQuery({
    queryKey: capabilitiesQueryKey,
    queryFn: () => listMCPCapabilities(),
    enabled: canReadCapabilities
  });
  const grantsQuery = useQuery({
    queryKey: grantsQueryKey,
    queryFn: () => listMCPGrants(),
    enabled: canReadGrants
  });
  const auditsQuery = useQuery({
    queryKey: auditsQueryKey,
    queryFn: () => listMCPAudits({ limit: 200 }),
    enabled: canReadAudits
  });

  const createMutation = useMutation({
    mutationFn: createUpstreamServer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: upstreamServersQueryKey });
      setCreateForm(emptyCreateServerForm);
      setServerFormState(null);
    }
  });
  const updateMutation = useMutation({
    mutationFn: ({ serverId, input }: { serverId: string; input: CreateServerForm }) =>
      updateMCPUpstreamServer(serverId, input),
    onSuccess: (server) => {
      queryClient.invalidateQueries({ queryKey: upstreamServersQueryKey });
      setCreateForm(emptyCreateServerForm);
      setServerFormState(null);
      setSelectedServerID(server.id);
    }
  });
  const deleteMutation = useMutation({
    mutationFn: (serverId: string) => deleteMCPUpstreamServer(serverId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: upstreamServersQueryKey });
      queryClient.invalidateQueries({ queryKey: capabilitiesQueryKey });
      queryClient.invalidateQueries({ queryKey: grantsQueryKey });
      queryClient.invalidateQueries({ queryKey: auditsQueryKey });
      setDeleteConfirmState(null);
      setSelectedServerID(null);
    }
  });
  const syncMutation = useMutation({
    mutationFn: (serverId: string) => syncMCPUpstreamTools(serverId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: upstreamServersQueryKey });
      queryClient.invalidateQueries({ queryKey: capabilitiesQueryKey });
      queryClient.invalidateQueries({ queryKey: auditsQueryKey });
    }
  });
  const statusMutation = useMutation({
    mutationFn: ({ serverId, nextStatus }: { serverId: string; nextStatus: string }) =>
      updateMCPUpstreamServerStatus(serverId, nextStatus),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: upstreamServersQueryKey });
    }
  });

  const servers = serversQuery.data ?? [];
  const capabilities = capabilitiesQuery.data ?? [];
  const grants = grantsQuery.data ?? [];
  const audits = auditsQuery.data ?? [];
  const filterValues = useMemo(() => ({
    query,
    status: status === "all" ? undefined : status,
    domain: domain === "all" ? undefined : domain
  }), [domain, query, status]);
  const filteredServers = useMemo(() => {
    const baseServers = filterUpstreamServers(servers, filterValues);
    if (transport === "all") return baseServers;
    return baseServers.filter((server) => server.transport === transport);
  }, [filterValues, servers, transport]);
  const selectedServer = servers.find((server) => server.id === selectedServerID) ?? null;
  const selectedServerContext = selectedServer
    ? buildServerContext(selectedServer, capabilities, grants, audits)
    : null;
  const domainOptions = useMemo(() => uniqueOptions(servers.map((server) => server.domain)), [servers]);
  const upstreamErrors = audits.filter((audit) => isUpstreamError(audit));
  const lastSyncAt = latestTimestamp(servers.map((server) => server.lastSyncedAt));
  const isLoading = serversQuery.isLoading || (canReadCapabilities && capabilitiesQuery.isLoading) || (canReadAudits && auditsQuery.isLoading);
  const hasLoadError = serversQuery.isError || capabilitiesQuery.isError || grantsQuery.isError || auditsQuery.isError;

  function updateFilter(next: { q?: string; status?: string; domain?: string; transport?: string }) {
    const updates: Record<string, string | null> = {};
    if ("q" in next) updates.q = next.q ?? null;
    if ("status" in next) updates.status = next.status === "all" ? null : next.status ?? null;
    if ("domain" in next) updates.domain = next.domain === "all" ? null : next.domain ?? null;
    if ("transport" in next) updates.transport = next.transport === "all" ? null : next.transport ?? null;

    navigate({
      pathname: location.pathname,
      search: updateQueryParams(location.search, updates)
    });
  }

  function selectServer(serverId: string | null) {
    if (serverId !== selectedServerID) {
      syncMutation.reset();
      statusMutation.reset();
    }
    setSelectedServerID(serverId);
  }

  function openCreateModal() {
    createMutation.reset();
    updateMutation.reset();
    setCreateForm(emptyCreateServerForm);
    setStdioConfigText("");
    setStdioArgsText("[]");
    setStdioEnvText("{}");
    setStdioFormError("");
    setServerFormState({ mode: "create", serverId: null });
  }

  function openEditModal(server: MCPUpstreamServer) {
    createMutation.reset();
    updateMutation.reset();
    setCreateForm({
      serverId: server.id,
      name: server.name,
      domain: server.domain,
      transport: server.transport || "streamable_http",
      endpoint: server.endpoint,
      stdio: {
        command: server.stdio?.command ?? "",
        args: server.stdio?.args ?? [],
        cwd: server.stdio?.cwd ?? "",
        env: server.stdio?.env ?? {}
      },
      namespace: server.namespace,
      ownerTeam: server.ownerTeam,
      routingDescription: server.routingDescription ?? "",
      collectorId: server.collectorId ?? "",
      token: ""
    });
    setStdioConfigText("");
    setStdioArgsText(JSON.stringify(server.stdio?.args ?? [], null, 2));
    setStdioEnvText(JSON.stringify(server.stdio?.env ?? {}, null, 2));
    setStdioFormError("");
    setServerFormState({ mode: "edit", serverId: server.id });
  }

  function closeServerFormModal() {
    if (createMutation.isPending || updateMutation.isPending) return;
    setServerFormState(null);
  }

  function submitServerForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!serverFormState) return;
    setStdioFormError("");
    let stdio = sanitizeStdioConfig(createForm);
    if (createForm.transport === "stdio") {
      try {
        stdio = {
          command: createForm.stdio?.command?.trim() ?? "",
          cwd: createForm.stdio?.cwd?.trim() ?? "",
          args: parseStringArrayJSON(stdioArgsText),
          env: parseStdioEnvJSON(stdioEnvText)
        };
      } catch (error) {
        setStdioFormError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    const input = {
      ...createForm,
      serverId: createForm.serverId.trim(),
      name: createForm.name.trim(),
      domain: createForm.domain.trim(),
      endpoint: createForm.endpoint.trim(),
      stdio,
      namespace: createForm.namespace.trim(),
      ownerTeam: createForm.ownerTeam.trim(),
      routingDescription: createForm.routingDescription?.trim() ?? "",
      collectorId: createForm.collectorId?.trim() ?? "",
      token: createForm.token?.trim() ?? ""
    };
    if (serverFormState.mode === "edit" && serverFormState.serverId) {
      updateMutation.mutate({ serverId: serverFormState.serverId, input });
    } else {
      createMutation.mutate(input);
    }
  }

  function openDeleteConfirm(server: MCPUpstreamServer) {
    deleteMutation.reset();
    statusMutation.reset();
    setDeleteConfirmState({
      server,
      step: server.status === "disabled" ? "confirm-delete" : "requires-disable"
    });
  }

  function closeDeleteConfirm() {
    if (deleteMutation.isPending || statusMutation.isPending) return;
    setDeleteConfirmState(null);
  }

  function confirmDisableBeforeDelete() {
    if (!deleteConfirmState) return;
    statusMutation.mutate(
      { serverId: deleteConfirmState.server.id, nextStatus: "disabled" },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: upstreamServersQueryKey });
          setDeleteConfirmState({
            server: { ...deleteConfirmState.server, status: "disabled" },
            step: "confirm-delete"
          });
        }
      }
    );
  }

  function confirmDeleteServer() {
    if (!deleteConfirmState) return;
    deleteMutation.mutate(deleteConfirmState.server.id);
  }

  function importStdioConfig() {
    try {
      const imported = parseMCPServerConfigImport(stdioConfigText);
      setCreateForm((form) => ({
        ...form,
        serverId: form.serverId || imported.serverId,
        name: form.name || imported.serverId,
        transport: "stdio",
        stdio: imported.stdio
      }));
      setStdioArgsText(JSON.stringify(imported.stdio.args ?? [], null, 2));
      setStdioEnvText(JSON.stringify(imported.stdio.env ?? {}, null, 2));
      setStdioFormError("");
    } catch (error) {
      setStdioFormError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <PageShell>
      <PageHeader
        actions={canManage ?
          <Button onClick={openCreateModal} variant="primary">
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            新增上游服务
          </Button> : undefined
        }
        title="上游服务"
      >
        管理企业现有 MCP 上游服务接入。这里登记的是智能体与企业系统之间的治理入口，上游工具保存后仍需同步、
        审核和授权，才会暴露给智能体使用。
      </PageHeader>

      {hasLoadError ? (
        <ErrorAlert>
          MCP 上游服务加载失败：无法加载上游服务、工具、授权或代理审计数据。
        </ErrorAlert>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          foot={`${servers.filter((server) => server.status === "active").length} 正常，${
            servers.filter((server) => server.status === "disabled").length
          } 已停用，${servers.filter((server) => server.status === "sync_failed").length} 同步失败`}
          label="服务"
          value={serversQuery.isLoading ? "..." : servers.length}
        />
        <MetricCard
          foot={`${capabilities.filter((capability) => capability.status === "active").length} 正常，${
            capabilities.filter((capability) => capability.status === "pending").length
          } 待审核，${capabilities.filter((capability) => capability.status === "missing").length} 已缺失`}
          label="工具"
          value={capabilitiesQuery.isLoading ? "..." : capabilities.length}
        />
        <MetricCard
          foot="最近一次上游工具同步时间"
          label="最近同步"
          value={serversQuery.isLoading ? "..." : formatDateTime(lastSyncAt)}
        />
        <MetricCard
          foot="最近 200 条代理审计中的上游异常或内部异常"
          label="上游异常"
          value={auditsQuery.isLoading ? "..." : upstreamErrors.length}
        />
      </section>

      <Card>
        <CardHeader className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle>上游服务列表</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              点击行查看同步结果、缺失工具、授权影响和最近上游异常。
            </p>
          </div>
          <Badge variant="muted">{filteredServers.length} 条可见</Badge>
        </CardHeader>
        <CardContent>
          <FilterRow>
            <FilterSearchField
              aria-label="搜索服务 ID / 接入地址 / 负责团队"
              placeholder="搜索服务 ID / 接入地址 / 负责团队"
              value={query}
              onChange={(event) => updateFilter({ q: event.target.value })}
            />
            <FilterSelect
              ariaLabel="筛选上游服务状态"
              value={status}
              onChange={(value) => updateFilter({ status: value })}
            >
              {statusOptions.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "全部状态" : mcpStatusLabel(option)}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              ariaLabel="筛选上游服务领域"
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
              ariaLabel="筛选上游服务传输方式"
              value={transport}
              onChange={(value) => updateFilter({ transport: value })}
            >
              <option value="all">全部传输方式</option>
              {transportOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </FilterSelect>
          </FilterRow>

          <DataTableShell dense minWidth={1280}>
            <TableHeader>
              <TableRow className="bg-background font-mono text-xs text-muted-foreground hover:bg-background">
                {[
                  "服务 ID",
                  "名称",
                  "领域",
                  "传输方式",
                  "接入地址",
                  "命名空间",
                  "状态",
                  "能力数",
                  "最近同步时间",
                  "最近同步结果",
                  "负责团队",
                  "操作"
                ].map((heading) => (
                  <TableHead className="border-b border-border px-3 py-3 font-medium" key={heading}>
                    {heading}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? <TableStateRow colSpan={12}>...</TableStateRow> : null}
              {!isLoading && hasLoadError ? (
                <TableStateRow colSpan={12} tone="danger">
                  上游服务加载失败。
                </TableStateRow>
              ) : null}
              {!isLoading && !hasLoadError && filteredServers.length === 0 ? (
                <TableStateRow colSpan={12}>暂无匹配的上游服务。</TableStateRow>
              ) : null}
              {!isLoading && !hasLoadError
                ? filteredServers.map((server) => (
                    <TableRow key={server.id}>
                      <TableCell className="max-w-[220px] border-b border-border px-3 py-3 font-mono text-xs">
                        <span className="block truncate" title={server.id}>
                          {server.id}
                        </span>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3">{server.name}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{server.domain || "-"}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{server.transport || "-"}</TableCell>
                      <TableCell className="max-w-[280px] border-b border-border px-3 py-3 font-mono text-xs">
                        <span className="block truncate" title={server.endpoint}>
                          {server.endpoint || "-"}
                        </span>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{server.namespace || "-"}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <Badge variant={mcpStatusVariant(server.status)}>{mcpStatusLabel(server.status)}</Badge>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">
                        {server.capabilitiesCount ?? capabilitiesByServer(capabilities, server.id).length}
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">
                        {formatDateTime(server.lastSyncedAt)}
                      </TableCell>
                      <TableCell className="max-w-[240px] border-b border-border px-3 py-3 font-mono text-xs">
                        <span className="block truncate" title={server.lastSyncResult || ""}>
                          {server.lastSyncResult || "-"}
                        </span>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">
                        {server.ownerTeam || "-"}
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <div className="flex items-center gap-2">
                          <Button
                            aria-label={`查看 ${server.id} 详情`}
                            onClick={() => selectServer(server.id)}
                            size="sm"
                            variant="secondary"
                          >
                            <Eye aria-hidden="true" />
                            查看详情
                          </Button>
                          {canManage && server.transport !== "builtin" ? <Button
                            aria-label={`编辑 ${server.id}`}
                            onClick={() => openEditModal(server)}
                            size="sm"
                            variant="secondary"
                          >
                            <Edit3 aria-hidden="true" />
                          </Button> : null}
                          {canManage && server.transport !== "builtin" ? <Button
                            aria-label={`删除 ${server.id}`}
                            onClick={() => openDeleteConfirm(server)}
                            size="sm"
                            variant="destructive"
                          >
                            <Trash2 aria-hidden="true" />
                          </Button> : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                : null}
            </TableBody>
          </DataTableShell>
        </CardContent>
      </Card>

      <DetailDrawer
        contextLabel="上游服务详情"
        onClose={() => selectServer(null)}
        open={Boolean(selectedServer)}
        subtitle={selectedServer ? `${selectedServer.domain || "-"} · ${selectedServer.transport === "collector_pull" ? selectedServer.collectorId || "-" : selectedServer.endpoint || "-"}` : ""}
        title={selectedServer?.name || selectedServer?.id || ""}
      >
        {selectedServer && selectedServerContext ? (
          <>
            <Card>
              <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <CardTitle>基础信息</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    保存上游服务只登记接入点，不会自动同步或向智能体暴露工具。
                  </p>
                </div>
                {canManage ? <div className="flex flex-wrap items-center gap-2">
                  {selectedServer.transport !== "builtin" ? <Button onClick={() => openEditModal(selectedServer)} size="sm" variant="secondary">
                    <Edit3 className="mr-2 h-4 w-4" aria-hidden="true" />
                    编辑
                  </Button> : null}
                  {selectedServer.transport !== "builtin" ? <Button
                    onClick={() => openDeleteConfirm(selectedServer)}
                    size="sm"
                    variant="destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                    删除
                  </Button> : null}
                  <Button
                    disabled={syncMutation.isPending}
                    onClick={() => syncMutation.mutate(selectedServer.id)}
                    size="sm"
                    variant="secondary"
                  >
                    <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                    同步工具
                  </Button>
                  {selectedServer.transport !== "builtin" ? <Button
                    disabled={statusMutation.isPending}
                    onClick={() =>
                      statusMutation.mutate({
                        serverId: selectedServer.id,
                        nextStatus: selectedServer.status === "active" ? "disabled" : "active"
                      })
                    }
                    size="sm"
                    variant={selectedServer.status === "active" ? "secondary" : "primary"}
                  >
                    {selectedServer.status === "active" ? (
                      <PowerOff className="mr-2 h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Power className="mr-2 h-4 w-4" aria-hidden="true" />
                    )}
                    {selectedServer.status === "active" ? "禁用" : "启用"}
                  </Button> : null}
                </div> : null}
              </CardHeader>
              <CardContent className="grid gap-4">
                <KeyValueList
                  items={[
                    { label: "server_id", value: selectedServer.id },
                    { label: "名称", value: selectedServer.name || "-" },
                    { label: "domain", value: selectedServer.domain || "-" },
                    { label: "transport", value: selectedServer.transport || "-" },
                    { label: "endpoint", value: selectedServer.endpoint || "-" },
                    { label: "collector_id", value: selectedServer.collectorId || "-" },
                    { label: "mcp_endpoint", value: <EndpointValue value={selectedServer.mcpEndpoint} /> },
                    ...(selectedServer.mcpCanonicalEndpoint && selectedServer.mcpCanonicalEndpoint !== selectedServer.mcpEndpoint
                      ? [{ label: "canonical_mcp_endpoint", value: <EndpointValue value={selectedServer.mcpCanonicalEndpoint} /> }]
                      : []),
                    { label: "namespace", value: selectedServer.namespace || "-" },
                    { label: "routing_description", value: selectedServer.routingDescription || "-" },
                    { label: "status", value: selectedServer.status || "-" },
                    { label: "owner_team", value: selectedServer.ownerTeam || "-" },
                    { label: "last_synced_at", value: formatDateTime(selectedServer.lastSyncedAt) },
                    { label: "last_sync_result", value: selectedServer.lastSyncResult || "-" },
                    { label: "capabilities", value: selectedServerContext.capabilities.length },
                    { label: "related_grants", value: grantsQuery.isLoading ? "..." : selectedServerContext.relatedGrantCount }
                  ]}
                />
                {syncMutation.isError || statusMutation.isError ? (
                  <ErrorAlert>
                    {syncMutation.error?.message || statusMutation.error?.message || "上游服务操作失败"}
                  </ErrorAlert>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  {canReadCapabilities ? <Button asChild variant="outline">
                    <Link to={`/admin/mcp/capabilities?server_id=${encodeURIComponent(selectedServer.id)}`}>
                      能力目录
                      <ExternalLink aria-hidden="true" />
                    </Link>
                  </Button> : null}
                  {canReadAudits ? <Button asChild variant="outline">
                    <Link to={`/admin/mcp/audits?upstream_server_id=${encodeURIComponent(selectedServer.id)}`}>
                      代理审计
                      <ExternalLink aria-hidden="true" />
                    </Link>
                  </Button> : null}
                </div>
              </CardContent>
            </Card>

            {canReadCapabilities ? <Card>
              <CardHeader className="flex flex-row items-start justify-between">
                <div>
                  <CardTitle>缺失工具</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    该上游服务下已缺失的能力，通常表示上游同步后不再返回。
                  </p>
                </div>
                <Badge variant={selectedServerContext.missingCapabilities.length > 0 ? "warning" : "muted"}>
                  {selectedServerContext.missingCapabilities.length} 个已缺失
                </Badge>
              </CardHeader>
              <CardContent>
                {selectedServerContext.missingCapabilities.length > 0 ? (
                  <ResourceList>
                    {selectedServerContext.missingCapabilities.map((capability) => (
                      <ResourceItem
                        key={capability.id}
                        meta={`${capability.upstreamName || "-"} · ${capability.riskLevel || "unknown"} · ${mcpStatusLabel(capability.status)}`}
                        title={capability.exposedName}
                      />
                    ))}
                  </ResourceList>
                ) : (
                  <p className="text-sm text-muted-foreground">暂无缺失工具。</p>
                )}
              </CardContent>
            </Card> : null}

            {canReadAudits ? <Card>
              <CardHeader className="flex flex-row items-start justify-between">
                <div>
                  <CardTitle>最近上游异常</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    从最近 200 条代理审计中按 upstreamServerID 关联。
                  </p>
                </div>
                <Badge variant={selectedServerContext.recentErrors.length > 0 ? "warning" : "muted"}>
                  {selectedServerContext.recentErrors.length} errors
                </Badge>
              </CardHeader>
              <CardContent>
                {selectedServerContext.recentErrors.length > 0 ? (
                  <ResourceList>
                    {selectedServerContext.recentErrors.map((audit) => (
                      <Alert key={audit.id} variant="warning">
                        <AlertDescription>
                          <ResourceItem
                            meta={`${formatDateTime(audit.createdAt)} · ${audit.exposedName || "-"} · ${formatDuration(
                              audit.durationMs
                            )}`}
                            title={
                              <span className="inline-flex items-center gap-2">
                                <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
                                {audit.decision}
                              </span>
                            }
                          >
                            {audit.error || audit.decisionReason || "-"}
                          </ResourceItem>
                        </AlertDescription>
                      </Alert>
                    ))}
                  </ResourceList>
                ) : (
                  <p className="text-sm text-muted-foreground">暂无上游异常。</p>
                )}
              </CardContent>
            </Card> : null}
          </>
        ) : null}
      </DetailDrawer>

      <ModalShell
        contextLabel="MCP 网关"
        onClose={closeServerFormModal}
        open={Boolean(serverFormState)}
        subtitle="保存只登记上游服务，不会自动同步工具，也不会把工具暴露给智能体。"
        title={serverFormState?.mode === "edit" ? "编辑上游服务" : "新增上游服务"}
      >
        <form className="grid gap-4" onSubmit={submitServerForm}>
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="server_id" required>
              <Input
                aria-label="server_id"
                disabled={serverFormState?.mode === "edit"}
                required
                value={createForm.serverId}
                onChange={(event) => setCreateForm((form) => ({ ...form, serverId: event.target.value }))}
              />
            </FormField>
            <FormField label="名称" required>
              <Input
                aria-label="名称"
                required
                value={createForm.name}
                onChange={(event) => setCreateForm((form) => ({ ...form, name: event.target.value }))}
              />
            </FormField>
            <FormField label="domain">
              <Input
                value={createForm.domain}
                onChange={(event) => setCreateForm((form) => ({ ...form, domain: event.target.value }))}
              />
            </FormField>
            <FormField label="transport">
              <NativeSelect
                className="bg-card"
                value={createForm.transport}
                onChange={(event) => setCreateForm((form) => {
                  const nextTransport = event.target.value;
                  return {
                    ...form,
                    transport: nextTransport,
                    endpoint: nextTransport === "collector_pull" ? "" : form.endpoint,
                    collectorId: nextTransport === "collector_pull" ? form.collectorId : "",
                    token: nextTransport === "streamable_http" ? form.token : ""
                  };
                })}
              >
                {transportOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            {createForm.transport !== "collector_pull" ? (
              <FormField label="endpoint">
                <Input
                  value={createForm.endpoint}
                  onChange={(event) => setCreateForm((form) => ({ ...form, endpoint: event.target.value }))}
                />
              </FormField>
            ) : (
              <FormField label="collector_id" required>
                <Input
                  aria-label="collector_id"
                  required
                  value={createForm.collectorId ?? ""}
                  onChange={(event) => setCreateForm((form) => ({ ...form, collectorId: event.target.value }))}
                />
              </FormField>
            )}
            {createForm.transport === "streamable_http" ? (
              <FormField label="token">
                <Input
                  aria-label="token"
                  autoComplete="off"
                  placeholder={
                    serverFormState?.mode === "edit" &&
                    servers.find((server) => server.id === serverFormState.serverId)?.hasToken
                      ? "已配置"
                      : undefined
                  }
                  type="password"
                  value={createForm.token ?? ""}
                  onChange={(event) => setCreateForm((form) => ({ ...form, token: event.target.value }))}
                />
              </FormField>
            ) : null}
            {createForm.transport === "stdio" ? (
              <>
                <div className="md:col-span-2">
                  <FormField label="mcp config json">
                    <Textarea
                      className="min-h-32 font-mono text-xs"
                      value={stdioConfigText}
                      onChange={(event) => setStdioConfigText(event.target.value)}
                    />
                  </FormField>
                  <div className="mt-2 flex justify-end">
                    <Button onClick={importStdioConfig} type="button" variant="secondary">
                      导入 MCP JSON
                    </Button>
                  </div>
                </div>
                <FormField label="stdio.command" required>
                  <Input
                    required
                    value={createForm.stdio?.command ?? ""}
                    onChange={(event) => setCreateForm((form) => ({
                      ...form,
                      stdio: { ...form.stdio, command: event.target.value }
                    }))}
                  />
                </FormField>
                <FormField label="stdio.args">
                  <Textarea
                    className="min-h-20 font-mono text-xs"
                    value={stdioArgsText}
                    onChange={(event) => setStdioArgsText(event.target.value)}
                  />
                </FormField>
                <FormField label="stdio.cwd">
                  <Input
                    value={createForm.stdio?.cwd ?? ""}
                    onChange={(event) => setCreateForm((form) => ({
                      ...form,
                      stdio: { ...form.stdio, cwd: event.target.value }
                    }))}
                  />
                </FormField>
                <FormField label="stdio.env json">
                  <Textarea
                    className="min-h-28 font-mono text-xs"
                    value={stdioEnvText}
                    onChange={(event) => setStdioEnvText(event.target.value)}
                  />
                </FormField>
              </>
            ) : null}
            <FormField label="namespace">
              <Input
                value={createForm.namespace}
                onChange={(event) => setCreateForm((form) => ({ ...form, namespace: event.target.value }))}
              />
            </FormField>
            <FormField label="owner_team">
              <Input
                aria-label="owner_team"
                value={createForm.ownerTeam}
                onChange={(event) => setCreateForm((form) => ({ ...form, ownerTeam: event.target.value }))}
              />
            </FormField>
            <div className="md:col-span-2">
              <FormField label="负责内容">
                <Textarea
                  aria-label="负责内容"
                  className="min-h-24"
                  placeholder="例如：负责代码分析、架构设计、功能实现、测试和故障定位。"
                  value={createForm.routingDescription ?? ""}
                  onChange={(event) => setCreateForm((form) => ({ ...form, routingDescription: event.target.value }))}
                />
              </FormField>
            </div>
          </div>
          {stdioFormError ? (
            <ErrorAlert>{stdioFormError}</ErrorAlert>
          ) : null}
          {createMutation.isError || updateMutation.isError ? (
            <ErrorAlert>
              {createMutation.error?.message || updateMutation.error?.message || "上游服务保存失败"}
            </ErrorAlert>
          ) : null}
          <Alert variant="muted">
            <AlertDescription>
              保存后请手动执行同步工具；工具同步、审核和授权完成前，不会暴露给智能体。
            </AlertDescription>
          </Alert>
          <div className="flex justify-end gap-2">
            <Button
              disabled={createMutation.isPending || updateMutation.isPending}
              onClick={closeServerFormModal}
              variant="secondary"
            >
              取消
            </Button>
            <Button disabled={createMutation.isPending || updateMutation.isPending} type="submit" variant="primary">
              {createMutation.isPending || updateMutation.isPending ? "保存中..." : "保存"}
            </Button>
          </div>
        </form>
      </ModalShell>
      {deleteConfirmState?.step === "requires-disable" ? (
        <ModalShell
          contextLabel="确认操作"
          onClose={closeDeleteConfirm}
          open
          title="删除上游服务"
        >
          <div className="grid gap-4">
            <p className="text-sm text-foreground">删除前需要先禁用该上游服务。</p>
            <KeyValueList
              items={[
                { label: "server_id", value: deleteConfirmState.server.id },
                { label: "status", value: deleteConfirmState.server.status }
              ]}
            />
            {deleteMutation.isError || statusMutation.isError ? (
              <ErrorAlert>
                {deleteMutation.error?.message || statusMutation.error?.message || "上游服务删除失败"}
              </ErrorAlert>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                disabled={deleteMutation.isPending || statusMutation.isPending}
                onClick={closeDeleteConfirm}
                variant="secondary"
              >
                取消
              </Button>
              <Button disabled={statusMutation.isPending} onClick={confirmDisableBeforeDelete} variant="destructive">
                {statusMutation.isPending ? "处理中..." : "先禁用"}
              </Button>
            </div>
          </div>
        </ModalShell>
      ) : null}
      <ConfirmDialog
        confirmLabel={deleteMutation.isPending ? "删除中..." : "确认删除"}
        description="删除后该上游服务默认不再出现在列表中，历史能力、授权和审计记录仍保留。"
        onClose={closeDeleteConfirm}
        onConfirm={confirmDeleteServer}
        open={deleteConfirmState?.step === "confirm-delete"}
        pending={deleteMutation.isPending}
        title="删除上游服务"
        variant="destructive"
      />
    </PageShell>
  );
}

function FormField({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <Label className="grid gap-2 text-sm">
      <span className="font-mono text-xs text-muted-foreground">
        {label}
        {required ? " *" : ""}
      </span>
      {children}
    </Label>
  );
}

function EndpointValue({ value }: { value?: string }) {
  if (!value) return <>-</>;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 break-all">{value}</span>
      <CopyButton aria-label={`复制 ${value}`} label="复制" size="sm" value={value} variant="outline" />
    </div>
  );
}

function sanitizeStdioConfig(form: CreateServerForm) {
  if (form.transport !== "stdio") return undefined;
  return {
    command: form.stdio?.command?.trim() ?? "",
    args: form.stdio?.args ?? [],
    cwd: form.stdio?.cwd?.trim() ?? "",
    env: form.stdio?.env ?? {}
  };
}

function parseStringArrayJSON(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("stdio.args must be a JSON array");
  }
  return parsed.map((item) => String(item));
}

function buildServerContext(
  server: MCPUpstreamServer,
  capabilities: MCPCapability[],
  grants: { capabilityId: string }[],
  audits: MCPAudit[]
) {
  const serverCapabilities = capabilitiesByServer(capabilities, server.id);
  const capabilityIDs = new Set(serverCapabilities.map((capability) => capability.id));
  return {
    capabilities: serverCapabilities,
    missingCapabilities: serverCapabilities.filter((capability) => capability.status === "missing"),
    relatedGrantCount: grants.filter((grant) => capabilityIDs.has(grant.capabilityId)).length,
    recentErrors: audits.filter((audit) => audit.upstreamServerId === server.id && isUpstreamError(audit)).slice(0, 5)
  };
}

function capabilitiesByServer(capabilities: MCPCapability[], serverId: string) {
  return capabilities.filter((capability) => capability.upstreamServerId === serverId);
}

function uniqueOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function latestTimestamp(values: Array<string | null | undefined>) {
  const timestamps = values.filter((value): value is string => {
    if (!value) return false;
    return !Number.isNaN(new Date(value).getTime());
  });
  if (timestamps.length === 0) return null;
  return timestamps.reduce((latest, value) =>
    new Date(value).getTime() > new Date(latest).getTime() ? value : latest
  );
}

function isUpstreamError(audit: MCPAudit) {
  return Boolean(audit.error) || decisionVariant(audit.decision) === "warning";
}
