import { useQuery } from "@tanstack/react-query";

import { ErrorAlert, DataTableShell, LoadingState, MetricCard, PageHeader, PageShell, TableStateRow } from "@/components/governance-ui";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getMyModelUsage, type ModelUsageItem } from "@/lib/model-usage";

const queryKey = ["model-usage"] as const;

export function ModelUsagePage() {
  const usageQuery = useQuery({ queryKey, queryFn: () => getMyModelUsage() });
  const usage = usageQuery.data;
  const items = usage?.items ?? [];
  const summary = usage?.summary;

  return (
    <PageShell>
      <PageHeader title="模型使用日志">
        查看当前账号通过平台接入 Token 发起的模型请求、响应状态和 Token 使用情况。
      </PageHeader>

      {usageQuery.isLoading ? <LoadingState label="正在加载模型使用日志" /> : null}
      {usageQuery.isError ? <ErrorAlert error={usageQuery.error}>模型使用日志加载失败</ErrorAlert> : null}

      {!usageQuery.isLoading && !usageQuery.isError && usage ? (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-8">
            <MetricCard label="请求次数" value={summary?.requestCount.toLocaleString() ?? "0"} foot="全部历史请求" />
            <MetricCard label="成功率" value={`${Math.round((summary?.successRate ?? 0) * 100)}%`} foot="全部历史请求" />
            <MetricCard label="输入 Token" value={summary?.inputTokens.toLocaleString() ?? "0"} foot="仅统计有 usage 的响应" />
            <MetricCard label="输出 Token" value={summary?.outputTokens.toLocaleString() ?? "0"} foot="仅统计有 usage 的响应" />
            <MetricCard label="缓存读取" value={summary?.cacheReadTokens.toLocaleString() ?? "0"} foot="上游返回的缓存 Token" />
            <MetricCard label="缓存写入" value={summary?.cacheCreationTokens.toLocaleString() ?? "0"} foot="输入 Token 子集" />
            <MetricCard label="usage 覆盖率" value={`${Math.round((summary?.usageCoverageRate ?? 0) * 100)}%`} foot="完整或部分 usage" />
            <MetricCard label="总 Token" value={summary?.totalTokens.toLocaleString() ?? "0"} foot="输入 + 输出" />
          </section>

          <Card>
            <CardHeader>
              <CardTitle>最近调用</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">显示最近 50 条记录，不展示请求和响应正文。</p>
            </CardHeader>
            <CardContent>
              <DataTableShell dense minWidth={1450}>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>账号 / Key</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead>接口 / 类型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>输入</TableHead>
                    <TableHead>输出</TableHead>
                    <TableHead>缓存</TableHead>
                    <TableHead>写入</TableHead>
                    <TableHead>推理</TableHead>
                    <TableHead>总量</TableHead>
                    <TableHead>延迟</TableHead>
                    <TableHead>速度</TableHead>
                    <TableHead>流量</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.length === 0 ? <TableStateRow colSpan={14}>暂无模型使用记录</TableStateRow> : null}
                  {items.map((item) => <UsageRow item={item} key={item.auditId} />)}
                </TableBody>
              </DataTableShell>
            </CardContent>
          </Card>
        </>
      ) : null}
    </PageShell>
  );
}

function UsageRow({ item }: { item: ModelUsageItem }) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap font-mono text-xs">{formatDateTime(item.createdAt)}</TableCell>
      <TableCell className="max-w-40">
        <div className="truncate text-xs">{item.userName || "当前账号"}</div>
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={item.apiKeyFingerprint}>{item.apiKeyFingerprint || "-"}</div>
      </TableCell>
      <TableCell className="font-mono text-xs">{item.model || "-"}</TableCell>
      <TableCell>
        <div className="font-mono text-xs">{item.endpoint || "-"}</div>
        <div className="text-[11px] text-muted-foreground">{requestTypeLabel(item.requestType)}</div>
      </TableCell>
      <TableCell>
        <Badge variant={statusVariant(item.status)}>{statusLabel(item.status)}</Badge>
        <div className="mt-1 text-[11px] text-muted-foreground">usage {item.usageStatus}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">{formatStatusCodes(item.gatewayStatus, item.upstreamStatus)}</div>
        {item.errorMessage ? <div className="max-w-36 truncate text-[11px] text-destructive" title={item.errorMessage}>{item.errorCode || item.errorMessage}</div> : null}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right font-mono text-xs">{formatToken(item.usageAvailable, item.inputTokens)}</TableCell>
      <TableCell className="whitespace-nowrap text-right font-mono text-xs">{formatToken(item.usageAvailable, item.outputTokens)}</TableCell>
      <TableCell className="whitespace-nowrap text-right font-mono text-xs">{formatToken(item.usageAvailable, item.cacheReadTokens)}</TableCell>
      <TableCell className="whitespace-nowrap text-right font-mono text-xs">{formatToken(item.usageAvailable, item.cacheCreationTokens)}</TableCell>
      <TableCell className="whitespace-nowrap text-right font-mono text-xs">{formatToken(item.usageAvailable, item.reasoningTokens)}</TableCell>
      <TableCell className="whitespace-nowrap text-right font-mono text-xs">{formatToken(item.usageAvailable, item.totalTokens)}</TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs">
        <div>{formatDuration(item.durationMs)}</div>
        <div className="text-[11px] text-muted-foreground">首字 {formatDuration(item.firstByteMs)}</div>
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs">{item.outputTps > 0 ? `${item.outputTps.toFixed(1)} t/s` : "-"}</TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs">
        <div>入 {formatBytes(item.requestBytes)}</div>
        <div className="text-[11px] text-muted-foreground">出 {formatBytes(item.responseBytes)}</div>
      </TableCell>
    </TableRow>
  );
}

function requestTypeLabel(value: string) {
  if (value === "stream") return "流式";
  if (value === "non_stream") return "非流式";
  if (value === "list") return "模型列表";
  return value || "-";
}

function formatStatusCodes(gatewayStatus: number, upstreamStatus: number) {
  if (!gatewayStatus && !upstreamStatus) return "-";
  if (upstreamStatus && upstreamStatus !== gatewayStatus) return `${gatewayStatus || "-"} / ${upstreamStatus}`;
  return String(gatewayStatus || upstreamStatus);
}

function formatToken(available: boolean, value: number) {
  return available ? value.toLocaleString() : "-";
}

function formatBytes(value: number) {
  if (!value) return "-";
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}K`;
  return `${(value / (1024 * 1024)).toFixed(1)}M`;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    started: "处理中",
    succeeded: "成功",
    failed: "失败",
    client_disconnected: "客户端断开",
    rejected_api_key: "Key 无效",
    rejected_scope: "权限拒绝",
    rejected_account: "账户停用",
    rejected_configuration: "配置错误"
  };
  return labels[status] ?? (status || "未知");
}

function statusVariant(status: string): BadgeProps["variant"] {
  if (status === "succeeded") return "success";
  if (status === "started") return "muted";
  if (status.startsWith("rejected_")) return "danger";
  return "warning";
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(value: number) {
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
}
