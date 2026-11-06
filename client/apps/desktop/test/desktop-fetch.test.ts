import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopFetch } from '../src/main/desktop-fetch.js';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('桌面原生网络请求', () => {
  it('使用 Chromium 网络栈，保留请求参数且禁用缓存和会话 Cookie', async () => {
    const nodeFetch = vi.fn(() => { throw new Error('setTypeOfService EINVAL'); });
    vi.stubGlobal('fetch', nodeFetch);
    const response = new Response('ok');
    mocks.fetch.mockResolvedValue(response);
    const signal = new AbortController().signal;

    expect(await desktopFetch(new URL('http://127.0.0.1:1234/healthz'), {
      method: 'POST', body: 'payload', headers: { Authorization: 'Bearer local-token' },
      redirect: 'error', signal
    })).toBe(response);
    expect(nodeFetch).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith('http://127.0.0.1:1234/healthz', {
      method: 'POST', body: 'payload', headers: { Authorization: 'Bearer local-token' },
      redirect: 'error', signal, credentials: 'omit', cache: 'no-store'
    });
  });

  it('透传原生网络错误，供调用者处理', async () => {
    const error = new Error('net::ERR_CONNECTION_REFUSED');
    mocks.fetch.mockRejectedValue(error);
    await expect(desktopFetch('http://127.0.0.1:1234/')).rejects.toBe(error);
  });
});
