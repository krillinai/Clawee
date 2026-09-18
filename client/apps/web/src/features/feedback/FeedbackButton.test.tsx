import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackButton } from './FeedbackButton.js';
import { RuntimeClient } from '../../runtime/client.js';

beforeEach(() => { localStorage.clear(); HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) { this.open = true; }); });
describe('主动会话反馈', () => {
  it('超限反馈保留导出入口，不重试发送', async () => {
    const draft = { local_feedback_id: '00000000-0000-0000-0000-000000000001', thread_id: 'thread_test', description: '问题', state: 'failed', error_code: 'FEEDBACK_QUOTA_EXCEEDED', size_bytes: 10, screenshots: [], retry_count: 0, expires_at: new Date().toISOString(), external_feedback_allowed: true, manifest: { completeness: 'partial', artifacts: [], missing_items: ['collection:quota_exceeded'] } };
    const client = new RuntimeClient({ baseUrl: 'http://local', fetchImpl: vi.fn(async url => String(url).endsWith('/policy') ? Response.json({ external_feedback_allowed: true }) : Response.json(draft)) });
    localStorage.setItem('clawee-feedback:thread_test', draft.local_feedback_id);
    render(<FeedbackButton client={client} threadId="thread_test" />); fireEvent.click(await screen.findByRole('button', { name: '反馈当前会话问题' }));
    expect(await screen.findByText(/请联系维护方调整限额/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本地导出' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认发送' })).not.toBeInTheDocument();
  });
  it('有导出清单但未授权的采集失败，重试重新采集', async () => {
    const draft = { local_feedback_id: '00000000-0000-0000-0000-000000000001', thread_id: 'thread_test', description: '问题', state: 'failed', error_code: 'FEEDBACK_COLLECTION_FAILED', size_bytes: 10, screenshots: [], retry_count: 0, expires_at: new Date().toISOString(), external_feedback_allowed: true, manifest: { completeness: 'partial', artifacts: [], missing_items: ['collection:interrupted'] } };
    const fetchImpl = vi.fn(async url => String(url).endsWith('/policy') ? Response.json({ external_feedback_allowed: true }) : Response.json(draft));
    const client = new RuntimeClient({ baseUrl: 'http://local', fetchImpl }); localStorage.setItem('clawee-feedback:thread_test', draft.local_feedback_id);
    render(<FeedbackButton client={client} threadId="thread_test" />); fireEvent.click(await screen.findByRole('button', { name: '反馈当前会话问题' }));
    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    await waitFor(() => expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/collect'))).toBe(true));
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/retry'))).toBe(false);
  });
  it('禁用策略隐藏入口', async () => { const client = new RuntimeClient({ baseUrl: 'http://local', fetchImpl: vi.fn(async () => Response.json({ external_feedback_allowed: false })) }); render(<FeedbackButton client={client} threadId="thread_test" />); await waitFor(() => expect(screen.queryByRole('button', { name: '反馈当前会话问题' })).not.toBeInTheDocument()); });
  it('发送前必须授权并显示接收方和partial缺失', async () => { const draft = { local_feedback_id: '00000000-0000-0000-0000-000000000001', thread_id: 'thread_test', description: '问题', state: 'awaiting_consent', origin: 'https://gateway.clawee.work', size_bytes: 10, screenshots: [], retry_count: 0, expires_at: new Date().toISOString(), manifest_sha256: 'a'.repeat(64), external_feedback_allowed: true, manifest: { completeness: 'partial', artifacts: [], missing_items: ['desktop:unavailable'] } }; const client = new RuntimeClient({ baseUrl: 'http://local', fetchImpl: vi.fn(async (_url, input) => { if (input?.method === 'POST') return Response.json(draft); if (String(_url).endsWith('/policy')) return Response.json({ external_feedback_allowed: true }); return Response.json(draft); }) }); localStorage.setItem('clawee-feedback:thread_test', draft.local_feedback_id); render(<FeedbackButton client={client} threadId="thread_test" />); fireEvent.click(await screen.findByRole('button', { name: '反馈当前会话问题' })); expect(await screen.findByText('desktop:unavailable')).toBeInTheDocument(); const send = screen.getByRole('button', { name: '确认发送' }); expect(send).toBeDisabled(); for (const check of screen.getAllByRole('checkbox')) fireEvent.click(check); expect(send).toBeEnabled(); expect(screen.getByText(/接收域名：gateway.clawee.work/)).toBeInTheDocument(); });
});
