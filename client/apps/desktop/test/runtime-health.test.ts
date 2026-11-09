import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeDaemonHealth, RuntimeHealthMonitor } from '../src/main/runtime-health.js';

const connection = { address: 'http://127.0.0.1:60764', token: 'private-token' };
function fixture() {
  const input = {
    connection: vi.fn(() => connection as typeof connection | undefined),
    hasProcess: vi.fn(() => true),
    enabled: vi.fn(() => true),
    recoverMissing: vi.fn(async () => {}),
    publish: vi.fn(),
    probe: vi.fn(async () => true),
    logger: { info: vi.fn(), warn: vi.fn() }
  };
  const monitor = new RuntimeHealthMonitor(input);
  return { monitor, input };
}

describe('桌面本地服务健康恢复', () => {
  afterEach(() => vi.useRealTimers());

  it('只有代理失败时重置连接池，重置有频率限制且不重启 daemon', async () => {
    vi.useFakeTimers();
    const { input } = fixture();
    const probeProxy = vi.fn(async () => false);
    const repairProxy = vi.fn(async () => {});
    const monitor = new RuntimeHealthMonitor({ ...input, probeProxy, repairProxy });
    monitor.resume(); await vi.advanceTimersByTimeAsync(0);
    await monitor.check(); await monitor.check(); await monitor.check();
    expect(repairProxy).toHaveBeenCalledOnce();
    expect(input.recoverMissing).not.toHaveBeenCalled();
    probeProxy.mockResolvedValue(true);
    await monitor.check();
    expect(input.publish).toHaveBeenLastCalledWith(true);
    monitor.stop();
  });

  it('探测不响应取消时也会结束，迟到响应不能把断线状态改为正常', async () => {
    vi.useFakeTimers();
    const { monitor, input } = fixture();
    let release!: (value: boolean) => void;
    input.probe.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    monitor.resume(); await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const work = monitor.check();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await work).toBe(false);
    }
    expect(input.publish).toHaveBeenLastCalledWith(false);
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.publish).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it('连续失败后标记不可用，恢复后重新发布连接，存活进程不被重启', async () => {
    vi.useFakeTimers();
    const { monitor, input } = fixture();
    monitor.resume(); await vi.advanceTimersByTimeAsync(0);
    input.publish.mockClear();
    input.probe.mockResolvedValue(false);
    await monitor.check(); await monitor.check();
    expect(input.publish).not.toHaveBeenCalled();
    await monitor.check();
    expect(input.publish).toHaveBeenCalledExactlyOnceWith(false);
    expect(input.recoverMissing).not.toHaveBeenCalled();
    input.probe.mockResolvedValue(true);
    await monitor.check();
    expect(input.publish).toHaveBeenLastCalledWith(true);
    monitor.stop();
  });

  it('进程退出时请求统一恢复，并合并重复检查', async () => {
    vi.useFakeTimers();
    const { monitor, input } = fixture();
    input.hasProcess.mockReturnValue(false);
    input.connection.mockReturnValue(undefined);
    input.recoverMissing.mockImplementation(async () => {
      input.hasProcess.mockReturnValue(true);
      input.connection.mockReturnValue(connection);
    });
    monitor.resume();
    await Promise.all([monitor.check(), monitor.check()]);
    expect(input.recoverMissing).toHaveBeenCalledOnce();
    expect(input.publish).toHaveBeenCalledWith(true);
    monitor.stop();
  });

  it('暂停或更新期间不恢复服务；停止后不再检查', async () => {
    vi.useFakeTimers();
    const { monitor, input } = fixture();
    monitor.resume(); await vi.advanceTimersByTimeAsync(0);
    monitor.pause(); input.probe.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(input.probe).not.toHaveBeenCalled();
    input.enabled.mockReturnValue(false);
    monitor.resume(); await vi.advanceTimersByTimeAsync(30_000);
    expect(input.probe).not.toHaveBeenCalled();
    input.enabled.mockReturnValue(true);
    monitor.resume(); await vi.advanceTimersByTimeAsync(0);
    expect(input.probe).toHaveBeenCalledOnce();
    monitor.stop(); input.probe.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(input.probe).not.toHaveBeenCalled();
  });

  it('真实 HTTP 检查有总超时，响应正文挂起也会结束', async () => {
    const server = createServer((_request, response) => { response.writeHead(200); response.write('{'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing address');
    try {
      expect(await probeDaemonHealth({ ...connection, address: `http://127.0.0.1:${address.port}` }, AbortSignal.timeout(30))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
