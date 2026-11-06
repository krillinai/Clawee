import { useEffect, useRef } from 'react';
import type { EnterpriseSessionResponse } from '@clawee/protocol';

export function useEnterpriseSessionRenewal(input: {
  service: { renewSession(): Promise<EnterpriseSessionResponse> } | null;
  session: EnterpriseSessionResponse;
  onSession(session: EnterpriseSessionResponse): void;
}) {
  const latest = useRef(input);
  latest.current = input;
  const enabled = input.session.status === 'signed_in' || input.session.status === 'service_unavailable';

  useEffect(() => {
    if (!enabled || input.service === null) return;
    const service = input.service;
    let canceled = false;
    let pending = false;
    let lastAttempt: number | undefined;
    const renew = () => {
      if (document.visibilityState !== 'visible' || pending) return;
      const now = Date.now();
      const remaining = Date.parse(latest.current.session.expiresAt ?? '') - now;
      const interval = Number.isFinite(remaining) && remaining > 0 ? Math.min(60_000, Math.max(1_000, remaining / 2)) : 60_000;
      if (lastAttempt !== undefined && now - lastAttempt < interval) return;
      lastAttempt = now;
      pending = true;
      void service.renewSession().then(session => {
        if (!canceled) latest.current.onSession(session);
      }).catch(() => {
        // 由现有会话轮询同步失效状态；网络故障等待下一次用户操作重试。
      }).finally(() => { pending = false; });
    };
    // 不使用定时器或后台请求保活，只有前台用户操作触发续期。
    const onActivity = (event: Event) => { if (event.isTrusted) renew(); };
    const events = ['pointerdown', 'keydown', 'wheel'] as const;
    for (const event of events) window.addEventListener(event, onActivity, { capture: true, passive: true });
    window.addEventListener('focus', onActivity);
    return () => {
      canceled = true;
      for (const event of events) window.removeEventListener(event, onActivity, true);
      window.removeEventListener('focus', onActivity);
    };
  }, [enabled, input.service, input.session.account?.subjectId, input.session.agentId]);
}
