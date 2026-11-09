import type {
  CodexFailureOrigin,
  CodexNetworkPath,
  CodexProxyErrorCode,
  CodexProxyStage
} from '@clawee/protocol';

const PROXY_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy',
  'NO_PROXY', 'no_proxy'
] as const;

export type ProxyEnvironmentSummary = {
  networkPath: CodexNetworkPath;
  proxyEnvKeys: string[];
  proxyApplies: boolean;
};

export function describeProxyEnvironment(
  baseUrl?: string,
  env: NodeJS.ProcessEnv = process.env
): ProxyEnvironmentSummary {
  const proxyEnvKeys = PROXY_KEYS.filter(key => typeof env[key] === 'string' && env[key]!.trim().length > 0);
  let target: URL | undefined;
  try {
    if (baseUrl !== undefined) target = new URL(baseUrl);
  } catch { }

  const proxyConfigured = target === undefined
    ? proxyEnvKeys.some(key => !key.toLowerCase().startsWith('no_'))
    : proxyKeyFor(target, env) !== undefined;
  const proxyApplies = proxyConfigured && !matchesNoProxy(target, env);
  return {
    networkPath: proxyApplies ? 'http_proxy' : 'direct',
    proxyEnvKeys,
    proxyApplies
  };
}

export function classifyProxyFailure(input: {
  status?: number;
  transportCode?: string;
  text?: string;
  stage: CodexProxyStage;
  proxyApplies: boolean;
  proxyHeader?: boolean;
}): { proxyErrorCode: CodexProxyErrorCode; failureOrigin: CodexFailureOrigin } | undefined {
  const text = input.text ?? '';
  const proxyMentioned = input.proxyHeader === true || /\bproxy\b|connect(?:ion)?\s+tunnel|proxy-authenticate|proxy authentication/i.test(text);
  if (input.status === 407 || /\b407\b|proxy[- ]authentication|required.*proxy.*auth|proxy-authenticate/i.test(text)) {
    return { proxyErrorCode: 'PROXY_AUTH_REQUIRED', failureOrigin: 'client_proxy' };
  }
  if ((input.status === 403 && proxyMentioned) || /proxy.*(?:forbidden|denied|blocked|policy)/i.test(text)) {
    return { proxyErrorCode: 'PROXY_POLICY_DENIED', failureOrigin: 'client_proxy' };
  }
  if (/connect(?:ion)?\s+tunnel|https?\s+connect|tunnel.*(?:failed|refused)|proxy.*(?:tunnel|connect)/i.test(text)
    || (proxyMentioned && (input.status === 502 || input.status === 504))) {
    return { proxyErrorCode: 'PROXY_TUNNEL_FAILED', failureOrigin: 'client_proxy' };
  }
  if (!input.proxyApplies) return undefined;
  if (input.stage === 'stream' && /^(?:ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_BODY_TIMEOUT)$/.test(input.transportCode ?? '')) {
    return { proxyErrorCode: 'PROXY_STREAM_INTERRUPTED', failureOrigin: 'client_proxy' };
  }
  if (input.stage === 'connect' || input.stage === 'response_headers') {
    if (/^(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT)$/.test(input.transportCode ?? '')) {
      return { proxyErrorCode: 'PROXY_CONNECT_TIMEOUT', failureOrigin: 'client_proxy' };
    }
    if (/^(?:ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR_SOCKET)$/.test(input.transportCode ?? '')) {
      return { proxyErrorCode: 'PROXY_CONNECT_FAILED', failureOrigin: 'client_proxy' };
    }
  }
  return undefined;
}

export function proxyErrorMessage(code: CodexProxyErrorCode): { message: string; suggestion: string; retryable: boolean } {
  switch (code) {
    case 'PROXY_AUTH_REQUIRED':
      return { message: 'HTTP 代理需要认证', suggestion: '请检查代理账号和密码。', retryable: false };
    case 'PROXY_CONNECT_FAILED':
      return { message: 'HTTP 代理无法连接模型服务', suggestion: '请检查代理地址、端口和访问白名单。', retryable: false };
    case 'PROXY_CONNECT_TIMEOUT':
      return { message: '通过 HTTP 代理连接模型服务超时', suggestion: '请检查代理稳定性后重试。', retryable: true };
    case 'PROXY_TUNNEL_FAILED':
      return { message: 'HTTP 代理无法建立 HTTPS 连接', suggestion: '请确认代理支持 HTTPS CONNECT，并允许访问模型服务。', retryable: false };
    case 'PROXY_POLICY_DENIED':
      return { message: 'HTTP 代理拒绝访问模型服务', suggestion: '请联系网络管理员检查代理访问策略。', retryable: false };
    case 'PROXY_STREAM_INTERRUPTED':
      return { message: 'HTTP 代理中断了模型流式响应', suggestion: '请确认代理支持 HTTPS 长连接和 SSE 转发。', retryable: true };
  }
}

function proxyKeyFor(target: URL, env: NodeJS.ProcessEnv): string | undefined {
  const keys = target.protocol === 'https:'
    ? ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
    : ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  return keys.find(key => typeof env[key] === 'string' && env[key]!.trim().length > 0);
}

function matchesNoProxy(target: URL | undefined, env: NodeJS.ProcessEnv): boolean {
  if (target === undefined) return false;
  const value = env.NO_PROXY ?? env.no_proxy;
  if (typeof value !== 'string' || value.trim() === '') return false;
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  return value.split(',').some(entry => {
    const item = entry.trim().toLowerCase();
    if (!item) return false;
    if (item === '*') return true;
    const normalized = item.replace(/^\.+/, '');
    const separator = normalized.lastIndexOf(':');
    const hostPattern = separator > 0 && /^\d+$/.test(normalized.slice(separator + 1))
      ? normalized.slice(0, separator)
      : normalized;
    const portPattern = separator > 0 && /^\d+$/.test(normalized.slice(separator + 1))
      ? normalized.slice(separator + 1)
      : undefined;
    if (portPattern !== undefined && portPattern !== port) return false;
    const suffix = hostPattern.startsWith('*.') ? hostPattern.slice(2) : hostPattern;
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}
