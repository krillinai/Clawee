import type {
  EnterpriseActivityDetailResponse,
  EnterpriseActivityStatisticsResponse
} from '@clawee/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEnterpriseActivityManager
} from '../../src/enterprise/activity-manager-2026-08-18.js';
import type {
  EnterpriseHttpClient
} from '../../src/enterprise/http-client-2026-07-30.js';
import {
  EnterpriseHttpError
} from '../../src/enterprise/http-client-2026-07-30.js';
import type {
  EnterpriseSessionManager
} from '../../src/enterprise/session-manager-2026-07-30.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enterprise activity manager', () => {
  it('allows detail only after the Agent appears in statistics for the same range', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const getActivityDetail = vi.fn(async () => detailFixture());
    const manager = createEnterpriseActivityManager({
      sessionManager: sessionManager(),
      httpClient: {
        hasAgentActivityGrant: vi.fn(async () => true),
        getActivityStatistics: vi.fn(async () => statisticsFixture()),
        getActivityDetail
      } as unknown as EnterpriseHttpClient,
      now: () => new Date('2026-08-18T08:00:00Z')
    });

    await expect(manager.getCapability()).resolves.toEqual({
      allowed: true,
      refreshedAt: '2026-08-18T08:00:00.000Z'
    });
    await expect(manager.getDetail({
      range: '7d',
      collectorId: 'collector-1',
      agentId: 'agent-1'
    })).rejects.toMatchObject({
      code: 'ENTERPRISE_ACTIVITY_NOT_FOUND',
      statusCode: 404
    });
    expect(getActivityDetail).not.toHaveBeenCalled();

    await manager.getStatistics('7d');
    await expect(manager.getDetail({
      range: '30d',
      collectorId: 'collector-1',
      agentId: 'agent-1'
    })).rejects.toMatchObject({
      code: 'ENTERPRISE_ACTIVITY_NOT_FOUND'
    });
    await expect(manager.getDetail({
      range: '7d',
      collectorId: 'collector-1',
      agentId: 'agent-1'
    })).resolves.toEqual(detailFixture());
    expect(getActivityDetail).toHaveBeenCalledOnce();
  });

  it('invalidates the enterprise session on a Gateway 401', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const session = sessionManager();
    const manager = createEnterpriseActivityManager({
      sessionManager: session,
      httpClient: {
        hasAgentActivityGrant: vi.fn(async () => {
          throw new EnterpriseHttpError(
            'ENTERPRISE_UNAUTHORIZED',
            'response',
            401,
            'unauthorized',
            undefined,
            'request-401'
          );
        })
      } as unknown as EnterpriseHttpClient
    });

    await expect(manager.getCapability()).rejects.toMatchObject({
      code: 'ENTERPRISE_SESSION_EXPIRED',
      statusCode: 401,
      details: {
        requestId: 'request-401',
        providerCode: 'unauthorized'
      }
    });
    expect(session.invalidateUnauthorized).toHaveBeenCalledOnce();
  });

  it('clears trusted Agent identifiers after permission revocation', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getActivityDetail = vi.fn()
      .mockRejectedValueOnce(new EnterpriseHttpError(
        'ENTERPRISE_DATA_VIEW_FORBIDDEN',
        'response',
        403,
        'data_view_forbidden'
      ))
      .mockResolvedValue(detailFixture());
    const manager = createEnterpriseActivityManager({
      sessionManager: sessionManager(),
      httpClient: {
        getActivityStatistics: vi.fn(async () => statisticsFixture()),
        getActivityDetail
      } as unknown as EnterpriseHttpClient
    });

    await manager.getStatistics('7d');
    await expect(manager.getDetail({
      range: '7d',
      collectorId: 'collector-1',
      agentId: 'agent-1'
    })).rejects.toMatchObject({
      code: 'ENTERPRISE_DATA_VIEW_FORBIDDEN'
    });
    await expect(manager.getDetail({
      range: '7d',
      collectorId: 'collector-1',
      agentId: 'agent-1'
    })).rejects.toMatchObject({
      code: 'ENTERPRISE_ACTIVITY_NOT_FOUND'
    });
    expect(getActivityDetail).toHaveBeenCalledOnce();
  });

  it('maps protocol failures from successful upstream responses to HTTP 502', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = createEnterpriseActivityManager({
      sessionManager: sessionManager(),
      httpClient: {
        getActivityStatistics: vi.fn(async () => {
          throw new EnterpriseHttpError(
            'ENTERPRISE_PROTOCOL_ERROR',
            'decode',
            200
          );
        })
      } as unknown as EnterpriseHttpClient
    });

    await expect(manager.getStatistics('7d')).rejects.toMatchObject({
      code: 'ENTERPRISE_PROTOCOL_ERROR',
      statusCode: 502
    });
  });
});

function sessionManager(): EnterpriseSessionManager {
  return {
    requireAccessToken: vi.fn(async () => 'access-token'),
    invalidateUnauthorized: vi.fn(async () => undefined)
  } as unknown as EnterpriseSessionManager;
}

function statisticsFixture(): EnterpriseActivityStatisticsResponse {
  return {
    range: '7d',
    timezone: 'Asia/Shanghai',
    startDate: '2026-08-12',
    endDate: '2026-08-18',
    generatedAt: '2026-08-18T08:00:00Z',
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
    trend: { granularity: 'day', points: [] },
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
    serverTime: '2026-08-18T08:00:00Z',
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
