import { describe, expect, it, vi } from 'vitest';
import {
  createEnterpriseHttpClient
} from '../../src/enterprise/http-client-2026-07-30.js';

const ORIGIN = 'https://enterprise.example';

describe('enterprise activity HTTP client', () => {
  it('loads personal statistics for the exact Agent and range and maps usage evidence', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => new URL(String(url)).pathname.endsWith('/agent-usage')
      ? jsonResponse({ data: usagePayload() }) : jsonResponse(detailPayload()));
    const result = await createEnterpriseHttpClient({ fetch, origin: ORIGIN }).getActivityDetail('access-token', 'collector/上海', 'agent?research', '7d');
    expect(result.usage).toMatchObject({ range: '7d', collectorId: 'collector/上海', agentId: 'agent?research',
      turnCount: 123, points: [{ turnCount: 123 }], mcpDistribution: [{ invocationCount: 4 }],
      skillUsage: [{ observedRuns: 5 }], skillUsageTotals: { observedSkillRuns: 5 } });
    expect(String(fetch.mock.calls[1]?.[0])).toBe(`${ORIGIN}/api/v1/app/activity/agent-usage?collector_id=collector%2F%E4%B8%8A%E6%B5%B7&agent_id=agent%3Fresearch&range=7d`);
  });

  it.each([404, 503])('keeps execution history when personal statistics return %s', async status => {
    const fetch = vi.fn(async (url: string | URL | Request) => new URL(String(url)).pathname.endsWith('/agent-usage')
      ? jsonResponse({ error: { code: 'activity_unavailable' } }, status) : jsonResponse(detailPayload()));
    const result = await createEnterpriseHttpClient({ fetch, origin: ORIGIN }).getActivityDetail('access-token', 'collector/上海', 'agent?research', '7d');
    expect(result.usage).toBeUndefined();
    expect(result.agent.agentId).toBe('agent?research');
  });

  it.each([401, 403])('propagates personal statistics authorization failures (%s)', async status => {
    const fetch = vi.fn(async (url: string | URL | Request) => new URL(String(url)).pathname.endsWith('/agent-usage')
      ? jsonResponse({ error: { code: 'data_view_forbidden' } }, status) : jsonResponse(detailPayload()));
    await expect(createEnterpriseHttpClient({ fetch, origin: ORIGIN }).getActivityDetail('access-token', 'collector/上海', 'agent?research', '7d'))
      .rejects.toMatchObject({ statusCode: status });
  });

  it.each([{ collector_id: 'other' }, { agent_id: 'other' }, { range: 'today' }, { granularity: 'hour' }])('rejects mismatched personal usage: %j', async mismatch => {
    const fetch = vi.fn(async (url: string | URL | Request) => new URL(String(url)).pathname.endsWith('/agent-usage')
      ? jsonResponse({ data: { ...usagePayload(), ...mismatch } }) : jsonResponse(detailPayload()));
    await expect(createEnterpriseHttpClient({ fetch, origin: ORIGIN }).getActivityDetail('access-token', 'collector/上海', 'agent?research', '7d'))
      .rejects.toMatchObject({ code: 'ENTERPRISE_PROTOCOL_ERROR' });
  });

  it('preserves Skill evidence counts and employee ownership without inventing missing statistics', async () => {
    const payload = statisticsPayload();
    const fetch = vi.fn(async () => jsonResponse({ data: {
      ...payload.data,
      organization: { ...payload.data.organization,
        skill_usage: [{ skill_id: 'skill-1', skill_key: 'research', skill_name: '调研', source: 'enterprise', requested_runs: 8, observed_runs: 5, implicit_runs: 2 }],
        skill_usage_totals: { requested_skill_runs: 8, observed_skill_runs: 5, explicit_skill_runs: 3, implicit_skill_runs: 2 }
      },
      agents: payload.data.agents.map(agent => ({ ...agent, employee_id: 'employee-1', employee_name: '张三' }))
    } }));
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });
    const result = await client.getActivityStatistics('access-token', '7d');
    expect(result.organization.skillUsage?.[0]).toMatchObject({ skillName: '调研', requestedRuns: 8, observedRuns: 5, implicitRuns: 2 });
    expect(result.organization.skillUsageTotals).toEqual({ requestedSkillRuns: 8, observedSkillRuns: 5, explicitSkillRuns: 3, implicitSkillRuns: 2 });
    expect(result.agents[0]).toMatchObject({ employeeId: 'employee-1', employeeName: '张三' });
    fetch.mockImplementation(async () => jsonResponse(payload));
    expect((await client.getActivityStatistics('access-token', '7d')).organization.skillUsage).toBeUndefined();
  });

  it('loads organization runtime status and strips undeclared fields', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) => jsonResponse({
      schema_version: 'office.v1', scope: 'organization', server_time: '2026-10-28T00:00:00Z',
      summary: { total_agents: 1, online_agents: 1, working_agents: 1, blocked_agents: 0, error_agents: 0 },
      agents: [{ collector_id: 'collector', agent_id: 'agent', status: 'thinking', current_task: '调研', last_seen_at: '2026-10-28T00:00:00Z', user_prompt: 'PRIVATE' }]
    }));
    const result = await createEnterpriseHttpClient({ fetch, origin: ORIGIN }).getActivityRuntime('access-token');
    expect(result).toMatchObject({ scope: 'organization', summary: { workingAgents: 1 }, agents: [{ currentTask: '调研', status: 'thinking' }] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`${ORIGIN}/api/v1/app/activity/runtime`);
  });

  it('loads organization runtime status when the gateway wraps the payload in data', async () => {
    const runtime = {
      schema_version: 'office.v1', scope: 'organization', server_time: '2026-10-28T00:00:00Z',
      summary: { total_agents: 1, online_agents: 1, working_agents: 1, blocked_agents: 0, error_agents: 0 },
      agents: [{ collector_id: 'collector', agent_id: 'agent', status: 'thinking', current_task: '调研', last_seen_at: '2026-10-28T00:00:00Z' }]
    };
    const fetch = vi.fn(async () => jsonResponse({ data: runtime }));

    await expect(createEnterpriseHttpClient({ fetch, origin: ORIGIN }).getActivityRuntime('access-token'))
      .resolves.toMatchObject({ scope: 'organization', summary: { workingAgents: 1 }, agents: [{ currentTask: '调研' }] });
  });

  it('uses only the documented app routes and strips sensitive detail fields', async () => {
    const fetch = vi.fn(async (
      url: string | URL | Request,
      _init?: RequestInit
    ) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/app/data-views') {
        return jsonResponse({
          data: [
            { view_id: 'other_view', actions: ['read'] },
            { view_id: 'agent_activity', actions: ['read'] }
          ]
        });
      }
      if (path === '/api/v1/app/activity/statistics') {
        return jsonResponse(statisticsPayload());
      }
      return jsonResponse({ data: detailPayload() });
    });
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    await expect(
      client.hasAgentActivityGrant('access-token')
    ).resolves.toBe(true);
    const statistics = await client.getActivityStatistics(
      'access-token',
      '7d'
    );
    const detail = await client.getActivityDetail(
      'access-token',
      'collector/上海',
      'agent?research'
    );

    expect(statistics).toMatchObject({
      range: '7d',
      organization: {
        usage: {
          totalTokens: 1_200
        },
        platformActivity: {
          activeUsers: 2,
          totalUsers: 4,
          rate: 0.5
        }
      },
      agents: [{
        collectorId: 'collector/上海',
        agentId: 'agent?research'
      }],
      tokenUsageRanking: [{
        rank: 1,
        name: '研发团队',
        requests: 2,
        totalTokens: 1_200
      }],
      dataStatus: {
        sub2api: 'available',
        activity: 'available'
      }
    });
    expect(detail.turns[0]).toMatchObject({
      prompt: 'authorized page content',
      assistantSummary: 'authorized answer'
    });
    expect(detail.toolCalls).toEqual([{
      toolCallId: 'tool-1',
      name: 'WebSearch',
      type: 'mcp',
      status: 'success',
      occurredAt: '2026-08-18T07:58:00Z',
      durationMs: 120
    }]);
    expect(detail.recentActivities).toEqual([{
      activityId: 'activity-1',
      type: 'tool',
      title: 'Search complete',
      status: 'completed',
      occurredAt: '2026-08-18T07:59:00Z'
    }]);
    expect(JSON.stringify(detail)).not.toContain('private tool');
    expect(fetch.mock.calls.map(call => String(call[0]))).toEqual([
      `${ORIGIN}/api/v1/app/data-views`,
      `${ORIGIN}/api/v1/app/activity/statistics?range=7d`,
      `${ORIGIN}/api/v1/app/activity/detail?collector_id=collector%2F%E4%B8%8A%E6%B5%B7&agent_id=agent%3Fresearch`
    ]);
    for (const call of fetch.mock.calls) {
      expect(call[1]).toMatchObject({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token'
        })
      });
    }
  });

  it('accepts the documented top-level office.v1 detail response', async () => {
    const fetch = vi.fn(async () => jsonResponse(detailPayload()));
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    await expect(client.getActivityDetail(
      'access-token',
      'collector/上海',
      'agent?research'
    )).resolves.toMatchObject({
      schemaVersion: 'office.v1',
      agent: {
        collectorId: 'collector/上海',
        agentId: 'agent?research'
      }
    });
  });

  it('accepts the legacy sub2api activity data status field', async () => {
    const currentPayload = statisticsPayload();
    const legacyPayload = {
      ...currentPayload,
      data: {
        ...currentPayload.data,
        data_status: {
          sub2api: 'available',
          activity: 'available'
        }
      }
    };
    const fetch = vi.fn(async () => jsonResponse(legacyPayload));
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    await expect(client.getActivityStatistics(
      'access-token',
      '7d'
    )).resolves.toMatchObject({
      dataStatus: {
        sub2api: 'available',
        activity: 'available'
      }
    });
  });

  it('rejects activity data status without a model usage field', async () => {
    const currentPayload = statisticsPayload();
    const invalidPayload = {
      ...currentPayload,
      data: {
        ...currentPayload.data,
        data_status: {
          activity: 'available'
        }
      }
    };
    const fetch = vi.fn(async () => jsonResponse(invalidPayload));
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    await expect(client.getActivityStatistics(
      'access-token',
      '7d'
    )).rejects.toMatchObject({
      code: 'ENTERPRISE_PROTOCOL_ERROR',
      stage: 'decode',
      statusCode: 200
    });
  });

  it('maps activity authorization and provider failures without retaining bodies', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: 'data_view_forbidden',
          request_id: 'request-forbidden',
          details: { secret: 'must-not-escape' }
        }
      }, 403))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: 'sub2api_rate_limited',
          request_id: 'request-rate-limit'
        }
      }), {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'retry-after': '3'
        }
      }));
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    await expect(
      client.hasAgentActivityGrant('access-token')
    ).rejects.toMatchObject({
      code: 'ENTERPRISE_DATA_VIEW_FORBIDDEN',
      requestId: 'request-forbidden',
      details: expect.objectContaining({ failureKind: 'response', statusCode: 403, upstreamCode: 'data_view_forbidden' })
    });
    await expect(
      client.getActivityStatistics('access-token', '7d')
    ).rejects.toMatchObject({
      code: 'ENTERPRISE_ACTIVITY_PROVIDER_ERROR',
      retryAfterMs: 3_000,
      requestId: 'request-rate-limit'
    });
  });
});

function statisticsPayload() {
  return {
    data: {
      range: '7d',
      timezone: 'Asia/Shanghai',
      start_date: '2026-08-12',
      end_date: '2026-08-18',
      generated_at: '2026-08-18T08:00:00Z',
      organization: {
        usage: {
          input_tokens: 1_000,
          cached_input_tokens: 600,
          output_tokens: 200,
          total_tokens: 1_200
        },
        active_employees: 1,
        active_agents: 1,
        completed_turns: 2,
        platform_activity: {
          active_users: 2,
          total_users: 4,
          rate: 0.5
        },
        mcp_distribution: []
      },
      trend: {
        granularity: 'day',
        points: []
      },
      model_distribution: [],
      token_usage_ranking: [{
        rank: 1,
        name: '研发团队',
        requests: 2,
        total_tokens: 1_200
      }],
      agents: [{
        collector_id: 'collector/上海',
        agent_id: 'agent?research',
        name: 'Research Agent',
        status: 'online',
        session_count: 1,
        turn_count: 2
      }],
      data_status: {
        model_usage: 'available',
        activity: 'available'
      }
    }
  };
}

function detailPayload() {
  return {
    schema_version: 'office.v1',
    server_time: '2026-08-18T08:00:00Z',
    agent: {
      collector_id: 'collector/上海',
      agent_id: 'agent?research',
      display_name: 'Research Agent',
      agent_type: 'clawee',
      workspace_name: '研发项目',
      status: 'online',
      sessions: [],
      sub_agents: {
        active_count: 0,
        total_count: 0,
        preview: []
      },
      recent_tool_calls: 1,
      last_seen_at: '2026-08-18T07:59:00Z',
      updated_at: '2026-08-18T07:59:00Z'
    },
    sessions: [],
    turns: [{
      id: 'turn-1',
      user_prompt: 'authorized page content',
      last_assistant_message: 'authorized answer'
    }],
    sub_agents: [],
    tool_calls: [{
      id: 'tool-1',
      tool_name: 'WebSearch',
      tool_type: 'mcp',
      status: 'success',
      started_at: '2026-08-18T07:58:00Z',
      duration_ms: 120,
      input: 'private tool input',
      response: 'private tool response',
      response_text: 'private response text'
    }],
    status_timeline: [],
    recent_activities: [{
      activity_id: 'activity-1',
      activity_type: 'tool',
      title: 'Search complete',
      status: 'completed',
      completed_at: '2026-08-18T07:59:00Z'
    }],
    stats: {
      session_duration_ms: 0,
      active_sub_agents: 0,
      total_sub_agents: 0,
      recent_activity_count: 0,
      business_risk_level: 'unknown',
      active_sessions: 0,
      active_work_ms: 0,
      tool_type_variety: 1,
      tool_call_count: 1
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function usagePayload() {
  return {
    collector_id: 'collector/上海', agent_id: 'agent?research', range: '7d', timezone: 'Asia/Shanghai',
    start_date: '2026-08-12', end_date: '2026-08-18', generated_at: '2026-08-18T08:00:00Z',
    session_count: 51, turn_count: 123, completed_turns: 120, tool_call_count: 345, granularity: 'day',
    points: [{ bucket_start: '2026-08-18T00:00:00+08:00', session_count: 51, turn_count: 123, completed_turns: 120, tool_call_count: 345 }],
    mcp_status: 'available', mcp_distribution: [{ id: 'search', label: '搜索服务', invocation_count: 4, share: 1 }],
    skill_usage: [{ skill_id: 'research', skill_key: 'research', skill_name: '调研', source: 'enterprise', requested_runs: 8, observed_runs: 5, implicit_runs: 2 }],
    skill_usage_totals: { requested_skill_runs: 8, observed_skill_runs: 5, explicit_skill_runs: 3, implicit_skill_runs: 2 }
  };
}
