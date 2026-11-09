import { useQuery } from "@tanstack/react-query";

import { getMyAgentUsage, type ActivityRange } from "../lib/activity-api";

export function agentUsageQueryKey(collectorId: string, agentId: string, range: ActivityRange) {
  return ["app-agent-usage", collectorId, agentId, range] as const;
}

export function useAgentUsage(collectorId: string, agentId: string, scope: "admin" | "app", range: ActivityRange) {
  return useQuery({
    queryKey: agentUsageQueryKey(collectorId, agentId, range),
    queryFn: () => getMyAgentUsage(collectorId, agentId, range),
    enabled: scope === "app" && collectorId.length > 0 && agentId.length > 0,
  });
}
