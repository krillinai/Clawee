import type {
  EnterpriseBilibiliDashboardRange,
  EnterpriseBilibiliDashboardResponse,
  EnterpriseBilibiliTopContent,
  EnterpriseBilibiliTrendPoint
} from '@clawee/protocol';
import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Bookmark,
  CalendarDays,
  Coins,
  Eye,
  ExternalLink,
  Heart,
  MessageCircle,
  MessageSquare,
  Radio,
  RefreshCw,
  Search,
  Share2,
  ThumbsUp,
  TrendingUp,
  UserPlus,
  Video
} from 'lucide-react';

export type BilibiliLoadState =
  | { status: 'idle' | 'loading' }
  | { status: 'loaded'; dashboard: EnterpriseBilibiliDashboardResponse }
  | { status: 'error'; forbidden: boolean };

export type BilibiliDashboardFilters = {
  range: EnterpriseBilibiliDashboardRange;
  sourceId?: string;
};

type TrendMetric = 'view' | 'interaction' | 'follower';
type ContentSort = 'view' | 'interaction' | 'engagement' | 'latest';

const contentDetailColumns = [
  { key: 'likeCount', label: '点赞' },
  { key: 'coinCount', label: '投币' },
  { key: 'favoriteCount', label: '收藏' },
  { key: 'replyCount', label: '评论' },
  { key: 'danmakuCount', label: '弹幕' },
  { key: 'shareCount', label: '分享' }
] as const;

const rangeLabels: Record<EnterpriseBilibiliDashboardRange, string> = {
  today: '今日',
  '7d': '近 7 天',
  '30d': '近 30 天'
};

export function BilibiliDashboardDetail(props: {
  state: BilibiliLoadState;
  filters: BilibiliDashboardFilters;
  onBack(): void;
  onRetry(): void;
  onFiltersChange(filters: BilibiliDashboardFilters): void;
}) {
  const dashboard = props.state.status === 'loaded' ? props.state.dashboard : undefined;
  const data = dashboard !== undefined
    && (dashboard.status === 'available' || dashboard.status === 'partial')
    ? dashboard.data
    : undefined;
  const account = dashboard?.account;
  const sources = dashboard?.sources ?? [];
  const selectedSourceId = props.filters.sourceId ?? account?.sourceId ?? '';

  return <main className="dashboard-page dashboard-detail-page"><div className="dashboard-page__inner dashboard-detail-inner">
    <header className="dashboard-detail-header dashboard-detail-header--complete">
      <button aria-label="返回数据看板" onClick={props.onBack} type="button"><ArrowLeft size={18} aria-hidden="true" /></button>
      <div className="dashboard-detail-heading">
        <span>内容运营</span>
        <div><h1>哔哩哔哩数据洞察</h1>{dashboard?.status === 'partial' ? <em>部分数据</em> : null}</div>
        <p>{account?.name ?? '企业业务数据'}{data === undefined ? '' : `，更新于 ${formatDateTime(dashboard?.lastSyncedAt ?? data.capturedAt)}`}</p>
      </div>
      <div className="dashboard-detail-toolbar">
        {sources.length > 0 ? <label className="dashboard-filter-field"><span>账号</span><select aria-label="哔哩哔哩账号" value={selectedSourceId} onChange={event => props.onFiltersChange({ ...props.filters, sourceId: event.target.value })}>{sources.map(source => <option key={source.sourceId} value={source.sourceId}>{source.name}{source.status === 'disabled' ? '（已停用）' : ''}</option>)}</select></label> : null}
        <div className="dashboard-range-filter" role="group" aria-label="统计周期">{(['today', '7d', '30d'] as const).map(range => <button type="button" key={range} aria-pressed={props.filters.range === range} onClick={() => props.onFiltersChange({ ...props.filters, range })}>{rangeLabels[range]}</button>)}</div>
        <button className="dashboard-refresh-button" type="button" aria-label="刷新哔哩哔哩数据" title="刷新数据" onClick={props.onRetry}><RefreshCw size={16} aria-hidden="true" /></button>
      </div>
    </header>

    {dashboard === undefined || data === undefined ? <BilibiliDashboardState state={props.state} onRetry={props.onRetry} /> : <DashboardContent dashboard={dashboard} fallbackRange={props.filters.range} />}
  </div></main>;
}

function DashboardContent(props: {
  dashboard: EnterpriseBilibiliDashboardResponse;
  fallbackRange: EnterpriseBilibiliDashboardRange;
}) {
  const data = props.dashboard.data;
  if (data === undefined) return null;
  const trend = normalizeLegacyTrend(data.trend ?? []);
  const topContents = data.topContents ?? [];
  const range = props.dashboard.range ?? props.fallbackRange;
  const unavailableParts = props.dashboard.unavailableParts ?? [];
  const deltas = summarizeTrend(trend);
  const engagementRate = ratio(data.interactionCount, data.viewCount);
  const averageViews = data.collectedContentCount === 0 ? 0 : data.viewCount / data.collectedContentCount;
  const bestInteraction = [...topContents].sort((left, right) => right.interactionCount - left.interactionCount)[0];

  const metrics: Array<{ label: string; value?: number; percent?: boolean; delta: string; icon: typeof UserPlus }> = [
    { label: '当前粉丝', value: data.followerCount, delta: `${formatSigned(deltas.follower)} 周期增长`, icon: UserPlus },
    { label: '累计播放', value: data.viewCount, delta: `${formatSigned(deltas.view)} 周期增长`, icon: Eye },
    { label: '累计互动', value: data.interactionCount, delta: `${formatSigned(deltas.interaction)} 周期增长`, icon: Heart },
    { label: '整体互动率', value: engagementRate, percent: true, delta: '互动量 / 播放量', icon: TrendingUp },
    { label: '累计投稿', value: data.publishedCount, delta: data.publishedCount === undefined ? '当前服务未提供' : `已采集 ${formatInteger(data.collectedContentCount)} 个`, icon: Video },
    { label: '单稿平均播放', value: averageViews, delta: '基于已采集稿件', icon: BarChart3 }
  ];

  return <>
    {props.dashboard.status === 'partial' || unavailableParts.length > 0 ? <div className="dashboard-partial-notice" role="status"><Radio size={15} aria-hidden="true" /><span>部分数据暂不可用{unavailableParts.length > 0 ? `：${unavailableParts.join('、')}` : ''}</span></div> : null}

    <section className="dashboard-detail-metrics dashboard-detail-metrics--complete" aria-label="哔哩哔哩运营核心指标">{metrics.map(item => { const Icon = item.icon; return <article key={item.label}>
      <div><Icon size={17} aria-hidden="true" /><span>{item.label}</span></div>
      <strong title={item.value === undefined ? undefined : item.percent ? formatPercent(item.value) : formatInteger(item.value)}>{item.value === undefined ? '暂无' : item.percent ? formatPercent(item.value) : formatCompactNumber(item.value)}</strong>
      <small data-direction={metricDirection(item.delta)}>{item.delta}</small>
    </article>; })}</section>

    <section className="dashboard-operational-strip" aria-label="运营摘要">
      <div><span>统计区间</span><strong>{formatDateRange(props.dashboard.startDate, props.dashboard.endDate, range)}</strong><small>{props.dashboard.timezone ?? 'Asia/Shanghai'}</small></div>
      <div><span>周期新增播放</span><strong>{formatSigned(deltas.view)}</strong><small>{formatSigned(deltas.interaction)} 次新增互动</small></div>
      <div><span>互动领先稿件</span><strong title={bestInteraction?.title}>{bestInteraction?.title || '暂无稿件'}</strong><small>{bestInteraction === undefined ? '等待采集' : `${formatInteger(bestInteraction.interactionCount)} 次互动`}</small></div>
    </section>

    <div className="dashboard-analytics-grid">
      <TrendPanel trend={trend} range={range} />
      <InteractionBreakdown data={data} />
    </div>

    <ContentPerformanceTable contents={topContents} total={data.collectedContentCount} />
  </>;
}

function TrendPanel(props: { trend: EnterpriseBilibiliTrendPoint[]; range: EnterpriseBilibiliDashboardRange }) {
  const [metric, setMetric] = useState<TrendMetric>('view');
  const values = props.trend.map(point => trendValue(point, metric));
  const [activeIndex, setActiveIndex] = useState(Math.max(0, values.length - 1));
  const currentIndex = Math.min(activeIndex, Math.max(0, values.length - 1));
  const current = props.trend[currentIndex];
  const chart = chartGeometry(values);
  const metricLabel = metric === 'view' ? '新增播放' : metric === 'interaction' ? '新增互动' : '新增粉丝';

  return <section className="dashboard-detail-panel dashboard-trend-panel">
    <header><div><h2>增长趋势</h2><p>{rangeLabels[props.range]}每日增量</p></div><div className="dashboard-metric-filter" role="group" aria-label="趋势指标">{([
      ['view', '播放'], ['interaction', '互动'], ['follower', '粉丝']
    ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={metric === value} onClick={() => { setMetric(value); setActiveIndex(Math.max(0, props.trend.length - 1)); }}>{label}</button>)}</div></header>
    {props.trend.length === 0 ? <div className="dashboard-detail-empty">当前周期暂无趋势数据</div> : <figure className="dashboard-trend-figure">
      <div className="dashboard-trend-current"><span>{current === undefined ? metricLabel : formatChartDate(current.date)} {metricLabel}</span><strong>{formatSigned(current === undefined ? 0 : trendValue(current, metric))}</strong></div>
      <svg viewBox="0 0 720 240" preserveAspectRatio="none" role="img" aria-label={`${metricLabel}趋势图`}>
        <line className="dashboard-chart-axis" x1="48" y1={chart.zeroY} x2="704" y2={chart.zeroY} />
        <path className="dashboard-chart-area" d={chart.areaPath} />
        <path className="dashboard-chart-line" d={chart.linePath} />
        {chart.points.map((point, index) => <g key={`${props.trend[index]?.date ?? index}-${metric}`} role="button" tabIndex={0} aria-label={`${props.trend[index]?.date ?? ''} ${formatSigned(values[index] ?? 0)}`} onMouseEnter={() => setActiveIndex(index)} onFocus={() => setActiveIndex(index)}>
          {index === currentIndex ? <line className="dashboard-chart-guide" x1={point.x} y1="16" x2={point.x} y2="214" /> : null}
          <circle className="dashboard-chart-hit" cx={point.x} cy={point.y} r="12" />
          <circle className="dashboard-chart-point" data-active={index === currentIndex} cx={point.x} cy={point.y} r={index === currentIndex ? 4 : 2.5} />
          <title>{props.trend[index]?.date}: {formatInteger(values[index] ?? 0)}</title>
        </g>)}
        {chart.max === 0 ? null : <text x="8" y="22">{formatCompactNumber(chart.max)}</text>}
        <text x="8" y={Math.min(232, chart.zeroY + 4)}>0</text>
      </svg>
      <figcaption><span>{formatChartDate(props.trend[0]?.date ?? '')}</span>{props.trend.length > 2 ? <span>{formatChartDate(props.trend[Math.floor(props.trend.length / 2)]?.date ?? '')}</span> : null}<span>{formatChartDate(props.trend.at(-1)?.date ?? '')}</span></figcaption>
    </figure>}
  </section>;
}

function InteractionBreakdown(props: { data: NonNullable<EnterpriseBilibiliDashboardResponse['data']> }) {
  const items = [
    { label: '点赞', value: props.data.likeCount, icon: ThumbsUp },
    { label: '投币', value: props.data.coinCount, icon: Coins },
    { label: '收藏', value: props.data.favoriteCount, icon: Bookmark },
    { label: '评论', value: props.data.replyCount, icon: MessageCircle },
    { label: '弹幕', value: props.data.danmakuCount, icon: MessageSquare },
    { label: '分享', value: props.data.shareCount, icon: Share2 }
  ];
  const detailedAvailable = items.some(item => item.value !== undefined);
  const detailedTotal = items.reduce((sum, item) => sum + (item.value ?? 0), 0);
  return <section className="dashboard-detail-panel dashboard-interaction-panel">
    <header><div><h2>互动构成</h2><p>最新稿件快照汇总</p></div><strong>{formatCompactNumber(props.data.interactionCount)}</strong></header>
    {!detailedAvailable ? <div className="dashboard-detail-empty">当前服务暂未提供细分互动</div> : detailedTotal === 0 ? <div className="dashboard-detail-empty">当前稿件没有细分互动</div> : <div className="dashboard-interaction-list">{items.map(item => { const Icon = item.icon; const value = item.value ?? 0; const share = ratio(value, detailedTotal); return <div key={item.label}>
      <span><Icon size={14} aria-hidden="true" />{item.label}</span>
      <div><i style={{ width: `${Math.max(2, share * 100)}%` }} /></div>
      <strong>{item.value === undefined ? '-' : formatCompactNumber(value)}</strong>
      <small>{item.value === undefined ? '-' : formatPercent(share)}</small>
    </div>; })}</div>}
  </section>;
}

function ContentPerformanceTable(props: { contents: EnterpriseBilibiliTopContent[]; total: number }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ContentSort>('view');
  const contents = useMemo(() => props.contents
    .filter(item => item.title.toLocaleLowerCase('zh-CN').includes(query.trim().toLocaleLowerCase('zh-CN')))
    .sort((left, right) => {
      if (sort === 'latest') return publishedAtTimestamp(right.publishedAt) - publishedAtTimestamp(left.publishedAt);
      if (sort === 'interaction') return right.interactionCount - left.interactionCount;
      if (sort === 'engagement') return ratio(right.interactionCount, right.viewCount) - ratio(left.interactionCount, left.viewCount);
      return right.viewCount - left.viewCount;
    }), [props.contents, query, sort]);
  const detailColumns = contentDetailColumns.filter(column =>
    props.contents.some(item => item[column.key] !== undefined)
  );

  return <section className="dashboard-detail-panel dashboard-content-panel">
    <header><div><h2>稿件表现</h2><p>展示播放 Top {formatInteger(props.contents.length)}，共采集 {formatInteger(props.total)} 个稿件</p></div><div className="dashboard-table-tools">
      <label className="dashboard-search-field"><Search size={14} aria-hidden="true" /><span className="sr-only">搜索稿件</span><input type="search" aria-label="搜索稿件" placeholder="搜索稿件标题" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label className="dashboard-sort-field"><span className="sr-only">稿件排序</span><select aria-label="稿件排序" value={sort} onChange={event => setSort(event.target.value as ContentSort)}><option value="view">按播放排序</option><option value="latest">按最新排序</option><option value="interaction">按互动排序</option><option value="engagement">按互动率排序</option></select></label>
    </div></header>
    {contents.length === 0 ? <div className="dashboard-detail-empty">{query.trim() ? '没有匹配的稿件' : '暂无稿件数据'}</div> : <div className="dashboard-content-table-wrap"><table className="dashboard-content-table" data-has-details={detailColumns.length > 0}>
      <caption className="sr-only">哔哩哔哩稿件表现明细</caption>
      <thead><tr><th>稿件</th><th>发布日期</th><th>播放</th>{detailColumns.map(column => <th key={column.key}>{column.label}</th>)}<th>总互动</th><th>互动率</th></tr></thead>
      <tbody>{contents.map(item => <tr key={`${item.sourceId}-${item.externalContentId}`}>
        <td><a className="dashboard-content-link" href={bilibiliVideoUrl(item.externalContentId)} target="_blank" rel="noreferrer"><strong title={item.title || '未命名稿件'}>{item.title || '未命名稿件'}</strong><ExternalLink size={12} aria-hidden="true" /></a></td>
        <td>{item.publishedAt === undefined ? '-' : formatDate(item.publishedAt)}</td>
        <td>{formatInteger(item.viewCount)}</td>{detailColumns.map(column => <td key={column.key}>{formatOptionalInteger(item[column.key])}</td>)}<td>{formatInteger(item.interactionCount)}</td><td>{formatPercent(ratio(item.interactionCount, item.viewCount))}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

function BilibiliDashboardState(props: { state: BilibiliLoadState; onRetry(): void }) {
  if (props.state.status === 'loading') return <section className="dashboard-detail-loading" role="status" aria-label="正在加载哔哩哔哩数据">
    <div className="dashboard-loading-metrics">{Array.from({ length: 8 }, (_, index) => <i key={index} />)}</div>
    <div className="dashboard-loading-panels"><i /><i /></div>
  </section>;
  let title = '企业数据暂不可用';
  let message = '请确认本地运行内核已连接并登录企业账号。';
  if (props.state.status === 'error') {
    title = props.state.forbidden ? '暂无查看权限' : '哔哩哔哩数据加载失败';
    message = props.state.forbidden ? '请联系管理员开通哔哩哔哩运营数据权限。' : '企业服务暂时无法返回数据，请稍后重试。';
  } else if (props.state.status === 'loaded') {
    title = props.state.dashboard.status === 'unconfigured' ? '数据源尚未接入' : '暂无可用采集数据';
    message = props.state.dashboard.status === 'unconfigured' ? '请先在企业管理端完成哔哩哔哩账号接入。' : '数据源已启用，但还没有成功同步的数据。';
  }
  return <section className="dashboard-detail-state" role={props.state.status === 'error' ? 'alert' : 'status'}><Video size={22} aria-hidden="true" /><h2>{title}</h2><p>{message}</p>{props.state.status === 'error' && !props.state.forbidden ? <button type="button" onClick={props.onRetry}><RefreshCw size={15} aria-hidden="true" />重试</button> : null}</section>;
}

function summarizeTrend(trend: EnterpriseBilibiliTrendPoint[]) {
  return trend.reduce((summary, point) => ({
    follower: summary.follower + point.followerCountDelta,
    view: summary.view + point.viewCountDelta,
    interaction: summary.interaction + point.interactionCountDelta
  }), { follower: 0, view: 0, interaction: 0 });
}

function normalizeLegacyTrend(trend: EnterpriseBilibiliTrendPoint[]): EnterpriseBilibiliTrendPoint[] {
  return trend.map((point, index) => {
    const previous = trend[index - 1];
    if (previous === undefined) return point;
    return {
      ...point,
      followerCountDelta: normalizeLegacyDelta(previous.followerCount, point.followerCount, point.followerCountDelta),
      viewCountDelta: normalizeLegacyDelta(previous.viewCount, point.viewCount, point.viewCountDelta),
      interactionCountDelta: normalizeLegacyDelta(previous.interactionCount, point.interactionCount, point.interactionCountDelta)
    };
  });
}

function normalizeLegacyDelta(previousTotal: number, currentTotal: number, delta: number): number {
  return previousTotal === 0 && currentTotal > 0 && delta === currentTotal ? 0 : delta;
}

function trendValue(point: EnterpriseBilibiliTrendPoint, metric: TrendMetric): number {
  if (metric === 'follower') return point.followerCountDelta;
  if (metric === 'interaction') return point.interactionCountDelta;
  return point.viewCountDelta;
}

function chartGeometry(values: number[]) {
  const width = 656;
  const height = 198;
  const left = 48;
  const top = 16;
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const scaleMax = max === min ? max + 1 : max;
  const span = Math.max(1, scaleMax - min);
  const pointAt = (value: number, index: number) => ({
    x: left + (values.length <= 1 ? width / 2 : index * width / (values.length - 1)),
    y: top + (scaleMax - value) / span * height
  });
  const points = values.map(pointAt);
  const zeroY = top + scaleMax / span * height;
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const areaPath = points.length === 0 ? '' : `${linePath} L ${points.at(-1)?.x ?? left} ${zeroY} L ${points[0]?.x ?? left} ${zeroY} Z`;
  return { points, zeroY, linePath, areaPath, max };
}

function ratio(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : numerator / denominator;
}

function publishedAtTimestamp(value: string | undefined): number {
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

function metricDirection(value: string): 'positive' | 'negative' | 'neutral' {
  if (value.startsWith('+')) return 'positive';
  if (value.startsWith('-')) return 'negative';
  return 'neutral';
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

function formatOptionalInteger(value: number | undefined): string {
  return value === undefined ? '-' : formatInteger(value);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatSigned(value: number): string {
  return `${value > 0 ? '+' : ''}${formatInteger(value)}`;
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 }).format(value);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(date);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(date);
}

function bilibiliVideoUrl(externalContentId: string): string {
  return `https://www.bilibili.com/video/${encodeURIComponent(externalContentId)}`;
}

function formatChartDate(value: string): string {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai' }).format(date);
}

function formatDateRange(start: string | undefined, end: string | undefined, range: EnterpriseBilibiliDashboardRange): string {
  if (start === undefined || end === undefined) return rangeLabels[range];
  return `${formatChartDate(start)} 至 ${formatChartDate(end)}`;
}
