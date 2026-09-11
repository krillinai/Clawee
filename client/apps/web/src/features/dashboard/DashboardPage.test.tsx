import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../../runtime/client.js';
import { DashboardPage } from './DashboardPage.js';

describe('DashboardPage', () => {
  it('summarizes static Agent and knowledge data', () => {
    render(<DashboardPage />);
    expect(screen.getByRole('heading', { name: '数据看板' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '业务洞察' })).toBeInTheDocument();
    for (const name of ['竞品洞察', '客户管理', '小红书运营', '抖音投放']) {
      expect(screen.queryByRole('heading', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /^编辑/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '哔哩哔哩运营' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('哔哩哔哩看板已连接企业服务');
    expect(screen.queryByText('总 Token')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Agent 运行' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '知识资产' })).not.toBeInTheDocument();
  });

  it('creates a personal dashboard in the employee view', async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(screen.getByRole('button', { name: '员工' }));
    await user.click(screen.getByRole('button', { name: '创建看板' }));
    await user.type(screen.getByPlaceholderText('例如：销售日报'), '我的销售日报');
    await user.type(screen.getByPlaceholderText('这个看板用于查看什么'), '跟踪个人销售目标');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByRole('heading', { name: '我的销售日报' })).toBeInTheDocument();
    expect(screen.getByText('个人看板')).toBeInTheDocument();
  });

  it('loads the enterprise Bilibili summary and opens its real dashboard', async () => {
    const user = userEvent.setup();
    render(<DashboardPage
      connected
      enterpriseSignedIn
      service={{
        getBilibiliDashboard: async () => ({
          status: 'available',
          data: {
            capturedAt: '2026-08-30T01:30:00Z',
            followerCount: 128_600,
            collectedContentCount: 24,
            viewCount: 8_650_000,
            interactionCount: 316_800,
            topContents: [{
              externalContentId: 'BV1test',
              title: '夏日新品开箱',
              capturedAt: '2026-08-30T01:20:00Z',
              viewCount: 680_000,
              interactionCount: 28_600
            }]
          }
        })
      }}
    />);

    expect(await screen.findByText('已采集 24 个稿件')).toBeInTheDocument();
    expect(screen.getByText('128,600')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开哔哩哔哩运营详情看板' }));
    expect(screen.getByRole('heading', { name: '哔哩哔哩运营' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '热门稿件' })).toBeInTheDocument();
    expect(screen.getByText('夏日新品开箱')).toBeInTheDocument();
    expect(screen.getByText('8,650,000')).toBeInTheDocument();
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
          status: 'partial',
          data: {
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
    expect(screen.getByRole('heading', { name: '热门稿件' })).toBeInTheDocument();
    expect(screen.getByText('暂无稿件数据')).toBeInTheDocument();
  });
});
