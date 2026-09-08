import { describe, expect, it } from "vitest";

import type { AgentListItem } from "../lib/office-api";
import { fixtureAgent, fixtureOffice } from "../test/office-fixtures";
import { filterAgents } from "./useDashboardFilters";

describe("filterAgents", () => {
  it("searches across agent, turn, session, and business system fields", () => {
    expect(
      filterAgents(fixtureOffice.agents, {
        query: "purchase",
        workspace: "all",
        statuses: [],
        businessSystems: [],
      }),
    ).toHaveLength(1);

    expect(
      filterAgents(
        [
          {
            ...fixtureAgent,
            current_session: {
              ...fixtureAgent.current_session!,
              summary: "Session summary unique-session-marker",
            },
            active_business_call: undefined,
          },
        ],
        {
          query: "unique-session-marker",
          workspace: "all",
          statuses: [],
          businessSystems: [],
        },
      ),
    ).toHaveLength(1);

    expect(
      filterAgents(fixtureOffice.agents, {
        query: "missing",
        workspace: "all",
        statuses: [],
        businessSystems: [],
      }),
    ).toHaveLength(0);
  });

  it("filters by workspace, status, and business system", () => {
    const codingAgent: AgentListItem = {
      ...fixtureAgent,
      agent_id: "platform-coder-01",
      display_name: "Platform Coder",
      role_label: "Engineer",
      workspace_name: "Platform",
      status: "coding",
      active_business_call: undefined,
      current_session: {
        ...fixtureAgent.current_session!,
        session_id: "S-9001",
        workspace_name: "Platform",
        summary: "Feature coding session",
      },
      current_turn: {
        ...fixtureAgent.current_turn!,
        turn_id: "turn_platform_coding",
        session_id: "S-9001",
        title: "Build platform feature",
        assistant_summary: "Coding dashboard UI",
        status: "coding",
      },
      sub_agents: {
        active_count: 0,
        total_count: 0,
        preview: [],
      },
    };

    expect(
      filterAgents([fixtureAgent, codingAgent], {
        query: "",
        workspace: "Global Operations",
        statuses: ["calling_business_system"],
        businessSystems: ["erp/ERP Gateway"],
      }),
    ).toEqual([fixtureAgent]);
  });
});
