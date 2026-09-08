import type {
  EnterpriseRechargeOrder,
  EnterpriseRechargeOrderPageResponse
} from '@clawee/protocol';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  RefreshCw
} from 'lucide-react';
import type { AppRoute } from '../../app/routes.js';
import './activity.css';

export function RechargeRecordsPage(props: {
  range: 'today' | '7d' | '30d';
  resolving: boolean;
  billingNotManaged: boolean;
  orders?: EnterpriseRechargeOrderPageResponse;
  loading: boolean;
  error?: string;
  page: number;
  onBack(): void;
  onRefresh(): void;
  onRetry(): void;
  onPreviousPage(): void;
  onNextPage(): void;
  onNavigate?(route: AppRoute): void;
}) {
  const orders = props.orders;
  const nextDisabled = props.loading
    || orders === undefined
    || props.page * 20 >= orders.total;

  return (
    <main className="activity-page">
      <div className="activity-page__inner">
        <header className="activity-records-header">
          <button
            className="activity-icon-button"
            type="button"
            aria-label="返回 Agent动态"
            title="返回 Agent动态"
            onClick={props.onBack}
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <div>
            <h1>充值记录</h1>
            <p>企业账户充值订单及到账结果</p>
          </div>
          <button
            className="activity-icon-button"
            type="button"
            aria-label="刷新充值记录"
            title="刷新充值记录"
            disabled={props.loading || props.billingNotManaged}
            onClick={props.onRefresh}
          >
            <RefreshCw
              className={props.loading ? 'activity-spin' : undefined}
              size={17}
              aria-hidden="true"
            />
          </button>
        </header>

        {props.billingNotManaged ? (
          <RecordsState
            label="平台未托管模型账单"
            message="当前部署使用企业自有模型服务，平台不管理该模型账单"
          />
        ) : props.resolving || (props.loading && orders === undefined) ? (
          <RecordsSkeleton />
        ) : props.error !== undefined && orders === undefined ? (
          <RecordsState
            error
            label="充值记录暂不可用"
            message={props.error}
            onRetry={props.onRetry}
          />
        ) : orders === undefined || orders.total === 0 ? (
          <RecordsState label="暂无充值记录" />
        ) : (
          <>
            <div className="activity-records-table-wrap">
              <table aria-label="充值记录">
                <thead>
                  <tr>
                    <th>充值时间</th>
                    <th>订单号</th>
                    <th>支付渠道</th>
                    <th>充值金额</th>
                    <th>状态</th>
                    <th>支付时间</th>
                    <th>到账时间</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.items.map(order => (
                    <tr key={order.orderNo}>
                      <td>{formatDateTime(order.createdAt)}</td>
                      <td>
                        <code title={order.orderNo}>{order.orderNo}</code>
                      </td>
                      <td>{order.channel === 'alipay' ? '支付宝' : '人工入账'}</td>
                      <td>{formatCents(order.amountCents)}</td>
                      <td><OrderStatus order={order} /></td>
                      <td>{formatOptionalDateTime(order.paidAt)}</td>
                      <td>{formatOptionalDateTime(order.fulfilledAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {props.error === undefined ? null : (
              <p className="activity-records-inline-error" role="alert">
                {props.error}
              </p>
            )}
            <footer className="activity-records-pagination">
              <span>共 {orders.total} 条</span>
              <div>
                <button
                  type="button"
                  aria-label="上一页"
                  title="上一页"
                  disabled={props.loading || props.page === 1}
                  onClick={props.onPreviousPage}
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                </button>
                <span>第 {props.page} 页</span>
                <button
                  type="button"
                  aria-label="下一页"
                  title="下一页"
                  disabled={nextDisabled}
                  onClick={props.onNextPage}
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}

function OrderStatus(props: { order: EnterpriseRechargeOrder }) {
  const status = orderStatus(props.order.status);
  return (
    <span className="activity-order-status" data-tone={status.tone}>
      {status.label}
    </span>
  );
}

function RecordsState(props: {
  label: string;
  message?: string;
  error?: boolean;
  onRetry?(): void;
}) {
  return (
    <section className="activity-state" role={props.error ? 'alert' : 'status'}>
      {props.error ? <CircleAlert size={24} aria-hidden="true" /> : null}
      <h2>{props.label}</h2>
      {props.message === undefined ? null : <p>{props.message}</p>}
      {props.onRetry === undefined ? null : (
        <button type="button" onClick={props.onRetry}>
          <RefreshCw size={15} aria-hidden="true" />
          重试
        </button>
      )}
    </section>
  );
}

function RecordsSkeleton() {
  return (
    <div className="activity-records-skeleton" role="status" aria-label="正在加载充值记录">
      <LoaderCircle className="activity-spin" size={22} aria-hidden="true" />
      <div>{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</div>
    </div>
  );
}

function orderStatus(status: EnterpriseRechargeOrder['status']): {
  label: string;
  tone: 'neutral' | 'warning' | 'success' | 'danger' | 'secondary';
} {
  switch (status) {
    case 'pending_payment':
      return { label: '待支付', tone: 'neutral' };
    case 'crediting':
      return { label: '已支付，到账处理中', tone: 'warning' };
    case 'succeeded':
      return { label: '已到账', tone: 'success' };
    case 'credit_failed':
      return { label: '已支付，到账异常', tone: 'danger' };
    case 'cancelled':
      return { label: '已取消', tone: 'neutral' };
    case 'refunding':
      return { label: '退款处理中', tone: 'warning' };
    case 'refunded':
      return { label: '已退款', tone: 'secondary' };
    case 'refund_failed':
      return { label: '退款异常', tone: 'danger' };
  }
}

function formatCents(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value / 100);
}

function formatOptionalDateTime(value: string | undefined): string {
  return value === undefined ? '-' : formatDateTime(value);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}
