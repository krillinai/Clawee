import type { EnterpriseBilibiliDashboardResponse } from '@clawee/protocol';
import { useEffect, useState } from 'react';
import { ArrowLeft, ContactRound, Eye, Heart, Megaphone, MessagesSquare, MousePointerClick, Plus, Radar, RefreshCw, Save, Sparkles, TrendingUp, Tv, UserPlus, Video, X } from 'lucide-react';
import { ApiClientError } from '../../runtime/client.js';
import './dashboard.css';
import './dashboard-layout.css';

type DashboardRole = 'admin' | 'employee';
type DashboardDetailId = 'xiaohongshu' | 'douyin' | 'bilibili';
type BilibiliLoadState =
  | { status: 'idle' | 'loading' }
  | { status: 'loaded'; dashboard: EnterpriseBilibiliDashboardResponse }
  | { status: 'error'; forbidden: boolean };
type DashboardEnterpriseService = {
  getBilibiliDashboard(): Promise<EnterpriseBilibiliDashboardResponse>;
};
type BusinessModule = {
  id: string; title: string; description: string; icon: typeof Radar;
  primaryLabel: string; primaryValue: string; secondaryLabel: string; secondaryValue: string;
  signal: string; tone: 'warning' | 'positive' | 'neutral'; scope: 'enterprise' | 'team' | 'personal';
};

const initialBusinessModules: BusinessModule[] = [
  { id: 'competitor', title: '竞品洞察', description: '追踪品牌、产品与市场动态', icon: Radar, primaryLabel: '跟踪品牌', primaryValue: '18', secondaryLabel: '本周新增信号', secondaryValue: '42', signal: '3 项需关注', tone: 'warning', scope: 'enterprise' },
  { id: 'customers', title: '客户管理', description: '汇总客户状态与关键跟进', icon: ContactRound, primaryLabel: '活跃客户', primaryValue: '1,286', secondaryLabel: '待跟进', secondaryValue: '37', signal: '续约健康度 92%', tone: 'positive', scope: 'team' },
  { id: 'xiaohongshu', title: '小红书运营', description: '追踪笔记发布、种草与粉丝互动', icon: MessagesSquare, primaryLabel: '本周发布', primaryValue: '24', secondaryLabel: '互动量', secondaryValue: '18.6 万', signal: '互动率提升 12.4%', tone: 'positive', scope: 'team' },
  { id: 'douyin', title: '抖音投放', description: '评估短视频投放消耗与转化效率', icon: Megaphone, primaryLabel: '本月消耗', primaryValue: '¥386,400', secondaryLabel: '综合 ROI', secondaryValue: '3.7', signal: '转化 2,416 次', tone: 'neutral', scope: 'enterprise' },
  { id: 'bilibili', title: '哔哩哔哩运营', description: '查看账号粉丝、稿件播放与互动表现', icon: Tv, primaryLabel: '当前粉丝', primaryValue: '—', secondaryLabel: '累计播放', secondaryValue: '—', signal: '等待企业数据', tone: 'neutral', scope: 'enterprise' }
];

export function DashboardPage(props: {
  connected?: boolean;
  enterpriseSignedIn?: boolean;
  service?: DashboardEnterpriseService | null;
  onSessionExpired?(): void;
} = {}) {
  const [role, setRole] = useState<DashboardRole>('admin');
  const [businessModules, setBusinessModules] = useState(initialBusinessModules);
  const [detailId, setDetailId] = useState<DashboardDetailId>();
  const [bilibili, setBilibili] = useState<BilibiliLoadState>({ status: 'idle' });
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ title: '', description: '' });
  const createDashboard = () => {
    if (!draft.title.trim()) return;
    setBusinessModules(items => [...items, { id: `custom-${items.length}`, title: draft.title.trim(), description: draft.description.trim() || '个人工作数据概览', icon: Sparkles, primaryLabel: '今日事项', primaryValue: '12', secondaryLabel: '已完成', secondaryValue: '8', signal: '仅当前用户可编辑', tone: 'neutral', scope: role === 'admin' ? 'enterprise' : 'personal' }]);
    setCreating(false); setDraft({ title: '', description: '' });
  };

  const loadBilibili = () => {
    if (props.service === null || props.service === undefined) return;
    let active = true;
    setBilibili({ status: 'loading' });
    void props.service.getBilibiliDashboard()
      .then(dashboard => {
        if (active) setBilibili({ status: 'loaded', dashboard });
      })
      .catch(error => {
        if (!active) return;
        const unauthorized = error instanceof ApiClientError
          && (error.code === 'ENTERPRISE_SESSION_EXPIRED'
            || error.code === 'ENTERPRISE_UNAUTHORIZED');
        if (unauthorized) props.onSessionExpired?.();
        setBilibili({
          status: 'error',
          forbidden: error instanceof ApiClientError
            && error.code === 'ENTERPRISE_DATA_VIEW_FORBIDDEN'
        });
      });
    return () => { active = false; };
  };

  useEffect(() => {
    if (props.connected !== true || props.enterpriseSignedIn !== true) {
      setBilibili({ status: 'idle' });
      return;
    }
    return loadBilibili();
  }, [props.connected, props.enterpriseSignedIn, props.service]);

  const visibleModules = businessModules.map(module => (
    module.id === 'bilibili'
      ? { ...module, ...bilibiliModuleSummary(bilibili, props) }
      : module
  ));

  if (detailId === 'bilibili') return <BilibiliDashboardDetail state={bilibili} onBack={() => setDetailId(undefined)} onRetry={loadBilibili} />;
  if (detailId !== undefined) return <DashboardDetail kind={detailId} onBack={() => setDetailId(undefined)} />;

  return <main className="dashboard-page"><div className="dashboard-page__inner">
    <header className="dashboard-header"><div><div className="dashboard-title-row"><h1>数据看板</h1><span>企业数据</span></div><p>业务运营数据与关键指标概览</p></div><div className="dashboard-period"><span>统计周期</span><strong>近 7 天</strong></div></header>
    <div className="dashboard-notice" role="note">哔哩哔哩看板已连接企业服务，其余业务模块为静态示例</div>
    <section className="dashboard-business" aria-labelledby="dashboard-business-title">
      <header><div><span>BUSINESS INTELLIGENCE</span><h2 id="dashboard-business-title">业务洞察</h2></div><div className="dashboard-business-controls"><div className="dashboard-role-control" role="group" aria-label="看板权限视图"><button aria-pressed={role === 'admin'} onClick={() => setRole('admin')}>管理员</button><button aria-pressed={role === 'employee'} onClick={() => setRole('employee')}>员工</button></div><button className="dashboard-add-button" onClick={() => { setCreating(true); setDraft({ title: '', description: '' }); }}><Plus size={15} />创建看板</button></div></header>
      <div className="dashboard-permission-note" role="status">{role === 'admin' ? '管理员可创建企业与团队看板' : '员工可查看已授权看板，并创建个人看板'}</div>
      {creating ? <div className="dashboard-editor" aria-label="创建看板"><label>看板名称<input autoFocus value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder="例如：销售日报" /></label><label>用途说明<input value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder="这个看板用于查看什么" /></label><button onClick={createDashboard} disabled={!draft.title.trim()}><Save size={15}/>保存</button><button aria-label="取消创建" onClick={() => setCreating(false)}><X size={15}/></button></div> : null}
      <div className="dashboard-business-grid">{visibleModules.map(module => { const Icon = module.icon; const hasDetail = module.id === 'xiaohongshu' || module.id === 'douyin' || module.id === 'bilibili'; const Tag = hasDetail ? 'button' : 'article'; return <Tag className="dashboard-business-card" key={module.id} {...(hasDetail ? { 'aria-label': `打开${module.title}详情看板`, onClick: () => setDetailId(module.id as DashboardDetailId), type: 'button' as const } : {})}>
        <div className="dashboard-card-access"><span>{module.scope === 'enterprise' ? '企业看板' : module.scope === 'team' ? '团队看板' : '个人看板'}</span>{hasDetail ? <em>查看详情</em> : null}</div>
        <div className="dashboard-business-card__heading"><span><Icon size={17} aria-hidden="true" /></span><div><h3>{module.title}</h3><p>{module.description}</p></div></div>
        <dl><div><dt>{module.primaryLabel}</dt><dd>{module.primaryValue}</dd></div><div><dt>{module.secondaryLabel}</dt><dd>{module.secondaryValue}</dd></div></dl>
        <small data-tone={module.tone}>{module.signal}</small>
      </Tag>; })}</div>
    </section>
  </div></main>;
}

function bilibiliModuleSummary(
  state: BilibiliLoadState,
  props: { connected?: boolean; enterpriseSignedIn?: boolean }
): Pick<BusinessModule, 'primaryValue' | 'secondaryValue' | 'signal' | 'tone'> {
  if (props.connected !== true) return { primaryValue: '—', secondaryValue: '—', signal: '本地运行内核未连接', tone: 'warning' };
  if (props.enterpriseSignedIn !== true) return { primaryValue: '—', secondaryValue: '—', signal: '登录企业账号后查看', tone: 'neutral' };
  if (state.status === 'loading') return { primaryValue: '—', secondaryValue: '—', signal: '正在加载企业数据', tone: 'neutral' };
  if (state.status === 'error') return { primaryValue: '—', secondaryValue: '—', signal: state.forbidden ? '当前账号无查看权限' : '企业数据加载失败', tone: 'warning' };
  if (state.status !== 'loaded') return { primaryValue: '—', secondaryValue: '—', signal: '等待企业数据', tone: 'neutral' };
  if (state.dashboard.status === 'unconfigured') return { primaryValue: '未配置', secondaryValue: '—', signal: '数据源尚未接入', tone: 'warning' };
  if (state.dashboard.status === 'unavailable' || state.dashboard.data === undefined) return { primaryValue: '待同步', secondaryValue: '—', signal: '暂无可用采集数据', tone: 'warning' };
  return {
    primaryValue: formatInteger(state.dashboard.data.followerCount),
    secondaryValue: formatInteger(state.dashboard.data.viewCount),
    signal: `已采集 ${formatInteger(state.dashboard.data.collectedContentCount)} 个稿件`,
    tone: 'positive'
  };
}

function BilibiliDashboardDetail(props: {
  state: BilibiliLoadState;
  onBack(): void;
  onRetry(): void;
}) {
  const data = props.state.status === 'loaded'
    && (props.state.dashboard.status === 'available' || props.state.dashboard.status === 'partial')
    ? props.state.dashboard.data
    : undefined;
  return <main className="dashboard-page dashboard-detail-page"><div className="dashboard-page__inner">
    <header className="dashboard-detail-header"><button aria-label="返回数据看板" onClick={props.onBack} type="button"><ArrowLeft size={18} aria-hidden="true" /></button><div><span>内容运营详情</span><h1>哔哩哔哩运营</h1><p>{data === undefined ? '企业业务数据' : `采集于 ${formatDateTime(data.capturedAt)}`}</p></div></header>
    {data === undefined ? <BilibiliDashboardState state={props.state} onRetry={props.onRetry} /> : <>
      <section className="dashboard-detail-metrics" aria-label="哔哩哔哩运营核心指标">{[
        { label: '当前粉丝', value: data.followerCount, icon: UserPlus },
        { label: '已采集稿件', value: data.collectedContentCount, icon: Video },
        { label: '稿件累计播放', value: data.viewCount, icon: Eye },
        { label: '稿件累计互动', value: data.interactionCount, icon: Heart }
      ].map(item => { const Icon = item.icon; return <article key={item.label}><Icon size={18} aria-hidden="true" /><span>{item.label}</span><strong>{formatInteger(item.value)}</strong></article>; })}</section>
      <section className="dashboard-detail-panel"><header><div><span>PERFORMANCE</span><h2>热门稿件</h2></div><small>按累计播放量排序</small></header>{data.topContents.length === 0 ? <div className="dashboard-detail-empty">暂无稿件数据</div> : <div className="dashboard-detail-table dashboard-detail-table--bilibili"><div><span>稿件</span><span>数据时间</span><span>播放量</span><span>互动量</span></div>{data.topContents.map(item => <div key={item.externalContentId}><span title={item.title || item.externalContentId}>{item.title || item.externalContentId}</span><span>{formatDateTime(item.capturedAt)}</span><span>{formatInteger(item.viewCount)}</span><span>{formatInteger(item.interactionCount)}</span></div>)}</div>}</section>
    </>}
  </div></main>;
}

function BilibiliDashboardState(props: { state: BilibiliLoadState; onRetry(): void }) {
  let title = '正在加载哔哩哔哩数据';
  let message = '正在从企业服务读取最新运营数据。';
  if (props.state.status === 'idle') {
    title = '企业数据暂不可用';
    message = '请确认本地运行内核已连接并登录企业账号。';
  } else if (props.state.status === 'error') {
    title = props.state.forbidden ? '暂无查看权限' : '哔哩哔哩数据加载失败';
    message = props.state.forbidden ? '请联系管理员开通哔哩哔哩运营数据权限。' : '企业服务暂时无法返回数据，请稍后重试。';
  } else if (props.state.status === 'loaded') {
    title = props.state.dashboard.status === 'unconfigured' ? '数据源尚未接入' : '暂无可用采集数据';
    message = props.state.dashboard.status === 'unconfigured' ? '请先在企业管理端完成哔哩哔哩账号接入。' : '数据源已启用，但还没有成功同步的数据。';
  }
  return <section className="dashboard-detail-state" role={props.state.status === 'error' ? 'alert' : 'status'}><Tv size={22} aria-hidden="true" /><h2>{title}</h2><p>{message}</p>{props.state.status === 'error' && !props.state.forbidden ? <button type="button" onClick={props.onRetry}><RefreshCw size={15} aria-hidden="true" />重试</button> : null}</section>;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai'
  }).format(date);
}

const xiaohongshuMetrics = [
  { label: '笔记曝光', value: '286.4 万', change: '+18.2%', icon: Eye },
  { label: '互动量', value: '18.6 万', change: '+12.4%', icon: Heart },
  { label: '新增粉丝', value: '12,846', change: '+9.7%', icon: UserPlus },
  { label: '种草转化', value: '8.6%', change: '+1.3%', icon: TrendingUp }
];

const douyinMetrics = [
  { label: '投放消耗', value: '¥386,400', change: '-4.6%', icon: Megaphone },
  { label: '视频播放', value: '1,862 万', change: '+21.8%', icon: Video },
  { label: '转化次数', value: '2,416', change: '+16.2%', icon: MousePointerClick },
  { label: '综合 ROI', value: '3.7', change: '+0.4', icon: TrendingUp }
];

function DashboardDetail(props: { kind: 'xiaohongshu' | 'douyin'; onBack(): void }) {
  const isXiaohongshu = props.kind === 'xiaohongshu';
  const title = isXiaohongshu ? '小红书运营' : '抖音投放';
  const metrics = isXiaohongshu ? xiaohongshuMetrics : douyinMetrics;
  const trend = isXiaohongshu ? [48, 56, 52, 68, 74, 81, 88] : [62, 58, 71, 66, 79, 86, 92];
  const rows = isXiaohongshu ? [
    ['夏日冰爽新喝法', '生活方式', '68.4 万', '5.8%'],
    ['城市野餐打卡计划', '户外场景', '52.7 万', '6.3%'],
    ['与好友分享开心时刻', '情绪共鸣', '46.9 万', '4.9%']
  ] : [
    ['夏季新品信息流', '信息流', '¥128,600', '4.2'],
    ['美食场景达人合投', '达人营销', '¥98,400', '3.9'],
    ['品牌话题挑战赛', '品牌广告', '¥76,800', '3.5']
  ];

  return <main className="dashboard-page dashboard-detail-page"><div className="dashboard-page__inner">
    <header className="dashboard-detail-header"><button aria-label="返回数据看板" onClick={props.onBack} type="button"><ArrowLeft size={18} aria-hidden="true" /></button><div><span>{isXiaohongshu ? '内容运营详情' : '广告投放详情'}</span><h1>{title}</h1><p>近 7 天数据 · 更新于今日 09:30</p></div></header>
    <section className="dashboard-detail-metrics" aria-label={`${title}核心指标`}>{metrics.map(item => { const Icon = item.icon; return <article key={item.label}><Icon size={18} aria-hidden="true" /><span>{item.label}</span><strong>{item.value}</strong><small>{item.change}</small></article>; })}</section>
    <section className="dashboard-detail-panel"><header><div><span>TREND</span><h2>{isXiaohongshu ? '曝光与互动趋势' : '消耗与转化趋势'}</h2></div><small>近 7 天</small></header><div className="dashboard-detail-chart" aria-label="近 7 天趋势">{trend.map((value, index) => <div key={index}><i style={{ height: `${value}%` }} /><span>{index + 1}日</span></div>)}</div></section>
    <section className="dashboard-detail-panel"><header><div><span>PERFORMANCE</span><h2>{isXiaohongshu ? '热门笔记表现' : '投放计划表现'}</h2></div></header><div className="dashboard-detail-table"><div><span>{isXiaohongshu ? '笔记' : '计划'}</span><span>类型</span><span>{isXiaohongshu ? '曝光' : '消耗'}</span><span>{isXiaohongshu ? '互动率' : 'ROI'}</span></div>{rows.map(row => <div key={row[0]}>{row.map(value => <span key={value}>{value}</span>)}</div>)}</div></section>
  </div></main>;
}
