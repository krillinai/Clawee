import { afterEach, expect, it, vi } from 'vitest';
import { feedbackAdminApi } from './feedback-admin-api';

afterEach(() => vi.unstubAllGlobals());
it('反馈列表保持统一响应分页，创建处理操作保留版本与幂等键', async () => { const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(init?.method === 'POST' ? { data: { version: 2 } } : { data: [{ report_id: 'fb_test' }], meta: { next_cursor: 'cursor', has_next: true } })); vi.stubGlobal('fetch', fetch); const list = await feedbackAdminApi.list(new URLSearchParams({ status: 'open' })); expect(list.items[0].report_id).toBe('fb_test'); expect(list.meta.has_next).toBe(true); await feedbackAdminApi.operate('fb_test', 'resolve', { expected_version: 1, idempotency_key: 'operation_test' }); expect(fetch.mock.calls[1][1]).toMatchObject({ credentials: 'include', method: 'POST' }); expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ expected_version: 1, idempotency_key: 'operation_test' }); });
it('403保留反馈错误码并提供授权说明', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'feedback_forbidden', message: '反馈请求未完成', details: [] } }, { status: 403 })));
  await expect(feedbackAdminApi.list(new URLSearchParams())).rejects.toMatchObject({
    status: 403,
    code: 'feedback_forbidden',
    message: '暂无反馈查看权限，请联系管理员开通问题反馈查看权限及全部反馈数据授权。'
  });
});
