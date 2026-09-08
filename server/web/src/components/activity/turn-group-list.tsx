import { Link } from "react-router-dom";

import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/governance-ui";
import { formatBeijingDateTime } from "@/lib/datetime";
import type { AgentStatus, SessionItem, TurnItem } from "@/lib/office-api";
import { truncateText } from "@/lib/text";
import { cn } from "@/lib/utils";

import { AgentStatusBadge } from "./status-badge";

type SessionGroup = {
  sessionId: string;
  status?: AgentStatus;
  turns: TurnItem[];
};

export function TurnGroupList({
  title,
  description,
  turns,
  sessions = [],
  limit,
  sessionLimit,
  turnLimitPerSession,
  moreHref,
  isLoading = false,
  emptyTitle = "暂无 turn",
  itemVariant = "card",
}: {
  title?: string;
  description?: string;
  turns: TurnItem[];
  sessions?: SessionItem[];
  limit?: number;
  sessionLimit?: number;
  turnLimitPerSession?: number;
  moreHref?: string;
  isLoading?: boolean;
  emptyTitle?: string;
  itemVariant?: "card" | "plain";
}) {
  const groupedTurns = groupTurnsBySession(turns, sessions, limit);
  const visibleGroups = typeof sessionLimit === "number" ? groupedTurns.slice(0, sessionLimit) : groupedTurns;
  const hasMoreGroups = typeof sessionLimit === "number" && groupedTurns.length > sessionLimit;

  return (
    <section className="grid min-w-0 gap-3">
      {title || description ? (
        <header className="grid gap-1">
          {title ? <h2 className="text-base font-semibold">{title}</h2> : null}
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </header>
      ) : null}
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Turn 信息加载中</div>
      ) : groupedTurns.length === 0 ? (
        <EmptyState title={emptyTitle} />
      ) : (
        <div className="grid min-w-0 gap-4">
          {visibleGroups.map((group, index) => (
            <section
              className={cn(
                "grid min-w-0 overflow-hidden rounded-md border border-border bg-card",
                itemVariant === "card" && "gap-3 p-3",
              )}
              key={group.sessionId}
            >
              {index > 0 ? <Separator /> : null}
              <div
                className={cn(
                  "flex min-w-0 flex-wrap items-center justify-between gap-2",
                  itemVariant === "plain" && "border-b border-border bg-muted/25 px-3 py-2.5",
                )}
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold">Session {compactID(group.sessionId)}</div>
                </div>
                <div className="flex items-center gap-2">
                  {group.status ? <AgentStatusBadge status={group.status} /> : null}
                  <span className="text-xs text-muted-foreground">{group.turns.length} 个 turn</span>
                </div>
              </div>
              <div className={cn("grid min-w-0 gap-3", itemVariant === "plain" && "p-3")}>
                {visibleTurnsForGroup(group.turns, turnLimitPerSession).map((turn) => {
                  const titleDuplicatesPrompt = isSimilarText(turn.title, turn.user_prompt);
                  const title = titleDuplicatesPrompt ? `Turn ${compactID(turn.turn_id)}` : turn.title || turn.turn_id;

                  return (
                    <article
                      className={cn(
                        "grid min-w-0 gap-3",
                        itemVariant === "card" && "rounded-md border border-border bg-card p-3",
                        itemVariant === "plain" && "rounded-md border border-border bg-muted/15 p-3 shadow-sm shadow-foreground/[0.02]",
                      )}
                      key={turn.turn_id}
                    >
                      <div
                        className={cn(
                          "flex min-w-0 flex-wrap items-start justify-between gap-2",
                          itemVariant === "plain" && "-m-3 mb-0 rounded-t-md border-b border-border bg-muted/30 px-3 py-2",
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div
                            className={cn("text-sm font-medium", itemVariant === "plain" ? "truncate font-semibold" : "break-words")}
                            title={itemVariant === "plain" ? title : undefined}
                          >
                            {title}
                          </div>
                        </div>
                        <AgentStatusBadge status={turn.status} />
                      </div>
                      <TurnTextBlock isCompact={itemVariant === "plain"} label="用户输入" value={turn.user_prompt} />
                      <TurnTextBlock isCompact={itemVariant === "plain"} label="助手回复" value={turn.last_assistant_message} />
                      <div className="text-xs text-muted-foreground">更新时间：{formatDateTime(turn.updated_at)}</div>
                    </article>
                  );
                })}
                {hasMoreTurnsInGroup(group.turns, turnLimitPerSession) ? (
                  <div className="text-center text-sm text-muted-foreground" aria-label="还有更多 turn">
                    ...
                  </div>
                ) : null}
              </div>
            </section>
          ))}
          {hasMoreGroups ? (
            moreHref ? (
              <Link
                aria-label="查看更多 session 和 turn"
                className="text-center text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                to={moreHref}
              >
                ... 查看更多 session 和 turn
              </Link>
            ) : (
              <div className="text-center text-sm text-muted-foreground" aria-label="还有更多 session 和 turn">
                ...
              </div>
            )
          ) : null}
        </div>
      )}
    </section>
  );
}

function visibleTurnsForGroup(turns: TurnItem[], limit?: number) {
  return typeof limit === "number" ? turns.slice(0, limit) : turns;
}

function hasMoreTurnsInGroup(turns: TurnItem[], limit?: number) {
  return typeof limit === "number" && turns.length > limit;
}

function TurnTextBlock({ isCompact = false, label, value }: { isCompact?: boolean; label: string; value?: string }) {
  const text = value?.trim() || "-";

  return (
    <div className="grid min-w-0 gap-1">
      <div className="text-xs font-semibold text-foreground">{label}</div>
      <div
        className={cn("whitespace-pre-wrap break-words text-sm leading-6", isCompact && "line-clamp-3")}
        title={isCompact ? text : undefined}
      >
        {text}
      </div>
    </div>
  );
}

function groupTurnsBySession(turns: TurnItem[], sessions: SessionItem[], limit?: number): SessionGroup[] {
  const sessionStatus = new Map(sessions.map((session) => [session.session_id, session.status]));
  const sortedTurns = [...turns].sort((left, right) => dateValue(right.updated_at) - dateValue(left.updated_at));
  const visibleTurns = typeof limit === "number" ? sortedTurns.slice(0, limit) : sortedTurns;
  const groups = new Map<string, SessionGroup>();

  for (const turn of visibleTurns) {
    const sessionId = turn.session_id || "-";
    const group = groups.get(sessionId) ?? {
      sessionId,
      status: turn.status ?? sessionStatus.get(sessionId),
      turns: [],
    };
    group.turns.push(turn);
    groups.set(sessionId, group);
  }

  return Array.from(groups.values());
}

function dateValue(value?: string) {
  if (!value) return 0;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  return date.getTime();
}

function formatDateTime(value?: string) {
  return formatBeijingDateTime(value);
}

function isSimilarText(left?: string, right?: string) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);

  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = normalizedLeft.length > normalizedRight.length ? normalizedLeft : normalizedRight;
  if (shorter.length >= 16 && longer.includes(shorter)) return true;

  const leftTokens = tokenize(normalizedLeft);
  const rightTokens = tokenize(normalizedRight);
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;

  const rightSet = new Set(rightTokens);
  const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
  return overlap / Math.min(leftTokens.length, rightTokens.length) >= 0.85;
}

function normalizeText(value?: string) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(value: string) {
  return value.match(/[\p{L}\p{N}_:/.-]+/gu) ?? [];
}

function compactID(value: string) {
  if (!value) return "-";
  if (truncateText(value, 12, "") === value) return value;
  return truncateText(value, 8);
}
