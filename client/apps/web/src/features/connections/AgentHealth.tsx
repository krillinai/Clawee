import type { EnterpriseMcpHealthResponse } from '@clawee/protocol';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../../runtime/errors.js';

export function AgentHealth(props: {
  upstreamId: string;
  name: string;
  connected: boolean;
  signedIn: boolean;
  service: { checkMcpHealth(upstreamId: string): Promise<EnterpriseMcpHealthResponse> } | null;
  onSessionExpired(): void;
}) {
  const [health, setHealth] = useState<EnterpriseMcpHealthResponse>();
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
  const onSessionExpired = useRef(props.onSessionExpired);
  onSessionExpired.current = props.onSessionExpired;

  const check = useCallback(async () => {
    const current = ++generation.current;
    setHealth(undefined);
    if (!props.connected || !props.signedIn || props.service === null) {
      setChecking(false);
      return;
    }
    setChecking(true);
    try {
      const result = await props.service.checkMcpHealth(props.upstreamId);
      if (current === generation.current) setHealth(result);
    } catch (error) {
      if (current !== generation.current) return;
      const unauthorized = error instanceof ApiClientError && (
        error.status === 401 || error.code === 'ENTERPRISE_SESSION_EXPIRED' || error.code === 'ENTERPRISE_UNAUTHORIZED'
      );
      const forbidden = error instanceof ApiClientError && (error.status === 403 || error.code === 'ENTERPRISE_AGENT_FORBIDDEN');
      setHealth({
        status: unauthorized || forbidden ? 'attention' : 'unknown',
        message: unauthorized ? '请先登录企业账号，再检查 Agent 状态'
          : forbidden ? '当前账号或 Agent 无权检查，请联系管理员'
          : '暂时无法检查，请检查客户端与企业 Gateway 的连接后重试',
        checkedAt: new Date().toISOString()
      });
      if (unauthorized) onSessionExpired.current();
    } finally {
      if (current === generation.current) setChecking(false);
    }
  }, [props.connected, props.signedIn, props.service, props.upstreamId]);

  useEffect(() => {
    void check();
    return () => { generation.current += 1; };
  }, [check]);

  const label = checking ? '检查中' : health === undefined ? '未检查'
    : { ready: '连接正常', attention: '需处理', connection_failed: '连接失败', unknown: '未确认' }[health.status];
  const message = checking ? '正在检查连接与执行条件'
    : health?.message ?? (!props.connected ? '客户端连接不可用，尚未检查 Agent'
      : !props.signedIn ? '登录企业账号后可检查' : '尚未检查 Agent');

  return (
    <div className="connection-health" aria-label={`${props.name} 健康检查`}>
      <div className="connection-health__head">
        <span role="status" data-health={checking ? 'checking' : health?.status ?? 'unknown'}>{label}</span>
        <button type="button" onClick={() => void check()}
          disabled={checking || !props.connected || !props.signedIn || props.service === null}
          aria-label={`立即检查 ${props.name}`}>
          {checking ? <LoaderCircle className="connections-spinner" size={12} aria-hidden="true" />
            : <RefreshCw size={12} aria-hidden="true" />}
          立即检查
        </button>
      </div>
      <p>{message}</p>
      {health !== undefined ? <small>最近检查：<time dateTime={health.checkedAt}>
        {new Date(health.checkedAt).toLocaleString('zh-CN', { hour12: false })}
      </time></small> : null}
    </div>
  );
}
