import { afterEach, describe, expect, it, vi } from "vitest";

import { APIError } from "./api";
import { isBillingNotManaged, listRechargeOrders, openRechargePage } from "./billing-api";

afterEach(() => vi.unstubAllGlobals());

describe("billing api", () => {
  it("opens the recharge page in a new browser tab", () => {
    const open = vi.fn();

    openRechargePage("https://billing.example/recharge/session-token", open);

    expect(open).toHaveBeenCalledWith(
      "https://billing.example/recharge/session-token",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("loads a recharge order page with explicit pagination", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { items: [], page: 3, page_size: 20, total: 42 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listRechargeOrders(3)).resolves.toEqual(expect.objectContaining({
      items: [], page: 3, page_size: 20, total: 42,
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/app/billing/recharge-orders?page=3&page_size=20",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("recognizes only the unified enterprise billing error", () => {
    expect(isBillingNotManaged(new APIError("not managed", 409, "billing_not_managed"))).toBe(true);
    expect(isBillingNotManaged(new APIError("unavailable", 503, "billing_unavailable"))).toBe(false);
    expect(isBillingNotManaged(new Error("billing_not_managed"))).toBe(false);
  });
});
