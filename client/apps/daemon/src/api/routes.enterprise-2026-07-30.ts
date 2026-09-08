import type { RuntimeErrorCode } from '@clawee/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  EnterpriseDingTalkCallbackFailureReason,
  EnterpriseDingTalkCallbackResult,
  EnterpriseDingTalkProviderError,
  EnterpriseSessionManager
} from '../enterprise/session-manager-2026-07-30.js';
import { EnterpriseSessionError } from '../enterprise/session-manager-2026-07-30.js';
import { EnterpriseHttpError } from '../enterprise/http-client-2026-07-30.js';
import type { EnterpriseSkillManager } from '../enterprise/skill-manager-2026-07-30.js';
import { EnterpriseSkillManagerError } from '../enterprise/skill-manager-2026-07-30.js';
import type { EnterpriseMcpManager } from '../enterprise/mcp-manager-2026-08-07.js';
import { EnterpriseMcpManagerError } from '../enterprise/mcp-manager-2026-08-07.js';
import { apiError } from './errors.js';

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8)
}).strict();

const registerSchema = loginSchema.extend({
  name: z.string().trim().min(1).optional()
}).strict();

const mcpPreferenceSchema = z.object({
  installed: z.boolean().optional(),
  enabled: z.boolean().optional(),
  confirmWriteToCodexHome: z.literal(true).optional()
}).strict().refine(
  value => value.installed !== undefined || value.enabled !== undefined,
  'at least one MCP preference field is required'
);

const qrLoginStartSchema = z.object({
  provider: z.enum(['feishu', 'dingtalk', 'wecom'])
}).strict();

const qrLoginRequestIdSchema = z.string().trim().min(1).max(256);
const dingTalkCallbackSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  error: z.string().min(1).max(128).optional()
}).strict();

const DINGTALK_CALLBACK_PATH = '/enterprise/dingtalk/callback';

export async function registerEnterpriseRoutes(
  server: FastifyInstance,
  input: {
    sessionManager: EnterpriseSessionManager;
    skillManager: EnterpriseSkillManager;
    mcpManager: EnterpriseMcpManager;
  }
): Promise<void> {
  server.post('/enterprise/dingtalk/login/prepare', async (request, reply) => {
    const prepare = input.sessionManager.prepareDingTalkLogin;
    if (prepare === undefined) {
      return reply.code(503).send(
        apiError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          'DingTalk login is unavailable'
        )
      );
    }
    const localPort = request.raw.socket.localPort;
    if (
      localPort === undefined
      || !Number.isInteger(localPort)
      || localPort < 1024
      || localPort > 65_535
    ) {
      return reply.code(503).send(
        apiError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          'Runtime loopback callback is unavailable'
        )
      );
    }
    const redirectUri = `http://127.0.0.1:${localPort}${DINGTALK_CALLBACK_PATH}`;
    try {
      const response = await prepare(redirectUri);
      return reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .send(response);
    } catch (error) {
      return sendEnterpriseError(reply, error);
    }
  });

  server.get<{ Querystring: unknown }>(
    DINGTALK_CALLBACK_PATH,
    async (request, reply) => {
      const callback = input.sessionManager.handleDingTalkCallback;
      const parsed = dingTalkCallbackSchema.safeParse(request.query);
      if (callback === undefined) {
        return sendDingTalkCallbackPage(reply, {
          signedIn: false,
          reason: 'service_unavailable'
        });
      }
      if (!parsed.success) {
        return sendDingTalkCallbackPage(reply, {
          signedIn: false,
          reason: 'invalid_callback'
        });
      }
      const result = await callback(parsed.data);
      if (result.signedIn) input.mcpManager.handleSessionAuthenticated();
      return sendDingTalkCallbackPage(reply, result);
    }
  );

  server.get('/enterprise/session', async () => {
    return input.sessionManager.getSnapshot();
  });

  server.post('/enterprise/session/refresh', async (_request, reply) => {
    try {
      const session = await input.sessionManager.refresh();
      if (session.status === 'signed_out') {
        await input.mcpManager.handleSessionSignedOut();
      }
      return session;
    } catch (error) {
      return sendEnterpriseError(reply, error);
    }
  });

  server.post<{ Body: unknown }>('/enterprise/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        apiError('VALIDATION_FAILED', 'email and password are invalid')
      );
    }
    try {
      const session = await input.sessionManager.login(parsed.data);
      input.mcpManager.handleSessionAuthenticated();
      return session;
    } catch (error) {
      return sendEnterpriseError(reply, error);
    }
  });

  server.post<{ Body: unknown }>('/enterprise/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        apiError('VALIDATION_FAILED', 'registration fields are invalid')
      );
    }
    try {
      const session = await input.sessionManager.register(parsed.data);
      input.mcpManager.handleSessionAuthenticated();
      return session;
    } catch (error) {
      return sendEnterpriseError(reply, error);
    }
  });

  server.post<{ Body: unknown }>('/enterprise/qr-login', async (request, reply) => {
    const parsed = qrLoginStartSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        apiError('VALIDATION_FAILED', 'QR login provider is invalid')
      );
    }
    if (input.sessionManager.startQrLogin === undefined) {
      return reply.code(503).send(
        apiError('ENTERPRISE_SERVICE_UNAVAILABLE', 'QR login is unavailable')
      );
    }
    try {
      return await input.sessionManager.startQrLogin(parsed.data);
    } catch (error) {
      return sendEnterpriseError(reply, error);
    }
  });

  server.get<{ Params: { requestId: string } }>(
    '/enterprise/qr-login/:requestId',
    async (request, reply) => {
      const parsed = qrLoginRequestIdSchema.safeParse(request.params.requestId);
      if (!parsed.success) {
        return reply.code(400).send(
          apiError('VALIDATION_FAILED', 'QR login request is invalid')
        );
      }
      if (input.sessionManager.pollQrLogin === undefined) {
        return reply.code(503).send(
          apiError('ENTERPRISE_SERVICE_UNAVAILABLE', 'QR login is unavailable')
        );
      }
      try {
        return await input.sessionManager.pollQrLogin(parsed.data);
      } catch (error) {
        return sendEnterpriseError(reply, error);
      }
    }
  );

  server.post('/enterprise/logout', async (_request, reply) => {
    try {
      const session = await input.sessionManager.logout();
      await input.mcpManager.handleSessionSignedOut();
      return session;
    } catch (error) {
      return sendEnterpriseError(reply, error);
    }
  });

  server.get('/enterprise/mcp', async (_request, reply) => {
    try {
      return await input.mcpManager.listConnections();
    } catch (error) {
      return sendEnterpriseError(reply, error);
    }
  });

  server.post('/enterprise/mcp/refresh', async (_request, reply) => {
    try {
      return await input.mcpManager.refreshConnections();
    } catch (error) {
      return sendEnterpriseError(reply, error);
    }
  });

  server.patch<{ Params: { upstreamId: string }; Body: unknown }>(
    '/enterprise/mcp/upstreams/:upstreamId/preference',
    async (request, reply) => {
      const parsed = mcpPreferenceSchema.safeParse(request.body);
      if (
        request.params.upstreamId.trim().length === 0
        || !parsed.success
      ) {
        return reply.code(400).send(
          apiError('VALIDATION_FAILED', 'MCP preference is invalid')
        );
      }
      try {
        return await input.mcpManager.updatePreference(
          request.params.upstreamId,
          parsed.data
        );
      } catch (error) {
        return sendEnterpriseError(reply, error);
      }
    }
  );

  server.get('/enterprise/skills', async (_request, reply) => {
    try {
      return await input.skillManager.listSkills();
    } catch (error) {
      return sendEnterpriseError(reply, error);
    }
  });

  server.get<{ Params: { skillId: string } }>(
    '/enterprise/skills/:skillId',
    async (request, reply) => {
      if (request.params.skillId.trim().length === 0) {
        return reply
          .code(400)
          .send(apiError('VALIDATION_FAILED', 'skillId is required'));
      }
      try {
        return await input.skillManager.getSkillDetail(request.params.skillId);
      } catch (error) {
        return sendEnterpriseError(reply, error);
      }
    }
  );

  server.post<{ Params: { skillId: string } }>(
    '/enterprise/skills/:skillId/install',
    async (request, reply) => {
      try {
        const result = await input.skillManager.installSkill(
          request.params.skillId
        );
        return reply.code(201).send(result);
      } catch (error) {
        return sendEnterpriseError(reply, error);
      }
    }
  );

  server.post<{ Params: { skillId: string } }>(
    '/enterprise/skills/:skillId/update',
    async (request, reply) => {
      try {
        return await input.skillManager.updateSkill(request.params.skillId);
      } catch (error) {
        return sendEnterpriseError(reply, error);
      }
    }
  );
}

function sendDingTalkCallbackPage(
  reply: FastifyReply,
  result: EnterpriseDingTalkCallbackResult
) {
  const title = result.signedIn ? '钉钉登录成功' : '钉钉登录未完成';
  const description = result.signedIn
    ? '您已成功登录 Clawee，可以关闭此页面并返回应用。'
    : dingTalkCallbackFailureMessage(result.reason, result.providerError);
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7f5;color:#202124;font-family:system-ui,sans-serif}.result{max-width:34rem;padding:2rem;text-align:center}.result h1{font-size:1.5rem;margin:0 0 .75rem}.result p{font-size:1rem;line-height:1.6;margin:0;color:#5f6368}</style></head><body><main class="result"><h1>${title}</h1><p>${description}</p></main></body></html>`;
  return reply
    .code(result.signedIn ? 200 : 400)
    .type('text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Pragma', 'no-cache')
    .header('Referrer-Policy', 'no-referrer')
    .header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    )
    .send(html);
}

function dingTalkCallbackFailureMessage(
  reason: EnterpriseDingTalkCallbackFailureReason,
  providerError?: EnterpriseDingTalkProviderError
): string {
  if (providerError !== undefined) {
    return dingTalkProviderErrorMessage(providerError);
  }
  switch (reason) {
    case 'invalid_callback':
      return '钉钉返回的登录参数不完整或格式无效，请在 Clawee 中重新发起登录。';
    case 'request_missing':
      return 'Clawee 中没有匹配的登录请求。应用可能已重启、已发起其他登录，或此链接已经使用过，请重新发起登录。';
    case 'state_mismatch':
      return '此回调与 Clawee 当前等待的登录请求不匹配。请关闭旧页面，并使用最新发起的登录页面。';
    case 'dingtalk_denied':
      return '您已取消或拒绝钉钉授权，请返回 Clawee 后重新发起登录。';
    case 'dingtalk_expired':
      return '登录请求已超过 10 分钟有效期，或授权码已经失效，请在 Clawee 中重新发起登录。';
    case 'dingtalk_account_unavailable':
      return '当前钉钉账号无法登录 Clawee，可能未加入企业、账号不可用或需要管理员完成绑定配置。';
    case 'secure_storage_unavailable':
      return 'Clawee 无法使用本地私有凭据文件，因此不能保存登录状态。请检查用户数据目录权限后重试。';
    case 'service_unavailable':
      return '钉钉或 Clawee 企业登录服务暂时不可用，请稍后重新发起登录。';
  }
}

function dingTalkProviderErrorMessage(
  error: EnterpriseDingTalkProviderError
): string {
  switch (error) {
    case 'oauth_provider_denied':
      return '您已取消或拒绝钉钉授权，请返回 Clawee 后重新发起登录。';
    case 'oauth_state_invalid':
      return '企业登录服务拒绝了本次登录状态，登录请求可能已经失效，请重新发起。';
    case 'dingtalk_upstream_unavailable':
      return '企业登录服务暂时无法连接钉钉，请稍后重新发起登录。';
    case 'not_enterprise_member':
      return '当前钉钉账号不是该企业的成员，请切换账号或联系企业管理员。';
    case 'dingtalk_email_missing':
      return '当前钉钉账号没有可用于 Clawee 的企业邮箱，请联系企业管理员补充邮箱。';
    case 'account_binding_required':
      return '当前钉钉身份需要由企业管理员绑定到已有 Clawee 账号后才能登录。';
    case 'auto_provision_disabled':
      return '企业已关闭账号自动创建，请联系企业管理员为您开通 Clawee 账号。';
    case 'system_not_initialized':
      return '企业登录系统尚未完成初始化，请联系企业管理员。';
    case 'account_disabled':
      return '对应的 Clawee 企业账号已停用，请联系企业管理员。';
    case 'identity_conflict':
      return '此钉钉身份已绑定到其他 Clawee 账号，请联系企业管理员处理。';
    case 'account_profile_conflict':
      return '钉钉账号资料与已有 Clawee 账号冲突，请联系企业管理员处理。';
    case 'agent_id_conflict':
      return '当前 Clawee Agent 已绑定到其他企业账号，请联系企业管理员处理。';
    case 'agent_forbidden':
      return '当前 Clawee Agent 已被禁用，无法完成企业登录，请联系企业管理员。';
    case 'agent_provisioning_unavailable':
      return '企业服务暂时无法登记当前 Clawee Agent，请稍后重试或联系企业管理员。';
    case 'dingtalk_disabled':
      return '企业管理员尚未启用钉钉登录，请改用其他登录方式。';
    case 'internal_error':
      return '企业登录服务发生内部错误，请稍后重新发起登录。';
  }
}

function sendEnterpriseError(reply: FastifyReply, error: unknown) {
  if (error instanceof EnterpriseSessionError) {
    return reply
      .code(error.statusCode)
      .send(apiError(error.code, enterpriseErrorMessage(error.code), error.details));
  }
  if (error instanceof EnterpriseHttpError) {
    return reply
      .code(error.statusCode ?? 500)
      .send(apiError(error.code, enterpriseErrorMessage(error.code)));
  }
  if (error instanceof EnterpriseSkillManagerError) {
    return reply
      .code(error.statusCode)
      .send(apiError(error.code, enterpriseErrorMessage(error.code)));
  }
  if (error instanceof EnterpriseMcpManagerError) {
    return reply
      .code(error.statusCode)
      .send(apiError(error.code, enterpriseErrorMessage(error.code)));
  }
  throw error;
}

function enterpriseErrorMessage(code: RuntimeErrorCode): string {
  switch (code) {
    case 'ENTERPRISE_INVALID_REQUEST':
      return 'Enterprise request is invalid';
    case 'ENTERPRISE_UNAUTHORIZED':
      return 'Enterprise credentials are invalid';
    case 'ENTERPRISE_REGISTERED_LOGIN_REQUIRED':
      return 'Registration succeeded; sign in is still required';
    case 'ENTERPRISE_SESSION_EXPIRED':
      return 'Enterprise session expired';
    case 'ENTERPRISE_ACCOUNT_INACTIVE':
      return 'Enterprise account is inactive';
    case 'ENTERPRISE_FRONTEND_FORBIDDEN':
      return 'Enterprise frontend access is unavailable';
    case 'ENTERPRISE_AGENT_FORBIDDEN':
      return 'Enterprise agent access is unavailable';
    case 'ENTERPRISE_AGENT_ID_CONFLICT':
      return 'Enterprise agent identity belongs to another account';
    case 'ENTERPRISE_SECURE_STORAGE_UNAVAILABLE':
      return 'Local credential storage is unavailable';
    case 'ENTERPRISE_SERVICE_UNAVAILABLE':
      return 'Enterprise service is unavailable';
    case 'ENTERPRISE_FORBIDDEN':
      return 'Enterprise Skill Hub access is forbidden';
    case 'ENTERPRISE_MCP_TOKEN_NOT_FOUND':
      return 'Enterprise MCP token is unavailable';
    case 'ENTERPRISE_MCP_UPSTREAM_NOT_FOUND':
      return 'Enterprise MCP upstream was not found';
    case 'ENTERPRISE_MCP_RUNTIME_UNAVAILABLE':
      return 'Enterprise MCP runtime configuration is unavailable';
    case 'ENTERPRISE_SKILL_NOT_FOUND':
      return 'Enterprise skill was not found';
    case 'ENTERPRISE_SKILL_VERSION_CHANGED':
      return 'Enterprise skill version changed';
    case 'ENTERPRISE_SKILL_PACKAGE_TOO_LARGE':
      return 'Enterprise skill package is too large';
    case 'ENTERPRISE_RATE_LIMITED':
      return 'Enterprise service rate limit was reached';
    case 'ENTERPRISE_SKILL_PACKAGE_INVALID':
      return 'Enterprise skill package is invalid';
    case 'ENTERPRISE_SKILL_PACKAGE_HASH_MISMATCH':
      return 'Enterprise skill package integrity check failed';
    case 'ENTERPRISE_SKILL_SOURCE_CONFLICT':
      return 'A different local skill source owns this name';
    case 'ENTERPRISE_SKILL_LOCAL_CHANGED':
      return 'The local enterprise skill was modified';
    case 'ENTERPRISE_SKILL_INSTALL_FAILED':
      return 'Enterprise skill installation failed';
    default:
      return 'Enterprise operation failed';
  }
}
