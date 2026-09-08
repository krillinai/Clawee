import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPublishedSkill,
  getPublishedSkillVersionFile,
  listAuthorizedSkillSpaces,
  listPublishedSkills,
  listPublishedSkillVersionFiles,
  uploadAppSkillVersion
} from "@/lib/skillhub-api";

import { AppSkillsPage } from "./app-skills";

vi.mock("@/lib/skillhub-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/skillhub-api")>("@/lib/skillhub-api");
  return {
    ...actual,
    getPublishedSkill: vi.fn(),
    getPublishedSkillVersionFile: vi.fn(),
    listAuthorizedSkillSpaces: vi.fn(),
    listPublishedSkills: vi.fn(),
    listPublishedSkillVersionFiles: vi.fn(),
    uploadAppSkillVersion: vi.fn()
  };
});

const getPublishedSkillMock = vi.mocked(getPublishedSkill);
const listAuthorizedSkillSpacesMock = vi.mocked(listAuthorizedSkillSpaces);
const listPublishedSkillsMock = vi.mocked(listPublishedSkills);
const listPublishedSkillVersionFilesMock = vi.mocked(listPublishedSkillVersionFiles);
const getPublishedSkillVersionFileMock = vi.mocked(getPublishedSkillVersionFile);
const uploadAppSkillVersionMock = vi.mocked(uploadAppSkillVersion);

describe("AppSkillsPage published detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPublishedSkillMock.mockResolvedValue({
      skillId: "skill-1",
      name: "web-tools-guide",
      description: "为企业 Agent 提供网页工具使用规范。",
      versionId: "version-2",
      version: "1.1.0",
      packageSha256: "a".repeat(64),
      changelog: "补充网页读取规则",
      updatedAt: "2026-07-27T10:00:00Z"
    });
    listPublishedSkillsMock.mockResolvedValue([{
      skillId: "skill-1",
      spaceId: "space-read",
      spaceName: "只读空间",
      name: "web-tools-guide",
      description: "为企业 Agent 提供网页工具使用规范。",
      versionId: "version-2",
      version: "1.1.0",
      packageSha256: "a".repeat(64),
      updatedAt: "2026-07-27T10:00:00Z"
    }]);
    listAuthorizedSkillSpacesMock.mockResolvedValue([
      skillSpace("space-read", "只读空间", ["read"]),
      skillSpace("space-write", "可写空间", ["read", "write"])
    ]);
    uploadAppSkillVersionMock.mockResolvedValue({
      skill: {
        skillId: "skill-2",
        spaceId: "space-write",
        spaceName: "可写空间",
        name: "release-helper",
        description: "发布辅助技能",
        currentVersionId: "version-1",
        createdBy: "当前用户",
        createdAt: "2026-08-24T10:00:00Z",
        updatedAt: "2026-08-24T10:00:00Z"
      },
      version: {
        versionId: "version-1",
        skillId: "skill-2",
        version: "1.0.0",
        description: "发布辅助技能",
        changelog: "首次上传",
        packageSha256: "b".repeat(64),
        source: null,
        createdAt: "2026-08-24T10:00:00Z"
      }
    });
    listPublishedSkillVersionFilesMock.mockResolvedValue({
      items: [{ path: "SKILL.md", size: 96 }, { path: "scripts/install.sh", size: 42 }]
    });
    getPublishedSkillVersionFileMock.mockImplementation(async (_skillId, _versionId, path) => ({
      path,
      size: path === "SKILL.md" ? 96 : 42,
      content: path === "SKILL.md"
        ? "---\nname: hidden\ndescription: hidden\n---\n# 用户端概述\n\n正文"
        : "#!/bin/sh\necho install"
    }));
  });

  it("renders the shared read-only detail content without publication management", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "web-tools-guide" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "用户端概述" })).toBeInTheDocument();
    expect(screen.getByText("当前查看版本 1.1.0")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载 ZIP 包安装" })).toHaveAttribute(
      "href",
      "/api/v1/app/skills/package?skill_id=skill-1&version_id=version-2"
    );

    clickTab(screen.getByRole("tab", { name: "文件" }));
    expect(await screen.findByRole("button", { name: "预览 scripts/install.sh" })).toBeInTheDocument();

    clickTab(screen.getByRole("tab", { name: "版本历史" }));
    const history = screen.getByRole("tabpanel", { name: "版本历史" });
    expect(within(history).getByText("1.1.0")).toBeInTheDocument();
    expect(within(history).getByText("补充网页读取规则")).toBeInTheDocument();

    expect(screen.queryByText("发布管理")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消当前发布" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /设为当前版本/ })).not.toBeInTheDocument();
    expect(listPublishedSkillVersionFilesMock).toHaveBeenCalledWith("skill-1", "version-2");
    expect(getPublishedSkillVersionFileMock).toHaveBeenCalledWith("skill-1", "version-2", "SKILL.md");
  });

  it("uploads a skill only to a writable authorized space", async () => {
    renderPage("/app/skills");

    const uploadButton = await screen.findByRole("button", { name: "上传 Skill" });
    await waitFor(() => expect(uploadButton).toBeEnabled());
    fireEvent.click(uploadButton);
    const dialog = screen.getByRole("dialog", { name: "上传 Skill" });
    const spaceSelect = within(dialog).getByRole("combobox", { name: "技能空间" });
    expect(spaceSelect).toHaveTextContent("可写空间");
    fireEvent.click(spaceSelect);
    const spaceOptions = await screen.findByRole("listbox");
    expect(within(spaceOptions).queryByRole("option", { name: "只读空间" })).not.toBeInTheDocument();
    fireEvent.click(within(spaceOptions).getByRole("option", { name: "可写空间" }));

    fireEvent.change(within(dialog).getByLabelText("版本号"), { target: { value: "1.0.0" } });
    fireEvent.change(within(dialog).getByLabelText("更新说明"), { target: { value: "首次上传" } });
    const file = new File(["zip"], "release-helper.zip", { type: "application/zip" });
    fireEvent.change(within(dialog).getByLabelText("Skill ZIP 包"), { target: { files: [file] } });
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(uploadAppSkillVersionMock).toHaveBeenCalledWith({
      spaceId: "space-write",
      version: "1.0.0",
      changelog: "首次上传",
      packageFile: file
    }));
    expect(await screen.findByText("Skill“release-helper”版本 1.0.0 已上传并发布")).toBeInTheDocument();
  });

  it("disables uploading when the user has no writable space", async () => {
    listAuthorizedSkillSpacesMock.mockResolvedValueOnce([skillSpace("space-read", "只读空间", ["read"])]);
    renderPage("/app/skills");

    await screen.findByText("web-tools-guide");
    const uploadButton = await screen.findByRole("button", { name: "上传 Skill" });
    expect(uploadButton).toBeDisabled();
    expect(uploadButton).toHaveAttribute("title", "暂无可上传的技能空间");
  });
});

function clickTab(tab: HTMLElement) {
  fireEvent.pointerDown(tab);
  fireEvent.mouseDown(tab);
  fireEvent.mouseUp(tab);
  fireEvent.click(tab);
}

function renderPage(initialEntry = "/app/skills/detail?skill_id=skill-1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AppSkillsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function skillSpace(spaceId: string, name: string, actions: Array<"read" | "write">) {
  return {
    spaceId,
    name,
    description: "",
    actions,
    memberCount: 1,
    skillCount: 1,
    publishedCount: 1,
    createdBy: "admin",
    updatedBy: "admin",
    createdAt: "2026-07-27T08:00:00Z",
    updatedAt: "2026-07-27T08:00:00Z"
  };
}
