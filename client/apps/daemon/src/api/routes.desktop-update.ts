import type { FastifyInstance } from 'fastify';
import type { RunManager } from '../runs/manager.js';
import type { SchedulerService } from '../scheduler/service.js';

export function registerDesktopUpdateRoutes(
  server: FastifyInstance,
  options: { runManager: RunManager; scheduler: SchedulerService; serverDeployment: boolean }
) {
  let prepared = false;
  let closing = false;

  function cancel(): void {
    options.runManager.cancelDesktopUpdate?.();
    options.scheduler.cancelDesktopUpdate?.();
    prepared = false;
  }

  for (const action of ['prepare', 'cancel'] as const) {
    server.post(`/desktop-update/${action}`, (_request, reply) => {
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
