import type { MCPAgent } from "./mcp-admin-api";
import type { AgentListItem } from "./office-api";

export type AgentGovernanceRow = {
  key: string;
  kind: "office_only" | "mcp_only" | "linked";
  displayName: string;
  officeAgent?: AgentListItem;
  mcpAgent?: MCPAgent;
};

export function mergeAgentGovernanceRows(
  officeAgents: AgentListItem[],
  mcpAgents: MCPAgent[],
): AgentGovernanceRow[] {
  const mcpByID = new Map(mcpAgents.map((agent) => [agent.agentId, agent]));
  const linkedMCPIDs = new Set<string>();
  const rows = officeAgents.map((officeAgent): AgentGovernanceRow => {
    const mcpAgent = officeAgent.mcp_agent_id ? mcpByID.get(officeAgent.mcp_agent_id) : undefined;
    if (mcpAgent) {
      linkedMCPIDs.add(mcpAgent.agentId);
      return {
        key: `linked:${officeAgent.collector_id}:${officeAgent.agent_id}`,
        kind: "linked",
        displayName: mcpAgent.name || officeAgent.display_name || officeAgent.agent_id,
        officeAgent,
        mcpAgent,
      };
    }
    return {
      key: `office:${officeAgent.collector_id}:${officeAgent.agent_id}`,
      kind: "office_only",
      displayName: officeAgent.display_name || officeAgent.agent_id,
      officeAgent,
    };
  });

  for (const mcpAgent of mcpAgents) {
    if (linkedMCPIDs.has(mcpAgent.agentId)) continue;
    rows.push({
      key: `mcp:${mcpAgent.agentId}`,
      kind: "mcp_only",
      displayName: mcpAgent.name || mcpAgent.agentId,
      mcpAgent,
    });
  }
  return rows;
}
