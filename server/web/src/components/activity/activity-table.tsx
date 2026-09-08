import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DataTableShell, TableStateRow } from "@/components/governance-ui";
import { formatBeijingDateTime } from "@/lib/datetime";
import type { AgentListItem } from "@/lib/office-api";
import { truncateMiddle, truncateText } from "@/lib/text";
import { cn } from "@/lib/utils";

import { AgentStatusBadge } from "./status-badge";

export function ActivityTable({
  agents,
  detailBasePath = "/admin/activity/detail",
  selectedKey,
  showOwner = false,
  onSelect,
}: {
  agents: AgentListItem[];
  detailBasePath?: string;
  selectedKey?: string;
  showOwner?: boolean;
  onSelect: (agent: AgentListItem) => void;
}) {
  const columnCount = showOwner ? 7 : 6;

  return (
    <DataTableShell dense minWidth={showOwner ? 1080 : 920}>
      <TableHeader>
        <TableRow className="bg-background font-mono text-xs text-muted-foreground">
          <TableHead className="border-b border-border px-3 py-3 font-medium">智能体</TableHead>
          {showOwner ? <TableHead className="min-w-[150px] whitespace-nowrap border-b border-border px-3 py-3 font-medium">责任账号</TableHead> : null}
          <TableHead className="border-b border-border px-3 py-3 font-medium">最新 session</TableHead>
          <TableHead className="border-b border-border px-3 py-3 font-medium">状态</TableHead>
          <TableHead className="border-b border-border px-3 py-3 font-medium">当前 turn</TableHead>
          <TableHead className="border-b border-border px-3 py-3 font-medium">最近心跳</TableHead>
          <TableHead className="border-b border-border px-3 py-3 text-right font-medium">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.length === 0 ? (
          <TableStateRow colSpan={columnCount}>暂无匹配的智能体活动</TableStateRow>
        ) : (
          agents.map((agent) => {
            const rowKey = activityKey(agent);
            const detailHref = `${detailBasePath}?collector_id=${encodeURIComponent(agent.collector_id)}&agent_id=${encodeURIComponent(agent.agent_id)}`;
            const latestSession = getLatestSession(agent);
            const currentTurn = agent.current_turn?.title || latestSession?.current_turn_title || "-";
            const currentStatus = agent.current_turn?.status ?? latestSession?.status ?? agent.status;
            const currentTurnLabel = truncateText(currentTurn, 72);
            return (
              <TableRow
                className={cn(
                  "cursor-pointer hover:bg-foreground/[0.03]",
                  selectedKey === rowKey && "bg-accent/30",
                )}
                key={rowKey}
                onClick={() => onSelect(agent)}
              >
                <TableCell className="border-b border-border px-3 py-3">
                  <div className="grid gap-1">
                    <strong>{agent.display_name}</strong>
                    <span className="font-mono text-xs text-muted-foreground">{agent.agent_id}</span>
                  </div>
                </TableCell>
                {showOwner ? (
                  <TableCell className="border-b border-border px-3 py-3">
                    <div className="grid gap-1">
                      <span className="break-words">{agent.owner_name || agent.owner_email || agent.owner_user_id || "-"}</span>
                      <span className="break-all text-xs text-muted-foreground">
                        {agent.owner_email || agent.owner_user_id || "-"}
                      </span>
                    </div>
                  </TableCell>
                ) : null}
                <TableCell className="border-b border-border px-3 py-3">
                  <span className="font-mono text-xs" title={latestSession?.session_id}>
                    {formatShortId(latestSession?.session_id)}
                  </span>
                </TableCell>
                <TableCell className="border-b border-border px-3 py-3">
                  <AgentStatusBadge status={currentStatus} />
                </TableCell>
                <TableCell className="max-w-[320px] border-b border-border px-3 py-3">
                  <div className="grid min-w-0 gap-1">
                    <span className="block truncate" title={currentTurn}>
                      {currentTurnLabel}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground" title={agent.current_turn?.turn_id}>
                      {agent.current_turn?.turn_id ?? "暂无 turn id"}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{formatDateTime(agent.last_seen_at)}</TableCell>
                <TableCell className="border-b border-border px-3 py-3">
                  <div className="flex justify-end">
                    <Button asChild size="sm" variant="outline">
                      <Link aria-label={`查看 ${agent.display_name} 详情`} to={detailHref}>
                        查看详情
                      </Link>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </DataTableShell>
  );
}

function formatDateTime(value?: string) {
  return formatBeijingDateTime(value);
}

function activityKey(agent: AgentListItem) {
  return `${agent.collector_id}/${agent.agent_id}`;
}

function getLatestSession(agent: AgentListItem) {
  if (agent.current_session) {
    const brief = agent.sessions.find((session) => session.session_id === agent.current_session?.session_id);
    return {
      session_id: agent.current_session.session_id,
      status: agent.current_session.status,
      current_turn_title: brief?.current_turn_title ?? agent.current_turn?.title ?? "-",
      active: brief?.active ?? agent.current_session.ended_at === undefined,
    };
  }

  return agent.sessions[0];
}

function formatShortId(value?: string) {
  if (!value) return "-";
  return truncateMiddle(value, 8, 6);
}
