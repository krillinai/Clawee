import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { adminApi, APIError } from '@/lib/api';
import { feedbackDiagnosticsSnapshot } from '@/lib/feedback-diagnostics';
import { FeedbackCollector } from './feedback-collector';

vi.mock('@/lib/api', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/api')>(), adminApi: { get: vi.fn(), postForm: vi.fn() } }));
vi.mock('@/lib/feedback-diagnostics', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/feedback-diagnostics')>(), feedbackDiagnosticsSnapshot: vi.fn(() => ({ errors: [], dropped_errors: 0 })) }));
beforeEach(() => {
  vi.clearAllMocks(); history.replaceState(null, '', '/admin/accounts');
  vi.mocked(adminApi.get).mockResolvedValue({ external_feedback_allowed: true });
  vi.mocked(adminApi.postForm).mockResolvedValue({ report_id: 'fb_test0001', display_number: 'FB-TEST', upload_state: 'ready', security_state: 'normal' });
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:preview'); static revokeObjectURL = vi.fn(); });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });
async function prepare() {
  render(<FeedbackCollector />); fireEvent.click(screen.getByRole('button', { name: '提交异常反馈' }));
  await waitFor(() => expect(adminApi.get).toHaveBeenCalledWith('/feedback/collection-policy'));
  fireEvent.change(screen.getByLabelText('问题描述（必填）'), { target: { value: '列表异常 password=private123' } });
  await waitFor(() => expect(screen.getByRole('button', { name: '准备反馈' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '准备反馈' }));
}
function consent() {
  fireEvent.click(screen.getByLabelText('确认可以发送上述资料和截图给软件维护方'));
  fireEvent.click(screen.getByLabelText('确认按部分资料发送，不包含桌面、会话及服务器日志'));
}

it('主动准备只采集本地快照，两项明确确认后才发送', async () => {
  await prepare(); expect(adminApi.postForm).not.toHaveBeenCalled();
  expect(screen.getByText('部分资料 · 浏览器异常 0 条 · 截图 0 张')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '发送反馈' })).toBeDisabled();
  consent(); fireEvent.click(screen.getByRole('button', { name: '发送反馈' }));
  expect(await screen.findByRole('status')).toHaveTextContent('FB-TEST');
  const form = vi.mocked(adminApi.postForm).mock.calls[0]![1];
  const metadata = JSON.parse(String(form.get('metadata')));
  expect(metadata).toMatchObject({ page: '/admin/accounts', confirmed: true, accept_partial: true, description: '列表异常 [REDACTED]' });
  expect(metadata.recovery_token).not.toBe(metadata.status_token);
  expect(metadata.confirmed_at).toBeTruthy();
});

it('禁用及策略读取失败不允许采集或发送', async () => {
  vi.mocked(adminApi.get).mockResolvedValueOnce({ external_feedback_allowed: false });
  render(<FeedbackCollector />); fireEvent.click(screen.getByRole('button', { name: '提交异常反馈' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('企业策略已禁止外部反馈');
  expect(screen.getByRole('button', { name: '准备反馈' })).toBeDisabled(); expect(adminApi.postForm).not.toHaveBeenCalled();
});

it('响应丢失重试复用完整快照和凭证，不重新采集', async () => {
  vi.mocked(adminApi.postForm).mockRejectedValueOnce(new Error('response lost'));
  await prepare(); consent(); fireEvent.click(screen.getByRole('button', { name: '发送反馈' }));
  await screen.findByText('发送未完成，资料已保留，可重试同一份反馈。');
  const first = String(vi.mocked(adminApi.postForm).mock.calls[0]![1].get('metadata'));
  fireEvent.click(screen.getByRole('button', { name: '重试发送' }));
  await screen.findByRole('status');
  expect(String(vi.mocked(adminApi.postForm).mock.calls[1]![1].get('metadata'))).toBe(first);
  expect(feedbackDiagnosticsSnapshot).toHaveBeenCalledTimes(1);
});

it('截图受限，准备前可移除，原始文件名不外传', async () => {
  render(<FeedbackCollector />); fireEvent.click(screen.getByRole('button', { name: '提交异常反馈' }));
  await waitFor(() => expect(adminApi.get).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('截图'), { target: { files: [new File(['svg'], 'secret.svg', { type: 'image/svg+xml' })] } });
  expect(screen.getByRole('alert')).toHaveTextContent('截图仅支持');
  const image = new File(['png'], 'customer-secret.png', { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('截图'), { target: { files: [image] } });
  expect(screen.getByAltText('截图 1')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('问题描述（必填）'), { target: { value: '截图异常' } });
  fireEvent.click(screen.getByRole('button', { name: '准备反馈' })); consent(); fireEvent.click(screen.getByRole('button', { name: '发送反馈' }));
  await screen.findByRole('status');
  expect((vi.mocked(adminApi.postForm).mock.calls[0]![1].get('screenshots') as File).name).toBe('screenshot-1');
});

it('过期快照不盲目重试，可新建反馈；本地导出不含外传凭证', async () => {
  vi.mocked(adminApi.postForm).mockRejectedValueOnce(new APIError('expired', 410, 'feedback_centre_request_failed'));
  await prepare(); consent(); fireEvent.click(screen.getByRole('button', { name: '发送反馈' }));
  await screen.findByText('反馈已过期，请新建反馈。');
  expect(screen.getByRole('button', { name: '重试发送' })).toBeDisabled();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: '本地导出' }));
  const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob;
  const exported = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
  expect(exported).not.toMatch(/recovery_token|status_token|private123/);
  expect(exported).toContain('gateway_logs:not_collected');
  fireEvent.click(screen.getByRole('button', { name: '新建反馈' }));
  expect(screen.getByLabelText('问题描述（必填）')).toBeEnabled();
  click.mockRestore();
});

it('策略读取失败保留重试入口，不采用默认允许外传', async () => {
  vi.mocked(adminApi.get).mockRejectedValueOnce(new Error('offline'));
  render(<FeedbackCollector />); fireEvent.click(screen.getByRole('button', { name: '提交异常反馈' }));
  await screen.findByText('无法读取反馈策略，请重试。');
  expect(screen.getByRole('button', { name: '准备反馈' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '重试读取策略' }));
  await waitFor(() => expect(adminApi.get).toHaveBeenCalledTimes(2));
});
