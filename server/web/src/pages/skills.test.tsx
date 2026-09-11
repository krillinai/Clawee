import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import {
  enableGitHubSource,
  getGitHubSourceToken,
  listGitHubSources,
	listSkillSpaces,
  listSkills,
  moveSkillsToSpace,
  publishLatestSkillVersions,
  queueGitHubSourceSync,
  updateGitHubSource,
  uploadSkillVersion,
  type AdminSkill,
  type GitHubSource,
  type GitHubSourceSummary,
  type SkillSourceSyncRun,
  type SkillVersion
} from "@/lib/skillhub-api";
import { permissions } from "@/lib/rbac-api";

import { SkillsPage } from "./skills";

const { skillSourceAvailabilityMock } = vi.hoisted(() => ({ skillSourceAvailabilityMock: vi.fn() }));

vi.mock("@/lib/skillhub-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/skillhub-api")>("@/lib/skillhub-api");
  return {
    ...actual,
    getSkillSourceAvailability: skillSourceAvailabilityMock,
    enableGitHubSource: vi.fn(),
    getGitHubSourceToken: vi.fn(),
    listGitHubSources: vi.fn(),
		listSkillSpaces: vi.fn(),
    listSkills: vi.fn(),
    moveSkillsToSpace: vi.fn(),
    publishLatestSkillVersions: vi.fn(),
    queueGitHubSourceSync: vi.fn(),
    updateGitHubSource: vi.fn(),
    uploadSkillVersion: vi.fn()
  };
});

const listSkillsMock = vi.mocked(listSkills);
const listSkillSpacesMock = vi.mocked(listSkillSpaces);
const moveSkillsToSpaceMock = vi.mocked(moveSkillsToSpace);
const publishLatestSkillVersionsMock = vi.mocked(publishLatestSkillVersions);
const listGitHubSourcesMock = vi.mocked(listGitHubSources);
const enableGitHubSourceMock = vi.mocked(enableGitHubSource);
const getGitHubSourceTokenMock = vi.mocked(getGitHubSourceToken);
const queueGitHubSourceSyncMock = vi.mocked(queueGitHubSourceSync);
const updateGitHubSourceMock = vi.mocked(updateGitHubSource);
const uploadSkillVersionMock = vi.mocked(uploadSkillVersion);

const published = skill({ skillId: "skill-1", name: "code-review", currentVersionId: "version-2" });
const unpublished = skill({ skillId: "skill-2", name: "release-notes", currentVersionId: null });
const uploadedVersion = version({ versionId: "version-3", version: "1.3.0" });
const sourceSummary: GitHubSourceSummary = {
  source: githubSource({ lastSyncedCommitSha: "a".repeat(40) }),
  latestRun: syncRun({ targetCommitSha: "a".repeat(40), discoveredCount: 7 }),
  discoveredCount: 7
};

describe("SkillsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    skillSourceAvailabilityMock.mockResolvedValue(true);
    listGitHubSourcesMock.mockResolvedValue([sourceSummary]);
		listSkillSpacesMock.mockResolvedValue([{
			spaceId: "skillspace_default",
			name: "默认技能空间",
			description: "",
			actions: [],
			memberCount: 0,
			skillCount: 2,
			publishedCount: 1,
			createdBy: "system",
			updatedBy: "system",
			createdAt: "2026-07-27T08:00:00Z",
			updatedAt: "2026-07-27T08:00:00Z"
		}, {
			spaceId: "skillspace_product",
			name: "产品技能空间",
			description: "",
			actions: [],
			memberCount: 0,
			skillCount: 0,
			publishedCount: 0,
			createdBy: "usr_admin",
			updatedBy: "usr_admin",
			createdAt: "2026-08-24T08:00:00Z",
			updatedAt: "2026-08-24T08:00:00Z"
		}]);
    enableGitHubSourceMock.mockResolvedValue(sourceSummary.source);
    getGitHubSourceTokenMock.mockResolvedValue("github_pat_saved");
    queueGitHubSourceSyncMock.mockResolvedValue({ runId: "run-queued" });
    updateGitHubSourceMock.mockResolvedValue(sourceSummary.source);
    listSkillsMock.mockResolvedValue([published, unpublished]);
    publishLatestSkillVersionsMock.mockResolvedValue({
      published: [
        { skill: published, version: version({ versionId: "version-3", skillId: published.skillId, version: "1.3.0" }) },
        { skill: unpublished, version: version({ versionId: "version-1", skillId: unpublished.skillId }) }
      ],
      failed: []
    });
    moveSkillsToSpaceMock.mockResolvedValue({ targetSpaceId: "skillspace_product", movedCount: 2, unchangedCount: 0 });
    uploadSkillVersionMock.mockResolvedValue({
      skill: { ...published, currentVersionId: uploadedVersion.versionId },
      version: uploadedVersion
    });
  });

  it("filters skills by publication status", async () => {
    renderPage();

    expect(await screen.findByText("code-review")).toBeInTheDocument();
    expect(screen.getByText("release-notes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "筛选发布状态" }));
    fireEvent.click(await within(screen.getByRole("listbox")).findByRole("option", { name: "已发布" }));

    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.queryByText("release-notes")).not.toBeInTheDocument();
  });

  it("keeps tab workspaces concise with deliberate vertical spacing", async () => {
    renderPage();

    const skillPanel = await screen.findByRole("tabpanel", { name: "Skill 列表" });
    expect(skillPanel).toHaveClass("mt-6");
    expect(within(skillPanel).getByRole("region", { name: "Skill 列表" })).toHaveClass("gap-4");
    expect(screen.getAllByText("Skill 列表")).toHaveLength(1);
    expect(screen.queryByText("按更新时间倒序展示全部 Skill，未发布版本不会出现在用户侧目录。")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批量发布" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "调整空间" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传版本" })).toBeInTheDocument();

    clickTab(screen.getByRole("tab", { name: "技能空间" }));
    const spacesPanel = await screen.findByRole("tabpanel", { name: "技能空间" });
    expect(spacesPanel).toHaveClass("mt-6");
    expect(within(spacesPanel).queryByRole("heading", { name: "技能空间" })).not.toBeInTheDocument();
    expect(screen.queryByText("管理 Clawee Agent 客户端的技能查看和上传范围。")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传版本" })).not.toBeInTheDocument();
  });

  it("uploads a version from a shadcn field form", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "上传版本" }));
    const dialog = screen.getByRole("dialog", { name: "上传 Skill 版本" });
    expect(dialog.querySelector('[data-slot="field-group"]')).toBeInTheDocument();
    expect(within(dialog).getByText("ZIP 可直接包含 SKILL.md，也可将全部内容放在单一顶层目录中；上传成功后将自动发布该版本，并替换当前发布版本。")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("版本号"), { target: { value: "1.3.0" } });
    fireEvent.change(within(dialog).getByLabelText("更新说明"), { target: { value: "补充安装脚本" } });
    const file = new File(["zip"], "code-review.zip", { type: "application/zip" });
    fireEvent.change(within(dialog).getByLabelText("Skill ZIP 包"), { target: { files: [file] } });
    const submit = within(dialog).getByRole("button", { name: "确认上传" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);

		await waitFor(() => expect(uploadSkillVersionMock).toHaveBeenCalledWith({ spaceId: "skillspace_default", version: "1.3.0", changelog: "补充安装脚本", packageFile: file }));
    expect(await screen.findByText("Skill“code-review”版本 1.3.0 已上传并发布")).toBeInTheDocument();
  });

  it("links each skill to its independent detail page", async () => {
    renderPage();

    expect(await screen.findByRole("link", { name: "查看 code-review 详情" })).toHaveAttribute(
      "href",
      "/admin/skills/detail?skill_id=skill-1"
    );
    expect(screen.queryByRole("dialog", { name: "code-review" })).not.toBeInTheDocument();
  });

  it("selects visible skills and publishes their latest versions after confirmation", async () => {
    renderPage();

    expect(screen.queryByRole("button", { name: "批量发布" })).not.toBeInTheDocument();
    await screen.findByText("release-notes");
    fireEvent.click(screen.getByRole("checkbox", { name: "选择当前可见的 Skill" }));
    expect(screen.getByRole("button", { name: "批量发布（2）" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "批量发布（2）" }));
    const dialog = screen.getByRole("dialog", { name: "批量发布 Skill" });
    expect(dialog).toHaveTextContent("将所选 2 个 Skill 的最新上传版本设为当前版本");
    expect(publishLatestSkillVersionsMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认发布 2 个" }));

    await waitFor(() => expect(publishLatestSkillVersionsMock).toHaveBeenCalledWith([
      { skillId: "skill-1", name: "code-review" },
      { skillId: "skill-2", name: "release-notes" }
    ]));
    expect(await screen.findByText("已批量发布 2 个 Skill 的最新版本")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "批量发布" })).not.toBeInTheDocument());
  });

  it("selects only the filtered rows and keeps failed skills selected for retry", async () => {
    publishLatestSkillVersionsMock.mockResolvedValueOnce({
      published: [],
      failed: [{ skillId: unpublished.skillId, name: unpublished.name, error: new Error("版本不存在") }]
    });
    renderPage();

    await screen.findByText("code-review");
    fireEvent.click(screen.getByRole("combobox", { name: "筛选发布状态" }));
    fireEvent.click(await within(screen.getByRole("listbox")).findByRole("option", { name: "未发布" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择当前可见的 Skill" }));
    expect(screen.getByRole("checkbox", { name: "选择 release-notes" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "批量发布（1）" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "批量发布 Skill" })).getByRole("button", { name: "确认发布 1 个" }));

    expect(await screen.findByText("有 1 个 Skill 发布失败：release-notes（版本不存在）")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择 release-notes" })).toBeChecked();
    expect(screen.getByRole("button", { name: "批量发布（1）" })).toBeEnabled();
  });

  it("moves selected skills to one target space with an atomic request", async () => {
    renderPage();

    await screen.findByText("release-notes");
    fireEvent.click(screen.getByRole("checkbox", { name: "选择当前可见的 Skill" }));
    fireEvent.click(screen.getByRole("button", { name: "调整空间（2）" }));

    const dialog = screen.getByRole("dialog", { name: "批量调整技能空间" });
    expect(dialog).toHaveTextContent("已选择 2 个 Skill，来自 1 个技能空间；实际调整 2 个");
    expect(within(dialog).getByRole("combobox", { name: "目标技能空间" })).toHaveTextContent("产品技能空间");
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(moveSkillsToSpaceMock).toHaveBeenCalledWith({
      skillIds: ["skill-1", "skill-2"],
      targetSpaceId: "skillspace_product"
    }));
    expect(await screen.findByText("已将 2 个 Skill 调整至“产品技能空间”")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "调整空间" })).not.toBeInTheDocument());
  });

  it("keeps the batch space dialog and selection after an atomic failure", async () => {
    moveSkillsToSpaceMock.mockRejectedValueOnce(new Error("目标空间不存在"));
    renderPage();

    fireEvent.click(await screen.findByRole("checkbox", { name: "选择 code-review" }));
    fireEvent.click(screen.getByRole("button", { name: "调整空间（1）" }));
    const dialog = screen.getByRole("dialog", { name: "批量调整技能空间" });
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);

    expect(await within(dialog).findByText("调整失败：目标空间不存在。本次未调整任何 Skill。")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "批量调整技能空间" })).not.toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "选择 code-review" })).toBeChecked();
    expect(screen.getByRole("button", { name: "调整空间（1）" })).toBeEnabled();
  });

  it("keeps the Skill list as the default tab and displays GitHub source operations after switching", async () => {
    renderPage();

    expect(await screen.findByText("code-review")).toBeInTheDocument();
    clickTab(await screen.findByRole("tab", { name: "GitHub 来源" }));

    expect(await screen.findByText("acme/skills")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("skills/")).toBeInTheDocument();
    expect(screen.getByText("每小时")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "自动发布" })).toBeInTheDocument();
    expect(screen.getByText("启用")).toBeInTheDocument();
    expect(screen.getByTitle("a".repeat(40))).toHaveTextContent("aaaaaaaa");
    expect(screen.getByRole("link", { name: "查看 Commit aaaaaaaa" })).toHaveAttribute("href", `https://github.com/acme/skills/commit/${"a".repeat(40)}`);
    expect(screen.getByText("成功")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增来源" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑 acme/skills" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即同步 acme/skills" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "禁用 acme/skills" })).toHaveClass("bg-secondary");
  });

  it("hides GitHub source governance when the backend capability is disabled", async () => {
    skillSourceAvailabilityMock.mockResolvedValueOnce(false);
    renderPage();

    expect(await screen.findByText("code-review")).toBeInTheDocument();
    await waitFor(() => expect(skillSourceAvailabilityMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("tab", { name: "GitHub 来源" })).not.toBeInTheDocument();
    expect(listGitHubSourcesMock).not.toHaveBeenCalled();
  });

  it("does not expose source write operations to a read-only user", async () => {
    renderPage([permissions.skillRead]);

    expect(await screen.findByText("code-review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批量发布" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "选择 code-review" })).not.toBeInTheDocument();

    clickTab(await screen.findByRole("tab", { name: "GitHub 来源" }));
    expect(await screen.findByText("acme/skills")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新增来源" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑 acme/skills" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "立即同步 acme/skills" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "禁用 acme/skills" })).not.toBeInTheDocument();
  });

  it("reports a queued sync run and refreshes the source view", async () => {
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "GitHub 来源" }));
    fireEvent.click(await screen.findByRole("button", { name: "立即同步 acme/skills" }));

    await waitFor(() => expect(queueGitHubSourceSyncMock).toHaveBeenCalledWith("source-1", expect.anything()));
    expect(await screen.findByText("已排队，同步任务 run-queued 正在等待执行")).toBeInTheDocument();
    await waitFor(() => expect(listGitHubSourcesMock).toHaveBeenCalledTimes(2));
  });

  it("shows the current discovered count when the latest sync attempt failed before discovery", async () => {
    listGitHubSourcesMock.mockResolvedValue([{
      ...sourceSummary,
      latestRun: syncRun({ status: "failed", discoveredCount: 0, errorSummary: "仓库工作区更新失败" }),
      discoveredCount: 86
    }]);
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "GitHub 来源" }));

    expect(await screen.findByRole("cell", { name: "86" })).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
  });

  it("loads the saved token for editing and preserves it when the field is cleared", async () => {
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "GitHub 来源" }));
    fireEvent.click(await screen.findByRole("button", { name: "编辑 acme/skills" }));

    const dialog = await screen.findByRole("dialog", { name: "编辑 GitHub 来源" });
    expect(getGitHubSourceTokenMock).toHaveBeenCalledWith("source-1");
    expect(within(dialog).getByLabelText("访问 Token")).toHaveValue("github_pat_saved");
    fireEvent.change(within(dialog).getByLabelText("访问 Token"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存来源" }));

    await waitFor(() => expect(updateGitHubSourceMock).toHaveBeenCalledWith("source-1", expect.anything()));
    expect(updateGitHubSourceMock.mock.calls[0]?.[1]).not.toHaveProperty("token");
  });

  it("shows the stable service error when queuing a sync fails", async () => {
    queueGitHubSourceSyncMock.mockRejectedValueOnce(new Error("同步服务不可用"));
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "GitHub 来源" }));
    fireEvent.click(await screen.findByRole("button", { name: "立即同步 acme/skills" }));

    expect(await screen.findByText("同步失败：同步服务不可用")).toBeInTheDocument();
  });

  it("shows the stable service error when enabling a source fails", async () => {
    listGitHubSourcesMock.mockResolvedValue([{ ...sourceSummary, source: { ...sourceSummary.source, status: "disabled" } }]);
    enableGitHubSourceMock.mockRejectedValueOnce(new Error("启用服务不可用"));
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "GitHub 来源" }));
    fireEvent.click(await screen.findByRole("button", { name: "启用 acme/skills" }));

    expect(await screen.findByText("启用失败：启用服务不可用")).toBeInTheDocument();
  });

  it("replaces a stale sync error with the latest source action error", async () => {
    listGitHubSourcesMock.mockResolvedValue([{ ...sourceSummary, source: { ...sourceSummary.source, status: "disabled" } }]);
    queueGitHubSourceSyncMock.mockRejectedValueOnce(new Error("同步服务不可用"));
    enableGitHubSourceMock.mockRejectedValueOnce(new Error("启用服务不可用"));
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "GitHub 来源" }));
    fireEvent.click(await screen.findByRole("button", { name: "立即同步 acme/skills" }));
    expect(await screen.findByText("同步失败：同步服务不可用")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "启用 acme/skills" }));
    expect(await screen.findByText("启用失败：启用服务不可用")).toBeInTheDocument();
    expect(screen.queryByText("同步失败：同步服务不可用")).not.toBeInTheDocument();
  });
});

function renderPage(adminPermissions?: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/admin/skills"]}>
        {adminPermissions ? <AdminPermissionsProvider account={{
          userId: "usr_reader",
          email: "reader@example.com",
          name: "Reader",
          status: "active",
          adminPermissions
        }}><SkillsPage /></AdminPermissionsProvider> : <SkillsPage />}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function clickTab(tab: HTMLElement) {
  fireEvent.pointerDown(tab);
  fireEvent.mouseDown(tab);
  fireEvent.mouseUp(tab);
  fireEvent.click(tab);
}

function skill(overrides: Partial<AdminSkill>): AdminSkill {
  return {
    skillId: "skill-default",
		spaceId: "skillspace_default",
		spaceName: "默认技能空间",
    name: "default-skill",
    description: "企业 Skill",
    currentVersionId: null,
    createdBy: "usr_admin",
    createdAt: "2026-07-27T08:00:00Z",
    updatedAt: "2026-07-27T09:00:00Z",
    ...overrides
  };
}

function version(overrides: Partial<SkillVersion>): SkillVersion {
  return {
    versionId: "version-default",
    skillId: "skill-1",
    version: "1.0.0",
    description: "企业代码审查规范",
    changelog: "更新说明",
    packageSha256: "a".repeat(64),
    source: null,
    createdAt: "2026-07-27T08:30:00Z",
    ...overrides
  };
}

function githubSource(overrides: Partial<GitHubSource> = {}): GitHubSource {
  return {
    sourceId: "source-1",
		spaceId: "skillspace_default",
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
    lastSyncedCommitSha: null,
    lastErrorSummary: "",
    createdBy: "usr_admin",
    createdAt: "2026-07-30T08:00:00Z",
    updatedAt: "2026-07-31T08:01:00Z",
    ...overrides
  };
}

function syncRun(overrides: Partial<SkillSourceSyncRun> = {}): SkillSourceSyncRun {
  return {
    runId: "run-1",
    sourceId: "source-1",
    trigger: "manual",
    repositoryMode: "remote",
    status: "success",
    requestedBy: "usr_admin",
    beforeCommitSha: null,
    targetCommitSha: null,
    discoveredCount: 0,
    createdVersionCount: 0,
    publishedCount: 0,
    conflictCount: 0,
    failedCount: 0,
    errorSummary: "",
    startedAt: "2026-07-31T08:00:00Z",
    finishedAt: "2026-07-31T08:01:00Z",
    createdAt: "2026-07-31T08:00:00Z",
    ...overrides
  };
}
