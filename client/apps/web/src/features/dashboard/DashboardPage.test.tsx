import type { EnterpriseBilibiliDashboardResponse } from '@clawee/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../runtime/client.js';
import { DashboardPage } from './DashboardPage.js';
import type { WorkbenchConversationRuntime } from './use-workbench-conversation.js';

function bilibiliDashboard(
  status: 'available' | 'partial' = 'available'
): EnterpriseBilibiliDashboardResponse {
  return {
    status,
    account: {
      sourceId: 'bdsrc_1',
      name: '品牌官方账号',
      status: 'active',
      statusReason: '',
      lastSuccessAt: '2026-08-30T01:30:00Z'
    },
    range: '7d',
    timezone: 'Asia/Shanghai',
    startDate: '2026-08-24',
    endDate: '2026-08-30',
    generatedAt: '2026-08-30T01:31:00Z',
    lastSyncedAt: '2026-08-30T01:30:00Z',
    unavailableParts: status === 'partial' ? ['历史互动明细'] : [],
    sources: [{
      sourceId: 'bdsrc_1',
      name: '品牌官方账号',
      status: 'active',
      statusReason: '',
      lastSuccessAt: '2026-08-30T01:30:00Z'
    }],
    data: {
      capturedAt: '2026-08-30T01:30:00Z',
      followerCount: 128_600,
      followingCount: 86,
      publishedCount: 30,
      collectedContentCount: 24,
      viewCount: 8_650_000,
      danmakuCount: 12_800,
      replyCount: 9_600,
      favoriteCount: 48_000,
      coinCount: 32_000,
      shareCount: 6_400,
      likeCount: 208_000,
      interactionCount: 316_800,
      trend: [
        { date: '2026-08-24', followerCount: 127_900, viewCount: 8_480_000, interactionCount: 307_000, followerCountDelta: 100, viewCountDelta: 20_000, interactionCountDelta: 1_200 },
        { date: '2026-08-30', followerCount: 128_600, viewCount: 8_650_000, interactionCount: 316_800, followerCountDelta: 700, viewCountDelta: 170_000, interactionCountDelta: 9_800 }
      ],
      topContents: [{
        sourceId: 'bdsrc_1',
        accountName: '品牌官方账号',
        externalContentId: 'BV1test',
        title: '夏日新品开箱',
        publishedAt: '2026-08-26T03:00:00Z',
        status: '0',
        capturedAt: '2026-08-30T01:20:00Z',
        viewCount: 680_000,
        danmakuCount: 1_100,
        replyCount: 800,
        favoriteCount: 4_200,
        coinCount: 3_100,
        shareCount: 600,
        likeCount: 18_800,
        interactionCount: 28_600
      }]
    }
  };
}

describe('DashboardPage', () => {
  it('masks the previous enterprise account data while a new user snapshot is loading', async () => {
    const user = userEvent.setup();
    let resolveDashboard!: (dashboard: EnterpriseBilibiliDashboardResponse) => void;
    const service = { getBilibiliDashboard: vi.fn(async () => bilibiliDashboard()) };
    const runtime: WorkbenchConversationRuntime = {
      client: null, connection: null, connected: false, subjectId: 'member_1',
      config: { permission: 'workspace-write', profile: 'default', model: null, reasoning: null }
    };
    const view = render(<DashboardPage connected enterpriseSignedIn service={service} conversationRuntime={runtime} />);
    await screen.findByText('已采集 24 个稿件');
    await user.click(screen.getByRole('button', { name: '打开哔哩哔哩运营详情看板' }));
    expect(screen.getByText('品牌官方账号 · 近 7 天')).toBeInTheDocument();
    service.getBilibiliDashboard.mockImplementation(() => new Promise(resolve => { resolveDashboard = resolve; }));
    view.rerender(<DashboardPage connected enterpriseSignedIn service={service}
      conversationRuntime={{ ...runtime, subjectId: 'member_2' }} />);
    expect(screen.queryByText('品牌官方账号 · 近 7 天')).not.toBeInTheDocument();
    expect(screen.queryByText('夏日新品开箱')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '输入任务' })).toBeDisabled();
    await waitFor(() => expect(resolveDashboard).toBeDefined());
    const next = bilibiliDashboard();
    next.account!.name = '新用户账号';
    await act(async () => { resolveDashboard(next); });
    expect(await screen.findByText('新用户账号 · 近 7 天')).toBeInTheDocument();
  });

  it('shows available modules with concise summaries', () => {
    render(<DashboardPage />);
    expect(screen.getByRole('heading', { name: '工作台' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '全部模块' })).toBeInTheDocument();
    const categories = screen.getByRole('group', { name: '模块分类' });
    expect(within(categories).getAllByRole('button').map(button => button.textContent)).toEqual([
      '全部1', '数据洞察1', '内容创作0', '素材设计0'
    ]);
    expect(within(categories).getByRole('button', { name: /^全部/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('打开模块')).not.toBeInTheDocument();
    for (const name of ['趋势洞察', '客户转化', '视频翻译', '竞品洞察', '客户管理', '小红书运营', '抖音投放']) {
      expect(screen.queryByRole('heading', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /^编辑/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '哔哩哔哩运营' })).toBeInTheDocument();
    expect(screen.queryByText('哔哩哔哩看板已连接企业服务')).not.toBeInTheDocument();
    expect(screen.getByText('本地运行内核未连接')).toBeInTheDocument();
    expect(screen.queryByText('总 Token')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Agent 运行' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '知识资产' })).not.toBeInTheDocument();
  });

  it('shows Agent activity first only when access is allowed and opens its existing route', async () => {
    const onOpenActivity = vi.fn();
    const user = userEvent.setup();
    const view = render(<DashboardPage activityAllowed={false} onOpenActivity={onOpenActivity} />);
    expect(screen.queryByRole('button', { name: '打开Agent动态模块' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: '模块分类' })).getByRole('button', { name: /^全部/ })).toHaveTextContent('全部1');

    view.rerender(<DashboardPage activityAllowed onOpenActivity={onOpenActivity} />);
    const activityCard = screen.getByRole('button', { name: '打开Agent动态模块' });
    expect(screen.getByRole('heading', { name: 'Agent动态' })).toBeInTheDocument();
    expect(activityCard).toBe(screen.getByRole('button', { name: '打开哔哩哔哩运营详情看板' }).previousElementSibling);
    expect(within(screen.getByRole('group', { name: '模块分类' })).getByRole('button', { name: /^全部/ })).toHaveTextContent('全部2');
    expect(within(screen.getByRole('group', { name: '模块分类' })).getByRole('button', { name: /^数据洞察/ })).toHaveTextContent('数据洞察2');
    await user.click(activityCard);
    expect(onOpenActivity).toHaveBeenCalledOnce();
  });

  it('keeps module cards simple while preserving live enterprise status', async () => {
    const service = { getBilibiliDashboard: vi.fn().mockResolvedValue(bilibiliDashboard()) };
    render(<DashboardPage connected enterpriseSignedIn service={service} />);
    const bilibiliCard = screen.getByRole('button', { name: '打开哔哩哔哩运营详情看板' });
    expect(within(bilibiliCard).getByRole('heading')).toBeInTheDocument();
    expect(bilibiliCard.querySelector('dl')).not.toBeInTheDocument();
    expect(within(bilibiliCard).queryByText('打开模块')).not.toBeInTheDocument();
    expect(await within(bilibiliCard).findByText('已采集 24 个稿件')).toBeInTheDocument();
    expect(within(bilibiliCard).queryByText('128,600')).not.toBeInTheDocument();
  });

  it('filters module categories and shows empty states without placeholder tools', async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    const categories = screen.getByRole('group', { name: '模块分类' });

    await user.click(within(categories).getByRole('button', { name: /^内容创作/ }));
    expect(screen.getByRole('region', { name: '内容创作' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('尚未接入内容创作模块');
    expect(screen.queryByRole('heading', { name: '视频翻译' })).not.toBeInTheDocument();
    await user.click(within(categories).getByRole('button', { name: /^素材设计/ }));
    expect(screen.getByRole('region', { name: '素材设计' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('尚未接入素材设计模块');
    expect(screen.queryByRole('button', { name: /开始创作|开始设计/ })).not.toBeInTheDocument();

    await user.click(within(categories).getByRole('button', { name: /^数据洞察/ }));
    expect(screen.getByRole('region', { name: '数据洞察' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开哔哩哔哩运营详情看板' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await user.click(within(categories).getByRole('button', { name: /^全部/ }));
    expect(screen.getByRole('region', { name: '全部模块' })).toBeInTheDocument();
  });

  it('returns from a read-only module to the selected workbench category', async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(screen.getByRole('button', { name: /^数据洞察/ }));
    await user.click(screen.getByRole('button', { name: '打开哔哩哔哩运营详情看板' }));
    await user.click(screen.getByRole('button', { name: '返回工作台' }));
    expect(screen.getByRole('heading', { name: '工作台' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^数据洞察/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('loads the enterprise Bilibili summary and opens its real dashboard', async () => {
    const user = userEvent.setup();
    render(<DashboardPage
      connected
      enterpriseSignedIn
      service={{
        getBilibiliDashboard: async () => bilibiliDashboard()
      }}
    />);

    expect(await screen.findByText('已采集 24 个稿件')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开哔哩哔哩运营详情看板' }));
    expect(screen.getByText('当前粉丝')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '哔哩哔哩数据洞察' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '增长趋势' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '互动构成' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '稿件表现' })).toBeInTheDocument();
    expect(screen.getAllByText('夏日新品开箱')).toHaveLength(2);
    const contentTable = screen.getByRole('table', { name: '哔哩哔哩稿件表现明细' });
    expect(within(contentTable).getByRole('columnheader', { name: '发布日期' })).toBeInTheDocument();
    expect(within(contentTable).getByText('2026/08/26')).toBeInTheDocument();
    expect(within(contentTable).queryByText('BV1test')).not.toBeInTheDocument();
    expect(within(contentTable).getByRole('link', { name: '夏日新品开箱' })).toHaveAttribute(
      'href',
      'https://www.bilibili.com/video/BV1test'
    );
    expect(within(contentTable).getByRole('link', { name: '夏日新品开箱' })).toHaveAttribute('target', '_blank');
    expect(screen.getByText('整体互动率')).toBeInTheDocument();
    for (const label of ['采集覆盖率', '账号关注数', '数据新鲜度']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.getByText('20.8万')).toBeInTheDocument();
  });

  it('sorts published content from newest to oldest and places undated content last', async () => {
    const user = userEvent.setup();
    const dashboard = bilibiliDashboard();
    const base = dashboard.data!.topContents[0]!;
    dashboard.data!.topContents = [
      { ...base, externalContentId: 'BV1old', title: '较早稿件', publishedAt: '2026-08-20T03:00:00Z' },
      { ...base, externalContentId: 'BV1undated', title: '无日期稿件', publishedAt: undefined },
      { ...base, externalContentId: 'BV1new', title: '最新稿件', publishedAt: '2026-08-29T03:00:00Z' }
    ];
    render(<DashboardPage connected enterpriseSignedIn service={{ getBilibiliDashboard: async () => dashboard }} />);

    await screen.findByText('已采集 24 个稿件');
    await user.click(screen.getByRole('button', { name: '打开哔哩哔哩运营详情看板' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '稿件排序' }), 'latest');

    const rows = within(screen.getByRole('table', { name: '哔哩哔哩稿件表现明细' })).getAllByRole('row');
    expect(rows.slice(1).map(row => within(row).getByRole('link').textContent)).toEqual([
      '最新稿件',
      '较早稿件',
      '无日期稿件'
    ]);
  });

  it('opens safely while the running daemon still returns the legacy dashboard shape', async () => {
    const user = userEvent.setup();
    const legacyDashboard = {
      status: 'available',
      data: {
        capturedAt: '2026-08-30T01:30:00Z',
        followerCount: 128_600,
        collectedContentCount: 1,
        viewCount: 680_000,
        interactionCount: 28_600,
        topContents: [{
          externalContentId: 'BV1legacy',
          title: '旧版采集稿件',
          capturedAt: '2026-08-30T01:20:00Z',
          viewCount: 680_000,
          interactionCount: 28_600
        }]
      }
    } as unknown as EnterpriseBilibiliDashboardResponse;
    render(<DashboardPage connected enterpriseSignedIn service={{
      getBilibiliDashboard: async () => legacyDashboard
    }} />);

    await screen.findByText('已采集 1 个稿件');
    await user.click(screen.getByRole('button', { name: '打开哔哩哔哩运营详情看板' }));
    expect(screen.getByRole('heading', { name: '哔哩哔哩数据洞察' })).toBeInTheDocument();
    expect(screen.getByText('当前周期暂无趋势数据')).toBeInTheDocument();
    expect(screen.getByText('当前服务暂未提供细分互动')).toBeInTheDocument();
    expect(screen.getAllByText('旧版采集稿件')).toHaveLength(2);
    const table = screen.getByRole('table', { name: '哔哩哔哩稿件表现明细' });
    expect(within(table).getByRole('columnheader', { name: '播放' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: '发布日期' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: '总互动' })).toBeInTheDocument();
    expect(within(table).queryByText('BV1legacy')).not.toBeInTheDocument();
    expect(within(table).getByRole('link', { name: '旧版采集稿件' })).toHaveAttribute(
      'href',
      'https://www.bilibili.com/video/BV1legacy'
    );
    expect(within(table).queryByRole('columnheader', { name: '点赞' })).not.toBeInTheDocument();
  });

  it('does not report the first cumulative snapshot as a growth spike from legacy gateways', async () => {
    const user = userEvent.setup();
    const dashboard = bilibiliDashboard();
    dashboard.range = '30d';
    dashboard.data!.viewCount = 8_260_000;
    dashboard.data!.interactionCount = 144_000;
    dashboard.data!.trend = [
      { date: '2026-08-14', followerCount: 0, viewCount: 0, interactionCount: 0, followerCountDelta: 0, viewCountDelta: 0, interactionCountDelta: 0 },
      { date: '2026-09-01', followerCount: 1_000, viewCount: 8_260_000, interactionCount: 144_000, followerCountDelta: 1_000, viewCountDelta: 8_260_000, interactionCountDelta: 144_000 },
      { date: '2026-09-12', followerCount: 1_000, viewCount: 8_260_000, interactionCount: 144_000, followerCountDelta: 0, viewCountDelta: 0, interactionCountDelta: 0 }
    ];
    render(<DashboardPage connected enterpriseSignedIn service={{
      getBilibiliDashboard: async filters => ({ ...dashboard, range: filters?.range ?? '7d' })
    }} />);

    await screen.findByText('已采集 24 个稿件');
    await user.click(screen.getByRole('button', { name: '打开哔哩哔哩运营详情看板' }));
    expect(screen.getByRole('button', { name: '2026-09-01 0' })).toBeInTheDocument();
    expect(screen.queryByText('+8,260,000')).not.toBeInTheDocument();
  });

  it('shows the Bilibili permission state without exposing placeholder data', async () => {
    const user = userEvent.setup();
    render(<DashboardPage
      connected
      enterpriseSignedIn
      service={{
        getBilibiliDashboard: async () => {
          throw new ApiClientError({
            status: 403,
            code: 'ENTERPRISE_DATA_VIEW_FORBIDDEN',
            message: 'forbidden'
          });
        }
      }}
    />);

    expect(await screen.findByText('当前账号无查看权限')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开哔哩哔哩运营详情看板' }));
    expect(screen.getByRole('heading', { name: '暂无查看权限' })).toBeInTheDocument();
    expect(screen.getByText('请联系管理员开通哔哩哔哩运营数据权限。')).toBeInTheDocument();
  });

  it('renders available metrics from a partially synchronized Bilibili dashboard', async () => {
    const user = userEvent.setup();
    render(<DashboardPage
      connected
      enterpriseSignedIn
      service={{
        getBilibiliDashboard: async () => ({
          ...bilibiliDashboard('partial'),
          data: {
            ...bilibiliDashboard('partial').data!,
            capturedAt: '2026-09-04T01:30:00Z',
            followerCount: 10,
            collectedContentCount: 1,
            viewCount: 20,
            interactionCount: 2,
            topContents: []
          }
        })
      }}
    />);

    expect(await screen.findByText('已采集 1 个稿件')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开哔哩哔哩运营详情看板' }));
    expect(screen.getByRole('heading', { name: '稿件表现' })).toBeInTheDocument();
    expect(screen.getByText('部分数据暂不可用：历史互动明细')).toBeInTheDocument();
    expect(screen.getByText('暂无稿件数据')).toBeInTheDocument();
  });

  it('reloads the dashboard for a selected period', async () => {
    const user = userEvent.setup();
    const getBilibiliDashboard = vi.fn(async () => bilibiliDashboard());
    render(<DashboardPage connected enterpriseSignedIn service={{ getBilibiliDashboard }} />);
    await screen.findByText('已采集 24 个稿件');
    await user.click(screen.getByRole('button', { name: '打开哔哩哔哩运营详情看板' }));
    await user.click(screen.getByRole('button', { name: '近 30 天' }));
    expect(getBilibiliDashboard).toHaveBeenLastCalledWith({
      range: '30d',
      sourceId: 'bdsrc_1'
    });
  });
});
