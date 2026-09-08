import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { APIError } from "@/lib/api";
import { listRechargeOrders, type RechargeOrder, type RechargeOrderPage, type RechargeOrderStatus } from "@/lib/billing-api";
import { listMyDataViews } from "@/lib/data-views-api";

import { AppRechargeRecordsPage } from "./app-recharge-records";

vi.mock("@/lib/billing-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/billing-api")>("@/lib/billing-api");
  return { ...actual, listRechargeOrders: vi.fn() };
});

vi.mock("@/lib/data-views-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data-views-api")>("@/lib/data-views-api");
  return { ...actual, listMyDataViews: vi.fn() };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

describe("AppRechargeRecordsPage", () => {
  it("does not request orders without the Agent activity grant", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("当前账户未开通 Agent 动态")).toBeInTheDocument();
    expect(listRechargeOrders).not.toHaveBeenCalled();
  });

  it("renders all statuses, formats values, and copies the full order number", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    const statuses: RechargeOrderStatus[] = [
      "pending_payment", "crediting", "succeeded", "credit_failed",
      "cancelled", "refunding", "refunded", "refund_failed",
    ];
    vi.mocked(listRechargeOrders).mockResolvedValue(pageOf(statuses.map((status, index) => orderOf(status, index))));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    renderPage();

    expect(await screen.findByRole("heading", { name: "充值记录" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回 Agent 动态" })).toHaveAttribute("href", "/app/activity");
    expect(await screen.findByText("PAY-TEST-0")).toBeInTheDocument();
    for (const label of ["待支付", "已支付，到账处理中", "已到账", "已支付，到账异常", "已取消", "退款处理中", "已退款", "退款异常"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByText("支付宝").length).toBeGreaterThan(0);
    expect(screen.getAllByText("人工入账").length).toBeGreaterThan(0);
    expect(screen.getAllByText("¥100.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "复制订单号 PAY-TEST-0" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("PAY-TEST-0"));
  });

  it("distinguishes an empty page from an unavailable response and retries", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    vi.mocked(listRechargeOrders)
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(pageOf([]));
    renderPage();

    expect(await screen.findByText("充值记录暂不可用，请稍后重试")).toBeInTheDocument();
    expect(screen.queryByText("暂无充值记录")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("暂无充值记录")).toBeInTheDocument();
    expect(listRechargeOrders).toHaveBeenCalledTimes(2);
  });

  it("shows the enterprise-managed explanation without a retry", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    vi.mocked(listRechargeOrders).mockRejectedValue(new APIError(
      "当前部署使用企业自有模型服务",
      409,
      "billing_not_managed",
    ));

    renderPage();

    expect(await screen.findByText("当前部署使用企业自有模型服务")).toBeInTheDocument();
    expect(screen.getByText("平台不管理该模型账单，因此没有中央充值记录。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });

  it("keeps the previous table while changing pages and disables pagination", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    let resolveSecond!: (value: RechargeOrderPage) => void;
    vi.mocked(listRechargeOrders).mockImplementation((page) => {
      if (page === 1) return Promise.resolve({ ...pageOf([orderOf("succeeded", 1)]), total: 21 });
      return new Promise((resolve) => { resolveSecond = resolve; });
    });
    renderPage();

    expect(await screen.findByText("PAY-TEST-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(listRechargeOrders).toHaveBeenLastCalledWith(2, 20));
    expect(screen.getByText("PAY-TEST-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();

    resolveSecond({ ...pageOf([orderOf("succeeded", 2)]), page: 2, total: 21 });
    expect(await screen.findByText("PAY-TEST-2")).toBeInTheDocument();
    expect(screen.getByText("第 2 页")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
  });

  it("polls processing orders every five seconds and stops after completion", async () => {
    vi.useFakeTimers();
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    vi.mocked(listRechargeOrders)
      .mockResolvedValueOnce(pageOf([orderOf("crediting", 1)]))
      .mockResolvedValue(pageOf([orderOf("succeeded", 1)]));
    renderPage();

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(listRechargeOrders).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(listRechargeOrders).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(listRechargeOrders).toHaveBeenCalledTimes(2);
  });
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/app/activity/recharge-records"]}>
        <AppRechargeRecordsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function pageOf(items: RechargeOrder[]): RechargeOrderPage {
  return { items, page: 1, page_size: 20, total: items.length };
}

function orderOf(status: RechargeOrderStatus, index: number): RechargeOrder {
  return {
    order_no: `PAY-TEST-${index}`,
    amount_cents: 10_000,
    currency: "CNY",
    channel: index % 2 === 0 ? "alipay" : "manual",
    status,
    payment_status: status === "pending_payment" ? "pending" : status === "cancelled" ? "cancelled" : status === "refunded" ? "refunded" : "paid",
    fulfillment_status: fulfillmentStatus(status),
    created_at: "2026-08-27T12:30:00+08:00",
    paid_at: status === "pending_payment" ? null : "2026-08-27T12:31:00+08:00",
    fulfilled_at: status === "succeeded" ? "2026-08-27T12:32:00+08:00" : null,
  };
}

function fulfillmentStatus(status: RechargeOrderStatus): RechargeOrder["fulfillment_status"] {
  switch (status) {
    case "crediting": return "processing";
    case "succeeded": return "succeeded";
    case "credit_failed": return "failed";
    case "refunding": return "refunding";
    case "refunded": return "refunded";
    case "refund_failed": return "refund_failed";
    default: return "pending";
  }
}
