import type { FastifyInstance } from 'fastify';
import type { RunManager } from '../runs/manager.js';
import type { SchedulerService } from '../scheduler/service.js';
import type { DesktopUpdateConnection } from '@clawee/protocol';

export function registerDesktopUpdateRoutes(
  server: FastifyInstance,
  options: { runManager: RunManager; scheduler: SchedulerService; serverDeployment: boolean; getConnection?(): Promise<DesktopUpdateConnection | null>; isWriting?(): boolean }
) {
  let prepared = false;
  let closing = false;
  let activityAt = 0;
  let activityBusy = true;

  server.post('/desktop-update/activity', async (request, reply) => {
    if (options.serverDeployment || closing || prepared) return reply.code(409).send({ error: { code: 'DESKTOP_UPDATE_UNAVAILABLE', message: '更新准备期间不能修改编辑状态' } });
    if (typeof request.body !== 'object' || request.body === null || !('busy' in request.body) || typeof request.body.busy !== 'boolean') {
      return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: '编辑状态无效' } });
    }
    activityBusy = request.body.busy;
    activityAt = Date.now();
    return { recorded: true };
  });

  server.get('/desktop-update/context', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (options.serverDeployment || closing) return { connection: null };
    return { connection: await options.getConnection?.() ?? null };
  });

  function cancel(): void {
    options.runManager.cancelDesktopUpdate?.();
    options.scheduler.cancelDesktopUpdate?.();
    prepared = false;
  }

  for (const action of ['prepare', 'cancel'] as const) {
    server.post(`/desktop-update/${action}`, (request, reply) => {
      if (options.serverDeployment) {
        return reply.code(403).send({ error: { code: 'DESKTOP_UPDATE_UNSUPPORTED', message: '服务器部署不支持桌面更新安装' } });
      }
      if (closing) {
        return reply.code(503).send({ error: { code: 'DESKTOP_UPDATE_UNAVAILABLE', message: 'daemon 正在关闭' } });
      }
      if (
        !options.runManager.prepareDesktopUpdate || !options.runManager.cancelDesktopUpdate
        || !options.scheduler.prepareDesktopUpdate || !options.scheduler.cancelDesktopUpdate
      ) {
        return reply.code(503).send({ error: { code: 'DESKTOP_UPDATE_UNAVAILABLE', message: '安装准备门禁不可用' } });
      }
      if (action === 'cancel') {
        cancel();
        return { prepared: false };
      }
      if (prepared) return { prepared: true };
      if (options.isWriting?.()) {
        return reply.code(409).send({ error: { code: 'DESKTOP_UPDATE_BUSY', message: '等待正在进行的本地写操作完成' } });
      }
      if (request.headers['x-clawee-automatic-update'] === '1' && (activityBusy || Date.now() - activityAt > 30_000)) {
        return reply.code(409).send({ error: { code: 'DESKTOP_UPDATE_BUSY', message: '等待工作台就绪和未保存文件处理完成' } });
      }
      try {
        const runsIdle = options.runManager.prepareDesktopUpdate();
        const workflowsIdle = options.scheduler.prepareDesktopUpdate();
        if (!runsIdle || !workflowsIdle) {
          cancel();
          return reply.code(409).send({ error: { code: 'DESKTOP_UPDATE_BUSY', message: '仍有未结束的本地任务或正在发起的工作流，请稍后再安装' } });
        }
        prepared = true;
        return { prepared: true };
      } catch {
        cancel();
        return reply.code(503).send({ error: { code: 'DESKTOP_UPDATE_UNAVAILABLE', message: '安装准备失败，请稍后重试' } });
      }
    });
  }

  return {
    isPrepared: () => prepared,
    close() { closing = true; }
  };
}
