import { useState } from "react";

import { EmptyState, ErrorAlert, LoadingState } from "@/components/governance-ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAgentUsage } from "@/hooks/useAgentUsage";
import type { ActivityRange } from "@/lib/activity-api";
import { formatDateTime } from "@/lib/mcp-admin-ui";

const rangeOptions: Array<{ value: ActivityRange; label: string }> = [
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];

export function ActivityDetailSkillUsage({ collectorId, agentId, scope }: { collectorId: string; agentId: string; scope: "admin" | "app" }) {
  const [range, setRange] = useState<ActivityRange>("7d");
  const usageQuery = useAgentUsage(collectorId, agentId, scope, range);

  if (scope !== "app") return null;
  if (usageQuery.isLoading) return <LoadingState label="Skill 使用统计加载中" />;
  if (usageQuery.isError || !usageQuery.data) {
    return <ErrorAlert error={usageQuery.error}>Skill 使用统计加载失败，请稍后重试。</ErrorAlert>;
  }

  const usage = usageQuery.data;
  const totals = usage.skill_usage_totals ?? {
    requested_skill_runs: 0,
    observed_skill_runs: 0,
    explicit_skill_runs: 0,
    implicit_skill_runs: 0,
  };
  return (
    <section aria-label="个人 Agent Skill 使用" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Skill 使用统计</h2>
          <p className="mt-1 text-sm text-muted-foreground">{usage.start_date} 至 {usage.end_date} · {usage.timezone}</p>
        </div>
        <ToggleGroup
          aria-label="Skill 统计时间范围"
          onValueChange={(value) => value && setRange(value as ActivityRange)}
          type="single"
          value={range}
          variant="outline"
        >
          {rangeOptions.map((option) => <ToggleGroupItem className="px-3" key={option.value} value={option.value}>{option.label}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>
      <section aria-label="个人 Skill 汇总" className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["明确请求", totals.requested_skill_runs],
          ["观测使用", totals.observed_skill_runs],
          ["显式使用", totals.explicit_skill_runs],
          ["隐式使用", totals.implicit_skill_runs],
        ].map(([label, value]) => (
          <div className="min-w-0 bg-card p-4" key={label}>
            <span className="text-xs text-muted-foreground">{label}</span>
            <strong className="mt-2 block font-mono text-2xl">{value}</strong>
          </div>
        ))}
      </section>
      <Card className="shadow-none">
        <CardHeader><CardTitle><h3>Skill 使用明细</h3></CardTitle><CardDescription>按 Skill 和来源汇总当前范围内的使用证据</CardDescription></CardHeader>
        <CardContent className="p-0">
          {usage.skill_usage.length === 0 ? <div className="p-6"><EmptyState title="当前范围内暂无 Skill 使用证据" /></div> : (
            <Table aria-label="个人 Skill 使用明细">
              <TableHeader><TableRow>
                <TableHead className="pl-6">Skill</TableHead><TableHead>来源</TableHead>
                <TableHead className="text-right">明确请求</TableHead><TableHead className="text-right">观测使用</TableHead><TableHead className="pr-6 text-right">隐式使用</TableHead>
              </TableRow></TableHeader>
              <TableBody>{usage.skill_usage.map((item) => (
                <TableRow key={`${item.source}:${item.skill_key}`}>
                  <TableCell className="pl-6 font-medium">{item.skill_name}</TableCell>
                  <TableCell>{item.source === "enterprise" ? "企业" : "本地"}</TableCell>
                  <TableCell className="text-right font-mono">{item.requested_runs}</TableCell>
                  <TableCell className="text-right font-mono">{item.observed_runs}</TableCell>
                  <TableCell className="pr-6 text-right font-mono">{item.implicit_runs}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">最近生成于 {formatDateTime(usage.generated_at)}</p>
    </section>
  );
}
