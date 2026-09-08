import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bot, Clock3, CreditCard, Database, History, RefreshCw, Users, WalletCards } from "lucide-react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Link, useSearchParams } from "react-router-dom";

import { ActivityDetailView } from "@/components/activity-detail/activity-detail-view";
import { EmptyState, ErrorAlert, PageHeader, PageShell } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  getMyActivityStatistics,
  type ActivityAgent,
  type ActivityRange,
  type ActivityStatistics,
  type ActivityTokenUsageRank,
} from "@/lib/activity-api";
import { APIError } from "@/lib/api";
import { createRechargeSession, getBillingOverview, isBillingNotManaged, openRechargePage, type BillingOverview } from "@/lib/billing-api";
import { canReadAgentActivity, listMyDataViews } from "@/lib/data-views-api";
import { mcpStatusLabel } from "@/lib/mcp-admin-ui";
import { cn } from "@/lib/utils";

const rangeOptions: Array<{ value: ActivityRange; label: string }> = [
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];

const trendConfig = {
  input_tokens: { label: "输入 Token", color: "hsl(var(--primary))" },
  output_tokens: { label: "输出 Token", color: "hsl(var(--success))" },
} satisfies ChartConfig;

export function AppActivityPage({ detail = false }: { detail?: boolean }) {
  const [searchParams] = useSearchParams();

  if (detail) {
    return (
      <ActivityDetailView
        agentId={searchParams.get("agent_id") ?? ""}
        collectorId={searchParams.get("collector_id") ?? ""}
        listPath="/app/activity"
        scope="app"
      />
    );
  }
  return <ActivityStatisticsView />;
}

function ActivityStatisticsView() {
  const queryClient = useQueryClient();
  const [range, setRange] = useState<ActivityRange>("7d");
  const dataViewsQuery = useQuery({ queryKey: ["app-data-views"], queryFn: listMyDataViews });
  const authorized = canReadAgentActivity(dataViewsQuery.data ?? []);
  const statisticsQuery = useQuery({
    queryKey: ["app-activity-statistics", range],
    queryFn: () => getMyActivityStatistics(range),
    enabled: authorized,
    retry: false,
  });
  const billingQuery = useQuery({
    queryKey: ["app-billing-overview", range],
    queryFn: () => getBillingOverview(range),
    enabled: authorized,
    retry: false,
  });

  useEffect(() => {
    if (statisticsQuery.error instanceof APIError && statisticsQuery.error.code === "data_view_forbidden") {
      void queryClient.invalidateQueries({ queryKey: ["app-data-views"] });
    }
  }, [queryClient, statisticsQuery.error]);

  if (dataViewsQuery.isLoading) return <ActivityPageSkeleton />;
  if (dataViewsQuery.isError) {
    return <PageShell><ErrorAlert>数据视图权限加载失败，请稍后重试。</ErrorAlert></PageShell>;
  }
  if (!authorized) {
    return (
      <PageShell>
        <PageHeader title="Agent 动态" />
        <EmptyState title="当前账户未开通 Agent 动态" description="请联系管理员授予数据视图读取权限。" />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        actions={(
          <ToggleGroup
            aria-label="统计时间范围"
            onValueChange={(value) => value && setRange(value as ActivityRange)}
            type="single"
            value={range}
            variant="outline"
          >
            {rangeOptions.map((option) => (
              <ToggleGroupItem className="px-3" key={option.value} value={option.value}>{option.label}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        title="Agent 动态"
      >
        {statisticsQuery.data ? `${statisticsQuery.data.start_date} 至 ${statisticsQuery.data.end_date} · ${statisticsQuery.data.timezone}` : "组织 Agent 活动与模型用量"}
      </PageHeader>

      {statisticsQuery.isLoading ? <ActivityContentSkeleton /> : null}
      {statisticsQuery.isError ? <ErrorAlert>Agent 动态加载失败，请稍后重试。</ErrorAlert> : null}
      {billingQuery.isLoading ? <BillingOverviewSkeleton /> : null}
      {billingQuery.isError && !isBillingNotManaged(billingQuery.error) ? <ErrorAlert>账户额度暂不可用，请稍后重试。</ErrorAlert> : null}
      {billingQuery.data ? <BillingSummary data={billingQuery.data} /> : null}
      {statisticsQuery.data ? (
        <ActivityContent
          data={statisticsQuery.data}
          onRetry={() => { void statisticsQuery.refetch(); }}
          retrying={statisticsQuery.isFetching}
        />
      ) : null}
    </PageShell>
  );
}

function ActivityContent({ data, onRetry, retrying }: { data: ActivityStatistics; onRetry: () => void; retrying: boolean }) {
  const usage = data.organization.usage;
  const modelUsageStatus = data.data_status.model_usage;
  const modelUsageAvailable = modelUsageStatus === "available";
  const metrics = [
    { label: "总 Token", value: modelUsageAvailable ? formatTokenCount(usage.total_tokens) : "--", exact: modelUsageAvailable ? formatInteger(usage.total_tokens) : undefined, icon: Database },
    { label: "活跃员工", value: formatInteger(data.organization.active_employees), exact: undefined, icon: Users },
    { label: "活跃 Agent", value: formatInteger(data.organization.active_agents), exact: undefined, icon: Bot },
    { label: "完成轮次", value: formatInteger(data.organization.completed_turns), exact: undefined, icon: Activity },
  ];
  const trendData = data.trend.points.map((point) => ({
    ...point,
    label: formatTrendLabel(point.bucket_start, data.trend.granularity, data.timezone),
  }));

  return (
    <>
      <section aria-label="核心指标" className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div className="min-w-0 bg-card p-5" key={metric.label}>
              <div className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
                <span>{metric.label}</span><Icon className="size-4 text-primary" aria-hidden="true" />
              </div>
              <strong className="mt-3 block truncate font-mono text-3xl font-semibold" title={metric.exact}>{metric.value}</strong>
            </div>
          );
        })}
      </section>

      {modelUsageAvailable ? <section aria-label="Token 统计" className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.7fr)]">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle><h2>Token 趋势</h2></CardTitle>
            <CardDescription>{data.trend.granularity === "hour" ? "按小时统计" : "按自然日统计"}</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer aria-label="Token 使用趋势图" className="h-[280px] w-full" config={trendConfig} role="img">
              <AreaChart accessibilityLayer data={trendData} margin={{ left: 4, right: 12, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis axisLine={false} dataKey="label" minTickGap={24} tickLine={false} />
                <YAxis axisLine={false} tickFormatter={(value) => formatTokenCount(Number(value))} tickLine={false} width={62} />
                <ChartTooltip content={<ChartTooltipContent />} cursor={{ stroke: "hsl(var(--border))", strokeDasharray: "3 3" }} />
                <Area dataKey="input_tokens" fill="var(--color-input_tokens)" fillOpacity={0.12} isAnimationActive={false} stroke="var(--color-input_tokens)" strokeWidth={2} type="monotone" />
                <Area dataKey="output_tokens" fill="var(--color-output_tokens)" fillOpacity={0.06} isAnimationActive={false} stroke="var(--color-output_tokens)" strokeWidth={2} type="monotone" />
              </AreaChart>
            </ChartContainer>
            <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
              <Legend color="bg-primary" label="输入 Token" />
              <Legend color="bg-success" label="输出 Token" />
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle><h2>Token 构成</h2></CardTitle>
            <CardDescription>缓存输入包含在输入 Token 内</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <UsageRow label="输入 Token" value={usage.input_tokens} total={usage.total_tokens} />
            <UsageRow label="其中缓存输入" value={usage.cached_input_tokens} total={usage.input_tokens} muted />
            <UsageRow label="输出 Token" value={usage.output_tokens} total={usage.total_tokens} />
          </CardContent>
        </Card>
      </section> : (
        <section aria-label="Token 统计">
          <Card className="shadow-none">
            <CardContent className="grid min-h-48 place-items-center gap-4 p-6">
              <EmptyState title={modelUsageStatus === "not_configured" ? "暂未配置模型用量数据源" : "Token 数据暂不可用"} />
              {modelUsageStatus === "unavailable" ? (
                <Button disabled={retrying} onClick={onRetry} size="sm" variant="outline">
                  <RefreshCw className={cn("size-4", retrying && "animate-spin")} aria-hidden="true" />
                  重试
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </section>
      )}

      {modelUsageAvailable ? <TokenUsageRanking items={data.token_usage_ranking} /> : null}

      <section aria-label="用量分布" className="grid items-start gap-4 xl:grid-cols-2">
        {modelUsageAvailable ? <DistributionCard
          empty="当前范围内没有模型用量"
          items={data.model_distribution.map((item) => ({ id: item.model, label: item.model, value: item.total_tokens, share: item.share, detail: `${formatInteger(item.requests)} 次请求` }))}
          title="模型分布"
          valueLabel="Token"
        /> : null}
        <DistributionCard
          empty="当前范围内没有已识别的 MCP 调用"
          items={data.organization.mcp_distribution.map((item) => ({ id: item.id, label: item.label, value: item.invocation_count, share: item.share, detail: `${formatPercent(item.share)} 占比` }))}
          title="MCP 使用分布"
          valueLabel="次调用"
        />
      </section>

      <AgentActivityTable agents={data.agents} />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2"><Clock3 className="size-3.5" aria-hidden="true" />数据生成于 {formatDateTime(data.generated_at, data.timezone)}</div>
        <div className="flex items-center gap-2">
          <Badge variant={modelUsageStatus === "available" ? "success" : modelUsageStatus === "not_configured" ? "muted" : "warning"}>
            {modelUsageStatus === "available" ? "Token 数据正常" : modelUsageStatus === "not_configured" ? "Token 数据源未配置" : "Token 数据暂不可用"}
          </Badge>
          <Badge variant="success">活动数据正常</Badge>
        </div>
      </div>
    </>
  );
}

function TokenUsageRanking({ items }: { items: ActivityTokenUsageRank[] }) {
  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader>
        <CardTitle><h2>Token 使用排行</h2></CardTitle>
        <CardDescription>当前统计范围内最多展示 50 项</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? <div className="p-6"><EmptyState title="当前范围内暂无 Token 使用记录" /></div> : (
          <Table aria-label="Token 使用排行">
            <TableHeader>
              <TableRow>
                <TableHead className="w-20 pl-6">排名</TableHead>
                <TableHead>使用方</TableHead>
                <TableHead className="text-right">请求数</TableHead>
                <TableHead className="pr-6 text-right">Token 消耗</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.rank}>
                  <TableCell className="pl-6 font-mono text-muted-foreground">{item.rank}</TableCell>
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell className="text-right font-mono">{formatInteger(item.requests)}</TableCell>
                  <TableCell className="pr-6 text-right font-mono font-semibold">{formatInteger(item.total_tokens)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function BillingSummary({ data }: { data: BillingOverview }) {
  const recharge = useMutation({
    mutationFn: createRechargeSession,
    onSuccess: (session) => openRechargePage(session.recharge_url),
  });
  return (
    <section aria-label="账户额度" className="grid gap-px overflow-hidden rounded-md border border-border bg-border">
      <div className="min-w-0 bg-card p-5">
        <div className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
          <span>账户余额</span><WalletCards className="size-4 text-primary" aria-hidden="true" />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <strong className="font-mono text-3xl font-semibold">{formatCurrency(data.balance_cny)}</strong>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={recharge.isPending} onClick={() => recharge.mutate()} size="sm"><CreditCard data-icon="inline-start" />充值</Button>
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button asChild size="icon" variant="outline">
                    <Link aria-label="充值记录" to="/app/activity/recharge-records"><History aria-hidden="true" /></Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>充值记录</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
        {recharge.isError ? <p className="mt-2 text-xs text-destructive">充值入口暂不可用</p> : null}
      </div>
    </section>
  );
}

function BillingOverviewSkeleton() {
  return <section aria-label="账户额度加载中" className="grid gap-px overflow-hidden rounded-md border bg-border"><Skeleton className="h-28 rounded-none" /></section>;
}

function UsageRow({ label, value, total, muted = false }: { label: string; value: number; total: number; muted?: boolean }) {
  const share = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <div className={cn("grid gap-2", muted && "pl-3") }>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className={muted ? "text-muted-foreground" : "font-medium"}>{label}</span>
        <span className="font-mono text-sm font-semibold">{formatInteger(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-sm bg-muted"><div className={cn("h-full bg-primary", muted && "bg-primary/45")} style={{ width: `${share * 100}%` }} /></div>
    </div>
  );
}

function DistributionCard({ title, items, empty, valueLabel }: {
  title: string;
  items: Array<{ id: string; label: string; value: number; share: number; detail: string }>;
  empty: string;
  valueLabel: string;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader><CardTitle><h2>{title}</h2></CardTitle></CardHeader>
      <CardContent>
        {items.length === 0 ? <EmptyState title={empty} /> : (
          <div className="grid gap-4">
            {items.map((item) => (
              <div className="grid gap-2" key={item.id}>
                <div className="flex min-w-0 items-baseline justify-between gap-4">
                  <div className="min-w-0"><div className="truncate text-sm font-medium" title={item.label}>{item.label}</div><div className="text-xs text-muted-foreground">{item.detail}</div></div>
                  <div className="shrink-0 font-mono text-sm font-semibold">{formatTokenCount(item.value)} <span className="font-sans text-xs font-normal text-muted-foreground">{valueLabel}</span></div>
                </div>
                <div className="h-1.5 overflow-hidden rounded-sm bg-muted"><div className="h-full bg-primary" style={{ width: `${Math.min(1, item.share) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AgentActivityTable({ agents }: { agents: ActivityAgent[] }) {
  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader><CardTitle><h2>Agent 活动</h2></CardTitle><CardDescription>会话、轮次与最近活动</CardDescription></CardHeader>
      <CardContent className="p-0">
        {agents.length === 0 ? <div className="p-6"><EmptyState title="当前范围内没有 Agent 活动" /></div> : (
          <Table>
            <TableHeader><TableRow><TableHead className="pl-6">Agent</TableHead><TableHead>状态</TableHead><TableHead className="text-right">会话</TableHead><TableHead className="text-right">轮次</TableHead><TableHead className="text-right">最近活动</TableHead><TableHead className="pr-6 text-right">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {agents.map((agent) => {
                const detailHref = `/app/activity/detail?collector_id=${encodeURIComponent(agent.collector_id)}&agent_id=${encodeURIComponent(agent.agent_id)}`;
                return (
                  <TableRow key={`${agent.collector_id}:${agent.agent_id}`}>
                    <TableCell className="pl-6"><div className="font-medium">{agent.name}</div><div className="font-mono text-xs text-muted-foreground">{agent.agent_id}</div></TableCell>
                    <TableCell><Badge variant={agent.status === "online" ? "success" : "muted"}>{mcpStatusLabel(agent.status)}</Badge></TableCell>
                    <TableCell className="text-right font-mono">{formatInteger(agent.session_count)}</TableCell>
                    <TableCell className="text-right font-mono">{formatInteger(agent.turn_count)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{agent.last_activity_at ? formatDateTime(agent.last_activity_at) : "尚无活动"}</TableCell>
                    <TableCell className="pr-6 text-right">
                      <Button asChild size="sm" variant="outline">
                        <Link aria-label={`查看 ${agent.name} 详情`} to={detailHref}>查看详情</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityPageSkeleton() {
  return <PageShell><Skeleton className="h-20 w-full" /><ActivityContentSkeleton /></PageShell>;
}

function ActivityContentSkeleton() {
  return (
    <div aria-label="正在加载 Agent 动态" className="grid gap-4">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <Skeleton className="h-28" key={index} />)}</div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.7fr)]"><Skeleton className="h-[360px]" /><Skeleton className="h-[360px]" /></div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-2"><span className={cn("size-2 rounded-sm", color)} aria-hidden="true" />{label}</span>;
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

function formatTokenCount(value: number) {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatPercent(value: number) {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function formatTrendLabel(value: string, granularity: "hour" | "day", timezone: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", granularity === "hour"
    ? { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }
    : { timeZone: timezone, month: "2-digit", day: "2-digit" }).format(date);
}

function formatDateTime(value: string, timezone = "Asia/Shanghai") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
