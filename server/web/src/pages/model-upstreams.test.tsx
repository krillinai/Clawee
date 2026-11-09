import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelUpstreamAccount } from "@/lib/model-upstream-admin-api";
import {
  listModelGroups,
  listModelUpstreamAccounts,
  updateModelUpstreamAccount
} from "@/lib/model-upstream-admin-api";

import { ModelUpstreamsPage } from "./model-upstreams";

vi.mock("@/lib/model-upstream-admin-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/model-upstream-admin-api")>("@/lib/model-upstream-admin-api");
  return {
    ...actual,
    listModelGroups: vi.fn(),
    listModelUpstreamAccounts: vi.fn(),
    updateModelUpstreamAccount: vi.fn()
  };
});

const listModelGroupsMock = vi.mocked(listModelGroups);
const listModelUpstreamAccountsMock = vi.mocked(listModelUpstreamAccounts);
const updateModelUpstreamAccountMock = vi.mocked(updateModelUpstreamAccount);

const activeAccount: ModelUpstreamAccount = {
  id: "upstream_1",
  name: "主力模型账号",
  baseUrl: "https://api.deepseek.com",
  models: ["clawee-vision", "deepseek-chat"],
  syncedModels: ["deepseek-chat"],
  manualModels: ["clawee-vision"],
  modelSyncAt: "2026-11-03T03:35:14Z",
  modelSyncError: "",
  status: "active",
  healthStatus: "healthy",
  hasApiKey: true,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-03T03:35:14Z"
};

describe("ModelUpstreamsPage 上游账号操作", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listModelGroupsMock.mockResolvedValue([]);
  });

  it("在删除前提供停用按钮，停用成功后切换为启用", async () => {
    listModelUpstreamAccountsMock
      .mockResolvedValueOnce([activeAccount])
      .mockResolvedValue([{ ...activeAccount, status: "disabled" }]);
    updateModelUpstreamAccountMock.mockResolvedValue({ ...activeAccount, status: "disabled" });
    renderPage();

    const row = await findRow("主力模型账号");
    expect(within(row).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "测试 主力模型账号 的上游连接",
      "手动同步 主力模型账号 的模型",
      "编辑 主力模型账号",
      "停用 主力模型账号",
      "删除 主力模型账号"
    ]);

    fireEvent.click(within(row).getByRole("button", { name: "停用 主力模型账号" }));

    await waitFor(() => {
      expect(updateModelUpstreamAccountMock).toHaveBeenCalledWith({
        id: "upstream_1",
        name: "主力模型账号",
        baseUrl: "https://api.deepseek.com",
        apiKey: "",
        manualModels: ["clawee-vision"],
        status: "disabled"
      });
    });
    expect(await within(await findRow("主力模型账号")).findByRole("button", { name: "启用 主力模型账号" })).toBeInTheDocument();
  });

  it("停用失败时展示错误提示", async () => {
    listModelUpstreamAccountsMock.mockResolvedValue([activeAccount]);
    updateModelUpstreamAccountMock.mockRejectedValue(new Error("没有更新权限"));
    renderPage();

    const row = await findRow("主力模型账号");
    fireEvent.click(within(row).getByRole("button", { name: "停用 主力模型账号" }));

    expect(await screen.findByText("上游账号状态更新失败：没有更新权限")).toBeInTheDocument();
  });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ModelUpstreamsPage section="accounts" />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function findRow(text: string) {
  const cell = await screen.findByText(text);
  const row = cell.closest("tr");
  if (!row) throw new Error(`No table row found for ${text}`);
  return row;
}
