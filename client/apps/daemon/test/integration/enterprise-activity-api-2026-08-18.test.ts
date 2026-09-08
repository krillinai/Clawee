import type {
  EnterpriseActivityDetailResponse,
  EnterpriseActivityStatisticsResponse
} from '@clawee/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../helpers/build-server.js';
import {
  EnterpriseActivityManagerError,
  type EnterpriseActivityManager
} from '../../src/enterprise/activity-manager-2026-08-18.js';

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('enterprise activity runtime API', () => {
  it('requires runtime authentication and forwards valid activity requests', async () => {
    const manager = createManager();
    server = await buildServer({
      token: 'secret',
      enterpriseActivityManager: manager
    });

    const unauthorized = await server.inject({
      method: 'GET',
      url: '/enterprise/activity/capability'
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(manager.getCapability).not.toHaveBeenCalled();

    const capability = await authGet('/enterprise/activity/capability');
    expect(capability.statusCode).toBe(200);
    expect(capability.json()).toEqual({
      allowed: true,
      refreshedAt: '2026-08-18T08:00:00.000Z'
    });

    const statistics = await authGet(
      '/enterprise/activity/statistics?range=7d'
    );
    expect(statistics.statusCode).toBe(200);
    expect(statistics.json()).toEqual(statisticsFixture());
    expect(manager.getStatistics).toHaveBeenCalledWith('7d');

    const detail = await authGet(
      '/enterprise/activity/detail'
      + '?range=7d&collectorId=collector-1&agentId=agent-1'
    );
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual(detailFixture());
    expect(manager.getDetail).toHaveBeenCalledWith({
      range: '7d',
      collectorId: 'collector-1',
      agentId: 'agent-1'
    });
  });

  it('rejects missing, invalid, and unknown query parameters', async () => {
    const manager = createManager();
    server = await buildServer({
      token: 'secret',
      enterpriseActivityManager: manager
    });

    for (const url of [
      '/enterprise/activity/statistics',
      '/enterprise/activity/statistics?range=week',
      '/enterprise/activity/statistics?range=7d&extra=value',
      '/enterprise/activity/detail?range=7d&collectorId=collector-1',
      '/enterprise/activity/detail?range=7d&collectorId=&agentId=agent-1',
      '/enterprise/activity/detail'
        + '?range=7d&collectorId=collector-1&agentId=agent-1&extra=value'
    ]) {
      const response = await authGet(url);
      expect(response.statusCode, url).toBe(400);
      expect(response.json(), url).toMatchObject({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'activity request is invalid'
        }
      });
    }

    expect(manager.getStatistics).not.toHaveBeenCalled();
    expect(manager.getDetail).not.toHaveBeenCalled();
  });

  it('maps manager failures to stable API errors with diagnostic details', async () => {
    const manager = createManager({
      getStatistics: vi.fn(async () => {
        throw new EnterpriseActivityManagerError(
          'ENTERPRISE_ACTIVITY_PROVIDER_ERROR',
          502,
          {
            requestId: 'gateway-request-1',
            retryAfterMs: 5_000,
            providerCode: 'SUB2API_TIMEOUT'
          }
        );
      })
    });
    server = await buildServer({
      token: 'secret',
      enterpriseActivityManager: manager
    });

    const response = await authGet(
      '/enterprise/activity/statistics?range=30d'
    );

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: 'ENTERPRISE_ACTIVITY_PROVIDER_ERROR',
        message: 'Enterprise activity provider is unavailable',
        details: {
          requestId: 'gateway-request-1',
          retryAfterMs: 5_000,
          providerCode: 'SUB2API_TIMEOUT'
        }
      }
    });
  });
});

function authGet(url: string) {
  return server!.inject({
    method: 'GET',
    url,
    headers: { authorization: 'Bearer secret' }
  });
}

function createManager(
  overrides: Partial<EnterpriseActivityManager> = {}
): EnterpriseActivityManager {
  return {
    getCapability: vi.fn(async () => ({
      allowed: true,
      refreshedAt: '2026-08-18T08:00:00.000Z'
    })),
    getStatistics: vi.fn(async () => statisticsFixture()),
    getDetail: vi.fn(async () => detailFixture()),
    clear: vi.fn(),
    ...overrides
  };
}

function statisticsFixture(): EnterpriseActivityStatisticsResponse {
  return {
    range: '7d',
    timezone: 'Asia/Shanghai',
    startDate: '2026-08-12',
    endDate: '2026-08-18',
    generatedAt: '2026-08-18T08:00:00.000Z',
    organization: {
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 600,
        outputTokens: 200,
        totalTokens: 1_200
      },
      activeEmployees: 1,
      activeAgents: 1,
      completedTurns: 2,
      mcpDistribution: []
    },
    trend: {
      granularity: 'day',
      points: []
    },
    modelDistribution: [],
    tokenUsageRanking: [],
    agents: [{
      collectorId: 'collector-1',
      agentId: 'agent-1',
      name: 'Agent',
      status: 'online',
      sessionCount: 1,
      turnCount: 2
    }],
    dataStatus: {
      sub2api: 'available',
      activity: 'available'
    }
  };
}

function detailFixture(): EnterpriseActivityDetailResponse {
  return {
    schemaVersion: 'office.v1',
    serverTime: '2026-08-18T08:00:00.000Z',
    agent: {
      collectorId: 'collector-1',
      agentId: 'agent-1',
      displayName: 'Agent',
      agentType: 'clawee',
      workspaceName: 'Project',
      status: 'online',
      activeSubAgentCount: 0,
      totalSubAgentCount: 0,
      recentToolCalls: 0
    },
    sessions: [],
    turns: [],
    subAgents: [],
    toolCalls: [],
    statusTimeline: [],
    recentActivities: [],
    stats: {
      sessionDurationMs: 0,
      activeSubAgents: 0,
      totalSubAgents: 0,
      recentActivityCount: 0,
      businessRiskLevel: 'unknown',
      activeSessions: 0,
      activeWorkMs: 0,
      toolTypeVariety: 0,
      toolCallCount: 0
    }
  };
}
