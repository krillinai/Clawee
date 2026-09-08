import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorAlert, PageHeader, PageShell } from "@/components/governance-ui";
import { useDashboardFilters } from "@/hooks/useDashboardFilters";
import { useOfficeSnapshot } from "@/hooks/useOfficeSnapshot";
import { useRealtimeEvents } from "@/hooks/useRealtimeEvents";
import type { AgentListItem } from "@/lib/office-api";

import { ActivityFilters } from "./activity-filters";
import { ActivitySidePanel } from "./activity-side-panel";
import { ActivitySummaryCards } from "./activity-summary-cards";
import { ActivityTable } from "./activity-table";

export function ActivityDashboardView({ navigation, scope = "admin" }: { navigation?: ReactNode; scope?: "admin" | "app" }) {
  const officeQuery = useOfficeSnapshot(scope);
  const connectionState = useRealtimeEvents(officeQuery.data?.sse_url, scope);
  const detailBasePath = scope === "app" ? "/app/activity/detail" : "/admin/activity/detail";
  const agents = officeQuery.data?.agents ?? [];
  const { filters, setFilters, filteredAgents } = useDashboardFilters(agents);
  const [selectedKey, setSelectedKey] = useState<string>();

  useEffect(() => {
    if (filteredAgents.length === 0) {
      setSelectedKey(undefined);
      return;
    }

    if (!selectedKey || !filteredAgents.some((agent) => agentKey(agent) === selectedKey)) {
      setSelectedKey(agentKey(filteredAgents[0]));
    }
  }, [filteredAgents, selectedKey]);

  const selectedAgent = useMemo(
    () => filteredAgents.find((agent) => agentKey(agent) === selectedKey) ?? filteredAgents[0],
    [filteredAgents, selectedKey],
  );

  return (
    <PageShell>
      {navigation}
      <PageHeader title="智能体活动" />

      {officeQuery.isError ? <ErrorAlert>智能体活动加载失败</ErrorAlert> : null}

      <ActivitySummaryCards isLoading={officeQuery.isLoading} summary={officeQuery.data?.summary} />

      <section className="grid min-w-0 gap-4 2xl:grid-cols-[minmax(0,2fr)_minmax(0,380px)]">
        <Card className="min-w-0 overflow-hidden shadow-none">
          <CardHeader>
            <CardTitle>活动列表</CardTitle>
          </CardHeader>
          <CardContent className="grid min-w-0 gap-4">
            <div className="grid min-w-0 gap-3">
              <div className="text-sm font-medium">筛选条件</div>
              <ActivityFilters
                filters={filters}
                officeFilters={
                  officeQuery.data?.filters ?? { workspaces: [], status_counts: {}, business_systems: [] }
                }
                setFilters={setFilters}
              />
            </div>
            {officeQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">智能体活动加载中</div>
            ) : officeQuery.isError ? (
              <EmptyState title="智能体活动加载失败" description="请稍后刷新重试。" />
            ) : filteredAgents.length === 0 ? (
              <EmptyState title={agents.length === 0 ? "还没有智能体状态" : "没有匹配的智能体"} />
            ) : (
              <ActivityTable
                agents={filteredAgents}
                detailBasePath={detailBasePath}
                onSelect={(agent) => setSelectedKey(agentKey(agent))}
                selectedKey={selectedKey}
                showOwner={scope === "admin"}
              />
            )}
          </CardContent>
        </Card>

        <ActivitySidePanel
          agent={selectedAgent}
          connectionState={connectionState}
          detailBasePath={detailBasePath}
          recentFeed={officeQuery.data?.recent_feed ?? []}
          scope={scope}
        />
      </section>
    </PageShell>
  );
}

function agentKey(agent: AgentListItem) {
  return `${agent.collector_id}/${agent.agent_id}`;
}
