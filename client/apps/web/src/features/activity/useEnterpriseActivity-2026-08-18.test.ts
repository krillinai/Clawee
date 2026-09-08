import type {
  EnterpriseActivityDetailResponse,
  EnterpriseActivityStatisticsResponse,
  EnterpriseSessionResponse
} from '@clawee/protocol';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../runtime/client.js';
import {
  useEnterpriseActivity
} from './useEnterpriseActivity-2026-08-18.js';

const session: EnterpriseSessionResponse = {
  status: 'signed_in',
  account: {
    subjectId: 'account-1',
    email: 'member@example.com',
    name: 'Member'
  },
  transportSecurity: 'secure_https'
};

describe('useEnterpriseActivity', () => {
  it('fails closed and leaves a direct activity route when capability is denied', async () => {
    const onLeave = vi.fn();
    const getActivityStatistics = vi.fn(async () => statisticsFixture());
    const route = { view: 'activity', range: '7d' } as const;
    const service = {
      getActivityCapability: vi.fn(async () => ({
        allowed: false,
        refreshedAt: '2026-08-18T08:00:00Z'
      })),
      getActivityStatistics,
      getActivityDetail: vi.fn(async () => detailFixture())
    };
    const { result } = renderHook(() => useEnterpriseActivity({
      connected: true,
      session,
      service,
      route,
      onNavigate: vi.fn(),
      onLeave,
      onUnauthorized: vi.fn()
    }));

    await waitFor(() => expect(result.current.capability).toBe('denied'));
    expect(onLeave).toHaveBeenCalledOnce();
    expect(getActivityStatistics).not.toHaveBeenCalled();
  });

  it('loads statistics before a trusted detail request', async () => {
    const getActivityStatistics = vi.fn(async () => statisticsFixture());
    const getActivityDetail = vi.fn(async () => detailFixture());
    const route = {
      view: 'activity-agent',
      range: '7d',
      collectorId: 'collector-1',
      agentId: 'agent-1'
    } as const;
    const service = {
      getActivityCapability: vi.fn(async () => ({
        allowed: true,
        refreshedAt: '2026-08-18T08:00:00Z'
      })),
      getActivityStatistics,
      getActivityDetail
    };
    const { result } = renderHook(() => useEnterpriseActivity({
      connected: true,
      session,
      service,
      route,
      onNavigate: vi.fn(),
      onLeave: vi.fn(),
      onUnauthorized: vi.fn()
    }));

    await waitFor(() => expect(result.current.detail).toEqual(detailFixture()));
    expect(getActivityStatistics).toHaveBeenCalledWith('7d');
    expect(getActivityDetail).toHaveBeenCalledWith({
      range: '7d',
      collectorId: 'collector-1',
      agentId: 'agent-1'
    });
    expect(
      getActivityStatistics.mock.invocationCallOrder[0]
    ).toBeLessThan(getActivityDetail.mock.invocationCallOrder[0]!);
  });

  it('does not query detail for identifiers absent from current statistics', async () => {
    const onNavigate = vi.fn();
    const getActivityDetail = vi.fn(async () => detailFixture());
    const route = {
      view: 'activity-agent',
      range: '7d',
      collectorId: 'unknown-collector',
      agentId: 'unknown-agent'
    } as const;
    const service = {
      getActivityCapability: vi.fn(async () => ({
        allowed: true,
        refreshedAt: '2026-08-18T08:00:00Z'
      })),
      getActivityStatistics: vi.fn(async () => statisticsFixture()),
      getActivityDetail
    };
    renderHook(() => useEnterpriseActivity({
      connected: true,
      session,
      service,
      route,
      onNavigate,
      onLeave: vi.fn(),
      onUnauthorized: vi.fn()
    }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(
      { view: 'activity', range: '7d' },
      { replace: true }
    ));
    expect(getActivityDetail).not.toHaveBeenCalled();
  });

  it('clears data, refreshes capability, and leaves after permission revocation', async () => {
    const onLeave = vi.fn();
    const route = { view: 'activity', range: '7d' } as const;
    const getActivityCapability = vi.fn()
      .mockResolvedValueOnce({
        allowed: true,
        refreshedAt: '2026-08-18T08:00:00Z'
      })
      .mockResolvedValueOnce({
        allowed: false,
        refreshedAt: '2026-08-18T08:01:00Z'
      });
    const service = {
      getActivityCapability,
      getActivityStatistics: vi.fn(async () => {
        throw new ApiClientError({
          status: 403,
          code: 'ENTERPRISE_DATA_VIEW_FORBIDDEN',
          message: 'forbidden'
        });
      }),
      getActivityDetail: vi.fn(async () => detailFixture())
    };
    const { result } = renderHook(() => useEnterpriseActivity({
      connected: true,
      session,
      service,
      route,
      onNavigate: vi.fn(),
      onLeave,
      onUnauthorized: vi.fn()
    }));

    await waitFor(() => expect(onLeave).toHaveBeenCalledOnce());
    expect(getActivityCapability).toHaveBeenCalledTimes(2);
    expect(result.current.capability).toBe('denied');
    expect(result.current.statistics).toBeUndefined();
    expect(result.current.detail).toBeUndefined();
  });
});

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
