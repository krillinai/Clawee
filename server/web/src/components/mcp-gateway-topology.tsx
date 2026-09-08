import * as React from "react";
import { ArrowRight, Bot, Braces, KeyRound, Network, Route, Server, ShieldCheck, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { HelpTooltip } from "@/components/help-tooltip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { MCPUpstreamServer } from "@/lib/mcp-admin-api";
import type { DashboardSummary } from "@/lib/mcp-admin-ui";
import { mcpStatusLabel, mcpStatusVariant } from "@/lib/mcp-admin-ui";
import { cn } from "@/lib/utils";

const VISIBLE_LIMIT = 4;

type TopologySide = "agent" | "upstream";
type HoverTarget = `${TopologySide}:${string}`;

type TopologyRow = {
  id: string;
  title: string;
  meta: string;
  status: string;
  icon: React.ComponentType<{ className?: string }>;
  target: HoverTarget;
  href: string;
  capabilitiesCount?: number;
};

type LinePath = {
  id: string;
  d: string;
  target: HoverTarget;
};

type TopologyPoint = {
  x: number;
  y: number;
};

type TopologyAnchors = {
  agentPanelX: number;
  gatewayLeftX: number;
  gatewayRightX: number;
  upstreamPanelX: number;
  agentRows: TopologyPoint[];
  upstreamRows: TopologyPoint[];
};

export type TopologyAgent = {
  id: string;
  title: string;
  meta: string;
  status: string;
  href: string;
};

type MCPGatewayTopologyProps = {
  agents: TopologyAgent[];
  servers: MCPUpstreamServer[];
  summary?: DashboardSummary;
  loading?: boolean;
};

const DEFAULT_TOPOLOGY_ANCHORS: TopologyAnchors = {
  agentPanelX: 28,
  gatewayLeftX: 42,
  gatewayRightX: 58,
  upstreamPanelX: 72,
  agentRows: [],
  upstreamRows: []
};

export function MCPGatewayTopology({ agents, servers, summary, loading = false }: MCPGatewayTopologyProps) {
  const topologyRef = React.useRef<HTMLDivElement>(null);
  const [hoverTarget, setHoverTarget] = React.useState<HoverTarget | null>(null);
  const [anchors, setAnchors] = React.useState<TopologyAnchors>(DEFAULT_TOPOLOGY_ANCHORS);
  const visibleAgents = activeFirst(agents).slice(0, VISIBLE_LIMIT).map(agentToRow);
  const visibleServers = activeFirst(servers).slice(0, VISIBLE_LIMIT).map(serverToRow);
  const agentTotal = loading ? "..." : agents.length;
  const serverTotal = loading ? "..." : servers.length;
  const isLoading = Boolean(loading);

  React.useLayoutEffect(() => {
    const measureAnchors = () => {
      const root = topologyRef.current;
      if (!root) return;

      const rootRect = root.getBoundingClientRect();
      if (rootRect.width <= 0) return;

      const agentPanel = root.querySelector<HTMLElement>('[data-topology-panel="agent"]');
      const gatewayPanel = root.querySelector<HTMLElement>('[data-topology-panel="gateway"]');
      const upstreamPanel = root.querySelector<HTMLElement>('[data-topology-panel="upstream"]');
      if (!agentPanel || !gatewayPanel || !upstreamPanel) return;

      const toSvgX = (viewportX: number) => ((viewportX - rootRect.left) / rootRect.width) * 100;
      const toSvgY = (viewportY: number) => ((viewportY - rootRect.top) / rootRect.height) * 100;
      const rowAnchors = (panel: HTMLElement, edge: "left" | "right") =>
        Array.from(panel.querySelectorAll<HTMLElement>(".mcp-topology-row"), (row) => {
          const rect = row.getBoundingClientRect();
          return {
            x: toSvgX(rect[edge]),
            y: toSvgY(rect.top + rect.height / 2)
          };
        });
      const agentRect = agentPanel.getBoundingClientRect();
      const gatewayRect = gatewayPanel.getBoundingClientRect();
      const upstreamRect = upstreamPanel.getBoundingClientRect();
      const nextAnchors = {
        agentPanelX: toSvgX(agentRect.right),
        gatewayLeftX: toSvgX(gatewayRect.left),
        gatewayRightX: toSvgX(gatewayRect.right),
        upstreamPanelX: toSvgX(upstreamRect.left),
        agentRows: rowAnchors(agentPanel, "right"),
        upstreamRows: rowAnchors(upstreamPanel, "left")
      };

      const coordinates = [
        nextAnchors.agentPanelX,
        nextAnchors.gatewayLeftX,
        nextAnchors.gatewayRightX,
        nextAnchors.upstreamPanelX,
        ...nextAnchors.agentRows.flatMap(({ x, y }) => [x, y]),
        ...nextAnchors.upstreamRows.flatMap(({ x, y }) => [x, y])
      ];
      if (coordinates.every(Number.isFinite)) {
        setAnchors((current) => (sameAnchors(current, nextAnchors) ? current : nextAnchors));
      }
    };

    measureAnchors();
    window.addEventListener("resize", measureAnchors);

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureAnchors);
    if (observer && topologyRef.current) {
      observer.observe(topologyRef.current);
      topologyRef.current
        .querySelectorAll<HTMLElement>("[data-topology-panel], .mcp-topology-row")
        .forEach((element) => observer.observe(element));
    }

    return () => {
      window.removeEventListener("resize", measureAnchors);
      observer?.disconnect();
    };
  }, [visibleAgents.length, visibleServers.length]);

  return (
    <TooltipProvider delayDuration={150}>
      <Card role="region" aria-label="Agent 接入治理链路">
        <CardHeader className="pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Network aria-hidden="true" className="size-4 text-primary" />
              <h3>Agent 接入治理链路</h3>
              <HelpTooltip label="查看 Agent 接入治理链路说明">
                运行实例通过 Clawee MCP Gateway 受控访问企业能力
              </HelpTooltip>
            </CardTitle>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="secondary">{agentTotal} 个运行实例</Badge>
              <Badge variant="secondary">{serverTotal} 个上游服务</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="mcp-topology-container relative pb-6">
          {isLoading ? <div data-testid="mcp-gateway-topology-loading" className="sr-only" /> : null}
          <div
            ref={topologyRef}
            data-testid="mcp-gateway-topology-grid"
            className="mcp-topology-grid relative grid"
          >
            <ConnectionLayer agents={visibleAgents} servers={visibleServers} anchors={anchors} hoverTarget={hoverTarget} />
            <TopologyList
              side="agent"
              title="Agent 运行实例"
              total={agents.length}
              rows={visibleAgents}
              emptyTitle="暂无运行实例"
              listHref="/admin/activity"
              loading={isLoading}
              onHoverChange={setHoverTarget}
            />
            <GatewayNode summary={summary} loading={isLoading} />
            <TopologyList
              side="upstream"
              title="上游 MCP 服务"
              total={servers.length}
              rows={visibleServers}
              emptyTitle="暂无上游服务"
              listHref="/admin/mcp/upstream-servers"
              loading={isLoading}
              onHoverChange={setHoverTarget}
            />
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}

function TopologyList({
  side,
  title,
  total,
  rows,
  emptyTitle,
  listHref,
  loading,
  onHoverChange
}: {
  side: TopologySide;
  title: string;
  total: number;
  rows: TopologyRow[];
  emptyTitle: string;
  listHref: string;
  loading: boolean;
  onHoverChange: (target: HoverTarget | null) => void;
}) {
  const moreCount = Math.max(total - VISIBLE_LIMIT, 0);

  return (
    <section
      data-topology-panel={side}
      className={cn(
        "mcp-topology-side-panel relative z-10 grid w-full min-w-0 content-start rounded-md bg-muted/35"
      )}
    >
      <div className="mcp-topology-panel-header flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <Link
          aria-label={`查看 ${title}列表`}
          className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          to={listHref}
        >
          <span>{loading ? "..." : total} 个</span>
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
      <div className="mcp-topology-list grid border-t border-border/35 pt-2">
        {loading ? (
          <LoadingRows />
        ) : rows.length > 0 ? (
          rows.map((row) => (
            <Tooltip key={row.id}>
              <TooltipTrigger asChild>
                <Link
                  aria-label={`查看 ${row.title} 详情`}
                  className={cn(
                    "mcp-topology-row flex w-full items-center rounded-sm bg-card/75 transition-colors duration-150 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    side === "upstream" && "flex-row-reverse text-right"
                  )}
                  to={row.href}
                  onBlur={() => onHoverChange(null)}
                  onFocus={() => onHoverChange(row.target)}
                  onMouseEnter={() => onHoverChange(row.target)}
                  onMouseLeave={() => onHoverChange(null)}
                >
                  <div
                    className={cn(
                      "mcp-topology-row-main flex min-w-0 flex-1 items-center text-left",
                      side === "upstream" && "flex-row-reverse text-right"
                    )}
                  >
                    <row.icon className="size-4 shrink-0 text-primary" />
                    <span className="mcp-topology-row-copy grid min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{row.title}</span>
                      <span className="mcp-topology-row-meta truncate text-xs text-muted-foreground">{row.meta}</span>
                    </span>
                  </div>
                  <Badge className="mcp-topology-status" variant={topologyStatusVariant(row.status)}>
                    <span className="mcp-topology-status-text">{mcpStatusLabel(row.status)}</span>
                  </Badge>
                </Link>
              </TooltipTrigger>
              <TooltipContent>
                {side === "agent" ? row.id : `${row.meta} · ${row.capabilitiesCount ?? 0} 个能力`}
              </TooltipContent>
            </Tooltip>
          ))
        ) : (
          <CompactEmptyState title={emptyTitle} icon={side === "agent" ? Bot : Server} />
        )}
        {!loading && moreCount > 0 ? (
          <Link
            aria-label={`查看其余 ${moreCount} 个 ${title}`}
            className="mcp-topology-more inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            to={listHref}
          >
            <span>另有 {moreCount} 个</span>
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
    </section>
  );
}

function LoadingRows() {
  return (
    <div className="mcp-topology-loading-list grid">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="mcp-topology-loading-row flex items-center rounded-md">
          <Skeleton className="size-4 shrink-0" />
          <div className="mcp-topology-loading-copy grid min-w-0 flex-1">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
          <Skeleton className="h-5 w-16" />
        </div>
      ))}
    </div>
  );
}

function GatewayNode({ summary, loading }: { summary?: DashboardSummary; loading: boolean }) {
  const grants = loading ? "..." : String(summary?.grants.total ?? 0);
  const tools = loading ? "..." : `${summary?.capabilities.active ?? 0} / ${summary?.capabilities.total ?? 0}`;
  const audits = loading ? "..." : String(summary?.audits.recent24h ?? 0);
  const intercepts = loading ? "..." : String((summary?.audits.rejected ?? 0) + (summary?.audits.upstreamError ?? 0));

  return (
    <section className="mcp-topology-gateway-panel relative z-10 flex w-full min-w-0 flex-col justify-center">
      <div data-topology-panel="gateway" className="mcp-topology-gateway-node mcp-topology-gateway-pulse grid rounded-md bg-muted/35">
        <div className="mcp-topology-gateway-header grid text-center">
          <div className="mcp-topology-gateway-icon mx-auto flex items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm shadow-primary/15">
            <Route className="size-5" />
          </div>
          <div>
            <h3 className="mcp-topology-gateway-title font-semibold">Clawee MCP Gateway</h3>
            <p className="mcp-topology-gateway-subtitle text-xs text-muted-foreground">企业 Agent 与企业系统之间的治理入口</p>
          </div>
        </div>
        <div className="mcp-topology-capabilities grid grid-cols-2">
          <CapabilityLabel icon={KeyRound} label="认证" />
          <CapabilityLabel icon={ShieldCheck} label="授权" />
          <CapabilityLabel icon={TriangleAlert} label="门禁" />
          <CapabilityLabel icon={Braces} label="审计" />
        </div>
        <div className="mcp-topology-stats grid grid-cols-2">
          <GatewayStat testId="gateway-stat-grants" label="有效授权" value={grants} />
          <GatewayStat testId="gateway-stat-tools" label="可用能力" value={tools} />
          <GatewayStat testId="gateway-stat-audits" label="24h 调用" value={audits} />
          <GatewayStat testId="gateway-stat-intercepts" label="异常拦截" value={intercepts} />
        </div>
      </div>
    </section>
  );
}

function CapabilityLabel({ icon: Icon, label }: { icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <div className="mcp-topology-capability flex items-center rounded-sm bg-card/75 text-xs text-muted-foreground">
      <Icon className="mcp-topology-capability-icon text-primary" />
      <span>{label}</span>
    </div>
  );
}

function GatewayStat({ testId, label, value }: { testId: string; label: string; value: string }) {
  return (
    <div className="mcp-topology-stat rounded-sm bg-card/75">
      <div data-testid={testId} className="mcp-topology-stat-value font-semibold text-foreground">
        {value}
      </div>
      <div className="mcp-topology-stat-label text-muted-foreground">{label}</div>
    </div>
  );
}

function CompactEmptyState({ title, icon: Icon }: { title: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <Empty className="min-h-[168px] gap-3 p-4">
      <EmptyHeader className="gap-2">
        <EmptyMedia variant="icon">
          <Icon className="size-5" />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

function ConnectionLayer({
  agents,
  servers,
  anchors,
  hoverTarget
}: {
  agents: TopologyRow[];
  servers: TopologyRow[];
  anchors: TopologyAnchors;
  hoverTarget: HoverTarget | null;
}) {
  const agentLines = buildLinePaths("agent", agents, anchors);
  const upstreamLines = buildLinePaths("upstream", servers, anchors);

  return (
    <svg className="mcp-topology-connections pointer-events-none absolute inset-0 z-0 h-full w-full" aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">
      {agentLines.map((line) => (
        <path
          key={line.id}
          data-testid="agent-gateway-line"
          d={line.d}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={hoverTarget === line.target ? 0.35 : 0.2}
          className={cn("mcp-topology-flow text-border", hoverTarget === line.target && "text-primary")}
        />
      ))}
      {upstreamLines.map((line) => (
        <path
          key={line.id}
          data-testid="gateway-upstream-line"
          d={line.d}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={hoverTarget === line.target ? 0.35 : 0.2}
          className={cn("mcp-topology-flow text-border", hoverTarget === line.target && "text-primary")}
        />
      ))}
    </svg>
  );
}

function buildLinePaths(side: TopologySide, rows: TopologyRow[], anchors: TopologyAnchors): LinePath[] {
  return rows.map((row, index) => {
    const fallbackY = rowY(index, rows.length);
    const rowAnchor =
      side === "agent"
        ? (anchors.agentRows?.[index] ?? { x: anchors.agentPanelX, y: fallbackY })
        : (anchors.upstreamRows?.[index] ?? { x: anchors.upstreamPanelX, y: fallbackY });
    const d = side === "agent" ? agentLinePath(rowAnchor, anchors) : upstreamLinePath(rowAnchor, anchors);

    return {
      id: `${side}-${row.id}`,
      d,
      target: row.target
    };
  });
}

function rowY(index: number, total: number) {
  if (total <= 1) return 50;
  const min = 18;
  const max = 82;
  return min + (index * (max - min)) / (total - 1);
}

function activeFirst<T extends { status: string }>(items: T[]) {
  return [...items].sort((left, right) => Number(isAvailable(right.status)) - Number(isAvailable(left.status)));
}

function sameAnchors(left: TopologyAnchors, right: TopologyAnchors) {
  return (
    Math.abs(left.agentPanelX - right.agentPanelX) < 0.1 &&
    Math.abs(left.gatewayLeftX - right.gatewayLeftX) < 0.1 &&
    Math.abs(left.gatewayRightX - right.gatewayRightX) < 0.1 &&
    Math.abs(left.upstreamPanelX - right.upstreamPanelX) < 0.1 &&
    samePoints(left.agentRows ?? [], right.agentRows) &&
    samePoints(left.upstreamRows ?? [], right.upstreamRows)
  );
}

function samePoints(left: TopologyPoint[], right: TopologyPoint[]) {
  return (
    left.length === right.length &&
    left.every((point, index) => Math.abs(point.x - right[index].x) < 0.1 && Math.abs(point.y - right[index].y) < 0.1)
  );
}

function agentLinePath(rowAnchor: TopologyPoint, anchors: TopologyAnchors) {
  const { x: startX, y } = rowAnchor;
  const endX = anchors.gatewayLeftX;
  const [startControlX, endControlX] = connectorControlXs(startX, endX);
  const startControlY = y + (50 - y) * 0.28;
  return `M ${roundSvgX(startX)} ${roundSvgX(y)} C ${roundSvgX(startControlX)} ${roundSvgX(startControlY)}, ${roundSvgX(endControlX)} 50, ${roundSvgX(endX)} 50`;
}

function upstreamLinePath(rowAnchor: TopologyPoint, anchors: TopologyAnchors) {
  const { x: endX, y } = rowAnchor;
  const startX = anchors.gatewayRightX;
  const [startControlX, endControlX] = connectorControlXs(startX, endX);
  const endControlY = y + (50 - y) * 0.28;
  return `M ${roundSvgX(startX)} 50 C ${roundSvgX(startControlX)} 50, ${roundSvgX(endControlX)} ${roundSvgX(endControlY)}, ${roundSvgX(endX)} ${roundSvgX(y)}`;
}

function connectorControlXs(startX: number, endX: number) {
  const controlOffset = (endX - startX) * 0.45;
  return [startX + controlOffset, endX - controlOffset] as const;
}

function roundSvgX(value: number) {
  return Math.round(value * 10) / 10;
}

function agentToRow(agent: TopologyAgent): TopologyRow {
  return {
    id: agent.id,
    title: agent.title || agent.id,
    meta: agent.meta,
    status: agent.status || "unknown",
    icon: Bot,
    target: `agent:${agent.id}`,
    href: agent.href
  };
}

function serverToRow(server: MCPUpstreamServer): TopologyRow {
  const tools = server.capabilitiesCount ?? 0;
  return {
    id: server.id,
    title: server.name || server.id,
    meta: `${tools} 个能力 · ${server.namespace || server.domain || server.id}`,
    status: server.status || "unknown",
    icon: Server,
    target: `upstream:${server.id}`,
    href: `/admin/mcp/upstream-servers/detail?server_id=${encodeURIComponent(server.id)}`,
    capabilitiesCount: server.capabilitiesCount
  };
}

function isAvailable(status: string) {
  return !["offline", "blocked", "error", "disabled"].includes(status.toLowerCase());
}

function topologyStatusVariant(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "offline") return "muted";
  if (normalized === "blocked") return "warning";
  if (["error", "sync_failed"].includes(normalized)) return "danger";
  if (isAvailable(normalized) && normalized !== "active") return "accent";
  return mcpStatusVariant(normalized || "unknown");
}
