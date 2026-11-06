import type { DaemonConnection } from '../shared/types.js';
import type { DesktopUpdateConnection } from '@clawee/protocol';
import { desktopFetch } from './desktop-fetch.js';

export class DesktopUpdateBusyError extends Error {}

export async function prepareDesktopUpdate(input: {
  shutdownStarted: boolean;
  dataImportPending: boolean;
  workspaceLoading: boolean;
  workspaceOpen: boolean;
  daemon: { hasProcess: boolean; currentConnection: DaemonConnection | undefined };
}): Promise<void> {
  if (input.shutdownStarted || input.dataImportPending || input.workspaceLoading) {
    throw new DesktopUpdateBusyError('等待本地数据导入或界面切换结束后安装更新');
  }
  const connection = input.daemon.currentConnection;
  if (connection !== undefined) {
    // 启动失败页没有编辑器状态；服务端仍检查并冻结实际任务、工作流和写操作。
    await requestDaemonUpdate(connection, 'prepare', input.workspaceOpen);
  } else if (input.daemon.hasProcess) {
    throw new DesktopUpdateBusyError('等待本地运行服务启动或退出后安装更新');
  }
}

export async function readDaemonUpdateConnection(connection: DaemonConnection | undefined): Promise<DesktopUpdateConnection | null> {
  if (connection === undefined) return null;
  const base = daemonBase(connection);
  const response = await desktopFetch(new URL('/desktop-update/context', base), {
    headers: { Authorization: `Bearer ${connection.token}` },
    redirect: 'error', signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error('无法确认当前服务器连接');
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('connection' in body)) throw new Error('服务器连接响应无效');
  if (body.connection === null) return null;
  const value = body.connection;
  if (typeof value !== 'object' || value === null || !('gateway' in value) || typeof value.gateway !== 'string') throw new Error('服务器更新来源无效');
  const gateway = new URL(value.gateway);
  if (gateway.protocol !== 'https:' || gateway.origin !== value.gateway || gateway.username || gateway.password) throw new Error('自动更新需要 HTTPS 服务器连接');
  return { gateway: value.gateway };
}

function daemonBase(connection: DaemonConnection): URL {
  const base = new URL(connection.address);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.protocol !== 'http:') throw new Error('客户更新准备只能访问本机运行服务');
  return base;
}

export async function requestDaemonUpdate(connection: DaemonConnection | undefined, action: 'prepare' | 'cancel', automatic = false): Promise<void> {
  if (connection === undefined) throw new Error('本地运行服务尚未就绪');
  const base = daemonBase(connection);
  const response = await desktopFetch(new URL(`/desktop-update/${action}`, base), {
    method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, ...(automatic ? { 'X-Clawee-Automatic-Update': '1' } : {}) },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  });
  const result: unknown = await response.json();
  if (response.status === 409) throw new DesktopUpdateBusyError('仍有未结束的本地任务或未保存文件，等待空闲后自动安装');
  if (!response.ok) throw new Error(`本地更新${action === 'prepare' ? '准备' : '取消'}失败（${response.status}）`);
  if (typeof result !== 'object' || result === null || !('prepared' in result) || result.prepared !== (action === 'prepare')) {
    throw new Error('本地运行服务未确认更新门禁状态');
  }
}
