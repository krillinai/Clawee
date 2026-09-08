import { describe, expect, it } from 'vitest';
import type {
  EnterpriseActivityCapabilityResponse,
  EnterpriseActivityDetailResponse,
  EnterpriseActivityStatisticsResponse,
  EnterpriseDingTalkLoginPrepareResponse,
  EnterpriseLoginRequest,
  EnterpriseQrLoginStartResponse,
  EnterpriseRegisterRequest,
  EnterpriseSessionResponse,
  EnterpriseSkillDetailResponse,
  EnterpriseSkillListResponse,
  EnterpriseSkillMutationResponse,
  RuntimeErrorCode
} from '../src/index.js';

describe('enterprise runtime contract', () => {
  it('exports enterprise session and skill contracts without credential fields', () => {
    const login: EnterpriseLoginRequest = {
      email: 'user@example.com',
      password: 'password-123'
    };
    const register: EnterpriseRegisterRequest = {
      email: login.email,
      name: 'User',
      password: login.password
    };
    const session: EnterpriseSessionResponse = {
      status: 'signed_in',
      account: {
        subjectId: 'acct-user',
        email: login.email,
        name: register.name ?? ''
      },
      expiresAt: '2026-07-30T12:00:00.000Z',
      transportSecurity: 'secure_https'
    };
    const qrLogin: EnterpriseQrLoginStartResponse = {
      requestId: 'qr-1',
      provider: 'wecom',
      qrCodeUrl: 'https://enterprise.example/qr-1.png',
      expiresAt: '2026-07-30T12:01:00.000Z',
      pollAfterMs: 1000
    };
    const dingtalkLogin: EnterpriseDingTalkLoginPrepareResponse = {
      authorizationUrl:
        'https://enterprise.example/api/v1/auth/dingtalk/clawee/start',
      expiresAt: '2026-08-17T12:10:00.000Z'
    };
    const activityCapability: EnterpriseActivityCapabilityResponse = {
      allowed: true,
      refreshedAt: '2026-08-18T08:00:00.000Z'
    };
    const activityStatistics: EnterpriseActivityStatisticsResponse = {
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
      trend: { granularity: 'day', points: [] },
      modelDistribution: [],
      tokenUsageRanking: [],
      agents: [{
        collectorId: 'collector-1',
        agentId: 'agent-1',
        name: 'Clawee Agent',
        status: 'online',
        sessionCount: 1,
        turnCount: 2
      }],
      dataStatus: {
        sub2api: 'available',
        activity: 'available'
      }
    };
    const activityDetail: EnterpriseActivityDetailResponse = {
      schemaVersion: 'office.v1',
      serverTime: '2026-08-18T08:00:00.000Z',
      agent: {
        collectorId: 'collector-1',
        agentId: 'agent-1',
        displayName: 'Clawee Agent',
        agentType: 'clawee',
        workspaceName: 'Project',
        status: 'online',
        activeSubAgentCount: 0,
        totalSubAgentCount: 0,
        recentToolCalls: 1
      },
      sessions: [],
      turns: [],
      subAgents: [],
      toolCalls: [{
        toolCallId: 'tool-1',
        name: 'WebSearch',
        type: 'mcp',
        status: 'success',
        occurredAt: '2026-08-18T07:59:00.000Z',
        durationMs: 120
      }],
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
        toolTypeVariety: 1,
        toolCallCount: 1
      }
    };
    const detail: EnterpriseSkillDetailResponse = {
      skillId: 'skill-1',
      name: 'enterprise-skill',
      description: 'Enterprise skill',
      version: '1.0.0',
      status: 'not_installed',
      integrity: 'not_applicable',
      actions: ['install'],
      changelog: 'Initial release'
    };
    const list: EnterpriseSkillListResponse = {
      skills: [detail],
      refreshedAt: '2026-07-30T12:00:00.000Z'
    };
    const mutation: EnterpriseSkillMutationResponse = {
      skill: {
        ...detail,
        status: 'installed',
        integrity: 'verified',
        actions: ['use']
      },
      localSkill: {
        id: detail.name,
        name: detail.name,
        status: 'valid',
        diagnostics: [],
        codexHome: '/tmp/codex-home',
        codexHomeMode: 'isolated',
        skillsPath: '/tmp/codex-home/skills',
        skillPath: `/tmp/codex-home/skills/${detail.name}`,
        skillFilePath: `/tmp/codex-home/skills/${detail.name}/SKILL.md`
      },
      operation: {
        id: 'operation-1',
        operation: 'install',
        skillId: detail.name,
        codexHome: '/tmp/codex-home',
        skillsPath: '/tmp/codex-home/skills',
        targetPath: `/tmp/codex-home/skills/${detail.name}`,
        status: 'succeeded',
        createdAt: '2026-07-30T12:00:00.000Z'
      }
    };
    const codes: RuntimeErrorCode[] = [
      'ENTERPRISE_UNAUTHORIZED',
      'ENTERPRISE_AGENT_FORBIDDEN',
      'ENTERPRISE_AGENT_ID_CONFLICT',
      'ENTERPRISE_SECURE_STORAGE_UNAVAILABLE',
      'ENTERPRISE_SKILL_PACKAGE_INVALID',
      'ENTERPRISE_SKILL_INSTALL_FAILED',
      'ENTERPRISE_DATA_VIEW_FORBIDDEN',
      'ENTERPRISE_DATA_AUTHORIZATION_UNAVAILABLE',
      'ENTERPRISE_ACTIVITY_UNAVAILABLE',
      'ENTERPRISE_ACTIVITY_PROVIDER_ERROR',
      'ENTERPRISE_ACTIVITY_NOT_FOUND'
    ];

    const serialized = JSON.stringify({
      session,
      qrLogin,
      dingtalkLogin,
      activityCapability,
      activityStatistics,
      activityDetail,
      list,
      mutation,
      codes
    });
    for (const forbidden of [
      'accessToken',
      'password',
      'cookie',
      'packageSha256',
      'versionId',
      'responseText',
      'toolInput'
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(dingtalkLogin.authorizationUrl).toContain('/dingtalk/clawee/start');
  });
});
