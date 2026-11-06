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
it('保留不可读取自动异常的类型与带时区分页游标', async () => {
  const expired = { report_id: 'incident_1', kind: 'automatic_incident', upload_state: 'expired' };
  const fetch = vi.fn().mockResolvedValue(Response.json({ data: [expired], meta: { next_cursor: '', has_next: false } }));
  vi.stubGlobal('fetch', fetch);
  const cursor = '2026-10-15T13:00:00.123456+08:00|11111111-1111-4111-8111-111111111111';
  const result = await feedbackAdminApi.list(new URLSearchParams({ kind: 'automatic_incident', include_unavailable: 'true', cursor }));
  expect(result.items).toEqual([expired]);
  expect(result.items[0].incident).toBeUndefined();
  const params = new URL(String(fetch.mock.calls[0][0]), 'https://example.invalid').searchParams;
  expect(params.get('kind')).toBe('automatic_incident');
  expect(params.get('include_unavailable')).toBe('true');
  expect(params.get('cursor')).toBe(cursor);
});
