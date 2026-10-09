import type { DaemonConnection } from '../shared/types.js';

export async function requestDaemonUpdate(connection: DaemonConnection | undefined, action: 'prepare' | 'cancel'): Promise<void> {
  if (connection === undefined) throw new Error('本地运行服务尚未就绪');
  const base = new URL(connection.address);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.protocol !== 'http:') {
    throw new Error('客户更新准备只能访问本机运行服务');
  }
  const response = await fetch(new URL(`/desktop-update/${action}`, base), {
    method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  });
  const result: unknown = await response.json();
  if (response.status === 409) throw new Error('仍有未结束的本地任务，请结束任务后再安装');
  if (!response.ok) throw new Error(`本地更新${action === 'prepare' ? '准备' : '取消'}失败（${response.status}）`);
  if (typeof result !== 'object' || result === null || !('prepared' in result) || result.prepared !== (action === 'prepare')) {
    throw new Error('本地运行服务未确认更新门禁状态');
  }
}
