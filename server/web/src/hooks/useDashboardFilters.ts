import { useMemo, useState } from "react";

import type { AgentListItem, AgentStatus, BusinessSystemCount } from "../lib/office-api";

export type DashboardFilterState = {
  query: string;
  workspace: string;
  statuses: AgentStatus[];
  businessSystems: string[];
};

const defaultFilters: DashboardFilterState = {
  query: "",
  workspace: "all",
  statuses: [],
  businessSystems: [],
};

export function filterAgents(agents: AgentListItem[], filters: DashboardFilterState): AgentListItem[] {
  const query = filters.query.trim().toLowerCase();

  return agents.filter((agent) => {
    if (query && !agentSearchText(agent).includes(query)) {
      return false;
    }

    if (filters.workspace !== "all" && agent.workspace_name !== filters.workspace) {
      return false;
    }

    if (filters.statuses.length > 0 && !filters.statuses.includes(agent.status)) {
      return false;
    }

    if (filters.businessSystems.length > 0) {
      if (!agent.active_business_call) {
        return false;
      }

      const key = businessSystemKey({
        system_type: agent.active_business_call.system_type,
        system_name: agent.active_business_call.system_name,
      });
      if (!filters.businessSystems.includes(key)) {
        return false;
      }
    }

    return true;
  });
}

export function useDashboardFilters(agents: AgentListItem[]) {
  const [filters, setFilters] = useState<DashboardFilterState>(defaultFilters);
  const filteredAgents = useMemo(() => filterAgents(agents, filters), [agents, filters]);

  return {
    filters,
    setFilters,
    filteredAgents,
    clearFilters: () => setFilters(defaultFilters),
  };
}

function agentSearchText(agent: AgentListItem): string {
  return [
    agent.display_name,
    agent.agent_id,
    agent.agent_type,
    agent.role_label,
    agent.workspace_name,
    agent.current_session?.session_id,
    agent.current_session?.summary,
    agent.current_turn?.title,
    agent.current_turn?.assistant_summary,
    agent.current_turn?.user_prompt,
    agent.active_business_call?.system_name,
    agent.active_business_call?.operation_label,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

function businessSystemKey(input: Pick<BusinessSystemCount, "system_type" | "system_name">): string {
  return `${keySegment(input.system_type)}/${keySegment(input.system_name)}`;
}

function keySegment(segment: string): string {
  return segmentNeedsEncoding(segment) ? `${segment.length}:${encodeURIComponent(segment)}` : segment;
}

function segmentNeedsEncoding(segment: string): boolean {
  return segment.includes("/") || segment.includes("%") || segment.includes(":");
}
