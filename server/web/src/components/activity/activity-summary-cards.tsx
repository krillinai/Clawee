import type { OfficeSummary } from "@/lib/office-api";
import { MetricCard } from "@/components/governance-ui";

export function ActivitySummaryCards({ summary, isLoading }: { summary?: OfficeSummary; isLoading: boolean }) {
  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      <MetricCard label="智能体总数" value={isLoading ? "..." : summary?.total_agents ?? 0} />
      <MetricCard label="在线" value={isLoading ? "..." : summary?.online_agents ?? 0} />
      <MetricCard label="工作中" value={isLoading ? "..." : summary?.working_agents ?? 0} />
      <MetricCard label="活跃会话" value={isLoading ? "..." : summary?.active_sessions ?? 0} />
      <MetricCard label="活跃 Turn" value={isLoading ? "..." : summary?.active_turns ?? 0} />
    </section>
  );
}
