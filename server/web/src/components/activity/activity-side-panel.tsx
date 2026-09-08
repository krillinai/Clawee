import type { ActivityFeedItem, AgentListItem } from "@/lib/office-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { useAgentDetail } from "@/hooks/useAgentDetail";
import { formatBeijingDateTime } from "@/lib/datetime";
import type { AgentStatus } from "@/lib/office-api";

import { statusLabel } from "./status-badge";
import { TurnGroupList } from "./turn-group-list";

const RECENT_STATUS_LIMIT = 5;

export function ActivitySidePanel({
  agent,
  detailBasePath = "/admin/activity/detail",
  recentFeed,
  connectionState,
  scope = "admin",
}: {
  agent?: AgentListItem;
  detailBasePath?: string;
  recentFeed: ActivityFeedItem[];
  connectionState: "connecting" | "connected" | "reconnecting" | "disconnected";
  scope?: "admin" | "app";
}) {
  const detailQuery = useAgentDetail(agent?.collector_id ?? "", agent?.agent_id ?? "", scope);
  const detailHref = agent
    ? `${detailBasePath}?collector_id=${encodeURIComponent(agent.collector_id)}&agent_id=${encodeURIComponent(agent.agent_id)}`
    : undefined;

  return (
    <div className="grid min-w-0 gap-4">
      <Card className="min-w-0 shadow-none">
        <CardHeader className="gap-2">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <CardTitle>实时状态</CardTitle>
            <Badge variant={connectionState === "connected" ? "success" : connectionState === "reconnecting" ? "warning" : "muted"}>
              {connectionLabel(connectionState)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          {recentFeed.length === 0 ? (
            <EmptyState title="暂无最近动态" />
          ) : (
            <ul className="grid min-w-0">
              {recentFeed.slice(0, RECENT_STATUS_LIMIT).map((item, index) => (
                <li
                  className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-2 border-b border-border py-2.5 text-sm last:border-b-0"
                  key={`${item.collector_id}-${item.agent_id}-${item.activity_id ?? index}`}
                >
                  <time
                    className="self-center font-mono text-xs text-muted-foreground"
                    dateTime={item.occurred_at}
                    title={formatDateTime(item.occurred_at)}
                  >
                    {formatTime(item.occurred_at)}
                  </time>
                  <ActivityFeedText item={item} />
                </li>
              ))}
              {recentFeed.length > RECENT_STATUS_LIMIT ? (
                <li className="text-center text-sm text-muted-foreground" aria-label="还有更多实时状态">
                  ...
                </li>
              ) : null}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0 shadow-none">
        <CardHeader>
          <CardTitle>选中智能体</CardTitle>
        </CardHeader>
        <CardContent>
          {!agent ? (
            <EmptyState title="请选择智能体" description="点击左侧列表中的任意一行。" />
          ) : (
            <div className="grid min-w-0 gap-3">
              <div className="min-w-0">
                <div className="text-base font-semibold">{agent.display_name}</div>
                <div className="break-all font-mono text-xs text-muted-foreground">{agent.agent_id}</div>
              </div>
              <TurnGroupList
                emptyTitle="该智能体暂无 turn"
                isLoading={detailQuery.isLoading}
                itemVariant="plain"
                limit={10}
                moreHref={detailHref}
                sessionLimit={3}
                sessions={detailQuery.data?.sessions ?? []}
                turnLimitPerSession={3}
                turns={detailQuery.data?.turns ?? []}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function connectionLabel(state: "connecting" | "connected" | "reconnecting" | "disconnected") {
  if (state === "connected") return "已连接";
  if (state === "reconnecting") return "重连中";
  if (state === "disconnected") return "未连接";
  return "连接中";
}

function formatDateTime(value: string) {
  return formatBeijingDateTime(value);
}

function formatTime(value: string) {
  const formatted = formatBeijingDateTime(value);
  const time = formatted.split(" ")[1];
  return time || formatted;
}

function ActivityFeedText({ item }: { item: ActivityFeedItem }) {
  const parsed = parseFeedText(item.text);
  const activity = item.activity_type || parsed.activity;
  const detail = feedDetail(item, parsed.summary);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 font-medium" title={parsed.source}>
        {parsed.source}
      </span>
      {activity ? (
        <Badge className="max-w-20 shrink-0 truncate font-mono" variant="muted" title={activity}>
          {statusLabel(activity as AgentStatus)}
        </Badge>
      ) : null}
      {detail ? (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={detail}>
          {detail}
        </span>
      ) : (
        <span className="min-w-0 flex-1" aria-hidden="true" />
      )}
    </div>
  );
}

function parseFeedText(text: string) {
  const match = text.match(/^(.+?)\s+([a-z][\w-]*):\s*(.+)$/i);
  if (!match) return { source: text || "-", activity: "", summary: text || "-" };

  return {
    source: match[1].trim() || "-",
    activity: match[2].trim(),
    summary: match[3].trim() || text,
  };
}

function feedDetail(item: ActivityFeedItem, fallback: string) {
  const summary = item.summary?.trim();
  if (summary && !isRedundantFeedDetail(summary, item.activity_type, item.title)) return summary;

  const title = item.title?.trim();
  if (title && !isRedundantFeedDetail(title, item.activity_type)) return title;

  const parsedSummary = fallback.trim();
  if (parsedSummary && !isRedundantFeedDetail(parsedSummary, item.activity_type, item.title)) return parsedSummary;

  return "";
}

function isRedundantFeedDetail(value: string, activityType?: string, title?: string) {
  const normalized = normalizeFeedText(value);
  return normalized === normalizeFeedText(activityType) || normalized === normalizeFeedText(title);
}

function normalizeFeedText(value?: string) {
  return (value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}
