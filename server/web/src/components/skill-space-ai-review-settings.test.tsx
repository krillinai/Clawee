import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { skillAIReviewApi } from "@/lib/skill-ai-review-api";
import type { SkillSpace } from "@/lib/skillhub-api";
import { SkillSpaceAIReviewSettings } from "./skill-space-ai-review-settings";

vi.mock("@/lib/skill-ai-review-api", async () => ({ ...await vi.importActual<typeof import("@/lib/skill-ai-review-api")>("@/lib/skill-ai-review-api"), skillAIReviewApi: { getConfig: vi.fn(), saveConfig: vi.fn() } }));

const space: SkillSpace = { spaceId: "space", name: "审核空间", description: "", approvalProvider: "local", approvers: [{ userId: "reviewer", name: "评审人" }], actions: ["read", "write"], memberCount: 1, skillCount: 1, publishedCount: 0, createdBy: "admin", updatedBy: "admin", createdAt: "", updatedAt: "" };
function mount(overrides: Partial<SkillSpace> = {}) {
  const close = vi.fn();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={cache}><SkillSpaceAIReviewSettings space={{ ...space, ...overrides }} onClose={close} /></QueryClientProvider>);
  return close;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(skillAIReviewApi.getConfig).mockResolvedValue({ enabled: false, agent_id: "" });
  vi.mocked(skillAIReviewApi.saveConfig).mockResolvedValue({});
});

describe("空间独立 AI 配置", () => {
  it.each([{ approvalProvider: "dingtalk" as const }, { approvers: [] }])("非 local 或无名单不可启用，即使钉钉有名单", async overrides => {
    mount(overrides);
    expect(await screen.findByRole("checkbox", { name: "启用 AI 前置审核" })).toBeDisabled();
    expect(skillAIReviewApi.saveConfig).not.toHaveBeenCalled();
  });

  it.each([{ approvers: [], approverRoleIds: ["role"] }, { approvers: [], approverRoles: [{ roleId: "role", name: "审核组" }] }])("角色名单可启用，Agent 必填", async overrides => {
    mount(overrides);
    fireEvent.click(await screen.findByRole("checkbox", { name: "启用 AI 前置审核" }));
    const save = screen.getByRole("button", { name: "保存 AI 配置" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: /执行 Agent ID/ }), { target: { value: "   " } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: /执行 Agent ID/ }), { target: { value: "agent" } });
    fireEvent.click(save);
    await waitFor(() => expect(skillAIReviewApi.saveConfig).toHaveBeenCalledWith("space", { enabled: true, agent_id: "agent" }));
  });

  it("关闭配置即清空 Agent，提交锁及同步防重", async () => {
    vi.mocked(skillAIReviewApi.getConfig).mockResolvedValue({ enabled: true, agent_id: "agent-old" });
    let finish!: (value: unknown) => void;
    vi.mocked(skillAIReviewApi.saveConfig).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const close = mount();
    await screen.findByDisplayValue("agent-old");
    fireEvent.click(screen.getByRole("checkbox", { name: "启用 AI 前置审核" }));
    expect(screen.getByRole("textbox", { name: /执行 Agent ID/ })).toHaveValue("");
    const form = screen.getByRole("button", { name: "保存 AI 配置" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(skillAIReviewApi.saveConfig).toHaveBeenCalledTimes(1));
    expect(skillAIReviewApi.saveConfig).toHaveBeenCalledWith("space", { enabled: false, agent_id: "" });
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    await act(async () => finish({}));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("GET 与 PUT 失败安全反馈且可重试", async () => {
    vi.mocked(skillAIReviewApi.getConfig).mockRejectedValueOnce(new Error("内部地址及栈"));
    mount();
    expect(await screen.findByText(/AI 审核配置加载失败/)).toBeInTheDocument();
    expect(screen.queryByText("内部地址及栈")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await screen.findByRole("checkbox", { name: "启用 AI 前置审核" });
    vi.mocked(skillAIReviewApi.saveConfig).mockRejectedValueOnce(new Error("内部地址及栈"));
    fireEvent.click(screen.getByRole("button", { name: "保存 AI 配置" }));
    expect(await screen.findByText(/保存失败，请确认 Agent 有效/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存 AI 配置" })).toBeEnabled();
  });
});
