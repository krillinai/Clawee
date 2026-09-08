import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import {
  bindGitHubSourceItem,
  getGitHubSource,
  listGitHubSourceSyncRuns,
  listSkills,
  queueGitHubSourceLocalScan,
  unbindGitHubSourceItem,
  type AdminSkill,
  type GitHubSourceDetail,
  type SkillSourceItem,
  type SkillSourceSyncRun
} from "@/lib/skillhub-api";
import { permissions } from "@/lib/rbac-api";

import { SkillSourceDetailPage } from "./skill-source-detail";

vi.mock("@/lib/skillhub-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/skillhub-api")>("@/lib/skillhub-api");
  return {
    ...actual,
    bindGitHubSourceItem: vi.fn(),
    getGitHubSource: vi.fn(),
    listGitHubSourceSyncRuns: vi.fn(),
    listSkills: vi.fn(),
    queueGitHubSourceLocalScan: vi.fn(),
    unbindGitHubSourceItem: vi.fn()
  };
});

const bindGitHubSourceItemMock = vi.mocked(bindGitHubSourceItem);
const getGitHubSourceMock = vi.mocked(getGitHubSource);
const listGitHubSourceSyncRunsMock = vi.mocked(listGitHubSourceSyncRuns);
const listSkillsMock = vi.mocked(listSkills);
const queueGitHubSourceLocalScanMock = vi.mocked(queueGitHubSourceLocalScan);
const unbindGitHubSourceItemMock = vi.mocked(unbindGitHubSourceItem);

const sourceDetail: GitHubSourceDetail = {
  source: {
    sourceId: "source-1",
    provider: "github",
    repositoryOwner: "acme",
    repositoryName: "skills",
    branch: "main",
    scanRoot: "skills/",
    excludePaths: ["archive/"],
    hasToken: true,
    autoPublish: true,
    schedule: "hourly",
    status: "active",
    lastAttemptAt: "2026-07-31T08:00:00Z",
    lastSuccessAt: "2026-07-31T08:01:00Z",
    lastSyncedCommitSha: "a".repeat(40),
    lastErrorSummary: "上次网络超时",
    createdBy: "usr_admin",
    createdAt: "2026-07-30T08:00:00Z",
    updatedAt: "2026-07-31T08:01:00Z"
  },
  items: [
    sourceItem({ sourceItemId: "item-active", discoveredName: "active-skill", status: "active", skillId: "skill-active" }),
    sourceItem({ sourceItemId: "item-conflict", discoveredName: "code-review", status: "name_conflict" }),
    sourceItem({ sourceItemId: "item-changed", discoveredName: "renamed-skill", status: "name_changed" }),
    sourceItem({ sourceItemId: "item-invalid", discoveredName: "broken-skill", status: "invalid", lastErrorSummary: "缺少 SKILL.md" }),
    sourceItem({ sourceItemId: "item-missing", discoveredName: "missing-skill", status: "missing", missingSince: "2026-07-31T08:00:00Z" })
  ],
  manualClone: null
};

describe("SkillSourceDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGitHubSourceMock.mockResolvedValue(sourceDetail);
    listGitHubSourceSyncRunsMock.mockResolvedValue([syncRun()]);
    listSkillsMock.mockResolvedValue([
      skill({ skillId: "skill-review", name: "code-review" }),
      skill({ skillId: "skill-other", name: "other-skill" })
    ]);
    bindGitHubSourceItemMock.mockResolvedValue({ ...sourceDetail.items[1], skillId: "skill-review", status: "active" });
    unbindGitHubSourceItemMock.mockResolvedValue({ ...sourceDetail.items[0], skillId: null, status: "name_conflict" });
    queueGitHubSourceLocalScanMock.mockResolvedValue({ runId: "run-local" });
  });

  it("shows source status, all source item states, and sync run evidence", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "acme/skills" })).toBeInTheDocument();
    expect(screen.getByText("Token 已设置")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("上次网络超时");
    expect(screen.getByText("正常")).toBeInTheDocument();
    expect(screen.getByText("名称冲突")).toBeInTheDocument();
    expect(screen.getByText("名称已变更")).toBeInTheDocument();
    expect(screen.getByText("无效")).toBeInTheDocument();
    expect(screen.getByText("缺失")).toBeInTheDocument();
    const sourceItemsSection = screen.getByRole("heading", { name: "来源项" }).closest("section") as HTMLElement;
    expect(within(sourceItemsSection).getByText("缺少 SKILL.md")).toBeVisible();
    expect(screen.getByText("manual")).toBeInTheDocument();
    expect(screen.getByTitle("b".repeat(40))).toHaveTextContent("bbbbbbbb");
    expect(screen.getByTitle("c".repeat(40))).toHaveTextContent("cccccccc");
    const runRow = screen.getByText("manual").closest("tr") as HTMLTableRowElement;
    expect(runRow).toHaveTextContent("7");
    expect(runRow).toHaveTextContent("3");
    expect(runRow).toHaveTextContent("2");
    expect(within(runRow).getAllByText("1")).toHaveLength(2);
    expect(runRow).toHaveTextContent("同步部分失败");
  });

  it("binds only a name conflict to a same-name Skill and confirms unbinding", async () => {
    renderPage();

    const bind = await screen.findByRole("button", { name: "绑定到现有 Skill code-review" });
    expect(screen.queryByRole("button", { name: /绑定到现有 Skill other-skill/ })).not.toBeInTheDocument();
    fireEvent.click(bind);
    await waitFor(() => expect(bindGitHubSourceItemMock).toHaveBeenCalledWith("item-conflict", "skill-review"));

    fireEvent.click(screen.getByRole("button", { name: "解绑 active-skill" }));
    const dialog = screen.getByRole("dialog", { name: "解除 Skill 绑定" });
    expect(unbindGitHubSourceItemMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认解绑" }));
    await waitFor(() => expect(unbindGitHubSourceItemMock).toHaveBeenCalledWith("item-active"));

    expect(screen.queryByRole("button", { name: /删除.*broken-skill|删除.*missing-skill/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /自动修复.*broken-skill|自动修复.*missing-skill/ })).not.toBeInTheDocument();
  });

  it("shows a visible binding error when the binding request fails", async () => {
    bindGitHubSourceItemMock.mockRejectedValue(new Error("无法绑定"));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "绑定到现有 Skill code-review" }));

    expect(await screen.findByText("绑定失败：无法绑定。")).toBeVisible();
  });

  it("keeps complete manual git commands behind an explicit button", async () => {
    const reason = "Git Clone 失败：git command failed: fatal: repository 'https://github.com/acme/skills.git/' not found";
    getGitHubSourceMock.mockResolvedValue({
      ...sourceDetail,
      source: { ...sourceDetail.source, lastErrorSummary: reason },
      manualClone: {
        workingDirectory: "/var/lib/claw-mcp/skill-sources/source-1",
        repositoryDirectory: "/var/lib/claw-mcp/skill-sources/source-1/repository",
        command: "git clone --progress --depth=1 --single-branch --no-tags --branch 'main' 'https://github.com/acme/skills.git' 'repository'",
        commandGroups: [
          { title: "首次同步：Clone", commands: ["git check-ref-format --branch 'main'", "git clone --progress --depth=1 --single-branch --no-tags --branch 'main' 'https://github.com/acme/skills.git' 'repository'"] },
          { title: "后续同步：Fetch", commands: ["git -C 'repository' remote get-url origin", "git -C 'repository' fetch --progress --prune --depth=1 origin 'main'"] },
          { title: "Skill 发现阶段", commands: ["git -C 'repository' ls-files --stage -z"] }
        ]
      }
    });

    renderPage();

    const commandButton = await screen.findByRole("button", { name: "手动操作命令" });
    expect(screen.getByRole("alert")).toHaveTextContent(reason);
    expect(screen.queryByText("/var/lib/claw-mcp/skill-sources/source-1/repository")).not.toBeInTheDocument();

    fireEvent.click(commandButton);

    const dialog = screen.getByRole("dialog", { name: "手动操作命令" });
    expect(within(dialog).getByText("/var/lib/claw-mcp/skill-sources/source-1")).toBeVisible();
    expect(within(dialog).getByText("/var/lib/claw-mcp/skill-sources/source-1/repository")).toBeVisible();
    expect(within(dialog).getByRole("heading", { name: "首次同步：Clone" })).toBeVisible();
    expect(within(dialog).getByRole("heading", { name: "后续同步：Fetch" })).toBeVisible();
    expect(within(dialog).getByRole("heading", { name: "Skill 发现阶段" })).toBeVisible();
    expect(within(dialog).getByText(/git clone --progress/)).toBeVisible();
    expect(within(dialog).getByText(/fetch --progress --prune/)).toBeVisible();
    expect(within(dialog).getByText(/ls-files --stage -z/)).toBeVisible();
    expect(within(dialog).getByText(/命令不包含已保存 Token/)).toBeVisible();

    fireEvent.click(within(dialog).getByRole("button", { name: "使用本地仓库继续扫描" }));
    await waitFor(() => expect(queueGitHubSourceLocalScanMock).toHaveBeenCalledWith("source-1"));
    expect(await screen.findByText(/本地仓库扫描任务已进入队列，运行 ID：run-local/)).toBeVisible();
  });

  it("keeps binding controls hidden for a read-only user", async () => {
    renderPage([permissions.skillRead]);

    await screen.findByText("名称冲突");
    expect(screen.queryByRole("button", { name: /绑定到现有 Skill/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /解绑 active-skill/ })).not.toBeInTheDocument();
  });
});

function renderPage(adminPermissions?: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const page = <QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/admin/skills/source-detail?source_id=source-1"]}><Routes><Route path="/admin/skills/source-detail" element={<SkillSourceDetailPage />} /></Routes></MemoryRouter></QueryClientProvider>;
  return render(adminPermissions ? <AdminPermissionsProvider account={{ userId: "usr_reader", email: "reader@example.com", name: "Reader", status: "active", adminPermissions }}>{page}</AdminPermissionsProvider> : page);
}

function skill(overrides: Partial<AdminSkill>): AdminSkill {
  return { skillId: "skill-default", name: "default-skill", description: "企业 Skill", currentVersionId: null, createdBy: "usr_admin", createdAt: "2026-07-30T08:00:00Z", updatedAt: "2026-07-31T08:00:00Z", ...overrides };
}

function sourceItem(overrides: Partial<SkillSourceItem>): SkillSourceItem {
  return { sourceItemId: "item-default", sourceId: "source-1", skillPath: "skills/default/SKILL.md", discoveredName: "default-skill", skillId: null, status: "active", lastSeenCommitSha: "a".repeat(40), lastContentSha256: "d".repeat(64), lastVersionId: null, lastErrorSummary: "", missingSince: null, createdAt: "2026-07-30T08:00:00Z", updatedAt: "2026-07-31T08:00:00Z", ...overrides };
}

function syncRun(overrides: Partial<SkillSourceSyncRun> = {}): SkillSourceSyncRun {
  return { runId: "run-1", sourceId: "source-1", trigger: "manual", repositoryMode: "remote", status: "failed", requestedBy: "usr_admin", beforeCommitSha: "b".repeat(40), targetCommitSha: "c".repeat(40), discoveredCount: 7, createdVersionCount: 3, publishedCount: 2, conflictCount: 1, failedCount: 1, errorSummary: "同步部分失败", startedAt: "2026-07-31T08:00:00Z", finishedAt: "2026-07-31T08:01:00Z", createdAt: "2026-07-31T08:00:00Z", ...overrides };
}
