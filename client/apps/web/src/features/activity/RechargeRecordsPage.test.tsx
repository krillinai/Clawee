import type { EnterpriseRechargeOrder } from '@clawee/protocol';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RechargeRecordsPage } from './RechargeRecordsPage.js';

const statuses: EnterpriseRechargeOrder['status'][] = [
  'pending_payment', 'crediting', 'succeeded', 'credit_failed',
  'cancelled', 'refunding', 'refunded', 'refund_failed'
];

function props() {
  return {
    range: '7d' as const,
    resolving: false,
    billingNotManaged: false,
    orders: {
      items: statuses.map((status, index) => order(status, index)),
      page: 1,
      total: 21
    },
    loading: false,
    page: 1,
    onBack: vi.fn(),
    onRefresh: vi.fn(),
    onRetry: vi.fn(),
    onPreviousPage: vi.fn(),
    onNextPage: vi.fn()
  };
}

describe('RechargeRecordsPage', () => {
  it('renders all payment and fulfillment outcomes without conflating credit failure', () => {
    render(<RechargeRecordsPage {...props()} />);
    const table = screen.getByRole('table', { name: '充值记录' });
    for (const label of [
      '待支付', '已支付，到账处理中', '已到账', '已支付，到账异常',
      '已取消', '退款处理中', '已退款', '退款异常'
    ]) {
      expect(within(table).getByText(label)).toBeInTheDocument();
    }
    expect(within(table).queryByText('支付失败')).not.toBeInTheDocument();
    expect(within(table).getAllByText('¥100.00')).toHaveLength(8);
    expect(within(table).getAllByText('-').length).toBeGreaterThan(0);
  });

  it('supports refresh, back, and fixed previous/next pagination', async () => {
    const handlers = props();
    const user = userEvent.setup();
    render(<RechargeRecordsPage {...handlers} />);

    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '刷新充值记录' }));
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await user.click(screen.getByRole('button', { name: '返回 Agent动态' }));
    expect(handlers.onRefresh).toHaveBeenCalledOnce();
    expect(handlers.onNextPage).toHaveBeenCalledOnce();
    expect(handlers.onBack).toHaveBeenCalledOnce();
  });

  it('shows empty, unavailable, loading, and enterprise-managed states', () => {
    const base = props();
    const { rerender } = render(
      <RechargeRecordsPage {...base} orders={{ items: [], page: 1, total: 0 }} />
    );
    expect(screen.getByText('暂无充值记录')).toBeInTheDocument();

    rerender(<RechargeRecordsPage {...base} orders={undefined} error="充值记录暂不可用，请稍后重试" />);
    expect(screen.getByRole('alert')).toHaveTextContent('充值记录暂不可用');

    rerender(<RechargeRecordsPage {...base} orders={undefined} loading />);
    expect(screen.getByRole('status', { name: '正在加载充值记录' })).toBeInTheDocument();

    rerender(<RechargeRecordsPage {...base} orders={undefined} billingNotManaged />);
    expect(screen.getByText('当前部署使用企业自有模型服务，平台不管理该模型账单'))
      .toBeInTheDocument();
  });
});

function order(
  status: EnterpriseRechargeOrder['status'],
  index: number
): EnterpriseRechargeOrder {
  return {
    orderNo: `PAY20260828100000-${index}`,
    amountCents: 10_000,
    currency: 'CNY',
    channel: index % 2 === 0 ? 'alipay' : 'manual',
    status,
    paymentStatus: status === 'pending_payment' ? 'pending' : 'paid',
    fulfillmentStatus: status === 'succeeded' ? 'succeeded' : 'pending',
    createdAt: '2026-08-28T10:00:00+08:00',
    ...(index === 0 ? {} : { paidAt: '2026-08-28T10:01:00+08:00' }),
    ...(status === 'succeeded'
      ? { fulfilledAt: '2026-08-28T10:01:05+08:00' }
      : {})
  };
}
