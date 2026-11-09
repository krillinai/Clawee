import { describe, expect, it, vi } from 'vitest';
import { createElement, StrictMode, useEffect, useMemo } from 'react';
import { renderHook } from '@testing-library/react';
import { ApiClientError, RuntimeClient } from '../runtime/client.js';
import { createConnectionService } from './connection-service.js';

describe('ConnectionService', () => {
  it('StrictMode复用service时重新激活观测，仍在15秒报告断连', async () => {
    vi.useFakeTimers();
    const original = window.claweeDesktop;
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    let failed = false;
    const client = new RuntimeClient({ baseUrl: 'http://localhost', fetchImpl: async () => { if (failed) throw new TypeError('network'); return new Response('{}'); } });
    const { result, unmount } = renderHook(() => {
      const service = useMemo(() => createConnectionService(client), [client]);
      useEffect(() => {
        service.activate();
        return () => service.dispose();
      }, [service]);
      return service;
    }, { wrapper: ({ children }) => createElement(StrictMode, null, children) });
    try {
      await result.current.check();
      failed = true;
      await expect(client.get('/runs')).rejects.toThrow('network');
      await vi.advanceTimersByTimeAsync(15000);
      expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'WEB_DISCONNECTED', duration_ms: 15000 }));
    } finally { unmount(); window.claweeDesktop = original; vi.useRealTimers(); }
  });

  it('重新激活后旧请求失败不复活观测或启动断连计时器', async () => {
    vi.useFakeTimers();
    const original = window.claweeDesktop;
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    let rejectOld!: (error: Error) => void;
    const client = new RuntimeClient({ baseUrl: 'http://localhost', fetchImpl: async url => {
      if (String(url).endsWith('/old')) return await new Promise<Response>((_resolve, reject) => { rejectOld = reject; });
      return new Response('{}');
    } });
    const service = createConnectionService(client);
    try {
      await service.check();
      const old = client.get('/old');
      service.dispose();
      service.activate();
      await service.check();
      rejectOld(new TypeError('old generation'));
      await expect(old).rejects.toThrow('old generation');
      await vi.advanceTimersByTimeAsync(15000);
      expect(reportIncident).not.toHaveBeenCalled();
    } finally { service.dispose(); window.claweeDesktop = original; vi.useRealTimers(); }
  });
  it('普通业务请求失败启动15秒计时；短暂恢复不报告持续断网', async () => {
    vi.useFakeTimers();
    const original = window.claweeDesktop;
    const reportIncident = vi.fn(async (_observation: { error_code: string }) => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    let failed = false;
    const client = new RuntimeClient({ baseUrl: 'http://localhost', fetchImpl: async () => { if (failed) throw new TypeError('network'); return new Response('{}'); } });
    const service = createConnectionService(client);
    try {
      await service.check();
      failed = true;
      await expect(client.get('/runs')).rejects.toThrow('network');
      await vi.advanceTimersByTimeAsync(14999);
      expect(reportIncident.mock.calls.some(([input]) => input.error_code === 'WEB_DISCONNECTED')).toBe(false);
      failed = false;
      await client.get('/runs');
      await vi.advanceTimersByTimeAsync(1);
      expect(reportIncident.mock.calls.some(([input]) => input.error_code === 'WEB_DISCONNECTED')).toBe(false);
      failed = true;
      await expect(client.get('/runs')).rejects.toThrow('network');
      await vi.advanceTimersByTimeAsync(15000);
      expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'error', error_code: 'WEB_DISCONNECTED', duration_ms: 15000 }));
    } finally { service.dispose(); window.claweeDesktop = original; vi.useRealTimers(); }
  });

  it.each([401, 403, 500])('HTTP %s不触发持续断网；dispose后忽略晚到check', async status => {
    vi.useFakeTimers();
    const original = window.claweeDesktop;
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    let pending: Promise<unknown> = Promise.resolve({});
    const service = createConnectionService({ get: async <T>() => await pending as T });
    try {
      await service.check();
      pending = Promise.reject(new ApiClientError({ status, code: 'HTTP_ERROR', message: 'error' }));
      await service.check();
      await vi.advanceTimersByTimeAsync(15000);
      expect(reportIncident).not.toHaveBeenCalled();
      let reject!: (error: Error) => void;
      pending = new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
      const late = service.check();
      service.dispose();
      reject(new TypeError('late failure'));
      await late;
      await vi.advanceTimersByTimeAsync(15000);
      expect(reportIncident).not.toHaveBeenCalled();
    } finally { service.dispose(); window.claweeDesktop = original; vi.useRealTimers(); }
  });
  it('首次加载不创建持续断连异常；已就绪后15秒触发，恢复清除计时器', async () => {
    vi.useFakeTimers();
    const original = window.claweeDesktop;
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    let failed = true;
    const service = createConnectionService({ get: vi.fn(async () => { if (failed) throw new TypeError('private URL'); return {}; }) } as unknown as Pick<RuntimeClient, 'get'>);
    try {
      await service.check(); await vi.advanceTimersByTimeAsync(16000); expect(reportIncident).not.toHaveBeenCalled();
      failed = false; await service.check(); reportIncident.mockClear(); failed = true; await service.check();
      await vi.advanceTimersByTimeAsync(14999); expect(reportIncident).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'error', layer: 'web_daemon', error_code: 'WEB_DISCONNECTED' }));
      failed = false; await service.check(); expect(reportIncident).toHaveBeenLastCalledWith(expect.objectContaining({ event_type: 'recovered' }));
      reportIncident.mockClear(); failed = true; await service.check(); service.dispose(); await vi.advanceTimersByTimeAsync(16000); expect(reportIncident).not.toHaveBeenCalled();
    } finally { service.dispose(); window.claweeDesktop = original; vi.useRealTimers(); }
  });
  it('returns the required model service configuration before reading Codex status', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === '/healthz') {
        return { ok: true, runtimeState: 'configuration_required' };
      }
      if (path === '/runtime/model-service') {
        return {
          status: 'configuration_required',
          mode: 'enterprise_managed'
        };
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const service = createConnectionService({
      get
    } as unknown as Pick<RuntimeClient, 'get'>);

    await expect(service.check()).resolves.toEqual({
      status: 'configuration_required',
      configuration: {
        status: 'configuration_required',
        mode: 'enterprise_managed'
      }
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).not.toHaveBeenCalledWith('/codex/status');
  });

  it('returns invalid_token for unauthorized Runtime responses', async () => {
    const client = {
      async get<T>(): Promise<T> {
        throw new ApiClientError({ status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
      }
    } satisfies Pick<RuntimeClient, 'get'>;
    const service = createConnectionService(client);

    await expect(service.check()).resolves.toEqual({ status: 'invalid_token', message: 'Unauthorized' });
  });

  it('returns disconnected for network errors', async () => {
    const client = {
      async get<T>(): Promise<T> {
        throw new TypeError('fetch failed');
      }
    } satisfies Pick<RuntimeClient, 'get'>;
    const service = createConnectionService(client);

    await expect(service.check()).resolves.toEqual({ status: 'disconnected', message: 'fetch failed' });
  });
});
