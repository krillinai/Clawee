import {
  Activity,
  ArrowRight,
  BookOpen,
  Bot,
  Folder,
  Puzzle,
  RefreshCw,
  Server,
  ShieldAlert
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, MouseEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Label,
  Pie,
  PieChart,
  XAxis,
  YAxis
} from "recharts";

import { useAdminPermission } from "@/components/admin-permissions";
import {
  EmptyState,
  ErrorAlert,
  LoadingState,
  PageHeader,
  PageShell,
  ResourceItem,
  ResourceList
} from "@/components/governance-ui";
import { HelpTooltip } from "@/components/help-tooltip";
import { MCPGatewayTopology } from "@/components/mcp-gateway-topology";
import type { TopologyAgent } from "@/components/mcp-gateway-topology";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import type { ChartConfig } from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { mergeAgentGovernanceRows } from "@/lib/agent-governance";
import { listKnowledgeBases } from "@/lib/knowledge-api";
import {
  listMCPAgents,
  listMCPAudits,
  listMCPCapabilities,
  listMCPGates,
  listMCPGrants,
  listMCPUpstreamServers
} from "@/lib/mcp-admin-api";
import type { MCPAgent, MCPAudit } from "@/lib/mcp-admin-api";
import { canDecideMCPGate, deriveMCPDashboardSummary, formatDuration } from "@/lib/mcp-admin-ui";
import { getAgentActivityList } from "@/lib/office-api";
import type { AgentListItem } from "@/lib/office-api";
import { permissions } from "@/lib/rbac-api";
import { listSharedSpaces } from "@/lib/shared-files-api";
import { listSkills } from "@/lib/skillhub-api";
import { truncateMiddle } from "@/lib/text";
import { cn } from "@/lib/utils";

const AUDIT_SAMPLE_LIMIT = 200;

const rangeOptions = {
  "24h": { label: "最近 24 小时", shortLabel: "24 小时", durationMs: 24 * 60 * 60 * 1000, bucketCount: 8 },
  "7d": { label: "最近 7 天", shortLabel: "7 天", durationMs: 7 * 24 * 60 * 60 * 1000, bucketCount: 7 },
  "30d": { label: "最近 30 天", shortLabel: "30 天", durationMs: 30 * 24 * 60 * 60 * 1000, bucketCount: 10 }
} as const;

type DashboardRange = keyof typeof rangeOptions;
type TrendSeries = "requests" | "latency";
type ActivityMode = "users" | "agents";
type OverviewNavigationItem = { id: string; label: string };

const auditTrendConfig = {
  requests: { label: "代理请求", color: "hsl(var(--primary))" },
  latency: { label: "平均延迟", color: "hsl(var(--muted-foreground))" }
} satisfies ChartConfig;

const auditResultConfig = {
  allowed: { label: "允许", color: "hsl(var(--primary))" },
  rejected: { label: "拒绝", color: "hsl(var(--destructive))" },
  error: { label: "错误", color: "hsl(var(--warning))" }
} satisfies ChartConfig;

const enterpriseChartConfig = {
  knowledge: { label: "知识库", color: "hsl(var(--primary))" },
  skills: { label: "技能", color: "hsl(var(--primary) / 0.62)" },
  shared: { label: "共享空间", color: "hsl(var(--primary) / 0.28)" }
} satisfies ChartConfig;

export function AdminOverviewPage() {
  const canReadUpstreams = useAdminPermission(permissions.mcpUpstreamRead);
  const canReadCapabilities = useAdminPermission(permissions.mcpCapabilityRead);
  const canReadAgents = useAdminPermission(permissions.agentRead);
  const canReadGrants = useAdminPermission(permissions.mcpGrantRead);
  const canReadGates = useAdminPermission(permissions.mcpGateRead);
  const canReadAudits = useAdminPermission(permissions.mcpAuditRead);
  const canReadActivity = useAdminPermission(permissions.activityRead);
  const canReadKnowledge = useAdminPermission(permissions.knowledgeRead);
  const canReadSkills = useAdminPermission(permissions.skillRead);
  const canReadSharedFiles = useAdminPermission(permissions.sharedFilesRead);
  const [range, setRange] = useState<DashboardRange>("24h");
  const [trendSeries, setTrendSeries] = useState<TrendSeries>("requests");
  const [activityMode, setActivityMode] = useState<ActivityMode>("users");
  const [updatedAt, setUpdatedAt] = useState(() => formatUpdatedAt(new Date()));

  const mcpSummaryQuery = useQuery({
    queryKey: ["mcp-dashboard-summary", { canReadUpstreams, canReadCapabilities, canReadAgents, canReadGrants, canReadAudits, range }],
    queryFn: async () => {
      const recentSince = new Date(Date.now() - rangeOptions[range].durationMs).toISOString();
      const [servers, capabilities, agents, grants, audits] = await Promise.all([
        canReadUpstreams ? listMCPUpstreamServers() : Promise.resolve([]),
        canReadCapabilities ? listMCPCapabilities() : Promise.resolve([]),
        canReadAgents ? listMCPAgents() : Promise.resolve([]),
        canReadGrants ? listMCPGrants() : Promise.resolve([]),
        canReadAudits ? listMCPAudits({ limit: AUDIT_SAMPLE_LIMIT, createdFrom: recentSince }) : Promise.resolve([])
      ]);

      return {
        servers,
        capabilities,
        agents,
        grants,
        audits,
        summary: deriveMCPDashboardSummary({ servers, capabilities, agents, grants, audits })
      };
    }
  });
  const officeActivityQuery = useQuery({
    queryKey: ["office-agent-activity"],
    queryFn: getAgentActivityList,
    enabled: canReadActivity
  });
  const pendingGatesQuery = useQuery({
    queryKey: ["mcp-dashboard-pending-gates"],
    queryFn: () => listMCPGates({ limit: AUDIT_SAMPLE_LIMIT, status: "pending" }),
    enabled: canReadGates
  });
  const enterpriseResourcesQuery = useQuery({
    queryKey: ["admin-overview-enterprise-resources", { canReadKnowledge, canReadSkills, canReadSharedFiles }],
    queryFn: async () => {
      const [knowledgeBases, skills, sharedSpaces] = await Promise.all([
        canReadKnowledge ? listKnowledgeBases() : Promise.resolve([]),
        canReadSkills ? listSkills() : Promise.resolve([]),
        canReadSharedFiles
          ? listSharedSpaces({})
          : Promise.resolve({ items: [], meta: { next_cursor: "", has_next: false } })
      ]);
      return { knowledgeBases, skills, sharedSpaces };
    },
    enabled: canReadKnowledge || canReadSkills || canReadSharedFiles
  });

  const mcpData = mcpSummaryQuery.data;
  const summary = mcpData?.summary;
  const audits = mcpData?.audits ?? [];
  const governanceRows = mergeAgentGovernanceRows(officeActivityQuery.data?.agents ?? [], mcpData?.agents ?? []);
  const canAssessAgentCoverage = canReadAgents && canReadActivity;
  const runningAgentCount = officeActivityQuery.data?.agents.length ?? 0;
  const governedAgentCount = canAssessAgentCoverage ? governanceRows.filter((row) => row.kind === "linked").length : 0;
  const ungovernedAgentCount = canAssessAgentCoverage ? governanceRows.filter((row) => row.kind === "office_only").length : 0;
  const offlineAgentCount = governanceRows.filter((row) => row.officeAgent?.status === "offline").length;
  const topologyAgents = (officeActivityQuery.data?.agents ?? []).map(agentToTopologyAgent);
  const pendingGates = (pendingGatesQuery.data ?? []).filter((gate) => canDecideMCPGate(gate.status, gate.expiresAt));
  const pendingApprovalGates = pendingGates.filter((gate) => gate.type === "admin_approval");
  const pendingConfirmationGates = pendingGates.filter((gate) => gate.type === "user_confirmation");
  const pendingCapabilities = mcpData?.capabilities.filter((capability) => capability.status === "pending") ?? [];
  const missingGrantedCapabilities =
    mcpData?.capabilities.filter(
      (capability) =>
        capability.status === "missing" &&
        mcpData.grants.some((grant) => grant.capabilityId === capability.id)
    ) ?? [];
  const absentGrantedCapabilityCount = summary?.capabilities.missingButGranted ?? 0;
  const authorizationIssueCount = missingGrantedCapabilities.length + absentGrantedCapabilityCount;
  const syncFailedServers = mcpData?.servers.filter((server) => server.status === "sync_failed") ?? [];
  const disabledAgentsWithAudits =
    mcpData?.agents.filter(
      (agent) => agent.status === "disabled" && audits.some((audit) => audit.agentId === agent.agentId)
    ) ?? [];
  const governanceBreakdown = {
    agents: ungovernedAgentCount + disabledAgentsWithAudits.length,
    gates: pendingGates.length,
    capabilities: pendingCapabilities.length + authorizationIssueCount,
    upstreams: syncFailedServers.length
  };
  const governanceActionCount = Object.values(governanceBreakdown).reduce((total, count) => total + count, 0);
  const isMCPLoading = mcpSummaryQuery.isLoading;
  const isAgentLoading = isMCPLoading || (canReadActivity && officeActivityQuery.isLoading);
  const isWorkbenchLoading = isMCPLoading || (canReadGates && pendingGatesQuery.isLoading) || (canReadActivity && officeActivityQuery.isLoading);
  const isRefreshing = mcpSummaryQuery.isFetching || officeActivityQuery.isFetching || pendingGatesQuery.isFetching || enterpriseResourcesQuery.isFetching;
  const hasMetricAccess = canAssessAgentCoverage || canReadGates || canReadCapabilities || canReadUpstreams || canReadAudits;
  const hasWorkbenchAccess = canReadGates || canReadCapabilities || canAssessAgentCoverage || canReadUpstreams;
  const showWorkbench = hasWorkbenchAccess && (isWorkbenchLoading || governanceActionCount > 0);
  const hasEnterpriseAccess = canReadKnowledge || canReadSkills || canReadSharedFiles;
  const showAccessAndResources =
    (canReadAgents && canReadActivity && canReadUpstreams) || hasEnterpriseAccess;
  const overviewNavigationItems = useMemo<OverviewNavigationItem[]>(() => [
    ...(hasMetricAccess ? [{ id: "governance-overview", label: "治理概况" }] : []),
    ...(showAccessAndResources ? [{ id: "access-resources", label: "接入与资源" }] : []),
    ...(canReadAudits || showWorkbench ? [{ id: "analysis-actions", label: "分析与处置" }] : [])
  ], [canReadAudits, hasMetricAccess, showAccessAndResources, showWorkbench]);
  const knowledgeBases = enterpriseResourcesQuery.data?.knowledgeBases ?? [];
  const skills = enterpriseResourcesQuery.data?.skills ?? [];
  const sharedSpaces = enterpriseResourcesQuery.data?.sharedSpaces.items ?? [];
  const enterpriseResourceData = [
    canReadKnowledge ? {
      key: "knowledge",
      label: "知识库",
      count: knowledgeBases.length,
      detail: `${sum(knowledgeBases.map((item) => item.documentCount))} 份文档`,
      href: "/admin/knowledge-bases",
      icon: BookOpen,
      swatchClassName: "bg-primary",
      fill: "var(--color-knowledge)"
    } : null,
    canReadSkills ? {
      key: "skills",
      label: "技能",
      count: skills.length,
      detail: `${skills.filter((item) => item.currentVersionId).length} 个已发布`,
      href: "/admin/skills",
      icon: Puzzle,
      swatchClassName: "bg-primary/60",
      fill: "var(--color-skills)"
    } : null,
    canReadSharedFiles ? {
      key: "shared",
      label: "共享空间",
      count: sharedSpaces.length,
      countSuffix: enterpriseResourcesQuery.data?.sharedSpaces.meta.has_next ? "+" : "",
      detail: `${sum(sharedSpaces.map((item) => item.fileCount))} 份文件`,
      href: "/admin/shared-files",
      icon: Folder,
      swatchClassName: "bg-primary/30",
      fill: "var(--color-shared)"
    } : null
  ].filter((item): item is NonNullable<typeof item> => item !== null);
  const enterpriseResourceCount = sum(enterpriseResourceData.map((item) => item.count));
  const enterpriseOverviewHref = enterpriseResourceData[0]?.href ?? "/admin";
  const auditResults = summarizeAuditResults(audits);
  const auditTotalLabel = audits.length >= AUDIT_SAMPLE_LIMIT ? `${AUDIT_SAMPLE_LIMIT}+` : String(audits.length);
  const auditTrend = buildAuditTrend(audits, range);
  const capabilityRanking = buildCapabilityRanking(audits);
  const activityRanking = buildActivityRanking(audits, mcpData?.agents ?? [], activityMode);

  async function refreshDashboard() {
    const tasks: Promise<unknown>[] = [mcpSummaryQuery.refetch()];
    if (canReadActivity) tasks.push(officeActivityQuery.refetch());
    if (canReadGates) tasks.push(pendingGatesQuery.refetch());
    if (hasEnterpriseAccess) tasks.push(enterpriseResourcesQuery.refetch());
    await Promise.all(tasks);
    setUpdatedAt(formatUpdatedAt(new Date()));
  }

  return (
    <div className="mx-auto w-full max-w-[1200px]">
      <TooltipProvider delayDuration={150}>
        <PageShell>
        <PageHeader
          title="企业治理总览"
          actions={
            <div className="grid justify-items-start gap-2 lg:justify-items-end">
              <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
                实时治理数据 · 最近更新 {updatedAt}
              </div>
              <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                {canReadAudits ? (
                  <Select value={range} onValueChange={(value) => setRange(value as DashboardRange)}>
                    <SelectTrigger className="w-[148px]" aria-label="统计时间范围">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {Object.entries(rangeOptions).map(([value, option]) => (
                          <SelectItem key={value} value={value}>{option.label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : null}
                <Button
                  aria-label="刷新数据"
                  disabled={isRefreshing}
                  onClick={() => void refreshDashboard()}
                  size="icon"
                  title="刷新数据"
                  variant="outline"
                >
                  <RefreshCw className={isRefreshing ? "animate-spin" : undefined} aria-hidden="true" />
                </Button>
                {canReadAudits ? (
                  <Button asChild>
                    <Link to="/admin/mcp/audits">
                      <Activity data-icon="inline-start" aria-hidden="true" />
                      查看代理审计
                    </Link>
                  </Button>
                ) : null}
              </div>
            </div>
          }
        >
          <p>统一查看 Agent 接入、企业能力纳管、授权门禁与调用审计，快速定位需要介入的治理风险。</p>
        </PageHeader>

        {overviewNavigationItems.length > 0 ? (
          <OverviewSectionNavigation items={overviewNavigationItems} />
        ) : null}

        {mcpSummaryQuery.isError ? (
          <ErrorAlert>MCP 治理数据加载失败：无法加载上游服务、能力、Agent、授权或代理审计。</ErrorAlert>
        ) : null}
        {canReadActivity && officeActivityQuery.isError ? <ErrorAlert>Agent 运行状态加载失败。</ErrorAlert> : null}
        {canReadGates && pendingGatesQuery.isError ? <ErrorAlert>门禁待办加载失败。</ErrorAlert> : null}
        {hasEnterpriseAccess && enterpriseResourcesQuery.isError ? <ErrorAlert>企业资源状态加载失败。</ErrorAlert> : null}

        {hasMetricAccess ? (
          <OverviewSection
            description="集中查看接入覆盖、治理待办、网关健康与代理调用状态。"
            id="governance-overview"
            title="治理概况"
          >
            <section aria-label="核心治理指标" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {canAssessAgentCoverage ? (
              <OverviewMetric
                badgeLabel={ungovernedAgentCount > 0 ? "需接入" : "已纳管"}
                icon={Bot}
                label="Agent 接入覆盖"
                value={isAgentLoading ? "..." : `${governedAgentCount}/${runningAgentCount}`}
                foot={isAgentLoading ? "正在汇总接入状态" : `${ungovernedAgentCount} 未接入 · ${offlineAgentCount} 离线`}
                variant={ungovernedAgentCount > 0 ? "warning" : "success"}
              />
            ) : null}
            {canReadGates || canReadCapabilities || canReadUpstreams || canReadAgents ? (
              <OverviewMetric
                badgeLabel={governanceActionCount > 0 ? "需关注" : "正常"}
                icon={ShieldAlert}
                label="治理待办"
                value={isWorkbenchLoading ? "..." : governanceActionCount}
                foot={
                  isWorkbenchLoading
                    ? "正在汇总风险事项"
                    : `Agent ${governanceBreakdown.agents} · 门禁 ${governanceBreakdown.gates} · 能力授权 ${governanceBreakdown.capabilities} · 上游 ${governanceBreakdown.upstreams}`
                }
                variant={governanceActionCount > 0 ? "warning" : "success"}
              />
            ) : null}
            {canReadUpstreams || canReadCapabilities ? (
              <OverviewMetric
                badgeLabel={(summary?.servers.syncFailed ?? 0) > 0 ? "需关注" : "正常"}
                icon={Server}
                label="Gateway 健康"
                value={
                  isMCPLoading
                    ? "..."
                    : canReadUpstreams
                      ? `${summary?.servers.active ?? 0}/${summary?.servers.total ?? 0}`
                      : `${summary?.capabilities.active ?? 0}/${summary?.capabilities.total ?? 0}`
                }
                foot={
                  isMCPLoading
                    ? "正在检查链路状态"
                    : `${summary?.servers.syncFailed ?? 0} 同步失败 · ${summary?.capabilities.active ?? 0} 个可用能力`
                }
                variant={(summary?.servers.syncFailed ?? 0) > 0 ? "warning" : "success"}
              />
            ) : null}
            {canReadAudits ? (
              <OverviewMetric
                badgeLabel={auditResults.rejected + auditResults.error > 0 ? "需关注" : "正常"}
                icon={Activity}
                label={`${rangeOptions[range].shortLabel}代理调用`}
                value={isMCPLoading ? "..." : auditTotalLabel}
                foot={
                  isMCPLoading
                    ? "正在汇总调用结果"
                    : `${auditResults.allowed} 允许 · ${auditResults.rejected} 拒绝 · ${auditResults.error} 错误`
                }
                variant={auditResults.rejected + auditResults.error > 0 ? "warning" : "success"}
              />
            ) : null}
            </section>
          </OverviewSection>
        ) : null}

        {showAccessAndResources ? (
          <OverviewSection
            description="查看 Agent 接入链路与企业资源纳管范围。"
            id="access-resources"
            title="接入与资源"
          >
            {canReadAgents && canReadActivity && canReadUpstreams ? (
              <MCPGatewayTopology
                agents={topologyAgents}
                loading={isAgentLoading}
                servers={mcpData?.servers ?? []}
                summary={summary}
              />
            ) : null}

            {hasEnterpriseAccess ? (
              <Card aria-labelledby="enterprise-resources-title" role="region">
            <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
              <CardTitle className="flex items-center gap-1.5">
                <h3 id="enterprise-resources-title">企业资源状态</h3>
                <HelpTooltip label="查看企业资源状态说明">
                  查看已经进入统一权限与审计边界的企业知识、技能和共享文件。
                </HelpTooltip>
              </CardTitle>
              <Button asChild size="sm" variant="ghost">
                <Link to={enterpriseOverviewHref}>
                  查看企业资源
                  <ArrowRight data-icon="inline-end" aria-hidden="true" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {enterpriseResourcesQuery.isLoading ? <LoadingState label="正在加载企业资源" /> : null}
              {!enterpriseResourcesQuery.isLoading ? (
                <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
                  <div className="grid items-center gap-5 sm:grid-cols-[minmax(180px,0.8fr)_minmax(220px,1fr)]">
                    <ChartContainer
                      aria-label={`纳管资源分布，共 ${enterpriseResourceCount} 项`}
                      className="mx-auto h-52 w-full max-w-[260px]"
                      config={enterpriseChartConfig}
                      role="img"
                    >
                      <PieChart accessibilityLayer>
                        <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="key" />} cursor={false} />
                        <Pie
                          data={enterpriseResourceData}
                          dataKey="count"
                          innerRadius={58}
                          nameKey="label"
                          outerRadius={80}
                          paddingAngle={enterpriseResourceData.length > 1 ? 3 : 0}
                          strokeWidth={3}
                        >
                          <Label
                            content={({ viewBox }) => {
                              if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                                return (
                                  <text dominantBaseline="middle" textAnchor="middle" x={viewBox.cx} y={viewBox.cy}>
                                    <tspan className="fill-foreground font-mono text-2xl font-semibold" x={viewBox.cx} y={viewBox.cy}>
                                      {enterpriseResourceCount}
                                    </tspan>
                                    <tspan className="fill-muted-foreground text-[10px]" x={viewBox.cx} y={(viewBox.cy ?? 0) + 18}>
                                      纳管资源
                                    </tspan>
                                  </text>
                                );
                              }
                              return null;
                            }}
                          />
                        </Pie>
                      </PieChart>
                    </ChartContainer>
                    <div className="grid gap-3 text-xs text-muted-foreground">
                      {enterpriseResourceData.map((item) => (
                        <div className="flex items-center gap-2" key={item.key}>
                          <span className={`size-2 rounded-sm ${item.swatchClassName}`} aria-hidden="true" />
                          <span className="flex-1">{item.label}</span>
                          <span className="font-mono font-semibold text-foreground">{item.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="grid">
                    {enterpriseResourceData.map((item, index) => {
                      const Icon = item.icon;
                      return (
                        <div key={item.key}>
                          <div className="flex min-h-16 items-center gap-3 py-2">
                            <div className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                              <Icon className="size-4" aria-hidden="true" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="font-medium">{item.label}</span>
                                <span className="font-mono text-lg font-semibold tabular-nums">
                                  {item.count}{"countSuffix" in item ? item.countSuffix : ""}
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground">{item.detail}</p>
                            </div>
                            <Button asChild size="sm" variant="ghost">
                              <Link to={item.href}>查看</Link>
                            </Button>
                          </div>
                          {index < enterpriseResourceData.length - 1 ? <Separator /> : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </CardContent>
              </Card>
            ) : null}
          </OverviewSection>
        ) : null}

        {canReadAudits || showWorkbench ? (
          <OverviewSection
            description="基于代理审计识别调用趋势、活跃使用、高频能力与需要处理的治理事项。"
            id="analysis-actions"
            title="分析与处置"
          >
            {canReadAudits ? (
              <section aria-label="调用与结果图表" className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.8fr)]">
            <Card aria-labelledby="audit-trend-title" role="region">
              <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
                <CardTitle className="flex items-center gap-1.5">
                  <h3 id="audit-trend-title">代理调用趋势</h3>
                  <HelpTooltip label="查看代理调用趋势说明">
                    按审计记录聚合请求量，辅助识别流量波动与异常时段。
                  </HelpTooltip>
                </CardTitle>
                <Tabs value={trendSeries} onValueChange={(value) => setTrendSeries(value as TrendSeries)}>
                  <TabsList aria-label="趋势指标">
                    <TabsTrigger value="requests">请求量</TabsTrigger>
                    <TabsTrigger value="latency">平均延迟</TabsTrigger>
                  </TabsList>
                </Tabs>
              </CardHeader>
              <CardContent>
                {isMCPLoading ? <LoadingState label="正在加载代理调用趋势" /> : (
                  <ChartContainer
                    aria-label={`${rangeOptions[range].label}${trendSeries === "requests" ? "代理请求" : "平均延迟"}趋势图`}
                    className="h-[260px] w-full"
                    config={auditTrendConfig}
                    role="img"
                  >
                    <AreaChart accessibilityLayer data={auditTrend} margin={{ left: 8, right: 12, top: 12 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis axisLine={false} dataKey="label" minTickGap={24} tickLine={false} />
                      <YAxis
                        allowDecimals={trendSeries === "latency"}
                        axisLine={false}
                        tickFormatter={(value) => trendSeries === "latency" ? formatDuration(Number(value)) : `${value}次`}
                        tickLine={false}
                        width={72}
                      />
                      <ChartTooltip
                        content={<ChartTooltipContent />}
                        cursor={{ stroke: "hsl(var(--border))", strokeDasharray: "3 3" }}
                      />
                      <Area
                        dataKey={trendSeries}
                        fill={`var(--color-${trendSeries})`}
                        fillOpacity={0.12}
                        isAnimationActive={false}
                        stroke={`var(--color-${trendSeries})`}
                        strokeWidth={2}
                        type="monotone"
                      />
                    </AreaChart>
                  </ChartContainer>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <span className="size-2 rounded-sm bg-primary" aria-hidden="true" />
                    {trendSeries === "requests" ? "代理请求" : "平均延迟"}
                  </span>
                  <span>数据来源：代理审计</span>
                </div>
              </CardContent>
            </Card>

            <Card aria-labelledby="audit-result-title" role="region">
              <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
                <CardTitle className="flex items-center gap-1.5">
                  <h3 id="audit-result-title">调用结果分布</h3>
                  <HelpTooltip label="查看调用结果分布说明">允许、拒绝和错误调用的占比。</HelpTooltip>
                </CardTitle>
                <Badge variant="secondary">审计样本</Badge>
              </CardHeader>
              <CardContent className="grid min-h-[284px] items-center gap-4 sm:grid-cols-[minmax(160px,1fr)_minmax(140px,0.8fr)]">
                {isMCPLoading ? <LoadingState label="正在加载调用结果" /> : (
                  <>
                    <ChartContainer
                      aria-label={`调用结果分布，共 ${audits.length} 次代理调用`}
                      className="mx-auto h-[190px] w-full max-w-[220px]"
                      config={auditResultConfig}
                      role="img"
                    >
                      <PieChart accessibilityLayer>
                        <Pie
                          data={[
                            { key: "allowed", label: "允许", value: auditResults.allowed, fill: "var(--color-allowed)" },
                            { key: "rejected", label: "拒绝", value: auditResults.rejected, fill: "var(--color-rejected)" },
                            { key: "error", label: "错误", value: auditResults.error, fill: "var(--color-error)" }
                          ]}
                          dataKey="value"
                          innerRadius={58}
                          nameKey="label"
                          outerRadius={76}
                          paddingAngle={audits.length > 0 ? 2 : 0}
                          strokeWidth={2}
                        >
                          <Cell fill="var(--color-allowed)" />
                          <Cell fill="var(--color-rejected)" />
                          <Cell fill="var(--color-error)" />
                          <Label
                            content={({ viewBox }) => {
                              if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                                return (
                                  <text dominantBaseline="middle" textAnchor="middle" x={viewBox.cx} y={viewBox.cy}>
                                    <tspan className="fill-foreground font-mono text-2xl font-semibold" x={viewBox.cx} y={viewBox.cy}>
                                      {auditTotalLabel}
                                    </tspan>
                                    <tspan className="fill-muted-foreground text-[10px]" x={viewBox.cx} y={(viewBox.cy ?? 0) + 18}>
                                      代理调用
                                    </tspan>
                                  </text>
                                );
                              }
                              return null;
                            }}
                          />
                        </Pie>
                      </PieChart>
                    </ChartContainer>
                    <div className="grid gap-3">
                      <ResultRow colorClassName="bg-primary" label="允许" value={auditResults.allowed} />
                      <ResultRow colorClassName="bg-destructive" label="拒绝" value={auditResults.rejected} />
                      <ResultRow colorClassName="bg-warning" label="错误" value={auditResults.error} />
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
              </section>
            ) : null}

            {canReadAudits ? (
              <Card aria-labelledby="agent-activity-title" role="region">
                <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <CardTitle className="flex items-center gap-1.5">
                    <h3 id="agent-activity-title">Agent 活跃使用</h3>
                    <HelpTooltip label="查看 Agent 活跃使用说明">
                      {activityMode === "users"
                        ? "按使用人聚合代理调用，识别使用企业 Agent 最频繁的成员。"
                        : "按 Agent 聚合代理调用，识别当前使用频率最高的智能体。"}
                    </HelpTooltip>
                  </CardTitle>
                  <div className="flex flex-wrap items-center gap-2">
                    <Tabs value={activityMode} onValueChange={(value) => setActivityMode(value as ActivityMode)}>
                      <TabsList aria-label="Agent 活跃统计维度">
                        <TabsTrigger value="users">按使用人</TabsTrigger>
                        <TabsTrigger value="agents">按 Agent</TabsTrigger>
                      </TabsList>
                    </Tabs>
                    <Button asChild size="sm" variant="ghost">
                      <Link to={canReadActivity ? "/admin/activity" : "/admin/mcp/audits"}>
                        查看智能体活动
                        <ArrowRight data-icon="inline-end" aria-hidden="true" />
                      </Link>
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {isMCPLoading ? <LoadingState label="正在加载 Agent 活跃排行" /> : null}
                  {!isMCPLoading && activityRanking.length === 0 ? (
                    <EmptyState title={`${rangeOptions[range].label}暂无 Agent 活动`} />
                  ) : null}
                  {!isMCPLoading && activityRanking.length > 0 ? (
                    <ActivityRanking items={activityRanking} />
                  ) : null}
                  {!isMCPLoading && activityRanking.length > 0 ? (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-xs text-muted-foreground">
                      <span><strong className="font-mono text-base text-foreground">{audits.length}</strong> 次代理调用 · {activityRanking.length} 个活跃{activityMode === "users" ? "使用人" : " Agent"}</span>
                      <Badge variant="secondary">{rangeOptions[range].label}</Badge>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            <section
              aria-label="能力使用与治理待办"
              className={cn("grid items-start gap-4", showWorkbench && canReadAudits && "lg:grid-cols-2")}
            >
            {canReadAudits ? (
              <Card aria-labelledby="capability-ranking-title" role="region">
                <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <CardTitle className="flex items-center gap-1.5">
                    <h3 id="capability-ranking-title">高频能力调用</h3>
                    <HelpTooltip label="查看高频能力调用说明">按暴露能力名称聚合的调用排行。</HelpTooltip>
                  </CardTitle>
                  <Button asChild size="sm" variant="ghost">
                    <Link to="/admin/mcp/capabilities">
                      查看能力目录
                      <ArrowRight data-icon="inline-end" aria-hidden="true" />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  {isMCPLoading ? <LoadingState label="正在加载能力调用排行" /> : null}
                  {!isMCPLoading && capabilityRanking.length === 0 ? (
                    <EmptyState title={`${rangeOptions[range].label}暂无能力调用`} />
                  ) : null}
                  {!isMCPLoading && capabilityRanking.length > 0 ? (
                    <RankingBars items={capabilityRanking} />
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            {showWorkbench ? (
              <Card aria-labelledby="governance-workbench-title" role="region">
                <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <CardTitle className="flex items-center gap-1.5">
                    <h3 id="governance-workbench-title">治理工作台</h3>
                    <HelpTooltip label="查看治理工作台说明">
                      按风险优先级处理影响接入与调用稳定性的事项。
                    </HelpTooltip>
                  </CardTitle>
                  {!isWorkbenchLoading ? <Badge variant="warning">{governanceActionCount} 项待办</Badge> : null}
                </CardHeader>
                <CardContent>
                  {isWorkbenchLoading ? <LoadingState label="正在汇总治理待办" /> : null}
                  {!isWorkbenchLoading && governanceActionCount > 0 ? (
                    <ResourceList variant="plain">
                      {pendingApprovalGates.length > 0 ? (
                        <ResourceItem
                          action={<Button asChild size="sm" variant="outline"><Link to="/admin/mcp/gates?status=pending">处理</Link></Button>}
                          meta={`${pendingApprovalGates.length} 个高风险调用正在等待管理员决策。`}
                          title="管理员审批待处理"
                          variant="plain"
                        />
                      ) : null}
                      {pendingConfirmationGates.length > 0 ? (
                        <ResourceItem
                          action={<Button asChild size="sm" variant="outline"><Link to="/admin/mcp/gates?status=pending">查看</Link></Button>}
                          meta={`${pendingConfirmationGates.length} 个调用正在等待发起用户确认。`}
                          title="用户确认等待中"
                          variant="plain"
                        />
                      ) : null}
                      {syncFailedServers.length > 0 ? (
                        <ResourceItem
                          action={<Button asChild size="sm" variant="outline"><Link to="/admin/mcp/upstream-servers?status=sync_failed">排查</Link></Button>}
                          meta={`${syncFailedServers.length} 个上游服务同步失败，可能影响可见能力。`}
                          title="上游同步失败"
                          variant="plain"
                        />
                      ) : null}
                      {authorizationIssueCount > 0 ? (
                        <ResourceItem
                          action={<Button asChild size="sm" variant="outline"><Link to="/admin/mcp/capabilities?status=missing">核查</Link></Button>}
                          meta={`${authorizationIssueCount} 个缺失能力仍保留授权关系。`}
                          title="缺失能力仍有授权"
                          variant="plain"
                        />
                      ) : null}
                      {disabledAgentsWithAudits.length > 0 ? (
                        <ResourceItem
                          action={<Button asChild size="sm" variant="outline"><Link to="/admin/mcp/agents?status=disabled">核查</Link></Button>}
                          meta={`${disabledAgentsWithAudits.length} 个已停用 Agent 在当前审计样本中仍有请求。`}
                          title="停用 Agent 仍有调用"
                          variant="plain"
                        />
                      ) : null}
                      {pendingCapabilities.length > 0 ? (
                        <ResourceItem
                          action={<Button asChild size="sm" variant="outline"><Link to="/admin/mcp/capabilities?status=pending">审核</Link></Button>}
                          meta={`${pendingCapabilities.length} 个新同步能力等待 Schema 与风险属性审核。`}
                          title="能力待审核"
                          variant="plain"
                        />
                      ) : null}
                      {ungovernedAgentCount > 0 ? (
                        <ResourceItem
                          action={<Button asChild size="sm" variant="outline"><Link to="/admin/mcp/agents">接入</Link></Button>}
                          meta={`${ungovernedAgentCount} 个运行实例尚未建立 MCP 治理身份。`}
                          title="Agent 尚未接入 MCP"
                          variant="plain"
                        />
                      ) : null}
                    </ResourceList>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}
            </section>
          </OverviewSection>
        ) : null}

        </PageShell>
      </TooltipProvider>
    </div>
  );
}

function OverviewSection({
  id,
  title,
  description,
  children
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="grid scroll-mt-16 gap-5 border-t border-border/40 pb-2 pt-7 first-of-type:border-t-0 first-of-type:pt-2"
      id={id}
    >
      <header className="grid gap-1">
        <h2 className="text-lg font-semibold leading-7" id={`${id}-title`}>{title}</h2>
        <p className="text-sm leading-5 text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  );
}

function OverviewSectionNavigation({ items }: { items: OverviewNavigationItem[] }) {
  const navRef = useRef<HTMLElement>(null);
  const [activeId, setActiveId] = useState(items[0]?.id ?? "");
  const resolvedActiveId = items.some((item) => item.id === activeId) ? activeId : items[0]?.id ?? "";

  useEffect(() => {
    function updateActiveSection() {
      const sections = items.flatMap((item) => {
        const element = document.getElementById(item.id);
        return element ? [{ element, id: item.id, rect: element.getBoundingClientRect() }] : [];
      });

      if (sections.length === 0 || sections.every(({ rect }) => rect.top === 0 && rect.bottom === 0)) return;

      const navBottom = navRef.current?.getBoundingClientRect().bottom ?? 0;
      const activationLine = Math.max(64, navBottom + 16);
      let nextActiveId = sections[0].id;

      for (const section of sections) {
        if (section.rect.top > activationLine) break;
        nextActiveId = section.id;
      }

      setActiveId(nextActiveId);
    }

    updateActiveSection();
    window.addEventListener("scroll", updateActiveSection, { passive: true });
    window.addEventListener("resize", updateActiveSection);
    return () => {
      window.removeEventListener("scroll", updateActiveSection);
      window.removeEventListener("resize", updateActiveSection);
    };
  }, [items]);

  function navigateToSection(event: MouseEvent<HTMLAnchorElement>, id: string) {
    event.preventDefault();
    const section = document.getElementById(id);
    if (!section) return;
    setActiveId(id);
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <nav
      aria-label="总览分区导航"
      className="sticky top-0 z-20 -mx-1 overflow-x-auto border-b border-border/40 bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/85"
      ref={navRef}
    >
      <div className="flex min-w-max items-center gap-1 rounded-lg bg-muted p-1">
        {items.map((item) => {
          const isActive = item.id === resolvedActiveId;
          return (
            <Button
              asChild
              className={cn(
                "shrink-0",
                isActive ? "text-foreground shadow-sm shadow-foreground/[0.04]" : "text-muted-foreground"
              )}
              key={item.id}
              size="sm"
              variant={isActive ? "outline" : "ghost"}
            >
              <a
                aria-current={isActive ? "location" : undefined}
                href={`#${item.id}`}
                onClick={(event) => navigateToSection(event, item.id)}
              >
                {item.label}
              </a>
            </Button>
          );
        })}
      </div>
    </nav>
  );
}

function OverviewMetric({
  icon: Icon,
  label,
  value,
  foot,
  variant,
  badgeLabel
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  foot: string;
  variant: "success" | "warning";
  badgeLabel: string;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <div className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-4" aria-hidden="true" />
        </div>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="font-mono text-3xl font-semibold tabular-nums">{value}</div>
        <div className="flex min-h-5 min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate" title={foot}>{foot}</span>
          <Badge className="shrink-0" variant={variant}>{badgeLabel}</Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function ResultRow({ colorClassName, label, value }: { colorClassName: string; label: string; value: number }) {
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
      <span className={`size-2 rounded-sm ${colorClassName}`} aria-hidden="true" />
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong className="font-mono font-semibold tabular-nums">{value}</strong>
    </div>
  );
}

function RankingBars({ items }: { items: RankingItem[] }) {
  const max = items[0]?.value ?? 1;

  return (
    <div className="grid gap-4">
      {items.map((item) => (
        <div className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3 sm:grid-cols-[minmax(120px,0.9fr)_minmax(120px,1fr)_3rem]" key={item.key}>
          <span className="truncate font-mono text-xs" title={item.label}>{item.label}</span>
          <span
            aria-label={`${item.label} 调用 ${item.value} 次`}
            aria-valuemax={max}
            aria-valuemin={0}
            aria-valuenow={item.value}
            className="order-3 col-span-2 h-2 overflow-hidden rounded-sm bg-muted sm:order-none sm:col-span-1"
            role="progressbar"
          >
            <span className="block h-full rounded-sm bg-primary" style={{ width: `${Math.max(4, Math.round((item.value / max) * 100))}%` }} />
          </span>
          <span className="text-right font-mono text-sm font-semibold tabular-nums">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function ActivityRanking({ items }: { items: ActivityRankingItem[] }) {
  const max = items[0]?.value ?? 1;

  return (
    <div className="grid">
      {items.map((item, index) => (
        <div className="grid min-h-16 grid-cols-[2rem_2.25rem_minmax(0,1fr)_3.5rem] items-center gap-3 border-t first:border-t-0 sm:grid-cols-[2rem_2.25rem_minmax(120px,0.9fr)_minmax(120px,1.2fr)_3.5rem]" key={item.key}>
          <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
          <span className="grid size-9 place-items-center rounded-md bg-primary/10 text-sm font-semibold text-primary">{item.avatar}</span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium" title={item.label}>{item.label}</span>
            <span className="block truncate text-xs text-muted-foreground" title={item.meta}>{item.meta}</span>
          </span>
          <span
            aria-label={`${item.label} 代理调用 ${item.value} 次`}
            aria-valuemax={max}
            aria-valuemin={0}
            aria-valuenow={item.value}
            className="hidden h-2 overflow-hidden rounded-sm bg-muted sm:block"
            role="progressbar"
          >
            <span className="block h-full rounded-sm bg-primary" style={{ width: `${Math.max(4, Math.round((item.value / max) * 100))}%` }} />
          </span>
          <span className="text-right">
            <strong className="block font-mono text-base tabular-nums">{item.value}</strong>
            <span className="text-[10px] text-muted-foreground">次</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function agentToTopologyAgent(agent: AgentListItem): TopologyAgent {
  return {
    id: `${agent.collector_id}/${agent.agent_id}`,
    title: agent.display_name || agent.agent_id,
    meta: `${agent.mcp_agent_id ? "已接入 MCP" : "未接入 MCP"} · ${truncateMiddle(agent.agent_id, 9, 7)}`,
    status: agent.status || "unknown",
    href: `/admin/activity/detail?collector_id=${encodeURIComponent(agent.collector_id)}&agent_id=${encodeURIComponent(agent.agent_id)}`
  };
}

function summarizeAuditResults(audits: MCPAudit[]) {
  return audits.reduce(
    (result, audit) => {
      const decision = audit.decision.toLowerCase();
      if (decision === "allowed" || decision === "allow" || decision === "success") {
        result.allowed += 1;
      } else if (decision.includes("reject") || decision.includes("denied") || decision.includes("deny")) {
        result.rejected += 1;
      } else {
        result.error += 1;
      }
      return result;
    },
    { allowed: 0, rejected: 0, error: 0 }
  );
}

function buildAuditTrend(audits: MCPAudit[], range: DashboardRange) {
  const option = rangeOptions[range];
  const now = Date.now();
  const start = now - option.durationMs;
  const bucketMs = option.durationMs / option.bucketCount;
  const buckets = Array.from({ length: option.bucketCount }, (_, index) => ({
    timestamp: start + index * bucketMs,
    requests: 0,
    durationTotal: 0,
    durationCount: 0
  }));

  for (const audit of audits) {
    const timestamp = Date.parse(audit.createdAt);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > now) continue;
    const bucketIndex = Math.min(option.bucketCount - 1, Math.floor((timestamp - start) / bucketMs));
    const bucket = buckets[bucketIndex];
    bucket.requests += 1;
    if (Number.isFinite(audit.durationMs)) {
      bucket.durationTotal += audit.durationMs;
      bucket.durationCount += 1;
    }
  }

  return buckets.map((bucket) => ({
    label: formatTrendLabel(bucket.timestamp, range),
    requests: bucket.requests,
    latency: bucket.durationCount > 0 ? Math.round(bucket.durationTotal / bucket.durationCount) : 0
  }));
}

type RankingItem = { key: string; label: string; value: number };

function buildCapabilityRanking(audits: MCPAudit[]): RankingItem[] {
  const counts = new Map<string, number>();
  for (const audit of audits) {
    const name = audit.exposedName || audit.capabilityId || "未知能力";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ key: label, label, value }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, 4);
}

type ActivityRankingItem = RankingItem & { avatar: string; meta: string };

function buildActivityRanking(audits: MCPAudit[], agents: MCPAgent[], mode: ActivityMode): ActivityRankingItem[] {
  const agentById = new Map(agents.map((agent) => [agent.agentId, agent]));
  const groups = new Map<string, { label: string; value: number; related: Set<string> }>();

  for (const audit of audits) {
    const agent = agentById.get(audit.agentId);
    const key = mode === "users" ? audit.actorId || agent?.boundUserId || "未知使用人" : audit.agentId || "未知 Agent";
    const label = mode === "users"
      ? agent?.boundUserName || agent?.boundUserEmail || audit.actorId || "未知使用人"
      : agent?.name || audit.agentId || "未知 Agent";
    const relatedKey = mode === "users" ? audit.agentId : audit.actorId;
    const current = groups.get(key) ?? { label, value: 0, related: new Set<string>() };
    current.value += 1;
    if (relatedKey) current.related.add(relatedKey);
    groups.set(key, current);
  }

  return [...groups.entries()]
    .map(([key, item]) => ({
      key,
      label: item.label,
      value: item.value,
      avatar: item.label.trim().slice(0, 1).toUpperCase() || "A",
      meta: mode === "users" ? `${item.related.size} 个常用 Agent` : `${item.related.size} 名活跃使用人`
    }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, 5);
}

function formatTrendLabel(timestamp: number, range: DashboardRange) {
  if (range === "24h") {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp);
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(timestamp);
}

function formatUpdatedAt(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

function sum(values: number[] | undefined) {
  return values?.reduce((total, value) => total + value, 0) ?? 0;
}
