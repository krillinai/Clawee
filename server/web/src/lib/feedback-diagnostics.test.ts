import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { adminApi } from './api';
import { feedbackDiagnosticsSnapshot, feedbackRandomToken, recordFeedbackRequestFailure, redactConsoleText, startFeedbackDiagnostics } from './feedback-diagnostics';

let stop: (() => void) | undefined;
beforeEach(() => { history.replaceState(null, '', '/admin/accounts'); });
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

it('仅在当前管理会话留存错误，脱敏并在退出时清理', () => {
  recordFeedbackRequestFailure('GET', '/api/v1/admin/accounts');
  expect(feedbackDiagnosticsSnapshot().errors).toHaveLength(0);
  stop = startFeedbackDiagnostics();
  window.dispatchEvent(new ErrorEvent('error', { message: '加载失败 password=private123 sk-testsecretvalue', error: new Error('https://intranet.example/app.js?token=private#hash /Users/alice/project/a.js') }));
  const snapshot = feedbackDiagnosticsSnapshot();
  expect(snapshot.errors).toHaveLength(1);
  expect(snapshot.errors[0]?.message).toContain('加载失败');
  expect(JSON.stringify(snapshot)).not.toMatch(/private123|sk-testsecretvalue|intranet\.example|\/Users\/alice/);
  history.replaceState(null, '', '/app'); recordFeedbackRequestFailure('GET', '/api/v1/app/accounts');
  expect(feedbackDiagnosticsSnapshot().errors).toHaveLength(1);
  stop(); expect(feedbackDiagnosticsSnapshot()).toEqual({ errors: [], dropped_errors: 0 });
});

it('有界留存并明确计数，固定快照不受后续错误影响', () => {
  stop = startFeedbackDiagnostics();
  for (let i = 0; i < 55; i++) recordFeedbackRequestFailure('GET', `/api/v1/admin/accounts?token=${i}`, 500);
  const snapshot = feedbackDiagnosticsSnapshot();
  expect(snapshot.errors).toHaveLength(50); expect(snapshot.dropped_errors).toBe(5);
  expect(snapshot.errors.every(entry => entry.path === '/api/v1/admin/accounts')).toBe(true);
  recordFeedbackRequestFailure('GET', '/api/v1/admin/new', 503);
  expect(snapshot.errors.at(-1)?.path).toBe('/api/v1/admin/accounts');
});

it('API错误只记录安全请求元数据，不记录请求、响应正文或认证信息', async () => {
  stop = startFeedbackDiagnostics();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'private-response', code: 'failed' } }), { status: 500 })));
  await expect(adminApi.post('/accounts?token=query-secret', { password: 'request-secret' })).rejects.toThrow('private-response');
  expect(feedbackDiagnosticsSnapshot().errors[0]).toMatchObject({ kind: 'http_error', path: '/api/v1/admin/accounts', method: 'POST', status: 500, message: '', stack: '' });
  expect(JSON.stringify(feedbackDiagnosticsSnapshot())).not.toMatch(/private-response|request-secret|query-secret/);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network secret=transport-secret')));
  await expect(adminApi.get('/accounts')).rejects.toThrow('transport-secret');
  expect(feedbackDiagnosticsSnapshot().errors.at(-1)?.kind).toBe('network_error');
  expect(JSON.stringify(feedbackDiagnosticsSnapshot())).not.toContain('transport-secret');
});

it('秘密和私钥脱敏，保留普通业务描述', () => {
  expect(redactConsoleText('问题描述 token="private123" Authorization: Bearer token123 Cookie: session-secret')).not.toMatch(/private123|token123|session-secret/);
  expect(redactConsoleText('-----BEGIN PRIVATE KEY-----\nprivate-value\n-----END PRIVATE KEY-----')).toBe('[REDACTED]');
  expect(redactConsoleText('列表不能打开')).toBe('列表不能打开');
  const first = feedbackRandomToken(); const second = feedbackRandomToken();
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(first).not.toBe(second);
});
