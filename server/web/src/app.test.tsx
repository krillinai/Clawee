import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listAccounts } from "@/lib/accounts-api";
import { currentAccount } from "@/lib/auth-api";
import { listKnowledgeBases, listKnowledgeDocuments } from "@/lib/knowledge-api";
import {
  listMCPAgents,
  listMCPAudits,
  listMCPCapabilities,
  listMCPGates,
  listMCPGrants,
  listMCPUpstreamServers
} from "@/lib/mcp-admin-api";
import { fetchCollectorOverview, getAgentActivityList, getAgentDetail, getOfficeSnapshot } from "@/lib/office-api";
import { fixtureAgentDetail, fixtureCollectorsOverview, fixtureOffice } from "@/test/office-fixtures";
import { ThemeProvider } from "@/components/theme-provider";
import { permissions } from "@/lib/rbac-api";
import { getSharedSpace, listSharedFiles } from "@/lib/shared-files-api";

import { App } from "./app";

vi.mock("@/lib/accounts-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/accounts-api")>("@/lib/accounts-api");
  return {
    ...actual,
    listAccounts: vi.fn()
  };
});

vi.mock("@/lib/auth-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth-api")>("@/lib/auth-api");
  return {
    ...actual,
    currentAccount: vi.fn()
  };
});

vi.mock("@/lib/mcp-admin-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp-admin-api")>("@/lib/mcp-admin-api");
  return {
    ...actual,
    listMCPAgents: vi.fn(),
    listMCPAudits: vi.fn(),
    listMCPCapabilities: vi.fn(),
    listMCPGates: vi.fn(),
    listMCPGrants: vi.fn(),
    listMCPUpstreamServers: vi.fn()
  };
});

vi.mock("@/lib/knowledge-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/knowledge-api")>("@/lib/knowledge-api");
  return { ...actual, listKnowledgeBases: vi.fn(), listKnowledgeDocuments: vi.fn() };
});

vi.mock("@/lib/office-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/office-api")>("@/lib/office-api");
  return {
    ...actual,
    fetchCollectorOverview: vi.fn(),
    getAgentActivityList: vi.fn(),
    getOfficeSnapshot: vi.fn(),
    getAgentDetail: vi.fn()
  };
});

vi.mock("@/lib/shared-files-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shared-files-api")>("@/lib/shared-files-api");
  return { ...actual, getSharedSpace: vi.fn(), listSharedFiles: vi.fn() };
});

const listAccountsMock = vi.mocked(listAccounts);
const currentAccountMock = vi.mocked(currentAccount);
const listMCPAgentsMock = vi.mocked(listMCPAgents);
const listMCPAuditsMock = vi.mocked(listMCPAudits);
const listMCPCapabilitiesMock = vi.mocked(listMCPCapabilities);
const listMCPGatesMock = vi.mocked(listMCPGates);
const listMCPGrantsMock = vi.mocked(listMCPGrants);
const listMCPUpstreamServersMock = vi.mocked(listMCPUpstreamServers);
const listKnowledgeBasesMock = vi.mocked(listKnowledgeBases);
const listKnowledgeDocumentsMock = vi.mocked(listKnowledgeDocuments);
const fetchCollectorOverviewMock = vi.mocked(fetchCollectorOverview);
const getAgentActivityListMock = vi.mocked(getAgentActivityList);
const getOfficeSnapshotMock = vi.mocked(getOfficeSnapshot);
const getAgentDetailMock = vi.mocked(getAgentDetail);
const getSharedSpaceMock = vi.mocked(getSharedSpace);
const listSharedFilesMock = vi.mocked(listSharedFiles);

function renderApp() {
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
}

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "EventSource",
      class {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        addEventListener() {}
        removeEventListener() {}
        close() {}
      }
    );
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ service: "clawee-gateway", status: "ok" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )));
    listAccountsMock.mockResolvedValue([]);
    listMCPAgentsMock.mockResolvedValue([]);
    listMCPAuditsMock.mockResolvedValue([]);
    listMCPCapabilitiesMock.mockResolvedValue([]);
    listMCPGatesMock.mockResolvedValue([]);
    listMCPGrantsMock.mockResolvedValue([]);
    listMCPUpstreamServersMock.mockResolvedValue([]);
    listKnowledgeBasesMock.mockResolvedValue([]);
    listKnowledgeDocumentsMock.mockResolvedValue([]);
    fetchCollectorOverviewMock.mockResolvedValue(fixtureCollectorsOverview);
    getAgentActivityListMock.mockResolvedValue(fixtureOffice);
    getOfficeSnapshotMock.mockResolvedValue(fixtureOffice);
    getAgentDetailMock.mockResolvedValue(fixtureAgentDetail);
    getSharedSpaceMock.mockResolvedValue({
      spaceId: "space-1", name: "项目资料", description: "", memberCount: 1, fileCount: 1, sizeBytes: 10,
      createdBy: "usr_admin", createdAt: "2026-08-01T00:00:00Z", updatedBy: "usr_admin", updatedAt: "2026-08-01T00:00:00Z"
    });
    listSharedFilesMock.mockResolvedValue({
      items: [{ fileId: "file-1", spaceId: "space-1", logicalPath: "guide.txt", fileName: "guide.txt", sizeBytes: 10, contentType: "text/plain", revision: 1, updatedByUserId: "usr_admin", updatedByUserName: "管理员", updatedByAgentId: "", updatedAt: "2026-08-01T00:00:00Z" }],
      meta: { next_cursor: "", has_next: false }
    });
    currentAccountMock.mockResolvedValue({
      user: {
        userId: "usr_admin",
        email: "admin@example.com",
    name: "Admin",
    status: "active",
    adminRoles: ["admin"],
    adminPermissions: Object.values(permissions)
      },
      redirectTo: "/admin"
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the login route with email and password fields", async () => {
    window.history.pushState({}, "", "/login");

    renderApp();

    expect(await screen.findByRole("heading", { name: "登录管理台" })).toBeInTheDocument();
    expect(screen.getByLabelText("邮箱地址")).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toBeInTheDocument();
    const themeSwitcher = screen.getByRole("radiogroup", { name: "界面主题" });
    expect(themeSwitcher).toBeInTheDocument();
    expect(themeSwitcher.parentElement).toHaveClass("flex-wrap");
    expect(screen.getByText("Agent 访问凭证与管理台登录会话相互独立。")).toBeInTheDocument();
    expect(screen.queryByText("管理员登录后进入治理控制台")).not.toBeInTheDocument();
  });

  it("renders the register route with email and password fields", async () => {
    window.history.pushState({}, "", "/register");

    renderApp();

    expect(await screen.findByRole("heading", { name: "注册账号" })).toBeInTheDocument();
    expect(screen.getByLabelText("邮箱地址")).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "界面主题" })).toBeInTheDocument();
    expect(screen.getByText("角色分配规则")).toBeInTheDocument();
  });

  it("redirects unauthenticated admin visits to login", async () => {
    currentAccountMock.mockRejectedValue(new Error("not authenticated"));
    window.history.pushState({}, "", "/admin");

    renderApp();

    await waitFor(() => expect(window.location.pathname).toBe("/login"));
  });

  it("redirects admin visits to login when the admin cookie is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "未认证" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    })));
    window.history.pushState({}, "", "/admin/accounts");

    renderApp();

    await waitFor(() => expect(window.location.pathname).toBe("/login"));
  });

  it("redirects an account without admin permissions away from admin", async () => {
    currentAccountMock.mockResolvedValue({
      user: {
        userId: "usr_user",
        email: "user@example.com",
        name: "User",
        status: "active"
      },
      redirectTo: "/app"
    });
    window.history.pushState({}, "", "/admin");

    renderApp();

    await waitFor(() => expect(window.location.pathname).toBe("/app/agents"));
    expect(screen.queryByRole("link", { name: "进入管理后台" })).not.toBeInTheDocument();
  });

  it("keeps the frontend application layout when switching tabs", async () => {
    window.history.pushState({}, "", "/app/agents");
    const view = renderApp();

    expect(await screen.findByRole("heading", { name: "我的 Agent 接入" })).toBeInTheDocument();
    const appNavigation = screen.getByRole("navigation", { name: "前台应用导航" });
    expect(view.container.querySelector("aside")).toContainElement(appNavigation);
    expect(view.container.querySelector("main nav")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "进入管理后台" })).toHaveAttribute("href", "/admin");
    const accountInformation = screen.getByRole("group", { name: "账户信息" });
    expect(screen.getByRole("radiogroup", { name: "界面主题" })).toBeInTheDocument();
    expect(within(accountInformation).queryByRole("link", { name: "进入管理后台" })).not.toBeInTheDocument();
    expect(within(accountInformation).queryByRole("radiogroup", { name: "界面主题" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "退出登录" })).not.toBeInTheDocument();
    fireEvent.click(within(accountInformation).getByRole("button", { name: "账户操作" }));
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "活动" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Collector" }));

    expect(await screen.findByRole("heading", { name: "我的 Collector" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Collector" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "进入管理后台" })).toHaveAttribute("href", "/admin");

    view.unmount();
  });

  it("renders the MCP capability catalog route in the frontend application", async () => {
    window.history.pushState({}, "", "/app/mcp-capabilities");

    renderApp();

    expect(await screen.findByRole("heading", { name: "MCP 能力目录" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "MCP" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps the root and app redirects", async () => {
    window.history.pushState({}, "", "/");

    renderApp();

    expect(await screen.findByRole("heading", { name: "我的 Agent 接入" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/app/agents"));
  });

  it("renders a not found page for unknown routes", async () => {
    window.history.pushState({}, "", "/unknown-admin-route");

    renderApp();

    expect(await screen.findByRole("heading", { name: "页面不存在" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回应用" })).toHaveAttribute("href", "/app");
    expect(window.location.pathname).toBe("/unknown-admin-route");
    expect(screen.queryByRole("heading", { name: "我的 Agent 接入" })).not.toBeInTheDocument();
  });

  it.each([
    "/admin/industry-packs/runs?pack_id=sales-crm",
    "/admin/industry-packs/sales-crm/runs",
    "/admin/industry-packs/sales-crm/runs/latest"
  ])("does not expose the removed industry pack page at %s", async (path) => {
    window.history.pushState({}, "", path);

    renderApp();

    expect(await screen.findByRole("heading", { name: "页面不存在" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回应用" })).toHaveAttribute("href", "/app");
    expect(window.location.pathname + window.location.search).toBe(path);
    expect(screen.queryByRole("heading", { name: "行业包运行记录" })).not.toBeInTheDocument();
  });

  it.each([
    ["/agent", "我的 Agent 接入"],
    ["/admin/users", "账号管理"],
    ["/admin/agents", "智能体管理"],
    ["/admin/mcp/agents-grants", "智能体管理"],
    ["/admin/mcp/gates/gate_legacy", "门禁队列"],
    ["/admin/mcp/proxy-audit", "代理审计"],
    ["/admin/skills/skill_legacy", "Skill 详情"],
    ["/admin/knowledge-bases/kb_legacy/documents", "知识库文档"],
    ["/admin/office/collectors", "采集器管理"],
    ["/admin/office/agent-activity", "智能体活动"],
    ["/admin/office/agent-activity/collector_legacy/agent_legacy", "智能体活动详情"]
  ])("renders a not found page instead of the legacy route %s", async (path, targetHeading) => {
    window.history.pushState({}, "", path);

    renderApp();

    expect(await screen.findByRole("heading", { name: "页面不存在" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回应用" })).toHaveAttribute("href", "/app");
    expect(window.location.pathname).toBe(path);
    expect(screen.queryByRole("heading", { name: targetHeading })).not.toBeInTheDocument();
  });

  it("renders the account management route for admins", async () => {
    window.history.pushState({}, "", "/admin/accounts");

    renderApp();

    expect(await screen.findByRole("heading", { name: "账号管理" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "账号管理" })).toHaveAttribute("href", "/admin/accounts");
  });

  it("renders the knowledge bases route for admins", async () => {
    window.history.pushState({}, "", "/admin/knowledge-bases");
    renderApp();
    expect(await screen.findByRole("heading", { name: "知识库" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建知识库" })).toBeInTheDocument();
  });

  it("opens document management on its own route", async () => {
    listKnowledgeBasesMock.mockResolvedValue([{
      knowledgeBaseId: "kb-1", name: "制度库", description: "", providerType: "bailian", status: "active", errorMessage: "", documentCount: 1, createdBy: "usr_admin", createdAt: "2026-07-26T00:00:00Z", updatedAt: "2026-07-26T00:00:00Z"
    }]);
    listKnowledgeDocumentsMock.mockResolvedValue([{
      documentId: "doc-1", knowledgeBaseId: "kb-1", name: "guide.pdf", sizeBytes: 10, mimeType: "application/pdf", status: "ready", errorMessage: "", uploadedBy: "usr_uploader", createdAt: "2026-07-26T00:00:00Z", updatedAt: "2026-07-26T00:00:00Z"
    }]);
    window.history.pushState({}, "", "/admin/knowledge-bases/documents?knowledge_base_id=kb-1");
    renderApp();

    expect(await screen.findByRole("heading", { name: "制度库文档" })).toBeInTheDocument();
    expect(await screen.findByText("上传人")).toBeInTheDocument();
    expect(await screen.findByText("usr_uploader")).toBeInTheDocument();
  });

  it("opens shared space file management on its own route", async () => {
    window.history.pushState({}, "", "/admin/shared-files/detail?space_id=space-1");
    renderApp();

    expect(await screen.findByRole("heading", { name: "项目资料文件" })).toBeInTheDocument();
    expect((await screen.findAllByText("guide.txt")).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "返回网盘" })).toHaveAttribute("href", "/admin/shared-files");
  });

  it("keeps the Skill source detail route behind Skill read permission", async () => {
    currentAccountMock.mockResolvedValue({
      user: {
        userId: "usr_reader",
        email: "reader@example.com",
        name: "Reader",
        status: "active",
        adminRoles: ["reader"],
        adminPermissions: [permissions.accountRead]
      },
      redirectTo: "/admin"
    });
    window.history.pushState({}, "", "/admin/skills/source-detail?source_id=source-1");

    renderApp();

    await waitFor(() => expect(window.location.pathname).toBe("/admin"));
  });

  it("renders the office collectors route for admins", async () => {
    window.history.pushState({}, "", "/admin/collectors");

    renderApp();

    expect(await screen.findByRole("heading", { name: "采集器管理" })).toBeInTheDocument();
    expect(screen.getByText("采集器列表")).toBeInTheDocument();
    expect(screen.getByText("采集器注册码")).toBeInTheDocument();
  });

  it("renders the unified Agent management route", async () => {
    window.history.pushState({}, "", "/admin/mcp/agents");
    renderApp();

    expect(
      await screen.findByRole("heading", { name: "智能体管理" }, { timeout: 5_000 })
    ).toBeInTheDocument();
    expect(screen.getByText("智能体列表")).toBeInTheDocument();
  });

  it("renders the office agent activity route for admins", async () => {
    window.history.pushState({}, "", "/admin/activity");

    renderApp();

    expect(await screen.findByRole("heading", { name: "智能体活动" })).toBeInTheDocument();
    expect(screen.getByText("活动列表")).toBeInTheDocument();
    expect(screen.getByText("实时状态")).toBeInTheDocument();
    expect(screen.getByText("活跃 Turn")).toBeInTheDocument();
  });

  it("renders the office agent detail route for admins", async () => {
    window.history.pushState({}, "", "/admin/activity/detail?collector_id=collector_1&agent_id=hermes-c03");

    renderApp();

    expect(await screen.findByRole("heading", { name: "Hermes C03" })).toBeInTheDocument();
    expect(screen.queryByText("智能体活动详情")).not.toBeInTheDocument();
    expect(screen.getByText(/采集器 ID:/)).toBeInTheDocument();
  });
});
