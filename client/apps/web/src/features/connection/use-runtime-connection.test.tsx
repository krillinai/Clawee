import { act, renderHook } from '@testing-library/react';
import { useEffect, useMemo, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '../../host/bridge.js';
import type { ConnectionConfig } from '../../runtime/types.js';
import { RuntimeClient } from '../../runtime/client.js';
import { createConnectionService, type ConnectionState } from '../../services/connection-service.js';
import { useRuntimeConnection } from './use-runtime-connection.js';

const config = { baseUrl: 'http://127.0.0.1:60764', token: 'runtime-token' };
function bridge(readConnectionConfig: HostBridge['readConnectionConfig']): HostBridge {
  return { kind: 'browser', readConnectionConfig, openExternal: async () => {}, revealPath: async () => ({ ok: true }), notify: async () => {} };
}
function useConnection(
  hostBridge: HostBridge,
  fetchImpl: typeof fetch,
  onResume?: () => void | Promise<void>
) {
  const [currentConfig, setConfig] = useState<ConnectionConfig | null>(null);
  const [state, setState] = useState<ConnectionState>({ status: 'disconnected', message: '' });
  const service = useMemo(() => currentConfig === null ? null : createConnectionService(new RuntimeClient({ ...currentConfig, fetchImpl })), [currentConfig, fetchImpl]);
  useEffect(() => { service?.activate(); return () => service?.dispose(); }, [service]);
  const retry = useRuntimeConnection({ hostBridge, config: currentConfig, service, onConfig: setConfig, onState: setState, onResume });
  return { config: currentConfig, state, retry };
}
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
const healthy = async () => Response.json({ ok: true });

describe('本地连接自动恢复', () => {
  afterEach(() => vi.useRealTimers());

  it('初始没有配置时持续读取，服务就绪后自动连接', async () => {
    vi.useFakeTimers();
    let ready = false;
    const host = bridge(async () => ready ? config : null);
    const view = renderHook(() => useConnection(host, healthy));
    await tick();
    expect(view.result.current.state.status).toBe('disconnected');
    ready = true;
    await tick(2_000);
    expect(view.result.current.state.status).toBe('connected');
    view.unmount();
  });

  it('首次检查失败后自动重试；并发唤醒事件合并请求', async () => {
    vi.useFakeTimers();
    let failed = true;
    const fetchImpl = vi.fn(async () => { if (failed) throw new TypeError('network'); return healthy(); });
    const host = bridge(async () => config);
    const view = renderHook(() => useConnection(host, fetchImpl));
    await tick();
    expect(view.result.current.state.status).toBe('disconnected');
    failed = false;
    await tick(1_000);
    expect(view.result.current.state.status).toBe('connected');
    fetchImpl.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('并发唤醒事件只通知一次上层恢复逻辑', async () => {
    vi.useFakeTimers();
    const host = bridge(async () => config);
    const onResume = vi.fn();
    const view = renderHook(() => useConnection(host, healthy, onResume));
    await tick();
    onResume.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(onResume).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('健康检查挂起时超时，并忽略之后返回的旧结果', async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    let first = true;
    const fetchImpl = vi.fn(async () => {
      if (first) { first = false; return new Promise<Response>(resolve => { release = resolve; }); }
      return healthy();
    });
    const host = bridge(async () => config);
    const view = renderHook(() => useConnection(host, fetchImpl));
    await tick();
    await tick(5_000);
    expect(view.result.current.state).toMatchObject({ status: 'disconnected', message: '本地服务连接超时' });
    await tick(1_000);
    expect(view.result.current.state.status).toBe('connected');
    await act(async () => release(Response.json({ runtimeState: 'configuration_required' })));
    expect(view.result.current.state.status).toBe('connected');
    expect(fetchImpl.mock.calls).toHaveLength(3);
    view.unmount();
  });

  it('配置读取挂起后能够重试；卸载后不再检查', async () => {
    vi.useFakeTimers();
    let first = true;
    const host = bridge(async () => {
      if (first) { first = false; return new Promise<ConnectionConfig | null>(() => {}); }
      return config;
    });
    const fetchImpl = vi.fn(healthy);
    const view = renderHook(() => useConnection(host, fetchImpl));
    await tick(6_000);
    expect(view.result.current.state.status).toBe('connected');
    view.unmount();
    fetchImpl.mockClear();
    await tick(30_000);
    window.dispatchEvent(new Event('focus'));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('连接事件优先于迟到的配置读取，并阻止旧检查覆盖新连接', async () => {
    vi.useFakeTimers();
    let publish!: (config: ConnectionConfig | null) => void;
    let release!: (config: ConnectionConfig | null) => void;
    const host = bridge(() => new Promise(resolve => { release = resolve; }));
    host.subscribeConnectionConfig = listener => { publish = listener; return () => {}; };
    const view = renderHook(() => useConnection(host, healthy));
    await tick();
    await act(async () => publish(config));
    expect(view.result.current.state.status).toBe('connected');
    await act(async () => release(null));
    expect(view.result.current.config).toEqual(config);
    view.unmount();
  });
});
