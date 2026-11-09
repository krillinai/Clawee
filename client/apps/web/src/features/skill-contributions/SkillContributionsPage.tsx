import { useEffect, useRef, useState } from 'react';
import { useModalBehavior } from '../../components/dialogs/use-modal-behavior.js';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, RefreshCw, X } from 'lucide-react';
import type { SkillContributionCSV, SkillContributionDownload, SkillContributionQuery, SkillContributionRecord, SkillContributionResponse } from '@clawee/protocol';
import type { createEnterpriseService } from '../../services/enterprise-service-2026-07-30.js';
import { ApiClientError, type RuntimeClient } from '../../runtime/client.js';
import type { ConnectionConfig } from '../../runtime/types.js';
import type { SubscribeRunEventsInput } from '../../runtime/sse.js';
import { ContributionConversation } from './ContributionConversation.js';
import './skill-contributions.css';

export function contributionPeriod(previous = false, now = new Date()) {
  const values = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const year = Number(values.find(part => part.type === 'year')?.value);
  const month = Number(values.find(part => part.type === 'month')?.value);
  const day = Number(values.find(part => part.type === 'day')?.value);
  if (previous) return { start_date: new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10), end_date: new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10) };
  return { start_date: `${year}-${String(month).padStart(2, '0')}-01`, end_date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

export function isContributionDenied(error: unknown) {
  return error instanceof ApiClientError && (error.status === 401 || error.status === 403);
}

function saveCSV(file: SkillContributionCSV) {
  const url = URL.createObjectURL(new Blob([file.content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = file.filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SkillContributionsPage(props: {
  service: ReturnType<typeof createEnterpriseService>;
  client: RuntimeClient;
  connection: ConnectionConfig;
  subscribe(input: SubscribeRunEventsInput): Promise<void>;
  modelReady: boolean;
  onDenied(): void;
  onBack(): void;
}) {
  const [query, setQuery] = useState<SkillContributionQuery>({ ...contributionPeriod(), report: 'uploads', page: 1, page_size: 50 });
  const [period, setPeriod] = useState('month');
  const [mobileView, setMobileView] = useState('data');
  const [summary, setSummary] = useState<SkillContributionResponse>();
  const [records, setRecords] = useState<SkillContributionResponse>();
  const [detail, setDetail] = useState<SkillContributionRecord>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [error, setError] = useState<string>();
  const [summaryError, setSummaryError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  const detailRequest = useRef(0);
  const drawer = useRef<HTMLElement>(null);
  const denied = useRef(props.onDenied); denied.current = props.onDenied;
  useModalBehavior(drawer, { open: detail !== undefined, onClose: () => { setDetail(undefined); detailRequest.current++; }, initialFocusRef: drawer });
  useEffect(() => { alive.current = true; return () => { alive.current = false; detailRequest.current++; }; }, []);
  function handleDenied(failure: unknown) { if (isContributionDenied(failure)) denied.current(); }
  const summaryKey = JSON.stringify([query.start_date, query.end_date, query.employee_id, refresh]);
  useEffect(() => {
    let stopped = false;
    setSummary(undefined); setSummaryError(undefined);
    void props.service.getSkillContributions('summary', { start_date: query.start_date, end_date: query.end_date, employee_id: query.employee_id }).then(response => { if (!stopped) setSummary(response); }).catch(failure => { if (!stopped) { setSummaryError('概览加载失败'); handleDenied(failure); } });
    return () => { stopped = true; };
  }, [props.service, summaryKey]);
  useEffect(() => {
    let stopped = false;
    setLoading(true); setError(undefined); setRecords(undefined); setDetail(undefined); setDetailError(undefined); setNotice(undefined); detailRequest.current++;
    void props.service.getSkillContributions('records', query).then(response => { if (!stopped) setRecords(response); }).catch(failure => { if (!stopped) { setError('数据加载失败，请检查查询条件或重试'); handleDenied(failure); } }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [props.service, query, refresh]);
  const detailOpen = detail !== undefined;
  function change(patch: Partial<SkillContributionQuery>) { setQuery(previous => ({ ...previous, ...patch, page: 1 })); }
  async function download(descriptor: SkillContributionDownload) {
    const file = await props.service.exportSkillContributions(descriptor.query);
    if (!alive.current) return;
    saveCSV(file); setNotice(file.rowCount === 0 ? '无匹配记录，已导出表头' : `已导出 ${file.rowCount} 条记录`);
  }
  async function openDetail(row: SkillContributionRecord) {
    const request = ++detailRequest.current;
    setDetail(row); setDetailLoading(true); setDetailError(undefined);
    try {
      const response = await props.service.getSkillContributions('detail', query.report === 'first_approvals' ? { skill_id: row.skill_id } : { version_id: row.version_id });
      if (alive.current && request === detailRequest.current) setDetail(response.items?.[0] as SkillContributionRecord);
    } catch (failure) { if (alive.current && request === detailRequest.current) { setDetailError('审核详情加载失败'); handleDenied(failure); } }
    finally { if (alive.current && request === detailRequest.current) setDetailLoading(false); }
  }
  const stats = summary?.summary;
  return <section className="contribution-page" data-mobile-view={mobileView}>
    <header className="contribution-heading"><div className="contribution-heading__title"><button type="button" onClick={props.onBack}><ArrowLeft size={16} aria-hidden="true" />返回工作台</button><h1>Skill 贡献</h1></div><button title="刷新" aria-label="刷新" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={17} /></button></header>
    <div className="contribution-filters">
      <label>周期<select aria-label="周期" value={period} onChange={event => { setPeriod(event.target.value); if (event.target.value !== 'custom') change(contributionPeriod(event.target.value === 'previous')); }}><option value="month">本月</option><option value="previous">上月</option><option value="custom">自定义</option></select></label>
      <label>开始日<input aria-label="开始日" type="date" value={query.start_date} onChange={event => { setPeriod('custom'); change({ start_date: event.target.value }); }} /></label>
      <label>结束日<input aria-label="结束日" type="date" value={query.end_date} onChange={event => { setPeriod('custom'); change({ end_date: event.target.value }); }} /></label>
      <label>员工 ID<input aria-label="员工 ID" value={query.employee_id ?? ''} onChange={event => change({ employee_id: event.target.value.trim() || undefined })} /></label>
    </div>
    <dl className="contribution-summary">
      <div><dt>上传数</dt><dd>{stats?.uploads ?? '—'}</dd></div>
      <div><dt>首次通过 Skill</dt><dd>{stats?.first_approvals ?? '—'}</dd></div>
      <div><dt>贡献人数</dt><dd>{stats?.contributors ?? '—'}</dd></div>
      <div><dt>首次通过平均分</dt><dd>{stats ? stats.average_score?.toFixed(2) ?? '未评分' : '—'}</dd><small>{stats ? `${stats.scored_count} 条有效评分` : '—'}</small></div>
    </dl>
    <div className="contribution-mobile-tabs" role="tablist" aria-label="面板视图"><button role="tab" aria-selected={mobileView === 'data'} onClick={() => setMobileView('data')}>数据</button><button role="tab" aria-selected={mobileView === 'chat'} onClick={() => setMobileView('chat')}>对话</button></div>
    <div className="contribution-workspace">
      <section className="contribution-data">
        <div className="contribution-table-toolbar">
          <div role="tablist" aria-label="数据视图">{(['uploads', 'first_approvals', 'employees'] as const).map(report => <button role="tab" key={report} aria-selected={query.report === report} onClick={() => change({ report, status: undefined, min_total_score: undefined })}>{({ uploads: '上传明细', first_approvals: '首次通过', employees: '员工汇总' })[report]}</button>)}</div>
          <button disabled={exporting || loading || !records} onClick={() => {
            setExporting(true); setNotice(undefined);
            const { page: _page, page_size: _size, ...conditions } = query;
            void download({ type: 'skill_contributions_csv', query: conditions }).catch(failure => { if (alive.current) { setNotice('CSV 下载失败，超过10,000行时请缩小查询范围'); handleDenied(failure); } }).finally(() => { if (alive.current) setExporting(false); });
          }}><Download size={15} />{exporting ? '正在下载' : '导出 CSV'}</button>
        </div>
        {query.report !== 'employees' ? <div className="contribution-filters contribution-table-filters">
          <label>审核状态<select aria-label="审核状态" value={query.status ?? ''} onChange={event => change({ status: (event.target.value || undefined) as SkillContributionQuery['status'] })}><option value="">全部</option><option value="pending">待审核</option><option value="approved">已通过</option><option value="rejected">已拒绝</option></select></label>
          <label>最低总分<input aria-label="最低总分" type="number" min={0} max={20} step="0.01" value={query.min_total_score ?? ''} onChange={event => change({ min_total_score: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>
        </div> : null}
        {summaryError ? <p role="alert" className="inline-error">{summaryError}</p> : null}
        {error ? <p role="alert" className="inline-error">{error}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        <div className="contribution-table-scroll">
          {loading ? <p role="status">正在加载</p> : records?.total === 0 ? <p role="status">无匹配记录</p> : records ? <table>
            <thead><tr>{(query.report === 'employees' ? ['员工', '上传数', '首次通过', '有效评分', '平均分'] : ['Skill / 版本', '员工', query.report === 'first_approvals' ? '首次通过时间' : '上传时间', '来源', '审核状态', '总分', '历史']).map(label => <th key={label}>{label}</th>)}</tr></thead>
            <tbody>{records.items?.map(row => 'skill_id' in row ? <tr key={row.id}>
              <td><button onClick={() => void openDetail(row)}>{row.skill_name}</button><small>{row.version ?? '未知版本'} · {row.version_id}</small>{!row.entity_available ? <small>版本已删除</small> : null}</td>
              <td>{row.employee_name || row.employee_id}<small>{row.employee_id}</small></td><td>{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(row.occurred_at))}</td><td>{({ app_upload: '客户端上传', admin_upload: '管理员上传', local: '本地审核', dingtalk: '外部审核' })[row.source] ?? row.source}</td><td>{row.status ? ({ pending: '待审核', approved: '已通过', rejected: '已拒绝' })[row.status] ?? row.status : '—'}</td><td>{row.scores?.total.toFixed(2) ?? '未评分'}</td><td>{row.history_status === 'unknown' ? '首次通过无法确认' : row.history_status === 'confirmed' ? '已确认' : '覆盖期内'}</td>
            </tr> : <tr key={row.employee_id}><td>{row.employee_name || row.employee_id}<small>{row.employee_id}</small></td><td>{row.uploads}</td><td>{row.first_approvals}</td><td>{row.scored_count}</td><td>{row.average_score?.toFixed(2) ?? '未评分'}</td></tr>)}</tbody>
          </table> : null}
        </div>
        <footer className="contribution-pagination"><span>{records ? `${records.total} 条 · 第 ${query.page} 页` : '—'}</span><button title="上一页" aria-label="上一页" disabled={loading || (query.page ?? 1) <= 1} onClick={() => setQuery(previous => ({ ...previous, page: (previous.page ?? 1) - 1 }))}><ChevronLeft size={17} /></button><button title="下一页" aria-label="下一页" disabled={loading || !records || (query.page ?? 1) * 50 >= records.total} onClick={() => setQuery(previous => ({ ...previous, page: (previous.page ?? 1) + 1 }))}><ChevronRight size={17} /></button></footer>
        <div className="contribution-coverage"><span>{records?.generated_at ? `生成于 ${new Date(records.generated_at).toLocaleString('zh-CN', { timeZone: records.timezone })} · ${records.timezone}` : ''}</span><span>{records?.coverage.notice ?? summary?.coverage.notice}</span></div>
      </section>
      <ContributionConversation client={props.client} connection={props.connection} subscribe={props.subscribe} query={{ start_date: query.start_date, end_date: query.end_date, employee_id: query.employee_id, report: query.report }} modelReady={props.modelReady} onDownload={download} onDenied={handleDenied} />
    </div>
    {detail ? <div className="contribution-drawer-backdrop" onClick={() => { setDetail(undefined); detailRequest.current++; }}><section ref={drawer} tabIndex={-1} role="dialog" aria-modal="true" aria-label="审核详情" className="contribution-drawer" onClick={event => event.stopPropagation()}><header><h2>{detail.skill_name}</h2><button title="关闭详情" aria-label="关闭详情" onClick={() => { setDetail(undefined); detailRequest.current++; }}><X size={18} /></button></header><p>{detail.version} · {detail.version_id}</p>{detailLoading ? <p role="status">正在加载审核详情</p> : detailError ? <p role="alert">{detailError}</p> : <><p>{detail.scores ? `总分 ${detail.scores.total.toFixed(2)} / 20` : '未评分'}</p>{detail.scores ? <dl className="contribution-scores">{(['scenario_value', 'result_effectiveness', 'ease_of_use', 'reuse_value'] as const).map((key, index) => <div key={key}><dt>{['场景价值', '结果有效性', '使用便利性', '复用价值'][index]}</dt><dd>{detail.scores![key].toFixed(2)}</dd></div>)}</dl> : null}{detail.approvers.map(person => <article key={person.user_id}><h3>{person.name || person.user_id}</h3><small>{person.user_id}</small><p>{person.scores ? [person.scores.scenario_value, person.scores.result_effectiveness, person.scores.ease_of_use, person.scores.reuse_value].map(value => value ?? '未评分').join(' / ') : '未评分'}</p><p>{person.comment || '无审核意见'}</p></article>)}</>}</section></div> : null}
  </section>;
}
