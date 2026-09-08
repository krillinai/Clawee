import { EmptyState, ErrorAlert, PageShell } from "@/components/governance-ui";
import { Card, CardContent } from "@/components/ui/card";
import { TurnGroupList } from "@/components/activity/turn-group-list";
import { useAgentDetail } from "@/hooks/useAgentDetail";
import type { ReactNode } from "react";

import { ActivityDetailHero } from "./activity-detail-hero";
import { ActivityDetailSummary } from "./activity-detail-summary";

export function ActivityDetailView({
  collectorId,
  agentId,
  listPath = "/admin/activity",
  navigation,
  scope = "admin",
}: {
  collectorId: string;
  agentId: string;
  listPath?: string;
  navigation?: ReactNode;
  scope?: "admin" | "app";
}) {
  const detailQuery = useAgentDetail(collectorId, agentId, scope);

  if (detailQuery.isLoading) {
    return (
      <PageShell>
        {navigation}
        <div className="text-sm text-muted-foreground">智能体活动详情加载中</div>
      </PageShell>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <PageShell>
        {navigation}
        <ErrorAlert>智能体活动详情加载失败</ErrorAlert>
        <EmptyState title="未找到该智能体" description="请返回活动列表重新选择。" />
      </PageShell>
    );
  }

  const detail = detailQuery.data;

  return (
    <PageShell>
      {navigation}
      <ActivityDetailHero detail={detail} listPath={listPath} />
      <ActivityDetailSummary detail={detail} />
      <Card className="shadow-none">
        <CardContent className="p-6">
          <TurnGroupList
            emptyTitle="该智能体暂无 turn"
            itemVariant="plain"
            sessions={detail.sessions}
            title="Turn 列表"
            turns={detail.turns}
          />
        </CardContent>
      </Card>
    </PageShell>
  );
}
