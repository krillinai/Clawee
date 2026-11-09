import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { feedbackAdminApi, type FeedbackReport } from '@/lib/feedback-admin-api';
import { APIError } from '@/lib/api';
import { FeedbackDetailPage, FeedbackPageView } from './feedback';

const access = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/components/admin-permissions', () => ({ useAdminPermission: () => access.allowed }));
vi.mock('@/lib/feedback-admin-api', async () => { const actual = await vi.importActual<typeof import('@/lib/feedback-admin-api')>('@/lib/feedback-admin-api'); return { ...actual, feedbackAdminApi: { ...actual.feedbackAdminApi, list: vi.fn(), get: vi.fn(), read: vi.fn(), operate: vi.fn() } }; });
const report: FeedbackReport = { report_id: 'fb_test0001', display_number: 'FB-TEST', description: '<img src=x onerror=alert(1)>', environment: { app_version: 'test' }, manifest: { missing_items: ['desktop:unavailable'], warnings: [] }, artifacts: [], events: [], created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), completeness: 'partial', processing_status: 'open', upload_state: 'ready', security_state: 'normal', version: 1 };
const automatic: FeedbackReport = { ...report, kind: 'automatic_incident', display_number: 'AI-TEST', manifest: undefined,
  incident: { incident_id: 'incident_1', installation_id: 'installation_12345678', app_session_id: 'session_1', revision: 3, source: 'daemon', layer: 'codex_model', stage: 'response', error_code: 'responseStreamDisconnected', message: 'responseStreamDisconnected', first_message: 'responseStreamDisconnected', first_seen_at: report.created_at, last_seen_at: report.created_at, occurrence_count: 3, outcome: 'recovered', environment: { runtime_version: '0.146.0', endpoint_fingerprint: 'a'.repeat(64) } } };
it('未登录的自动异常展示 Agent 并明确员工尚未关联', async () => {
  vi.mocked(feedbackAdminApi.get).mockResolvedValue({ ...automatic, incident: { ...automatic.incident!, reporter: { enterprise_key: 'a'.repeat(64), agent_id: 'agent_1' } } });
  page('/admin/feedback/incident_1');
  const facts = await screen.findByLabelText('自动异常事实');
  expect(facts).toHaveTextContent('agent_1');
  expect(facts).toHaveTextContent('未关联员工');
  expect(facts).not.toHaveTextContent('客户端企业账号快照');
});
it('自动异常展示员工账号、技术错误、时间线与原始日志下载', async () => {
  const enriched: FeedbackReport = { ...automatic, artifacts: [{ artifact_id: 'incident_raw_logs', kind: 'logs', name: 'incident-raw-logs.ndjson', size_bytes: 128, content_type: 'application/x-ndjson', record_count: 1, source: 'incident_snapshot', upload_state: 'received' }],
    incident: { ...automatic.incident!, reporter: { enterprise_key: 'a'.repeat(64), subject_id: 'user_zhang', display_name: '张三', agent_id: 'agent_1' }, logs_expected: true,
      diagnostics: { error_message: 'connection reset', error_stack: 'Error: connection reset\n at /app/client.ts:42', request_method: 'POST', request_path: '/runs' },
      first_diagnostics: { error_message: 'Reconnecting... 1/5', additional_details: 'HTTP 503', request_id: 'req_first' },
      timeline: [{ at: report.created_at, event_type: 'error', stage: 'response', error_code: 'responseStreamDisconnected' }] } };
  vi.mocked(feedbackAdminApi.get).mockResolvedValue(enriched);
  vi.mocked(feedbackAdminApi.read).mockResolvedValue({ records: [{ text: 'TLS connection reset', artifact_id: 'incident_raw_logs', continuation: false, fragment_offset: 0 }], next_cursor: '', has_next: false });
  page('/admin/feedback/incident_1');
  expect(await screen.findByLabelText('自动异常事实')).toHaveTextContent('张三');
  expect(screen.getByLabelText('自动异常事实')).toHaveTextContent('接收中心未核验');
  expect(screen.getByLabelText('最近错误详情')).toHaveTextContent('/app/client.ts:42');
  expect(screen.getByLabelText('首次错误详情')).toHaveTextContent('HTTP 503');
  expect(screen.getByLabelText('首次错误详情')).toHaveTextContent('req_first');
  expect(screen.getByLabelText('异常时间线')).toHaveTextContent('发生异常');
  expect(await screen.findByText('TLS connection reset')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'incident-raw-logs.ndjson' })).toHaveAttribute('download');
});
it('列表按员工查找并显示发生时账号快照', async () => {
  vi.mocked(feedbackAdminApi.list).mockResolvedValue({ items: [{ ...automatic, incident: { ...automatic.incident!, reporter: { enterprise_key: 'a'.repeat(64), subject_id: 'user_zhang', display_name: '张三' } } }], meta: { next_cursor: '', has_next: false } });
  page('/admin/feedback?cursor=old-page');
  expect(await screen.findByText('张三 · 客户端自动上报')).toBeInTheDocument();
  expect(screen.getByText('账号 user_zhang（客户端快照）')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('员工姓名或账号 ID'), { target: { value: '张三' } });
  await waitFor(() => { const params = vi.mocked(feedbackAdminApi.list).mock.calls.at(-1)![0]; expect(params.get('reporter')).toBe('张三'); expect(params.has('cursor')).toBe(false); });
});
it('自动异常展示技术事实、未知值与独立人工状态，不读取会话或附件', async () => {
  vi.mocked(feedbackAdminApi.get).mockResolvedValue(automatic); page('/admin/feedback/incident_1');
  expect(await screen.findByLabelText('自动异常事实')).toHaveTextContent('运行已恢复');
  expect(screen.getByLabelText('自动异常事实')).toHaveTextContent('0.146.0');
  expect(screen.getByLabelText('自动异常事实')).toHaveTextContent('未知');
  expect(screen.getByRole('button', { name: '标记已处理' })).toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: '会话' })).not.toBeInTheDocument(); expect(feedbackAdminApi.read).not.toHaveBeenCalled();
});
it('自动异常列表显示安装后缀、次数及恢复，并传递类型与链路筛选', async () => {
  vi.mocked(feedbackAdminApi.list).mockResolvedValue({ items: [automatic], meta: { next_cursor: '', has_next: false } }); page('/admin/feedback');
  expect(await screen.findByText('AI-TEST')).toBeInTheDocument(); expect(screen.getByText('3 次')).toBeInTheDocument(); expect(screen.getByText('运行已恢复')).toBeInTheDocument();
  expect(screen.getByText(/匿名 \/ 自报 · 12345678/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('combobox', { name: '反馈类型' })); fireEvent.click(await screen.findByRole('option', { name: '自动异常' }));
  fireEvent.click(screen.getByRole('combobox', { name: '异常链路' })); fireEvent.click(await screen.findByRole('option', { name: 'Codex 到模型' }));
  await waitFor(() => { const params = vi.mocked(feedbackAdminApi.list).mock.calls.at(-1)?.[0]; expect(params?.get('kind')).toBe('automatic_incident'); expect(params?.get('layer')).toBe('codex_model'); });
});
it('过期自动异常列表仍按类型展示，不冒充手工反馈', async () => {
  const expired = { ...automatic, incident: undefined, description: undefined, upload_state: 'expired', expires_at: new Date(Date.now() - 86400000).toISOString() };
  vi.mocked(feedbackAdminApi.list).mockResolvedValue({ items: [expired], meta: { next_cursor: '', has_next: false } });
  page('/admin/feedback?kind=automatic_incident&include_unavailable=true');
  expect(await screen.findByRole('link', { name: 'AI-TEST' })).toBeInTheDocument();
  const row = screen.getByRole('row', { name: /AI-TEST/ });
  expect(within(row).getByText('自动异常')).toBeInTheDocument();
  expect(within(row).queryByText('手工反馈')).not.toBeInTheDocument();
  expect(screen.getByText('expired / normal')).toBeInTheDocument();
  expect(screen.queryByText('3 次')).not.toBeInTheDocument();
});
it.each(['expired', 'quarantine'])('不可读取的自动异常详情保留类型且不显示手工材料入口：%s', async state => {
  const unavailable = { ...automatic, incident: undefined, description: undefined,
    upload_state: state === 'expired' ? 'expired' : 'ready', security_state: state === 'quarantine' ? 'quarantine' : 'normal',
    expires_at: new Date(Date.now() + (state === 'expired' ? -1 : 1) * 86400000).toISOString() };
  vi.mocked(feedbackAdminApi.get).mockResolvedValue(unavailable);
  page('/admin/feedback/incident_1');
  expect(await screen.findByRole('heading', { name: 'AI-TEST' })).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('不能读取正文与处理');
  expect(screen.getByRole('region', { name: '处理记录' })).toBeInTheDocument();
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '标记已处理' })).not.toBeInTheDocument();
  expect(feedbackAdminApi.read).not.toHaveBeenCalled();
});
beforeEach(() => { vi.clearAllMocks(); access.allowed = true; vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); vi.mocked(feedbackAdminApi.list).mockResolvedValue({ items: [], meta: { next_cursor: '', has_next: false } }); vi.mocked(feedbackAdminApi.get).mockResolvedValue(report); vi.mocked(feedbackAdminApi.read).mockResolvedValue({ records: [], has_next: false, next_cursor: '' }); });
function page(path: string) { const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); return { ...render(<QueryClientProvider client={query}><MemoryRouter initialEntries={[path]}><Routes><Route path="/admin/feedback" element={<FeedbackPageView />} /><Route path="/admin/feedback/:id" element={<FeedbackDetailPage />} /></Routes></MemoryRouter></QueryClientProvider>), query }; }
it.each([
  ['开始处理', 'open', '处理人将记录为当前中心账号。'],
  ['标记已处理', 'open', '记录处理结论和验证结果，并将反馈标记为已处理。'],
  ['重新打开', 'resolved', '填写重新打开原因，将反馈恢复为待处理。']
])('%s弹窗有可访问描述且不产生警告', async (title, status, description) => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    vi.mocked(feedbackAdminApi.get).mockResolvedValue({ ...report, processing_status: status });
    page('/admin/feedback/fb_test0001');
    fireEvent.click(await screen.findByRole('button', { name: title }));
    expect(screen.getByRole('dialog', { name: title })).toHaveAccessibleDescription(description);
    expect(warning).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});
it('截图预览不关联不存在的描述且不产生警告', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    vi.mocked(feedbackAdminApi.get).mockResolvedValue({ ...report, artifacts: [{ artifact_id: 'shot_1', kind: 'screenshot', name: '截图', size_bytes: 1, content_type: 'image/png', record_count: 0, source: 'browser', upload_state: 'ready' }] });
    page('/admin/feedback/fb_test0001');
    fireEvent.click(await screen.findByRole('button', { name: '截图' }));
    expect(screen.getByRole('dialog', { name: '问题截图' })).not.toHaveAttribute('aria-describedby');
    expect(warning).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});
it('列表只加载摘要，筛选进入URL，空列表可用', async () => { page('/admin/feedback?status=resolved'); expect(await screen.findByText('没有符合条件的反馈')).toBeInTheDocument(); expect(feedbackAdminApi.read).not.toHaveBeenCalled(); fireEvent.change(screen.getByLabelText('编号或描述'), { target: { value: '排障' } }); await waitFor(() => expect(vi.mocked(feedbackAdminApi.list).mock.calls.at(-1)?.[0].get('keyword')).toBe('排障')); });
it('列表复用统一表格，状态与异常材料筛选保留参数并重置分页', async () => {
  vi.mocked(feedbackAdminApi.list).mockResolvedValue({ items: [report], meta: { next_cursor: 'next-page', has_next: true } });
  const { container } = page('/admin/feedback?keyword=排障&cursor=old-page');
  expect(await screen.findByRole('link', { name: 'FB-TEST' })).toHaveAttribute('href', '/admin/feedback/fb_test0001?keyword=%E6%8E%92%E9%9A%9C&cursor=old-page');
  expect(screen.getByRole('heading', { name: '问题反馈' })).toHaveClass('text-2xl');
  expect(screen.getAllByRole('columnheader')).toHaveLength(8);
  expect(container.querySelector('[data-slot="card"]')).toBeInTheDocument();
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: '筛选反馈状态' })).toHaveTextContent('待处理');
  fireEvent.click(screen.getByRole('combobox', { name: '筛选反馈状态' }));
  fireEvent.click(await screen.findByRole('option', { name: '处理中' }));
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
it('来源、版本与日期筛选保留其他条件，清空条件并重置分页', async () => {
  page('/admin/feedback?status=all&keyword=排障&cursor=old-page');
  await screen.findByText('没有符合条件的反馈');
  expect(screen.getByRole('combobox', { name: '筛选反馈状态' })).toHaveTextContent('全部状态');
  for (const [label, key, value, expected] of [
    ['来源', 'source', 'desktop', 'desktop'],
    ['App 版本', 'version', '0.1.15', '0.1.15'],
    ['开始时间', 'from', '2026-09-01', '2026-09-01T00:00:00Z'],
    ['结束时间', 'to', '2026-09-18', '2026-09-18T23:59:59Z']
  ]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
    await waitFor(() => {
      const params = vi.mocked(feedbackAdminApi.list).mock.calls.at(-1)![0];
      expect(params.get(key!)).toBe(expected);
      expect(params.get('status')).toBe('all');
      expect(params.get('keyword')).toBe('排障');
      expect(params.has('cursor')).toBe(false);
    });
  }
  fireEvent.change(screen.getByLabelText('来源'), { target: { value: '' } });
  await waitFor(() => {
    const params = vi.mocked(feedbackAdminApi.list).mock.calls.at(-1)![0];
    expect(params.has('source')).toBe(false);
    expect(params.get('version')).toBe('0.1.15');
    expect(params.get('from')).toBe('2026-09-01T00:00:00Z');
    expect(params.get('to')).toBe('2026-09-18T23:59:59Z');
  });
});
it('详情安全显示正文和partial，日志切换后才读取，处理冲突不覆盖', async () => { vi.mocked(feedbackAdminApi.operate).mockRejectedValue(new APIError('conflict', 409, 'feedback_version_conflict')); page('/admin/feedback/fb_test0001'); expect(await screen.findByText(report.description!)).toBeInTheDocument(); expect(screen.getByText('desktop:unavailable')).toBeInTheDocument(); expect(document.querySelector('img')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: '标记已处理' })); fireEvent.change(screen.getByLabelText('内部处理结论（必填）'), { target: { value: '已定位' } }); fireEvent.change(screen.getByLabelText('验证方法与结果（必填）'), { target: { value: '测试通过，未发布' } }); fireEvent.click(screen.getByRole('button', { name: '确认' })); expect(await screen.findByText('反馈版本或状态已变更，请关闭表单并重新读取。')).toBeInTheDocument(); expect(vi.mocked(feedbackAdminApi.operate).mock.calls[0]?.[2]).toMatchObject({ expected_version: 1, resolution_summary: '已定位', verification: '测试通过，未发布' }); });
it('只读账号隐藏处理操作，quarantine不读取正文', async () => { access.allowed = false; vi.mocked(feedbackAdminApi.get).mockResolvedValue({ ...report, security_state: 'quarantine', description: undefined, manifest: undefined }); page('/admin/feedback/fb_test0001'); expect(await screen.findByText('材料尚未就绪、已隔离或已过期，不能读取正文与处理。')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: '标记已处理' })).not.toBeInTheDocument(); expect(feedbackAdminApi.read).not.toHaveBeenCalled(); });
it('列表网络错误提供重试', async () => { vi.mocked(feedbackAdminApi.list).mockRejectedValue(new Error('offline')); page('/admin/feedback'); expect(await screen.findByRole('alert')).toHaveTextContent('反馈列表加载失败'); expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument(); });
it('反馈列表和详情遇到403提示授权且不提供重试', async () => {
  vi.mocked(feedbackAdminApi.list).mockRejectedValue(new APIError('反馈请求未完成', 403, 'feedback_forbidden'));
  page('/admin/feedback');
  expect(await screen.findByRole('alert')).toHaveTextContent('请联系管理员开通问题反馈查看权限及全部反馈数据授权');
  expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
});
it('反馈详情遇到403不误报为不可用', async () => {
  vi.mocked(feedbackAdminApi.get).mockRejectedValue(new APIError('反馈请求未完成', 403, 'feedback_forbidden'));
  page('/admin/feedback/fb_test0001');
  expect(await screen.findByRole('alert')).toHaveTextContent('全部反馈数据授权');
  expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
});
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
