import { act, renderHook } from '@testing-library/react';
import type { EnterpriseSessionResponse } from '@clawee/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnterpriseSessionRenewal } from './use-enterprise-session-renewal.js';

const session: EnterpriseSessionResponse = {
  status: 'signed_in', transportSecurity: 'secure_https',
  account: { subjectId: 'user-1', email: 'user@example.com', name: '用户' },
  expiresAt: '2099-01-01T00:00:00Z'
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function setup(renewSession = vi.fn(async () => session)) {
  const listeners = vi.spyOn(window, 'addEventListener');
  const onSession = vi.fn();
  const service = { renewSession };
  const hook = renderHook((current: EnterpriseSessionResponse) => useEnterpriseSessionRenewal({ service, session: current, onSession }), { initialProps: session });
  const activity = async (type = 'pointerdown', isTrusted = true) => {
    const listener = listeners.mock.calls.find(([event]) => event === type)?.[1] as EventListener;
    await act(async () => { listener({ isTrusted } as Event); });
  };
  return { ...hook, renewSession, onSession, activity };
}

describe('客户端登录态自动续期', () => {
  it('长时间打开或后台轮询不保活，用户操作触发且每分钟限流', async () => {
    const { renewSession, activity } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60_000); });
    expect(renewSession).not.toHaveBeenCalled();
    await activity('pointerdown', false);
    expect(renewSession).not.toHaveBeenCalled();
    await activity();
    await activity('keydown');
    await activity('wheel');
    expect(renewSession).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(renewSession).toHaveBeenCalledTimes(1);
    await activity('keydown');
    expect(renewSession).toHaveBeenCalledTimes(2);
  });

  it('后台窗口不续期，重新聚焦后恢复', async () => {
    const { renewSession, activity } = setup();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await activity();
    expect(renewSession).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await activity('focus');
    expect(renewSession).toHaveBeenCalledTimes(1);
  });

  it('续期请求未完成时不重复，退出后的响应不覆盖状态', async () => {
    let resolve!: (response: EnterpriseSessionResponse) => void;
    const renewal = new Promise<EnterpriseSessionResponse>(done => { resolve = done; });
    const { renewSession, activity, rerender, onSession } = setup(vi.fn(async () => renewal));
    await activity();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await activity();
    expect(renewSession).toHaveBeenCalledTimes(1);
    rerender({ status: 'signed_out', transportSecurity: 'secure_https' });
    await act(async () => { resolve(session); });
    expect(onSession).not.toHaveBeenCalled();
  });

  it('断网后等待下一次用户操作重试', async () => {
    const renewSession = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(session);
    const { activity, onSession } = setup(renewSession);
    await activity();
    expect(onSession).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await activity();
    expect(onSession).toHaveBeenCalledWith(session);
  });
});
