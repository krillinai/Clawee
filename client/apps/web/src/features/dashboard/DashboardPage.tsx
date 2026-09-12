import type { EnterpriseBilibiliDashboardRange, EnterpriseBilibiliDashboardResponse } from '@clawee/protocol';
import { useEffect, useState } from 'react';
import { Plus, Save, Sparkles, Tv, X } from 'lucide-react';
import { ApiClientError } from '../../runtime/client.js';
import {
  BilibiliDashboardDetail,
  type BilibiliDashboardFilters,
  type BilibiliLoadState
} from './BilibiliDashboardDetail.js';
import './dashboard.css';
import './dashboard-layout.css';

type DashboardRole = 'admin' | 'employee';
type DashboardDetailId = 'bilibili';
type DashboardEnterpriseService = {
  getBilibiliDashboard(input?: {
    range?: EnterpriseBilibiliDashboardRange;
    sourceId?: string;
  }): Promise<EnterpriseBilibiliDashboardResponse>;
};
type BusinessModule = {
  id: string; title: string; description: string; icon: typeof Tv;
  primaryLabel: string; primaryValue: string; secondaryLabel: string; secondaryValue: string;
  signal: string; tone: 'warning' | 'positive' | 'neutral'; scope: 'enterprise' | 'team' | 'personal';
};

const initialBusinessModules: BusinessModule[] = [
  { id: 'bilibili', title: '哔哩哔哩运营', description: '查看账号粉丝、稿件播放与互动表现', icon: Tv, primaryLabel: '当前粉丝', primaryValue: '-', secondaryLabel: '累计播放', secondaryValue: '-', signal: '等待企业数据', tone: 'neutral', scope: 'enterprise' }
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
  const [bilibiliFilters, setBilibiliFilters] = useState<BilibiliDashboardFilters>({ range: '7d' });
  const [bilibiliReload, setBilibiliReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ title: '', description: '' });
  const createDashboard = () => {
    if (!draft.title.trim()) return;
    setBusinessModules(items => [...items, { id: `custom-${items.length}`, title: draft.title.trim(), description: draft.description.trim() || '个人工作数据概览', icon: Sparkles, primaryLabel: '今日事项', primaryValue: '12', secondaryLabel: '已完成', secondaryValue: '8', signal: '仅当前用户可编辑', tone: 'neutral', scope: role === 'admin' ? 'enterprise' : 'personal' }]);
    setCreating(false); setDraft({ title: '', description: '' });
  };

  useEffect(() => {
    if (props.connected !== true || props.enterpriseSignedIn !== true || props.service === null || props.service === undefined) {
      setBilibili({ status: 'idle' });
      return;
    }
    let active = true;
    setBilibili({ status: 'loading' });
    void props.service.getBilibiliDashboard(bilibiliFilters)
      .then(dashboard => {
        if (!active) return;
        setBilibili({ status: 'loaded', dashboard });
        if (bilibiliFilters.sourceId === undefined && dashboard.account?.sourceId !== undefined) {
          setBilibiliFilters(current => ({ ...current, sourceId: dashboard.account?.sourceId }));
        }
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
  }, [props.connected, props.enterpriseSignedIn, props.service, bilibiliFilters.range, bilibiliFilters.sourceId, bilibiliReload]);

  const visibleModules = businessModules.map(module => (
    module.id === 'bilibili'
      ? { ...module, ...bilibiliModuleSummary(bilibili, props) }
      : module
  ));

  if (detailId === 'bilibili') return <BilibiliDashboardDetail
    state={bilibili}
    filters={bilibiliFilters}
    onBack={() => setDetailId(undefined)}
    onRetry={() => setBilibiliReload(value => value + 1)}
    onFiltersChange={setBilibiliFilters}
  />;

  return <main className="dashboard-page"><div className="dashboard-page__inner">
    <header className="dashboard-header"><div><div className="dashboard-title-row"><h1>数据看板</h1><span>企业数据</span></div><p>业务运营数据与关键指标概览</p></div><div className="dashboard-period"><span>统计周期</span><strong>近 7 天</strong></div></header>
    <div className="dashboard-notice" role="note">哔哩哔哩看板已连接企业服务</div>
    <section className="dashboard-business" aria-labelledby="dashboard-business-title">
      <header><div><span>BUSINESS INTELLIGENCE</span><h2 id="dashboard-business-title">业务洞察</h2></div><div className="dashboard-business-controls"><div className="dashboard-role-control" role="group" aria-label="看板权限视图"><button aria-pressed={role === 'admin'} onClick={() => setRole('admin')}>管理员</button><button aria-pressed={role === 'employee'} onClick={() => setRole('employee')}>员工</button></div><button className="dashboard-add-button" onClick={() => { setCreating(true); setDraft({ title: '', description: '' }); }}><Plus size={15} />创建看板</button></div></header>
      <div className="dashboard-permission-note" role="status">{role === 'admin' ? '管理员可创建企业与团队看板' : '员工可查看已授权看板，并创建个人看板'}</div>
      {creating ? <div className="dashboard-editor" aria-label="创建看板"><label>看板名称<input autoFocus value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder="例如：销售日报" /></label><label>用途说明<input value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder="这个看板用于查看什么" /></label><button onClick={createDashboard} disabled={!draft.title.trim()}><Save size={15}/>保存</button><button aria-label="取消创建" onClick={() => setCreating(false)}><X size={15}/></button></div> : null}
      <div className="dashboard-business-grid">{visibleModules.map(module => { const Icon = module.icon; const hasDetail = module.id === 'bilibili'; const Tag = hasDetail ? 'button' : 'article'; return <Tag className="dashboard-business-card" key={module.id} {...(hasDetail ? { 'aria-label': `打开${module.title}详情看板`, onClick: () => setDetailId('bilibili'), type: 'button' as const } : {})}>
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
  if (props.connected !== true) return { primaryValue: '-', secondaryValue: '-', signal: '本地运行内核未连接', tone: 'warning' };
  if (props.enterpriseSignedIn !== true) return { primaryValue: '-', secondaryValue: '-', signal: '登录企业账号后查看', tone: 'neutral' };
  if (state.status === 'loading') return { primaryValue: '-', secondaryValue: '-', signal: '正在加载企业数据', tone: 'neutral' };
  if (state.status === 'error') return { primaryValue: '-', secondaryValue: '-', signal: state.forbidden ? '当前账号无查看权限' : '企业数据加载失败', tone: 'warning' };
  if (state.status !== 'loaded') return { primaryValue: '-', secondaryValue: '-', signal: '等待企业数据', tone: 'neutral' };
  if (state.dashboard.status === 'unconfigured') return { primaryValue: '未配置', secondaryValue: '-', signal: '数据源尚未接入', tone: 'warning' };
  if (state.dashboard.status === 'unavailable' || state.dashboard.data === undefined) return { primaryValue: '待同步', secondaryValue: '-', signal: '暂无可用采集数据', tone: 'warning' };
  return {
    primaryValue: formatInteger(state.dashboard.data.followerCount),
    secondaryValue: formatInteger(state.dashboard.data.viewCount),
    signal: `已采集 ${formatInteger(state.dashboard.data.collectedContentCount)} 个稿件`,
    tone: 'positive'
  };
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}
