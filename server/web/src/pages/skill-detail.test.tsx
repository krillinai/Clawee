import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCurrentSkillVersion,
  getSkill,
  getSkillVersionFile,
  listSkillVersionFiles,
  setCurrentSkillVersion,
  SkillHubAPIError,
  type AdminSkillDetail,
  type SkillVersion
} from "@/lib/skillhub-api";

import { SkillDetailPage } from "./skill-detail";

vi.mock("@/lib/skillhub-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/skillhub-api")>("@/lib/skillhub-api");
  return {
    ...actual,
    clearCurrentSkillVersion: vi.fn(),
    getSkill: vi.fn(),
    getSkillVersionFile: vi.fn(),
    listSkillVersionFiles: vi.fn(),
    setCurrentSkillVersion: vi.fn()
  };
});

const getSkillMock = vi.mocked(getSkill);
const listSkillVersionFilesMock = vi.mocked(listSkillVersionFiles);
const getSkillVersionFileMock = vi.mocked(getSkillVersionFile);
const setCurrentSkillVersionMock = vi.mocked(setCurrentSkillVersion);
const clearCurrentSkillVersionMock = vi.mocked(clearCurrentSkillVersion);

const detail: AdminSkillDetail = {
  skill: {
    skillId: "skill-1",
    name: "web-tools-guide",
    description: "为企业 Agent 提供网页工具使用规范。",
    currentVersionId: "version-2",
    createdBy: "usr_admin",
    createdAt: "2026-07-27T08:00:00Z",
    updatedAt: "2026-07-27T10:00:00Z"
  },
  versions: [
    version({ versionId: "version-1", version: "1.0.0", createdAt: "2026-07-27T08:30:00Z" }),
    version({ versionId: "version-2", version: "1.1.0", createdAt: "2026-07-27T09:30:00Z" }),
    version({ versionId: "version-3", version: "1.2.0", createdAt: "2026-07-27T10:30:00Z" })
  ]
};

describe("SkillDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSkillMock.mockResolvedValue(detail);
    listSkillVersionFilesMock.mockImplementation(async (_skillId, versionId) => ({
      items: versionId === "version-3"
        ? [{ path: "SKILL.md", size: 86 }, { path: "assets/logo.png", size: 2048 }]
        : [{ path: "SKILL.md", size: 96 }, { path: "scripts/install.sh", size: 42 }, { path: "scripts/Makefile", size: 24 }]
    }));
    getSkillVersionFileMock.mockImplementation(async (_skillId, versionId, path) => {
      if (path === "assets/logo.png") {
        throw new SkillHubAPIError("该文件不支持在线预览", 422, "file_not_previewable");
      }
      return {
        path,
        size: 96,
        content: path === "SKILL.md"
          ? `---\nname: hidden-name\ndescription: hidden-description\n---\n# ${versionId === "version-3" ? "最新版概述" : "当前版概述"}\n\n| 能力 | 状态 |\n| --- | --- |\n| 网页读取 | 可用 |\n\n<script>alert("unsafe")</script>`
          : path.endsWith("Makefile") ? "build:\n\tmake test" : "#!/bin/sh\necho install"
      };
    });
    setCurrentSkillVersionMock.mockResolvedValue({ skill: { ...detail.skill, currentVersionId: "version-3" }, version: detail.versions[2] });
    clearCurrentSkillVersionMock.mockResolvedValue(undefined);
  });

  it("defaults to the published version and safely renders its overview", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "web-tools-guide" })).toBeInTheDocument();
    expect(screen.getByText("为企业 Agent 提供网页工具使用规范。")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "当前版概述" })).toBeInTheDocument();
    expect(getSkillVersionFileMock).toHaveBeenCalledWith("skill-1", "version-2", "SKILL.md");
    expect(screen.queryByText("hidden-name", { exact: false })).not.toBeInTheDocument();
    expect(document.querySelector("script")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载 ZIP 包安装" })).toHaveAttribute(
      "href",
      "/api/v1/admin/skills/version-package?skill_id=skill-1&version_id=version-2"
    );
    expect(screen.getByRole("link", { name: "下载 ZIP 包安装" })).toHaveAttribute(
      "download",
      "web-tools-guide-1.1.0.zip"
    );
  });

  it("switches overview, files, and package target when viewing a historical version", async () => {
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "版本历史" }));
    const history = screen.getByRole("tabpanel", { name: "版本历史" });
    const rows = within(history).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("1.2.0");
    expect(rows[1]).toHaveTextContent("最新上传");
    expect(rows[2]).toHaveTextContent("1.1.0");
    expect(rows[2]).toHaveTextContent("当前");

    fireEvent.click(within(history).getByRole("button", { name: "查看此版本 1.2.0" }));
    clickTab(screen.getByRole("tab", { name: "概述" }));

    expect(await screen.findByRole("heading", { name: "最新版概述" })).toBeInTheDocument();
    expect(screen.getByText("当前查看版本 1.2.0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设为当前查看版本 1.2.0" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载 ZIP 包安装" })).toHaveAttribute(
      "href",
      "/api/v1/admin/skills/version-package?skill_id=skill-1&version_id=version-3"
    );

    clickTab(screen.getByRole("tab", { name: "文件" }));
    expect(await screen.findByRole("button", { name: "预览 assets/logo.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "预览 assets/logo.png" }));
    expect(await screen.findByText("该文件不支持在线预览")).toBeInTheDocument();
    expect(getSkillVersionFileMock).toHaveBeenCalledWith("skill-1", "version-3", "assets/logo.png");
  });

  it("lets the backend preview unknown extensions and uses ordinary nested list semantics", async () => {
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "文件" }));
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(document.querySelector('[role="treeitem"], [role="group"], [aria-expanded]')).not.toBeInTheDocument();
    const makefileButton = await screen.findByRole("button", { name: "预览 scripts/Makefile" });
    fireEvent.click(makefileButton);

    expect(await screen.findByText("make test", { exact: false })).toBeInTheDocument();
    expect(getSkillVersionFileMock).toHaveBeenCalledWith("skill-1", "version-2", "scripts/Makefile");
    expect(makefileButton).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "返回文件列表" })).toBeInTheDocument();
  });

  it("shows ordinary file loading errors instead of the unsupported preview state", async () => {
    listSkillVersionFilesMock.mockResolvedValue({ items: [{ path: "SKILL.md", size: 96 }, { path: "notes.custom", size: 24 }] });
    getSkillVersionFileMock.mockImplementation(async (_skillId, _versionId, path) => {
      if (path === "notes.custom") throw new SkillHubAPIError("文件不存在", 404, "not_found");
      return { path, size: 96, content: "---\nname: test\ndescription: test\n---\n# 概述" };
    });
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "预览 notes.custom" }));

    expect(await screen.findByText("文件预览加载失败：文件不存在。")).toBeInTheDocument();
    expect(screen.queryByText("该文件不支持在线预览")).not.toBeInTheDocument();
  });

  it("shows the files request error in overview instead of a missing SKILL.md state", async () => {
    listSkillVersionFilesMock.mockRejectedValue(new Error("目录读取失败"));
    renderPage();

    expect(await screen.findByText("概述加载失败：目录读取失败。")).toBeInTheDocument();
    expect(screen.queryByText("暂无概述")).not.toBeInTheDocument();
    expect(getSkillVersionFileMock).not.toHaveBeenCalled();
  });

  it("allows long version and directory names to shrink and wrap", async () => {
    const longVersion = "release-2026-07-28-with-a-very-long-enterprise-version-name";
    const longDirectory = "enterprise-web-automation-reference-materials-with-a-very-long-directory-name";
    getSkillMock.mockResolvedValue({
      skill: { ...detail.skill, currentVersionId: "version-long" },
      versions: [version({ versionId: "version-long", version: longVersion })]
    });
    listSkillVersionFilesMock.mockResolvedValue({
      items: [{ path: "SKILL.md", size: 96 }, { path: `${longDirectory}/guide.txt`, size: 24 }]
    });
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "版本历史" }));
    expect(screen.getByText(longVersion)).toHaveClass("min-w-0", "break-all");
    clickTab(screen.getByRole("tab", { name: "文件" }));
    expect(await screen.findByText(longDirectory)).toHaveClass("min-w-0", "break-all");
  });

  it("keeps publish and unpublish actions behind confirmations", async () => {
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "版本历史" }));
    fireEvent.click(screen.getByRole("button", { name: "设为当前版本 1.2.0" }));
    let confirm = screen.getByRole("dialog", { name: "设为当前版本" });
    expect(setCurrentSkillVersionMock).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "确认发布" }));
    await waitFor(() => expect(setCurrentSkillVersionMock).toHaveBeenCalledWith("skill-1", "version-3"));

    fireEvent.click(screen.getByRole("button", { name: "取消当前发布" }));
    confirm = screen.getByRole("dialog", { name: "取消当前发布" });
    fireEvent.click(within(confirm).getByRole("button", { name: "确认取消发布" }));
    await waitFor(() => expect(clearCurrentSkillVersionMock).toHaveBeenCalledWith("skill-1"));
  });

  it("falls back to the newest uploaded version when no version is published", async () => {
    getSkillMock.mockResolvedValue({ skill: { ...detail.skill, currentVersionId: null }, versions: detail.versions });

    renderPage();

    expect(await screen.findByText("当前查看版本 1.2.0")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "最新版概述" })).toBeInTheDocument();
    expect(getSkillVersionFileMock).toHaveBeenCalledWith("skill-1", "version-3", "SKILL.md");
  });

  it("shows GitHub repository, path, and the full Commit evidence for sourced versions", async () => {
    const commitSha = "b".repeat(40);
    getSkillMock.mockResolvedValue({
      ...detail,
      versions: detail.versions.map((item) => item.versionId === "version-2" ? {
        ...item,
        source: {
          sourceId: "source-1",
          repositoryOwner: "acme",
          repositoryName: "skills",
          path: "engineering/code-review/SKILL.md",
          commitSha,
          contentSha256: "c".repeat(64)
        }
      } : item)
    });

    renderPage();

    expect(await screen.findByText("acme/skills")).toBeInTheDocument();
    expect(screen.getByText("engineering/code-review/SKILL.md")).toBeInTheDocument();
    const commit = screen.getByRole("link", { name: `查看 Commit ${commitSha}` });
    expect(commit).toHaveAttribute("href", `https://github.com/acme/skills/commit/${commitSha}`);
    expect(commit).toHaveAttribute("target", "_blank");
    expect(commit).toHaveAttribute("rel", "noreferrer");

    clickTab(screen.getByRole("tab", { name: "版本历史" }));
    expect(within(screen.getByRole("tabpanel", { name: "版本历史" })).getByText("engineering/code-review/SKILL.md")).toBeInTheDocument();
  });

  it("does not render a source evidence block for manually uploaded versions", async () => {
    renderPage();

    await screen.findByRole("heading", { name: "web-tools-guide" });
    expect(screen.queryByText("GitHub 来源")).not.toBeInTheDocument();
  });
});

function clickTab(tab: HTMLElement) {
  fireEvent.pointerDown(tab);
  fireEvent.mouseDown(tab);
  fireEvent.mouseUp(tab);
  fireEvent.click(tab);
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/admin/skills/detail?skill_id=skill-1"]}>
        <Routes>
          <Route path="/admin/skills/detail" element={<SkillDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function version(overrides: Partial<SkillVersion>): SkillVersion {
  return {
    versionId: "version-default",
    skillId: "skill-1",
    version: "1.0.0",
    description: "企业网页工具规范",
    changelog: "更新说明",
    packageSha256: "a".repeat(64),
    source: null,
    createdAt: "2026-07-27T08:30:00Z",
    ...overrides
  };
}
