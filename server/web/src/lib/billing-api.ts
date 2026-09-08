import { appApi } from "@/lib/api";
import { APIError } from "@/lib/api";
import type { ActivityRange, ActivityUsage } from "@/lib/activity-api";

export type BillingUsage = ActivityUsage & {
  requests: number;
};

export type BillingOverview = {
  currency: "CNY";
  exchange_rate: number;
  balance_cny: number;
  start_date: string;
  end_date: string;
  granularity: "hour" | "day";
  generated_at: string;
  stats: BillingUsage;
};

export type RechargeSession = {
  recharge_url: string;
  expires_at: string;
};

export type RechargeOrderStatus =
  | "pending_payment"
  | "crediting"
  | "succeeded"
  | "credit_failed"
  | "cancelled"
  | "refunding"
  | "refunded"
  | "refund_failed";

export type RechargeOrder = {
  order_no: string;
  amount_cents: number;
  currency: "CNY";
  channel: "alipay" | "manual";
  status: RechargeOrderStatus;
  payment_status: "pending" | "paid" | "cancelled" | "refunded";
  fulfillment_status:
    | "pending"
    | "processing"
    | "succeeded"
    | "failed"
    | "refunding"
    | "refunded"
    | "refund_failed";
  created_at: string;
  paid_at?: string | null;
  fulfilled_at?: string | null;
};

export type RechargeOrderPage = {
  items: RechargeOrder[];
  page: number;
  page_size: number;
  total: number;
};

export function getBillingOverview(range: ActivityRange): Promise<BillingOverview> {
  return appApi.get<BillingOverview>(`/billing/overview?range=${range}`);
}

export function createRechargeSession(): Promise<RechargeSession> {
  return appApi.post<RechargeSession>("/billing/recharge-session");
}

export function listRechargeOrders(page: number, pageSize = 20): Promise<RechargeOrderPage> {
  return appApi.get<RechargeOrderPage>(`/billing/recharge-orders?page=${page}&page_size=${pageSize}`);
}

export function openRechargePage(url: string, open: typeof window.open = window.open.bind(window)) {
  open(url, "_blank", "noopener,noreferrer");
}

export function isBillingNotManaged(error: unknown): boolean {
  return error instanceof APIError && error.code === "billing_not_managed";
}
