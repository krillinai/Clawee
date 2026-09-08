import { useQuery } from "@tanstack/react-query";

import { getAgentDetail, getMyAgentDetail } from "../lib/office-api";

export function agentDetailQueryKey(collectorId: string, agentId: string, scope: "admin" | "app" = "admin") {
  return [scope === "app" ? "app-agent-detail" : "agent-detail", collectorId, agentId] as const;
}

export function useAgentDetail(collectorId: string, agentId: string, scope: "admin" | "app" = "admin") {
  return useQuery({
    queryKey: agentDetailQueryKey(collectorId, agentId, scope),
    queryFn: () => scope === "app" ? getMyAgentDetail(collectorId, agentId) : getAgentDetail(collectorId, agentId),
    enabled: collectorId.length > 0 && agentId.length > 0,
  });
}
