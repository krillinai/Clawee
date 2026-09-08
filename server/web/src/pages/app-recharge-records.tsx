import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { CopyButton } from "@/components/copy-button";
import { DataTableShell, EmptyState, ErrorAlert, PageHeader, PageShell } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isBillingNotManaged, listRechargeOrders, type RechargeOrder, type RechargeOrderStatus } from "@/lib/billing-api";
import { canReadAgentActivity, listMyDataViews } from "@/lib/data-views-api";
import { formatBeijingDateTime } from "@/lib/datetime";

const pageSize = 20;

const statusPresentation: Record<RechargeOrderStatus, { label: string; variant: "muted" | "warning" | "success" | "danger" | "secondary" }> = {
  pending_payment: { label: "待支付", variant: "muted" },
  crediting: { label: "已支付，到账处理中", variant: "warning" },
  succeeded: { label: "已到账", variant: "success" },
  credit_failed: { label: "已支付，到账异常", variant: "danger" },
  cancelled: { label: "已取消", variant: "muted" },
  refunding: { label: "退款处理中", variant: "warning" },
  refunded: { label: "已退款", variant: "secondary" },
  refund_failed: { label: "退款异常", variant: "danger" },
};

export function AppRechargeRecordsPage() {
  const [page, setPage] = useState(1);
  const dataViewsQuery = useQuery({ queryKey: ["app-data-views"], queryFn: listMyDataViews });
  const authorized = canReadAgentActivity(dataViewsQuery.data ?? []);
  const recordsQuery = useQuery({
    queryKey: ["app-recharge-orders", page],
    queryFn: () => listRechargeOrders(page, pageSize),
    enabled: authorized,
    retry: false,
    refetchOnWindowFocus: true,
    placeholderData: (previous) => previous,
    refetchInterval: (query) => query.state.data?.items.some((order) => order.status === "crediting" || order.status === "refunding") ? 5_000 : false,
  });

  if (dataViewsQuery.isLoading) return <RechargeRecordsPageSkeleton />;
  if (dataViewsQuery.isError) {
    return (
      <PageShell>
        <RechargeRecordsBackLink />
        <PageHeader title="充值记录" />
        <ErrorAlert>数据视图权限加载失败，请稍后重试</ErrorAlert>
      </PageShell>
    );
  }
  if (!authorized) {
    return (
      <PageShell>
        <RechargeRecordsBackLink />
        <PageHeader title="充值记录" />
        <EmptyState title="当前账户未开通 Agent 动态" description="请联系管理员授予数据视图读取权限。" />
      </PageShell>
    );
  }

  const result = recordsQuery.data;
  if (recordsQuery.isError && isBillingNotManaged(recordsQuery.error)) {
    return (
      <PageShell>
        <RechargeRecordsBackLink />
        <PageHeader title="充值记录" />
        <EmptyState title="当前部署使用企业自有模型服务" description="平台不管理该模型账单，因此没有中央充值记录。" />
      </PageShell>
    );
  }
  const hasPrevious = page > 1;
  const hasNext = Boolean(result && page * pageSize < result.total);

  return (
    <PageShell>
      <RechargeRecordsBackLink />
      <PageHeader
        actions={(
          <Button disabled={recordsQuery.isFetching} onClick={() => void recordsQuery.refetch()} size="sm" variant="outline">
            <RefreshCw data-icon="inline-start" />刷新
          </Button>
        )}
        title="充值记录"
      >
        企业账户充值订单及到账结果
      </PageHeader>

      {recordsQuery.isError ? (
        <ErrorAlert>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>充值记录暂不可用，请稍后重试</span>
            <Button onClick={() => void recordsQuery.refetch()} size="sm" variant="outline">重试</Button>
          </div>
        </ErrorAlert>
      ) : null}

      <DataTableShell minWidth={960}>
        <TableHeader>
          <TableRow>
            <TableHead>充值时间</TableHead>
            <TableHead>订单号</TableHead>
            <TableHead>支付渠道</TableHead>
            <TableHead className="text-right">充值金额</TableHead>
            <TableHead>充值状态</TableHead>
            <TableHead>支付时间</TableHead>
            <TableHead>到账时间</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recordsQuery.isLoading ? <RechargeTableSkeletonRows /> : null}
          {!recordsQuery.isLoading && !recordsQuery.isError && result?.total === 0 ? (
            <TableRow><TableCell colSpan={7}><EmptyState title="暂无充值记录" /></TableCell></TableRow>
          ) : null}
          {result?.items.map((order) => <RechargeOrderRow key={order.order_no} order={order} />)}
        </TableBody>
      </DataTableShell>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>共 {result?.total ?? 0} 条</span>
        <div className="flex items-center gap-2">
          <Button disabled={!hasPrevious || recordsQuery.isFetching} onClick={() => setPage((value) => value - 1)} size="sm" variant="outline">上一页</Button>
          <span className="min-w-16 text-center">第 {page} 页</span>
          <Button disabled={!hasNext || recordsQuery.isFetching} onClick={() => setPage((value) => value + 1)} size="sm" variant="outline">下一页</Button>
        </div>
      </div>
    </PageShell>
  );
}

function RechargeOrderRow({ order }: { order: RechargeOrder }) {
  const status = statusPresentation[order.status];
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-xs">{formatBeijingDateTime(order.created_at)}</TableCell>
      <TableCell>
        <div className="flex max-w-64 items-center gap-2">
          <span className="min-w-0 truncate font-mono text-xs" title={order.order_no}>{order.order_no}</span>
          <CopyButton aria-label={`复制订单号 ${order.order_no}`} label="复制" size="sm" value={order.order_no} variant="outline" />
        </div>
      </TableCell>
      <TableCell>{order.channel === "alipay" ? "支付宝" : "人工入账"}</TableCell>
      <TableCell className="text-right font-mono">{formatRechargeAmount(order.amount_cents)}</TableCell>
      <TableCell><Badge variant={status.variant}>{status.label}</Badge></TableCell>
      <TableCell className="whitespace-nowrap text-xs">{formatBeijingDateTime(order.paid_at)}</TableCell>
      <TableCell className="whitespace-nowrap text-xs">{formatBeijingDateTime(order.fulfilled_at)}</TableCell>
    </TableRow>
  );
}

function RechargeRecordsBackLink() {
  return (
    <div>
      <Button asChild size="sm" variant="ghost">
        <Link to="/app/activity"><ArrowLeft data-icon="inline-start" />返回 Agent 动态</Link>
      </Button>
    </div>
  );
}

function RechargeRecordsPageSkeleton() {
  return (
    <PageShell>
      <Skeleton className="h-9 w-36" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-72 w-full" />
    </PageShell>
  );
}

function RechargeTableSkeletonRows() {
  return Array.from({ length: 4 }, (_, row) => (
    <TableRow key={row}>
      {Array.from({ length: 7 }, (_, cell) => (
        <TableCell key={cell}><Skeleton className="h-5 w-full" /></TableCell>
      ))}
    </TableRow>
  ));
}

function formatRechargeAmount(amountCents: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountCents / 100);
}
