import { expect, it, vi } from 'vitest';
import type { DesktopLogger } from '../src/main/logger.js';
import { collectDesktopFeedback } from '../src/main/feedback.js';

vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0' }, dialog: {} }));
it('常规反馈只获取桌面版本，不刷新或扫描桌面历史日志', async () => {
  const flush = vi.fn(async () => {});
  const snapshot = await collectDesktopFeedback({ threadId: 'thread_test', logDir: '/unavailable/logs', logger: { flush } as unknown as DesktopLogger });
  expect(snapshot.environment.app_version).toBe('1.0.0');
  expect(snapshot.records).toEqual([]);
  expect(snapshot.warnings).toEqual([]);
  expect(flush).not.toHaveBeenCalled();
});
