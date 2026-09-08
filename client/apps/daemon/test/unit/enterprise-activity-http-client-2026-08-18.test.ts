import { describe, expect, it, vi } from 'vitest';
import {
  createEnterpriseHttpClient
} from '../../src/enterprise/http-client-2026-07-30.js';

const ORIGIN = 'https://enterprise.example';

describe('enterprise activity HTTP client', () => {
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
      details: undefined
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
