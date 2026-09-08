import { MetricCard } from "@/components/governance-ui";
import type { AgentActivityDetail } from "@/lib/office-api";

export function ActivityDetailSummary({ detail }: { detail: AgentActivityDetail }) {
  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="活跃会话" value={detail.stats.active_sessions} />
      <MetricCard label="Session 数" value={detail.sessions.length} />
      <MetricCard label="Turn 数" value={detail.turns.length} />
      <MetricCard label="当前 turn" value={detail.current_turn?.status ?? "-"} foot={detail.current_turn?.title ?? "暂无当前 turn"} />
    </section>
  );
}
