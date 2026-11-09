import { afterEach, describe, expect, it, vi } from 'vitest';
import { net } from 'electron';
import { DesktopUpdateBusyError, prepareDesktopUpdate } from '../src/main/customer-update-daemon.js';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));
afterEach(() => { vi.mocked(net.fetch).mockReset(); });

const connection = { address: 'http://127.0.0.1:1234', token: 'local-token' };
const idle = { shutdownStarted: false, dataImportPending: false, workspaceLoading: false, workspaceOpen: false,
  daemon: { hasProcess: false, currentConnection: undefined } };

describe('故障工作台更新准备', () => {
  it('Runtime 启动失败且无服务进程时，无需工作台就绪即可准备安装', async () => {
    await expect(prepareDesktopUpdate(idle)).resolves.toBeUndefined();
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it.each(['shutdownStarted', 'dataImportPending', 'workspaceLoading'] as const)('%s 期间继续等待，不请求停机', async field => {
    await expect(prepareDesktopUpdate({ ...idle, [field]: true })).rejects.toBeInstanceOf(DesktopUpdateBusyError);
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it('daemon 仍在启动且尚未提供接口时继续等待', async () => {
    await expect(prepareDesktopUpdate({ ...idle, daemon: { hasProcess: true, currentConnection: undefined } }))
      .rejects.toBeInstanceOf(DesktopUpdateBusyError);
  });

  it.each([false, true])('工作台是否存在为 %s 时仍向存活服务冻结实际任务与写操作', async workspaceOpen => {
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({ prepared: true })));
    await prepareDesktopUpdate({ ...idle, workspaceOpen, daemon: { hasProcess: true, currentConnection: connection } });
    expect(net.fetch).toHaveBeenCalledWith(`${connection.address}/desktop-update/prepare`, expect.objectContaining({
      headers: { Authorization: 'Bearer local-token', ...(workspaceOpen ? { 'X-Clawee-Automatic-Update': '1' } : {}) }
    }));
  });

  it.each([409, 503])('启动失败页也不能绕过服务端仍在执行的任务、写操作或不可用的门禁：%s', async status => {
    vi.mocked(net.fetch).mockResolvedValue(new Response('{}', { status }));
    await expect(prepareDesktopUpdate({ ...idle, daemon: { hasProcess: true, currentConnection: connection } })).rejects.toThrow();
  });
});
