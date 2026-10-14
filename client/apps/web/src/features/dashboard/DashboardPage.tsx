import type { EnterpriseBilibiliDashboardRange, EnterpriseBilibiliDashboardResponse } from '@clawee/protocol';
import type { ThreadResponse } from '@clawee/protocol';
import { useEffect, useState } from 'react';
import { Activity, ChevronRight, Tv } from 'lucide-react';
import { ApiClientError } from '../../runtime/client.js';
import {
  BilibiliDashboardDetail,
  type BilibiliDashboardFilters,
  type BilibiliLoadState
} from './BilibiliDashboardDetail.js';
import './dashboard.css';
import './dashboard-layout.css';
import './workbench.css';
import { WorkbenchModuleLayout } from './WorkbenchModuleLayout.js';
import { WorkbenchConversationPanel } from './WorkbenchConversationPanel.js';
import { buildBilibiliModuleContext } from './workbench-module-context.js';
import type { WorkbenchConversationRuntime } from './use-workbench-conversation.js';

type DashboardDetailId = 'bilibili';
const workbenchCategories = [
  { id: 'data', label: '数据洞察' },
  { id: 'content', label: '内容创作' },
  { id: 'design', label: '素材设计' }
] as const;
type WorkbenchCategory = typeof workbenchCategories[number]['id'];
type DashboardEnterpriseService = {
  getBilibiliDashboard(input?: {
    range?: EnterpriseBilibiliDashboardRange;
    sourceId?: string;
  }): Promise<EnterpriseBilibiliDashboardResponse>;
};
type WorkbenchModule = {
  id: string; title: string; description: string; icon: typeof Tv;
  category: WorkbenchCategory; mode: 'read-only' | 'interactive' | 'planned';
  signal?: string; tone?: 'warning' | 'positive' | 'neutral';
};

const workbenchModules: WorkbenchModule[] = [
  { id: 'activity', title: 'Agent动态', description: '查看团队 Agent 的用量与执行情况', icon: Activity, category: 'data', mode: 'read-only' },
  { id: 'bilibili', title: '哔哩哔哩运营', description: '查看账号粉丝、稿件播放与互动表现', icon: Tv, category: 'data', mode: 'read-only', signal: '等待企业数据', tone: 'neutral' }
];

export function DashboardPage(props: {
  connected?: boolean;
  enterpriseSignedIn?: boolean;
  service?: DashboardEnterpriseService | null;
  onSessionExpired?(): void;
  onModuleOpenChange?(open: boolean): void;
  conversationRuntime?: WorkbenchConversationRuntime;
  onConversationCreated?(thread: ThreadResponse): void;
  activityAllowed?: boolean;
  onOpenActivity?(): void;
} = {}) {
  const [category, setCategory] = useState<WorkbenchCategory | 'all'>('all');
  const [detailId, setDetailId] = useState<DashboardDetailId>();
  const [bilibili, setBilibili] = useState<BilibiliLoadState>({ status: 'idle' });
  const [bilibiliFilters, setBilibiliFilters] = useState<BilibiliDashboardFilters>({ range: '7d' });
  const [bilibiliReload, setBilibiliReload] = useState(0);
  const [loadedSubjectId, setLoadedSubjectId] = useState<string>();
  const [conversationThreads, setConversationThreads] = useState<Record<string, string>>({});
  useEffect(() => {
    props.onModuleOpenChange?.(detailId !== undefined);
    return () => props.onModuleOpenChange?.(false);
  }, [detailId, props.onModuleOpenChange]);
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
        setLoadedSubjectId(props.conversationRuntime?.subjectId);
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
  }, [props.connected, props.enterpriseSignedIn, props.service, props.conversationRuntime?.subjectId, bilibiliFilters.range, bilibiliFilters.sourceId, bilibiliReload]);

  const bilibiliViewState: BilibiliLoadState = props.enterpriseSignedIn !== true ? { status: 'idle' }
    : bilibili.status === 'loaded' && (loadedSubjectId !== props.conversationRuntime?.subjectId
      || (bilibili.dashboard.range !== undefined && bilibili.dashboard.range !== bilibiliFilters.range)
      || (bilibiliFilters.sourceId !== undefined && bilibili.dashboard.account?.sourceId !== bilibiliFilters.sourceId))
      ? { status: 'loading' } : bilibili;

  const availableModules = workbenchModules.filter(module => (
    module.id !== 'activity' || props.activityAllowed === true
  ));
  const visibleModules = availableModules.filter(module => (
    category === 'all' || module.category === category
  )).map(module => {
    if (module.id !== 'bilibili') return module;
    const summary = bilibiliModuleSummary(bilibiliViewState, props);
    return {
      ...module,
      signal: summary.signal,
      tone: summary.tone
    };
  });
  const categoryLabel = category === 'all'
    ? '全部模块'
    : workbenchCategories.find(item => item.id === category)!.label;

  if (detailId === 'bilibili') {
    const context = buildBilibiliModuleContext(bilibiliViewState, bilibiliFilters);
    const scopeKey = JSON.stringify([context.moduleId, props.conversationRuntime?.subjectId,
      props.conversationRuntime?.project?.id, context.scopeKey]);
    const onBack = () => setDetailId(undefined);
    return <WorkbenchModuleLayout onBack={onBack} workspace={<BilibiliDashboardDetail
      state={bilibiliViewState} filters={bilibiliFilters} onBack={onBack}
      onRetry={() => setBilibiliReload(value => value + 1)} onFiltersChange={setBilibiliFilters}
    />} conversation={<WorkbenchConversationPanel key={scopeKey} context={context}
      runtime={props.conversationRuntime} threadId={conversationThreads[scopeKey]}
      onThreadCreated={thread => {
        setConversationThreads(previous => ({ ...previous, [scopeKey]: thread.id }));
        props.onConversationCreated?.(thread);
      }} />} />;
  }

  return <main className="dashboard-page workbench-page"><div className="dashboard-page__inner">
    <header className="dashboard-header">
      <div className="dashboard-title-row"><h1>工作台</h1></div>
    </header>
    <div className="workbench-categories" role="group" aria-label="模块分类">
      <button aria-pressed={category === 'all'} onClick={() => setCategory('all')} type="button">
        <span>全部</span><b>{availableModules.length}</b>
      </button>
      {workbenchCategories.map(item => (
        <button aria-pressed={category === item.id} key={item.id} onClick={() => setCategory(item.id)} type="button">
          <span>{item.label}</span><b>{availableModules.filter(module => module.category === item.id).length}</b>
        </button>
      ))}
    </div>
    <section className="dashboard-business" aria-label={categoryLabel}>
      {visibleModules.length === 0 ? (
        <div className="workbench-empty" role="status">
          <p>尚未接入{categoryLabel}模块</p>
          <span>新能力接入后会在这里展示。</span>
        </div>
      ) : <div className="dashboard-business-grid">{visibleModules.map(module => {
        const Icon = module.icon;
        const hasDetail = module.id === 'activity' || module.id === 'bilibili';
        const Tag = hasDetail ? 'button' : 'article';
        return <Tag className="dashboard-business-card" data-mode={module.mode} key={module.id} {...(hasDetail ? { 'aria-label': module.id === 'bilibili' ? `打开${module.title}详情看板` : `打开${module.title}模块`, onClick: () => module.id === 'activity' ? props.onOpenActivity?.() : setDetailId(module.id as DashboardDetailId), type: 'button' as const } : {})}>
          <div className="dashboard-business-card__heading">
            <span><Icon size={18} aria-hidden="true" /></span>
            <h3>{module.title}</h3>
            {hasDetail ? <ChevronRight className="workbench-card-chevron" size={18} aria-hidden="true" /> : <span className="workbench-card-planned">规划中</span>}
          </div>
          <p className="workbench-card-description">{module.description}</p>
          {module.signal ? <small data-tone={module.tone}>{module.signal}</small> : null}
        </Tag>;
      })}</div>}
    </section>
  </div></main>;
}

function bilibiliModuleSummary(
  state: BilibiliLoadState,
  props: { connected?: boolean; enterpriseSignedIn?: boolean }
): { signal: string; tone: WorkbenchModule['tone'] } {
  if (props.connected !== true) return { signal: '本地运行内核未连接', tone: 'warning' };
  if (props.enterpriseSignedIn !== true) return { signal: '登录企业账号后查看', tone: 'neutral' };
  if (state.status === 'loading') return { signal: '正在加载企业数据', tone: 'neutral' };
  if (state.status === 'error') return { signal: state.forbidden ? '当前账号无查看权限' : '企业数据加载失败', tone: 'warning' };
  if (state.status !== 'loaded') return { signal: '等待企业数据', tone: 'neutral' };
  if (state.dashboard.status === 'unconfigured') return { signal: '数据源尚未接入', tone: 'warning' };
  if (state.dashboard.status === 'unavailable' || state.dashboard.data === undefined) return { signal: '暂无可用采集数据', tone: 'warning' };
  return {
    signal: `已采集 ${formatInteger(state.dashboard.data.collectedContentCount)} 个稿件`,
    tone: 'positive'
  };
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}
