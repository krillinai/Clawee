import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";

import { useAdminPermission } from "@/components/admin-permissions";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isForbiddenError } from "@/lib/api";
import {
  getModelProxyAudit,
  listModelProxyAudits,
  summarizeModelProxyAudits,
  type ModelProxyAudit,
  type ModelProxyAuditFilters,
  type ModelProxyAuditSummary
} from "@/lib/model-proxy-admin-api";
import { permissions } from "@/lib/rbac-api";
import { formatDateTime, formatDuration, redactHeaders } from "@/lib/mcp-admin-ui";
import { readQueryParam, updateQueryParams } from "@/lib/url-state";

const auditLimit = 100;
const statusOptions = [
  ["all", "全部状态"],
  ["started", "进行中"],
  ["succeeded", "成功"],
  ["failed", "失败"],
  ["client_disconnected", "客户端断开"],
  ["rejected_api_key", "API Key 拒绝"],
  ["rejected_scope", "权限拒绝"],
  ["rejected_account", "账号拒绝"],
  ["rejected_configuration", "配置拒绝"]
] as const;
const usageStatusOptions = [
  ["all", "全部 usage"],
  ["complete", "usage 完整"],
  ["partial", "usage 部分"],
  ["unavailable", "usage 不可用"]
] as const;

export function ModelProxyAuditPage() {
  const canRead = useAdminPermission(permissions.mcpAuditRead);
  const location = useLocation();
  const navigate = useNavigate();
  const defaultTimeRange = useMemo(() => {
    const createdTo = new Date();
    const createdFrom = new Date(createdTo.getTime() - 24 * 60 * 60 * 1000);
    return { createdFrom: createdFrom.toISOString(), createdTo: createdTo.toISOString() };
  }, []);
  const userId = readQueryParam(location.search, "user_id") ?? "";
  const model = readQueryParam(location.search, "model") ?? "";
  const endpoint = readQueryParam(location.search, "endpoint") ?? "all";
  const status = readQueryParam(location.search, "status") ?? "all";
  const createdFrom = readQueryParam(location.search, "created_from") ?? defaultTimeRange.createdFrom;
  const createdTo = readQueryParam(location.search, "created_to") ?? defaultTimeRange.createdTo;
  const errorOnly = readQueryParam(location.search, "error_only") === "true";
  const usageStatusValue = readQueryParam(location.search, "usage_status");
  const usageStatus: ModelProxyAuditFilters["usageStatus"] | "all" = usageStatusValue === "complete" || usageStatusValue === "partial" || usageStatusValue === "unavailable" ? usageStatusValue : "all";
  const usageSourceValue = readQueryParam(location.search, "usage_source");
  const usageSource: ModelProxyAuditFilters["usageSource"] | "all" = usageSourceValue === "upstream" || usageSourceValue === "estimated" || usageSourceValue === "unavailable" ? usageSourceValue : "all";
  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null);

  const filters = useMemo(
    () => ({
      limit: auditLimit,
      ...(userId.trim() ? { userId: userId.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(endpoint !== "all" ? { endpoint } : {}),
      ...(status !== "all" ? { status } : {}),
      ...(usageStatus !== "all" ? { usageStatus } : {}),
      ...(usageSource !== "all" ? { usageSource } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {}),
      ...(errorOnly ? { errorOnly: true } : {})
    }),
    [createdFrom, createdTo, endpoint, errorOnly, model, status, usageSource, usageStatus, userId]
  );
  const summaryFilters = useMemo(() => {
    const { limit: _limit, ...summary } = filters;
    return summary;
  }, [filters]);
  const auditsQuery = useQuery({
    enabled: canRead,
    queryKey: ["model-proxy-audits", filters],
    queryFn: () => listModelProxyAudits(filters)
  });
  const summaryQuery = useQuery({
    enabled: canRead,
    queryKey: ["model-proxy-audit-summary", summaryFilters],
    queryFn: () => summarizeModelProxyAudits(summaryFilters)
  });
  const detailQuery = useQuery({
    enabled: canRead && Boolean(selectedAuditId),
    queryKey: ["model-proxy-audit", selectedAuditId],
    queryFn: () => getModelProxyAudit(selectedAuditId as string)
  });

  const audits = auditsQuery.data?.items ?? [];
  const summaries = summaryQuery.data ?? [];
  const totals = useMemo(() => summarizeTotals(summaries), [summaries]);

  function updateFilter(next: Record<string, string | boolean | null>) {
    navigate({ pathname: location.pathname, search: updateQueryParams(location.search, next) });
  }

  return (
    <PageShell>
      <PageHeader title="全部日志">
        查看所有下游用户的模型请求、响应、模型和 Token 使用量。默认展示最近 24 小时，API Key 只显示指纹，请求体中的密钥和多模态内容只保存脱敏摘要。
      </PageHeader>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="请求总数" value={auditsQuery.isLoading ? "..." : totals.requests} foot="当前汇总范围" />
        <MetricCard label="成功率" value={auditsQuery.isLoading ? "..." : `${Math.round(totals.successRate * 100)}%`} foot="按用户和模型汇总" />
        <MetricCard label="输入 Token" value={auditsQuery.isLoading ? "..." : totals.inputTokens.toLocaleString()} foot="仅统计有 usage 的响应" />
        <MetricCard label="输出 Token" value={auditsQuery.isLoading ? "..." : totals.outputTokens.toLocaleString()} foot="仅统计有 usage 的响应" />
        <MetricCard label="usage 覆盖率" value={auditsQuery.isLoading ? "..." : `${Math.round(totals.usageCoverageRate * 100)}%`} foot="完整或部分 usage" />
        <MetricCard label="缓存读取" value={auditsQuery.isLoading ? "..." : totals.cacheReadTokens.toLocaleString()} foot="输入 Token 子集" />
      </section>

      <Card>
        <CardHeader className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle>模型请求记录</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">API Key 只显示指纹；请求和响应内容遵循网关脱敏及摘要策略。</p>
          </div>
          <Badge variant="muted">{audits.length} 条记录</Badge>
        </CardHeader>
        <CardContent>
          <FilterRow>
            <FilterSearchField
              aria-label="筛选用户"
              className="sm:w-56"
              placeholder="用户名 / user_id"
              value={userId}
              onChange={(event) => updateFilter({ user_id: event.target.value || null })}
            />
            <FilterSearchField
              aria-label="筛选模型"
              className="sm:w-56"
              placeholder="模型名"
              value={model}
              onChange={(event) => updateFilter({ model: event.target.value || null })}
            />
            <FilterSelect ariaLabel="筛选接口" value={endpoint} onChange={(value) => updateFilter({ endpoint: value === "all" ? null : value })}>
              <option value="all">全部接口</option>
              <option value="/v1/models">模型列表</option>
              <option value="/v1/chat/completions">Chat Completions</option>
              <option value="/v1/responses">Responses</option>
            </FilterSelect>
            <FilterSelect ariaLabel="筛选状态" value={status} onChange={(value) => updateFilter({ status: value === "all" ? null : value })}>
              {statusOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect ariaLabel="筛选 usage 状态" value={usageStatus} onChange={(value) => updateFilter({ usage_status: value === "all" ? null : value })}>
              {usageStatusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </FilterSelect>
            <Input
              aria-label="筛选开始时间"
              className="w-full sm:w-56"
              type="datetime-local"
              value={toDateTimeLocalInputValue(createdFrom)}
              onChange={(event) => updateFilter({ created_from: fromDateTimeLocalInputValue(event.target.value) || null })}
            />
            <Input
              aria-label="筛选结束时间"
              className="w-full sm:w-56"
              type="datetime-local"
              value={toDateTimeLocalInputValue(createdTo)}
              onChange={(event) => updateFilter({ created_to: fromDateTimeLocalInputValue(event.target.value) || null })}
            />
            <div className="flex h-9 items-center rounded-md border border-border bg-card px-3">
              <Label className="flex items-center gap-2 text-sm" htmlFor="model-audit-error-only">
                <Checkbox
                  aria-label="仅看错误"
                  checked={errorOnly}
                  id="model-audit-error-only"
                  onCheckedChange={(checked) => updateFilter({ error_only: checked === true ? true : null })}
                />
                仅看错误
              </Label>
            </div>
          </FilterRow>

          <DataTableShell dense minWidth={1180}>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>用户</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>接口</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>上游状态</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>耗时</TableHead>
                <TableHead>详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auditsQuery.isLoading ? <TableStateRow colSpan={9}>模型审计加载中</TableStateRow> : null}
              {auditsQuery.isError ? (
                <TableStateRow colSpan={9} tone="danger">
                  {isForbiddenError(auditsQuery.error) ? "当前账号没有模型审计查看权限" : "模型审计加载失败"}
                </TableStateRow>
              ) : null}
              {!auditsQuery.isLoading && !auditsQuery.isError && audits.length === 0 ? <TableStateRow colSpan={9}>暂无模型调用记录</TableStateRow> : null}
              {audits.map((audit) => (
                <ModelAuditRow audit={audit} key={audit.auditId} onOpen={() => setSelectedAuditId(audit.auditId)} />
              ))}
            </TableBody>
          </DataTableShell>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>用户与模型汇总</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTableShell dense embedded minWidth={760}>
            <TableHeader>
              <TableRow>
                <TableHead>用户</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>请求数</TableHead>
                <TableHead>成功率</TableHead>
                <TableHead>输入 Token</TableHead>
                <TableHead>输出 Token</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summaryQuery.isLoading ? <TableStateRow colSpan={6}>汇总加载中</TableStateRow> : null}
              {!summaryQuery.isLoading && summaries.length === 0 ? <TableStateRow colSpan={6}>暂无汇总数据</TableStateRow> : null}
              {summaries.map((summary) => (
                <SummaryRow key={`${summary.userId}:${summary.model}`} summary={summary} />
              ))}
            </TableBody>
          </DataTableShell>
        </CardContent>
      </Card>

      <ModelAuditDrawer audit={detailQuery.data ?? null} onClose={() => setSelectedAuditId(null)} />
    </PageShell>
  );
}

function ModelAuditRow({ audit, onOpen }: { audit: ModelProxyAudit; onOpen: () => void }) {
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{formatDateTime(audit.createdAt)}</TableCell>
      <TableCell>
        <span className="block max-w-[180px] truncate" title={audit.userId}>
          {audit.userNameSnapshot || audit.userId || "-"}
        </span>
      </TableCell>
      <TableCell className="font-mono text-xs">{audit.model || "-"}</TableCell>
      <TableCell className="font-mono text-xs">{audit.endpoint}</TableCell>
      <TableCell>
        <Badge variant={modelAuditStatusVariant(audit.status)}>{modelAuditStatusLabel(audit.status)}</Badge>
      </TableCell>
      <TableCell className="font-mono text-xs">{audit.upstreamStatus || "-"}</TableCell>
      <TableCell className="font-mono text-xs">
        {audit.usageAvailable ? `${audit.inputTokens.toLocaleString()} / ${audit.outputTokens.toLocaleString()}` : "-"}
        <span className="block text-[11px] text-muted-foreground">{audit.usageStatus ?? "unavailable"}</span>
      </TableCell>
      <TableCell className="font-mono text-xs">{formatDuration(audit.durationMs)}</TableCell>
      <TableCell>
        <Button size="sm" variant="ghost" onClick={onOpen}>
          查看
        </Button>
      </TableCell>
    </TableRow>
  );
}

function SummaryRow({ summary }: { summary: ModelProxyAuditSummary }) {
  return (
    <TableRow>
      <TableCell>{summary.userNameSnapshot || summary.userId || "-"}</TableCell>
      <TableCell className="font-mono text-xs">{summary.model || "-"}</TableCell>
      <TableCell className="font-mono text-xs">{summary.requestCount.toLocaleString()}</TableCell>
      <TableCell className="font-mono text-xs">{Math.round(summary.successRate * 100)}%</TableCell>
      <TableCell className="font-mono text-xs">{summary.inputTokens.toLocaleString()}</TableCell>
      <TableCell className="font-mono text-xs">{summary.outputTokens.toLocaleString()}</TableCell>
    </TableRow>
  );
}

function ModelAuditDrawer({ audit, onClose }: { audit: ModelProxyAudit | null; onClose: () => void }) {
  return (
    <DetailDrawer
      contextLabel="模型网关日志"
      onClose={onClose}
      open={Boolean(audit)}
      subtitle={audit ? `${audit.userNameSnapshot || audit.userId || "未知用户"} · ${audit.model || "未指定模型"}` : ""}
      title={audit?.auditId || ""}
    >
      {audit ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>请求字段</CardTitle>
            </CardHeader>
            <CardContent>
              <KeyValueList
                items={[
                  { label: "request_id", value: audit.requestId || "-" },
                  { label: "user_id", value: audit.userId || "-" },
                  { label: "user_name_snapshot", value: audit.userNameSnapshot || "-" },
                  { label: "api_key_id", value: audit.apiKeyId || "-" },
                  { label: "api_key_fingerprint", value: audit.apiKeyFingerprint || "-" },
                  { label: "endpoint", value: audit.endpoint },
                  { label: "model", value: audit.model || "-" },
                  { label: "requested_model", value: audit.requestedModel || "-" },
                  { label: "upstream_model", value: audit.upstreamModel || "-" },
                  { label: "response_model", value: audit.responseModel || "-" },
                  { label: "usage_status", value: audit.usageStatus || "unavailable" },
                  { label: "usage_source", value: audit.usageSource || "unavailable" },
                  { label: "input_tokens", value: audit.inputTokens },
                  { label: "output_tokens", value: audit.outputTokens },
                  { label: "cache_read_tokens", value: audit.cacheReadTokens ?? 0 },
                  { label: "cache_creation_tokens", value: audit.cacheCreationTokens ?? 0 },
                  { label: "reasoning_tokens", value: audit.reasoningTokens ?? 0 },
                  { label: "status", value: modelAuditStatusLabel(audit.status) },
                  { label: "error", value: audit.errorMessage || audit.errorCode || "-" },
                  { label: "duration_ms", value: audit.durationMs },
                  { label: "request_bytes", value: audit.requestBytes },
                  { label: "response_bytes", value: audit.responseBytes },
                  { label: "response_chunks", value: audit.responseChunks },
                  { label: "created_at", value: formatDateTime(audit.createdAt) },
                  { label: "completed_at", value: audit.completedAt ? formatDateTime(audit.completedAt) : "-" }
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

function summarizeTotals(summaries: ModelProxyAuditSummary[]) {
  const requests = summaries.reduce((total, item) => total + item.requestCount, 0);
  const succeeded = summaries.reduce((total, item) => total + item.succeededCount, 0);
  return {
    requests,
    successRate: requests > 0 ? succeeded / requests : 0,
    inputTokens: summaries.reduce((total, item) => total + item.inputTokens, 0),
    outputTokens: summaries.reduce((total, item) => total + item.outputTokens, 0),
    usageCoverageRate: requests > 0 ? summaries.reduce((total, item) => total + (item.usageCoverageRate ?? 0) * item.requestCount, 0) / requests : 0,
    cacheReadTokens: summaries.reduce((total, item) => total + (item.cacheReadTokens ?? 0), 0)
  };
}

function modelAuditStatusLabel(status: string) {
  return (({
      started: "进行中",
      succeeded: "成功",
      failed: "失败",
      client_disconnected: "客户端断开",
      rejected_api_key: "API Key 拒绝",
      rejected_scope: "权限拒绝",
      rejected_account: "账号拒绝",
      rejected_configuration: "配置拒绝"
    }[status] ?? status) || "未知");
}

function modelAuditStatusVariant(status: string): "success" | "danger" | "warning" | "muted" {
  if (status === "succeeded") return "success";
  if (status.startsWith("rejected") || status === "failed") return "danger";
  if (status === "client_disconnected") return "warning";
  return "muted";
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
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
