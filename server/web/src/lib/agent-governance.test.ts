import { describe, expect, it } from "vitest";

import type { MCPAgent } from "./mcp-admin-api";
import type { AgentListItem } from "./office-api";
import { mergeAgentGovernanceRows } from "./agent-governance";

describe("mergeAgentGovernanceRows", () => {
  it("keeps Office-only and MCP-only Agents while merging an explicit link once", () => {
    const officeOnly = officeAgent("office_only");
    const linkedOffice = officeAgent("office_linked", "mcp_linked");
    const mcpOnly = mcpAgent("mcp_only");
    const linkedMCP = mcpAgent("mcp_linked");

    const rows = mergeAgentGovernanceRows([officeOnly, linkedOffice], [mcpOnly, linkedMCP]);

    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.kind === "office_only")?.officeAgent).toBe(officeOnly);
    expect(rows.find((row) => row.kind === "mcp_only")?.mcpAgent).toBe(mcpOnly);
    expect(rows.find((row) => row.kind === "linked")).toMatchObject({
      officeAgent: linkedOffice,
      mcpAgent: linkedMCP,
    });
  });

  it("does not guess links from matching names or ids", () => {
    const office = officeAgent("same_id");
    const mcp = mcpAgent("same_id");

    const rows = mergeAgentGovernanceRows([office], [mcp]);

    expect(rows.map((row) => row.kind)).toEqual(["office_only", "mcp_only"]);
  });

  it("uses the server-managed MCP name for linked agents", () => {
    const office = { ...officeAgent("office-1", "mcp-1"), display_name: "Codex Local" };
    const mcp = { ...mcpAgent("mcp-1"), name: "徐刚的Codex" };

    const rows = mergeAgentGovernanceRows([office], [mcp]);

    expect(rows[0]?.displayName).toBe("徐刚的Codex");
  });
});

function officeAgent(agentId: string, mcpAgentId?: string): AgentListItem {
  return {
    collector_id: "collector_1",
    agent_id: agentId,
    mcp_agent_id: mcpAgentId,
    display_name: agentId,
    avatar_label: "A",
    agent_type: "codex",
    role_label: "Agent",
    device_id: "device_1",
    workspace_name: "workspace",
    status: "idle",
    sub_agents: { active_count: 0, total_count: 0, preview: [] },
    sessions: [],
    recent_tool_calls: 0,
    last_seen_at: "2026-07-29T10:00:00Z",
    updated_at: "2026-07-29T10:00:00Z",
  };
}

function mcpAgent(agentId: string): MCPAgent {
  return {
    agentId,
    clientId: "",
    name: agentId,
    tenantId: "",
    actorId: "owner_1",
    status: "active",
    createdAt: "2026-07-29T10:00:00Z",
    updatedAt: "2026-07-29T10:00:00Z",
  };
}
