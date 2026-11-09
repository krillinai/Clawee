import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopIncidentGate, incidentE2EFetch, readIncidentEnterpriseKey } from '../src/main/desktop-incidents.js';
import { registerIpcHandlers } from '../src/main/desktop-main.js';
import { desktopIpc } from '../src/shared/ipc.js';
import { createPackagedIncidentReceiver } from '../e2e/packaged-app.js';

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: { removeHandler: vi.fn(), handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, handler) }
}));
vi.mock('../src/main/customer-update-native.js', () => ({ createCustomerNativeUpdater: vi.fn() }));

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  handlers.clear(); vi.restoreAllMocks();
});

describe('桌面异常企业识别', () => {
  it.each(['', 'gateway = ""', 'gateway = " "', 'gateway = 123', 'invalid [', 'gateway = "not-a-url"',
    'gateway = "ftp://example.com"', 'gateway = "https://user:pass@example.com"', 'gateway = "https://example.com/path"',
    'gateway = "https://example.com?key=value"'])('无效配置不能退回无企业模式：%s', contents => {
    const directory = mkdtempSync(join(tmpdir(), 'clawee-desktop-incidents-')); directories.push(directory);
    const path = join(directory, 'config.toml'); writeFileSync(path, contents);
    expect(readIncidentEnterpriseKey(path)).toBe('unknown');
  });
  it('丢失文件为未知，只有明确无企业配置路径才返回空键', () => {
    expect(readIncidentEnterpriseKey(join(tmpdir(), randomUUID(), 'missing.toml'))).toBe('unknown');
    expect(readIncidentEnterpriseKey(undefined)).toBe('');
  });
  it('有效企业绑定使用规范化origin指纹', () => {
    const directory = mkdtempSync(join(tmpdir(), 'clawee-desktop-incidents-')); directories.push(directory);
    const path = join(directory, 'config.toml'); writeFileSync(path, 'gateway = " https://EXAMPLE.com:443/ "');
    expect(readIncidentEnterpriseKey(path)).toBe(createHash('sha256').update('https://example.com').digest('hex'));
  });
});

function fixture() {
  const observe = vi.fn(); const incidentGate = createDesktopIncidentGate(observe);
  const stop = vi.fn(async () => {}); const start = vi.fn(async () => {}); const restartRuntime = vi.fn(async () => {});
  const updates = { installationPending: false };
  registerIpcHandlers({ incidentGate, development: false, updates, daemon: { stop }, bootstrap: { start, restartRuntime } } as unknown as Parameters<typeof registerIpcHandlers>[0]);
  const frame = { url: 'clawee-app://app/index.html' };
  const event = { senderFrame: frame, sender: { mainFrame: frame } } as unknown as IpcMainInvokeEvent;
  const observation = { event_id: randomUUID(), event_type: 'error', source: 'web', layer: 'web_daemon', stage: 'request', error_code: 'WEB_REQUEST_FAILED' };
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  return { observe, incidentGate, stop, start, restartRuntime, updates, event, observation, invoke };
}

describe('主进程实际IPC异常门禁', () => {
  it('接收可信主帧白名单事件，拒绝额外字段及daemon伪装', () => {
    const view = fixture(); view.invoke(desktopIpc.reportIncident, view.observation);
    view.invoke(desktopIpc.reportIncident, { ...view.observation, message: 'private' });
    view.invoke(desktopIpc.reportIncident, { ...view.observation, source: 'daemon', layer: 'daemon_codex' });
    expect(view.observe).toHaveBeenCalledExactlyOnceWith(view.observation);
  });
  it('拒绝非可信来源、bootstrap页面及子帧', () => {
    const view = fixture(); const handler = handlers.get(desktopIpc.reportIncident)!;
    for (const url of ['https://example.com', 'clawee-app://bootstrap/index.html']) {
      expect(() => handler({ ...view.event, senderFrame: { url } } as IpcMainInvokeEvent, view.observation)).toThrow();
    }
    handler({ ...view.event, senderFrame: { url: 'clawee-app://app/frame.html' } } as IpcMainInvokeEvent, view.observation);
    expect(view.observe).not.toHaveBeenCalled();
  });
  it('主动关闭或更新时不采集，恢复后重新采集', () => {
    const view = fixture(); view.incidentGate.stop(); view.invoke(desktopIpc.reportIncident, view.observation);
    expect(view.observe).not.toHaveBeenCalled();
    view.incidentGate.resume(); view.invoke(desktopIpc.reportIncident, view.observation);
    expect(view.observe).toHaveBeenCalledOnce();
  });
  it.each([desktopIpc.bootstrapRetry, desktopIpc.restartRuntime])('%s执行期间拦截断连，完成后恢复', async channel => {
    const view = fixture(); let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    if (channel === desktopIpc.bootstrapRetry) view.stop.mockImplementation(() => pending);
    else view.restartRuntime.mockImplementation(() => pending);
    const work = view.invoke(channel); view.invoke(desktopIpc.reportIncident, view.observation);
    expect(view.observe).not.toHaveBeenCalled(); finish(); await work;
    view.invoke(desktopIpc.reportIncident, view.observation); expect(view.observe).toHaveBeenCalledOnce();
  });
  it('重启失败后不会永久吞掉后续异常，更新中禁止发起重启', async () => {
    const view = fixture(); view.restartRuntime.mockRejectedValueOnce(new Error('failed'));
    await expect(view.invoke(desktopIpc.restartRuntime)).rejects.toThrow('failed');
    view.invoke(desktopIpc.reportIncident, view.observation); expect(view.observe).toHaveBeenCalledOnce();
    view.updates.installationPending = true;
    expect(await view.invoke(desktopIpc.restartRuntime)).toMatchObject({ ok: false });
    expect(await view.invoke(desktopIpc.bootstrapRetry)).toMatchObject({ ok: false });
    expect(view.restartRuntime).toHaveBeenCalledTimes(1); expect(view.stop).not.toHaveBeenCalled();
  });
});

describe('受控E2E上报通道', () => {
  it('本地接收器统计实际HTTP请求，拒绝请求也计数', async () => {
    const userData = join(tmpdir(), randomUUID());
    const receiver = await createPackagedIncidentReceiver(userData);
    try {
      const snapshot = { incident_id: randomUUID(), revision: 2 };
      const send = incidentE2EFetch(randomUUID(), receiver.origin)!;
      const url = `https://gateway.clawee.work/api/v1/feedback/incidents/${snapshot.incident_id}`;
      const response = await send(url, { method: 'PUT', body: JSON.stringify(snapshot) });
      expect(await response.json()).toEqual({ data: { incident_id: snapshot.incident_id, accepted_revision: 2 } });
      expect(receiver.requestCount).toBe(1); expect(receiver.snapshots).toEqual([snapshot]);
      const rejected = await send(url, { method: 'POST', body: '{}' });
      expect(rejected.status).toBe(400); expect(receiver.requestCount).toBe(2);
    } finally { await receiver.close(); }
  });
  it('普通启动忽略接收器覆盖，仅受控E2E可使用回环HTTP', async () => {
    expect(incidentE2EFetch(undefined, 'http://127.0.0.1:12345')).toBeUndefined();
    expect(() => incidentE2EFetch(randomUUID(), 'https://example.com')).toThrow();
    expect(() => incidentE2EFetch(randomUUID(), 'http://127.0.0.1:12345/private')).toThrow();
    const fetchImpl = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}));
    await incidentE2EFetch(randomUUID(), 'http://127.0.0.1:12345')!('https://gateway.clawee.work/api/v1/feedback/incidents/id', { method: 'PUT' });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('http://127.0.0.1:12345/api/v1/feedback/incidents/id');
  });
});
