import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { feedbackAdminApi, type FeedbackReport } from '@/lib/feedback-admin-api';
import { APIError } from '@/lib/api';
import { FeedbackDetailPage, FeedbackPageView } from './feedback';

const access = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/components/admin-permissions', () => ({ useAdminPermission: () => access.allowed }));
vi.mock('@/lib/feedback-admin-api', async () => { const actual = await vi.importActual<typeof import('@/lib/feedback-admin-api')>('@/lib/feedback-admin-api'); return { ...actual, feedbackAdminApi: { ...actual.feedbackAdminApi, list: vi.fn(), get: vi.fn(), read: vi.fn(), operate: vi.fn() } }; });
const report: FeedbackReport = { report_id: 'fb_test0001', display_number: 'FB-TEST', description: '<img src=x onerror=alert(1)>', environment: { app_version: 'test' }, manifest: { missing_items: ['desktop:unavailable'], warnings: [] }, artifacts: [], events: [], created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), completeness: 'partial', processing_status: 'open', upload_state: 'ready', security_state: 'normal', version: 1 };
beforeEach(() => { vi.clearAllMocks(); access.allowed = true; vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); vi.mocked(feedbackAdminApi.list).mockResolvedValue({ items: [], meta: { next_cursor: '', has_next: false } }); vi.mocked(feedbackAdminApi.get).mockResolvedValue(report); vi.mocked(feedbackAdminApi.read).mockResolvedValue({ records: [], has_next: false, next_cursor: '' }); });
function page(path: string) { const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); return { ...render(<QueryClientProvider client={query}><MemoryRouter initialEntries={[path]}><Routes><Route path="/admin/feedback" element={<FeedbackPageView />} /><Route path="/admin/feedback/:id" element={<FeedbackDetailPage />} /></Routes></MemoryRouter></QueryClientProvider>), query }; }
it('列表只加载摘要，筛选进入URL，空列表可用', async () => { page('/admin/feedback?status=resolved'); expect(await screen.findByText('没有符合条件的反馈')).toBeInTheDocument(); expect(feedbackAdminApi.read).not.toHaveBeenCalled(); fireEvent.change(screen.getByLabelText('编号或描述'), { target: { value: '排障' } }); await waitFor(() => expect(vi.mocked(feedbackAdminApi.list).mock.calls.at(-1)?.[0].get('keyword')).toBe('排障')); });
it('列表复用统一表格，状态与异常材料筛选保留参数并重置分页', async () => {
  vi.mocked(feedbackAdminApi.list).mockResolvedValue({ items: [report], meta: { next_cursor: 'next-page', has_next: true } });
  const { container } = page('/admin/feedback?keyword=排障&cursor=old-page');
  expect(await screen.findByRole('link', { name: 'FB-TEST' })).toHaveAttribute('href', '/admin/feedback/fb_test0001?keyword=%E6%8E%92%E9%9A%9C&cursor=old-page');
  expect(screen.getByRole('heading', { name: '问题反馈' })).toHaveClass('text-2xl');
  expect(screen.getAllByRole('columnheader')).toHaveLength(8);
  expect(container.querySelector('[data-slot="card"]')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '待处理' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.mouseDown(screen.getByRole('tab', { name: '处理中' }), { button: 0, ctrlKey: false });
  await waitFor(() => {
    const params = vi.mocked(feedbackAdminApi.list).mock.calls.at(-1)![0];
    expect(params.get('status')).toBe('investigating');
    expect(params.get('keyword')).toBe('排障');
    expect(params.has('cursor')).toBe(false);
  });
  fireEvent.click(screen.getByRole('checkbox', { name: '包含异常材料' }));
  await waitFor(() => expect(vi.mocked(feedbackAdminApi.list).mock.calls.at(-1)![0].get('include_unavailable')).toBe('true'));
  fireEvent.click(await screen.findByRole('button', { name: '下一页' }));
  await waitFor(() => expect(vi.mocked(feedbackAdminApi.list).mock.calls.at(-1)![0].get('cursor')).toBe('next-page'));
});
it('加载失败在统一表格内展示重试入口', async () => {
  vi.mocked(feedbackAdminApi.list).mockRejectedValueOnce(new Error('offline'));
  page('/admin/feedback');
  expect(await screen.findByRole('alert')).toHaveTextContent('反馈列表加载失败');
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('没有符合条件的反馈')).toBeInTheDocument();
});
it('详情安全显示正文和partial，日志切换后才读取，处理冲突不覆盖', async () => { vi.mocked(feedbackAdminApi.operate).mockRejectedValue(new APIError('conflict', 409, 'feedback_version_conflict')); page('/admin/feedback/fb_test0001'); expect(await screen.findByText(report.description!)).toBeInTheDocument(); expect(screen.getByText('desktop:unavailable')).toBeInTheDocument(); expect(document.querySelector('img')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: '标记已处理' })); fireEvent.change(screen.getByLabelText('内部处理结论（必填）'), { target: { value: '已定位' } }); fireEvent.change(screen.getByLabelText('验证方法与结果（必填）'), { target: { value: '测试通过，未发布' } }); fireEvent.click(screen.getByRole('button', { name: '确认' })); expect(await screen.findByText('反馈版本或状态已变更，请关闭表单并重新读取。')).toBeInTheDocument(); expect(vi.mocked(feedbackAdminApi.operate).mock.calls[0]?.[2]).toMatchObject({ expected_version: 1, resolution_summary: '已定位', verification: '测试通过，未发布' }); });
it('只读账号隐藏处理操作，quarantine不读取正文', async () => { access.allowed = false; vi.mocked(feedbackAdminApi.get).mockResolvedValue({ ...report, security_state: 'quarantine', description: undefined, manifest: undefined }); page('/admin/feedback/fb_test0001'); expect(await screen.findByText('材料尚未就绪、已隔离或已过期，不能读取正文与处理。')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: '标记已处理' })).not.toBeInTheDocument(); expect(feedbackAdminApi.read).not.toHaveBeenCalled(); });
it('列表网络错误提供重试', async () => { vi.mocked(feedbackAdminApi.list).mockRejectedValue(new Error('offline')); page('/admin/feedback'); expect(await screen.findByRole('alert')).toHaveTextContent('反馈列表加载失败'); expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument(); });
it('包含异常材料筛选保存在URL并显示材料状态', async () => {
  vi.mocked(feedbackAdminApi.list).mockResolvedValue({ items: [{ ...report, upload_state: 'uploading', security_state: 'quarantine', description: undefined }], meta: { next_cursor: '', has_next: false } });
  page('/admin/feedback?status=all');
  expect(await screen.findByText('FB-TEST')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: '包含异常材料' }));
  await waitFor(() => expect(vi.mocked(feedbackAdminApi.list).mock.calls.at(-1)?.[0].get('include_unavailable')).toBe('true'));
  expect(await screen.findByText('uploading / quarantine')).toBeInTheDocument();
});
it('响应丢失后重试复用请求与幂等键，修改内容重新生成键', async () => {
  vi.mocked(feedbackAdminApi.operate).mockRejectedValue(new Error('response lost'));
  page('/admin/feedback/fb_test0001'); await screen.findByText(report.description!);
  fireEvent.click(screen.getByRole('button', { name: '标记已处理' }));
  fireEvent.change(screen.getByLabelText('内部处理结论（必填）'), { target: { value: '已定位' } });
  fireEvent.change(screen.getByLabelText('验证方法与结果（必填）'), { target: { value: '测试通过' } });
  fireEvent.click(screen.getByRole('button', { name: '确认' })); await screen.findByText('操作失败，请重试。');
  const first = vi.mocked(feedbackAdminApi.operate).mock.calls[0]![2];
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(feedbackAdminApi.operate).toHaveBeenCalledTimes(2));
  expect(vi.mocked(feedbackAdminApi.operate).mock.calls[1]![2]).toEqual(first);
  await waitFor(() => expect(screen.getByRole('button', { name: '确认' })).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText('内部处理结论（必填）'), { target: { value: '补充结论' } });
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(feedbackAdminApi.operate).toHaveBeenCalledTimes(3));
  expect(vi.mocked(feedbackAdminApi.operate).mock.calls[2]![2].idempotency_key).not.toBe(first.idempotency_key);
});
it('响应丢失后轮询版本变化，仍可用原请求恢复成功结果', async () => {
  vi.mocked(feedbackAdminApi.operate).mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({});
  const view = page('/admin/feedback/fb_test0001'); await screen.findByText(report.description!);
  fireEvent.click(screen.getByRole('button', { name: '开始处理' })); fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await screen.findByText('操作失败，请重试。');
  const first = vi.mocked(feedbackAdminApi.operate).mock.calls[0]![2];
  vi.mocked(feedbackAdminApi.get).mockResolvedValue({ ...report, version: 2, processing_status: 'investigating' });
  await act(async () => { await view.query.invalidateQueries({ queryKey: ['feedback-report', report.report_id] }); });
  expect(await screen.findByText('反馈已更新，请关闭表单后重新读取。')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '确认' })).toBeEnabled(); fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(feedbackAdminApi.operate).toHaveBeenCalledTimes(2));
  expect(vi.mocked(feedbackAdminApi.operate).mock.calls[1]![2]).toEqual(first);
});
