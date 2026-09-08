import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";

import {
  DataTableShell,
  DetailDrawer,
  FilterRow,
  FilterSearchField,
  FilterSelect,
  JsonTabs,
  KeyValueList,
  MetricCard,
  PageHeader,
  PageShell,
  TableStateRow
} from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { useAdminPermission } from "@/components/admin-permissions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  listMCPAgents,
  listMCPAudits,
  listMCPCapabilities,
  listMCPUpstreamServers,
  type MCPAudit
} from "@/lib/mcp-admin-api";
import { decisionLabel, decisionVariant, formatDateTime, formatDuration, redactHeaders } from "@/lib/mcp-admin-ui";
import { permissions } from "@/lib/rbac-api";
import { readQueryParam, updateQueryParams } from "@/lib/url-state";
import { cn } from "@/lib/utils";

const auditLimit = 200;
const decisionOptions = ["all", "allowed", "rejected", "upstream_error", "internal_error"] as const;

export function MCPProxyAuditPage() {
  const canReadAgents = useAdminPermission(permissions.agentRead);
  const canReadUpstreams = useAdminPermission(permissions.mcpUpstreamRead);
  const canReadCapabilities = useAdminPermission(permissions.mcpCapabilityRead);
  const location = useLocation();
  const navigate = useNavigate();
  const decision = readQueryParam(location.search, "decision") ?? "all";
  const agentID = readQueryParam(location.search, "agent_id") ?? "all";
  const upstreamServerID = readQueryParam(location.search, "upstream_server_id") ?? "all";
  const tool = readQueryParam(location.search, "tool") ?? "";
  const createdFrom = readQueryParam(location.search, "created_from") ?? "";
  const createdTo = readQueryParam(location.search, "created_to") ?? "";
  const auditID = readQueryParam(location.search, "audit_id") ?? "";
  const traceID = readQueryParam(location.search, "trace_id") ?? "";
  const createdFromInput = toDateTimeLocalInputValue(createdFrom);
  const createdToInput = toDateTimeLocalInputValue(createdTo);
  const errorOnly = readQueryParam(location.search, "error_only") === "true";
  const [selectedAuditID, setSelectedAuditID] = useState<string | null>(null);

  const auditFilters = useMemo(
    () => ({
      ...(decision !== "all" ? { decision } : {}),
      ...(agentID !== "all" ? { agentId: agentID } : {}),
      ...(upstreamServerID !== "all" ? { upstreamServerId: upstreamServerID } : {}),
      ...(tool.trim() ? { tool: tool.trim() } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {}),
      ...(errorOnly ? { errorOnly: true } : {}),
      limit: auditLimit
    }),
    [agentID, createdFrom, createdTo, decision, errorOnly, tool, upstreamServerID]
  );

  const auditsQuery = useQuery({
    queryKey: ["mcp-audits", auditFilters],
    queryFn: () => listMCPAudits(auditFilters)
  });
  const agentsQuery = useQuery({
    queryKey: ["mcp-agents"],
    queryFn: () => listMCPAgents(),
    enabled: canReadAgents
  });
  const serversQuery = useQuery({
    queryKey: ["mcp-upstream-servers"],
    queryFn: () => listMCPUpstreamServers(),
    enabled: canReadUpstreams
  });
  const capabilitiesQuery = useQuery({
    queryKey: ["mcp-capabilities"],
    queryFn: () => listMCPCapabilities(),
    enabled: canReadCapabilities
  });

  const audits = auditsQuery.data ?? [];
  const visibleAudits = useMemo(
    () =>
      filterVisibleAudits(audits, {
        agentID,
        auditID,
        createdFrom,
        createdTo,
        decision,
        errorOnly,
        tool,
        traceID,
        upstreamServerID
      }),
    [agentID, auditID, audits, createdFrom, createdTo, decision, errorOnly, tool, traceID, upstreamServerID]
  );
  const agents = agentsQuery.data ?? [];
  const servers = serversQuery.data ?? [];
  const capabilities = capabilitiesQuery.data ?? [];
  const serverByID = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers]);
  const selectedAudit = visibleAudits.find((audit) => audit.id === selectedAuditID) ?? null;
  const isLoading = auditsQuery.isLoading;
  const hasLoadError = auditsQuery.isError;
  const summary = useMemo(() => deriveAuditSummary(visibleAudits), [visibleAudits]);

  function updateFilter(next: {
    decision?: string;
    agent_id?: string;
    upstream_server_id?: string;
    tool?: string;
    created_from?: string;
    created_to?: string;
    error_only?: boolean;
  }) {
    const updates: Record<string, string | boolean | null> = {
      audit_id: null,
      trace_id: null
    };
    if ("decision" in next) updates.decision = next.decision === "all" ? null : next.decision ?? null;
    if ("agent_id" in next) updates.agent_id = next.agent_id === "all" ? null : next.agent_id ?? null;
    if ("upstream_server_id" in next) {
      updates.upstream_server_id = next.upstream_server_id === "all" ? null : next.upstream_server_id ?? null;
    }
    if ("tool" in next) updates.tool = next.tool ?? null;
    if ("created_from" in next) updates.created_from = next.created_from ?? null;
    if ("created_to" in next) updates.created_to = next.created_to ?? null;
    if ("error_only" in next) updates.error_only = next.error_only ? true : null;

    navigate({
      pathname: location.pathname,
      search: updateQueryParams(location.search, updates)
    });
  }

  return (
    <PageShell>
      <PageHeader title="代理审计">
        企业智能体通过 MCP Gateway 调用企业系统的审计证据页。本页只展示代理调用、授权决策和上下游请求响应证据。
      </PageHeader>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard foot={`当前展示 ${visibleAudits.length} 条记录`} label="24 小时代理调用" value={isLoading ? "..." : summary.recent24h} />
        <MetricCard foot="裁决结果为允许" label="已放行" value={isLoading ? "..." : summary.allowed} />
        <MetricCard foot="裁决结果为拒绝" label="已拒绝" value={isLoading ? "..." : summary.rejected} />
        <MetricCard foot="上游错误或带 error 的调用" label="上游异常" value={isLoading ? "..." : summary.upstreamError} />
      </section>

      <Card>
        <CardHeader className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle>代理审计记录</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">按智能体、上游服务、工具、时间范围和错误状态查询审计记录。</p>
          </div>
          <Badge variant="muted">{visibleAudits.length} 条可见</Badge>
        </CardHeader>
        <CardContent>
          <FilterRow>
            <FilterSelect ariaLabel="筛选审计裁决结果" value={decision} onChange={(value) => updateFilter({ decision: value })}>
              {decisionOptions.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "全部裁决结果" : decisionLabel(option)}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect ariaLabel="筛选审计智能体" value={agentID} onChange={(value) => updateFilter({ agent_id: value })}>
              <option value="all">全部智能体</option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name || agent.agentId}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              ariaLabel="筛选审计上游服务"
              className="sm:w-56"
              value={upstreamServerID}
              onChange={(value) => updateFilter({ upstream_server_id: value })}
            >
              <option value="all">全部上游服务</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name || server.id}
                </option>
              ))}
            </FilterSelect>
            <FilterSearchField
              aria-label="筛选审计工具"
              list="mcp-audit-tool-options"
              placeholder="工具 / exposed_name"
              value={tool}
              onChange={(event) => updateFilter({ tool: event.target.value })}
            >
              <datalist id="mcp-audit-tool-options">
                {capabilities.map((capability) => (
                  <option key={capability.id} value={capability.exposedName} />
                ))}
              </datalist>
            </FilterSearchField>
            <Input
              aria-label="筛选审计开始时间"
              className="w-full sm:w-56"
              placeholder="开始时间"
              type="datetime-local"
              value={createdFromInput}
              onChange={(event) => updateFilter({ created_from: fromDateTimeLocalInputValue(event.target.value) })}
            />
            <Input
              aria-label="筛选审计结束时间"
              className="w-full sm:w-56"
              placeholder="结束时间"
              type="datetime-local"
              value={createdToInput}
              onChange={(event) => updateFilter({ created_to: fromDateTimeLocalInputValue(event.target.value) })}
            />
            <Card className="h-9 justify-center px-3 shadow-none">
              <Label className="flex items-center gap-2 text-sm" htmlFor="error-only-filter">
                <Checkbox
                  aria-label="仅看错误"
                  checked={errorOnly}
                  id="error-only-filter"
                  onCheckedChange={(checked) => updateFilter({ error_only: checked === true })}
                />
                仅看错误
              </Label>
            </Card>
          </FilterRow>

          <DataTableShell dense minWidth={1780}>
            <TableHeader>
              <TableRow className="bg-background font-mono text-xs text-muted-foreground">
                {[
                  "创建时间",
                  "裁决结果",
                  "智能体 ID",
                  "操作者 ID",
                  "租户 ID",
                  "暴露名称",
                  "上游服务",
                  "上游名称",
                  "耗时",
                  "追踪 ID",
                  "错误",
                  "操作"
                ].map((heading) => (
                  <TableHead className="border-b border-border px-3 py-3 font-medium" key={heading}>
                    {heading}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? <TableStateRow colSpan={12}>代理审计加载中</TableStateRow> : null}
              {!isLoading && hasLoadError ? (
                <TableStateRow colSpan={12} tone="danger">
                  代理审计加载失败
                </TableStateRow>
              ) : null}
              {!isLoading && !hasLoadError && visibleAudits.length === 0 ? (
                <TableStateRow colSpan={12}>暂无代理审计记录</TableStateRow>
              ) : null}
              {!isLoading && !hasLoadError
                ? visibleAudits.map((audit) => (
                    <TableRow
                      className={cn("hover:bg-foreground/[0.03]", selectedAuditID === audit.id && "bg-primary/5")}
                      key={audit.id}
                    >
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{formatDateTime(audit.createdAt)}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <Badge variant={decisionVariant(audit.decision)}>{decisionLabel(audit.decision)}</Badge>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{audit.agentId || "-"}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{audit.actorId || "-"}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{audit.tenantId || "-"}</TableCell>
                      <TableCell className="max-w-[240px] border-b border-border px-3 py-3 font-mono text-xs">
                        <span className="block truncate" title={audit.exposedName}>
                          {audit.exposedName || "-"}
                        </span>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">
                        {serverLabel(serverByID, audit.upstreamServerId)}
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{audit.upstreamName || "-"}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{formatDuration(audit.durationMs)}</TableCell>
                      <TableCell className="max-w-[220px] border-b border-border px-3 py-3 font-mono text-xs">
                        <span className="block truncate" title={audit.traceId}>
                          {audit.traceId || "-"}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[220px] border-b border-border px-3 py-3 font-mono text-xs">
                        <span className="block truncate" title={audit.error}>
                          {audit.error || "-"}
                        </span>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <Button onClick={() => setSelectedAuditID(audit.id)} variant="secondary">
                          详情
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                : null}
            </TableBody>
          </DataTableShell>
        </CardContent>
      </Card>

      <AuditDrawer audit={selectedAudit} onClose={() => setSelectedAuditID(null)} serverName={serverLabel(serverByID, selectedAudit?.upstreamServerId)} />
    </PageShell>
  );
}

function AuditDrawer({
  audit,
  serverName,
  onClose
}: {
  audit: MCPAudit | null;
  serverName: string;
  onClose: () => void;
}) {
  return (
    <DetailDrawer
      contextLabel="代理追踪"
      onClose={onClose}
      open={Boolean(audit)}
      subtitle={audit ? `${audit.agentId || "-"} · ${serverName}` : ""}
      title={audit?.traceId || ""}
    >
      {audit ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>追踪字段</CardTitle>
            </CardHeader>
            <CardContent>
              <KeyValueList
                items={[
                  { label: "trace_id", value: audit.traceId || "-" },
                  { label: "request_id", value: audit.requestId || "-" },
                  { label: "inbound_session_id", value: audit.inboundSessionId || "-" },
                  { label: "upstream_session_id", value: audit.upstreamSessionId || "-" },
                  { label: "agent_id", value: audit.agentId || "-" },
                  { label: "actor_id", value: audit.actorId || "-" },
                  { label: "tenant_id", value: audit.tenantId || "-" },
                  { label: "token_id", value: audit.tokenId || "-" },
                  { label: "token_hash", value: audit.tokenHash || "-" },
                  { label: "upstream_server_id", value: audit.upstreamServerId || "-" },
                  { label: "capability_id", value: audit.capabilityId || "-" },
                  { label: "exposed_name", value: audit.exposedName || "-" },
                  { label: "upstream_name", value: audit.upstreamName || "-" },
                  { label: "decision", value: audit.decision || "-" },
                  { label: "decision_reason", value: audit.decisionReason || "-" },
                  { label: "error", value: audit.error || "-" },
                  { label: "duration_ms", value: audit.durationMs },
                  { label: "created_at", value: formatDateTime(audit.createdAt) },
                  { label: "completed_at", value: formatDateTime(audit.completedAt) }
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>JSON 证据</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="[&_pre]:max-h-[420px]">
                <JsonTabs
                  tabs={[
                    { id: "request_headers", label: "request_headers", value: redactHeaders(audit.requestHeaders) ?? {} },
                    { id: "request_body", label: "request_body", value: audit.requestBody ?? {} },
                    { id: "response_headers", label: "response_headers", value: redactHeaders(audit.responseHeaders) ?? {} },
                    { id: "response_body", label: "response_body", value: audit.responseBody ?? {} }
                  ]}
                />
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </DetailDrawer>
  );
}

function deriveAuditSummary(audits: MCPAudit[]) {
  const recentSince = Date.now() - 24 * 60 * 60 * 1000;
  const recentAudits = audits.filter((audit) => {
    const createdAt = new Date(audit.createdAt).getTime();
    return !Number.isNaN(createdAt) && createdAt >= recentSince;
  });

  return {
    recent24h: recentAudits.length,
    allowed: recentAudits.filter((audit) => decisionVariant(audit.decision) === "success").length,
    rejected: recentAudits.filter((audit) => decisionVariant(audit.decision) === "danger").length,
    upstreamError: recentAudits.filter((audit) => decisionVariant(audit.decision) === "warning" || Boolean(audit.error)).length
  };
}

function filterVisibleAudits(
  audits: MCPAudit[],
  filters: {
    agentID: string;
    auditID: string;
    createdFrom: string;
    createdTo: string;
    decision: string;
    errorOnly: boolean;
    tool: string;
    traceID: string;
    upstreamServerID: string;
  }
) {
  return audits.filter((audit) => {
    return (
      (!filters.auditID || audit.id === filters.auditID) &&
      (!filters.traceID || audit.traceId === filters.traceID) &&
      (filters.decision === "all" || audit.decision === filters.decision) &&
      (filters.agentID === "all" || audit.agentId === filters.agentID) &&
      (filters.upstreamServerID === "all" || audit.upstreamServerId === filters.upstreamServerID) &&
      (!filters.tool || audit.exposedName === filters.tool || audit.upstreamName === filters.tool) &&
      (!filters.errorOnly || Boolean(audit.error)) &&
      (!filters.createdFrom || isAtOrAfter(audit.createdAt, filters.createdFrom)) &&
      (!filters.createdTo || isAtOrBefore(audit.createdAt, filters.createdTo))
    );
  });
}

function isAtOrAfter(value: string, threshold: string) {
  const valueTime = new Date(value).getTime();
  const thresholdTime = new Date(threshold).getTime();
  return Number.isNaN(valueTime) || Number.isNaN(thresholdTime) || valueTime >= thresholdTime;
}

function isAtOrBefore(value: string, threshold: string) {
  const valueTime = new Date(value).getTime();
  const thresholdTime = new Date(threshold).getTime();
  return Number.isNaN(valueTime) || Number.isNaN(thresholdTime) || valueTime <= thresholdTime;
}

function serverLabel(serverByID: Map<string, { name: string }>, serverId?: string) {
  if (!serverId) return "-";
  return serverByID.get(serverId)?.name || serverId;
}

function toDateTimeLocalInputValue(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function fromDateTimeLocalInputValue(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}
