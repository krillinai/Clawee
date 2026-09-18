import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

import { getAdminFeatureStatus } from "@/lib/admin-feature-api";
import { AdminFeatureGate } from "./admin-feature-gate";

vi.mock("@/lib/admin-feature-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin-feature-api")>("@/lib/admin-feature-api");
  return { ...actual, getAdminFeatureStatus: vi.fn() };
});

const mountPage = vi.fn();
function Page() { mountPage(); return <p>业务页面</p>; }
function show(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}><AdminFeatureGate><Page /></AdminFeatureGate></MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => { vi.clearAllMocks(); });

it.each([
  ["/admin/feedback", "feedback"],
  ["/admin/feedback/fb_missing", "feedback"],
  ["/admin/knowledge-bases", "knowledge"],
  ["/admin/knowledge-bases/documents?knowledge_base_id=missing", "knowledge"],
  ["/admin/skills", "skills"],
  ["/admin/skills/detail", "skills"],
  ["/admin/skills/source-detail", "skill_sources"],
  ["/admin/shared-files", "shared_files"],
  ["/admin/shared-files/detail", "shared_files"],
  ["/admin/shared-files/storage", "shared_file_storage"],
  ["/admin/activity/detail", "activity"],
  ["/admin/mcp/upstream-servers/detail", "mcp"],
  ["/admin/mcp/capabilities", "mcp"],
  ["/admin/mcp/agents", "mcp"],
  ["/admin/mcp/gates/detail", "mcp"],
  ["/admin/mcp/audits", "mcp"],
  ["/admin/data-permissions", "data_permissions"],
  ["/admin/accounts", "accounts"],
  ["/admin/rbac/roles", "rbac"],
  ["/admin/platform-branding", "platform_branding"],
  ["/admin/client-downloads", "client_downloads"]
])("%s 未启用时不挂载业务页面", async (path, feature) => {
  vi.mocked(getAdminFeatureStatus).mockResolvedValue({ features: { [feature]: false } });
  show(path);
  expect(await screen.findByText("功能未开启")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(mountPage).not.toHaveBeenCalled();
});

it("已启用时正常加载页面，资源 404 仍由业务页处理", async () => {
  vi.mocked(getAdminFeatureStatus).mockResolvedValue({ features: { knowledge: true } });
  show("/admin/knowledge-bases/documents?knowledge_base_id=missing");
  expect(await screen.findByText("业务页面")).toBeInTheDocument();
  expect(screen.queryByText("功能未开启")).not.toBeInTheDocument();
});

it("状态请求失败显示友好提示并可重试，不暴露错误正文", async () => {
  vi.mocked(getAdminFeatureStatus).mockRejectedValueOnce(new Error("GET /api/v1/admin/status failed with 500"));
  vi.mocked(getAdminFeatureStatus).mockResolvedValueOnce({ features: { feedback: false } });
  show("/admin/feedback");
  expect(await screen.findByRole("alert")).toHaveTextContent("功能状态暂时不可用，请稍后重试。");
  expect(screen.queryByText(/failed with/)).not.toBeInTheDocument();
  expect(mountPage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("功能未开启")).toBeInTheDocument();
});
