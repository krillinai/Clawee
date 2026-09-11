import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GitHubSource } from "@/lib/skillhub-api";

import { SkillSourceForm } from "./skill-source-form";

describe("SkillSourceForm", () => {
  it("shows repository input guidance and the GitHub token creation link for a new source", () => {
    render(<SkillSourceForm onCancel={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByLabelText("GitHub 仓库地址")).toHaveAttribute("placeholder", "https://github.com/acme/skills");
    expect(screen.getByText("填写完整的 GitHub 仓库地址，例如 https://github.com/acme/skills。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往 GitHub 创建 Token" })).toHaveAttribute(
      "href",
      "https://github.com/settings/personal-access-tokens/new"
    );
    expect(screen.getByText(/并授予目标仓库 Contents 只读权限/)).toBeInTheDocument();
  });

  it("leaves a new source branch empty for server-side default resolution", () => {
    const onSubmit = vi.fn();
    render(<SkillSourceForm onCancel={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("GitHub 仓库地址"), { target: { value: "https://github.com/acme/skills" } });
    fireEvent.click(screen.getByRole("button", { name: "创建来源" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ branch: "" }));
  });

  it("rejects a repository URL outside GitHub", () => {
    const onSubmit = vi.fn();
    render(<SkillSourceForm onCancel={vi.fn()} onSubmit={onSubmit} />);

    const repositoryInput = screen.getByLabelText("GitHub 仓库地址");
    fireEvent.change(repositoryInput, { target: { value: "https://gitlab.com/acme/skills" } });

    expect(repositoryInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "创建来源" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits a new GitHub source with its schedule and auto-publish selection", () => {
    const onSubmit = vi.fn();
    render(<SkillSourceForm onCancel={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("GitHub 仓库地址"), { target: { value: "https://github.com/acme/skills" } });
    fireEvent.change(screen.getByLabelText("分支"), { target: { value: "release" } });
    fireEvent.change(screen.getByLabelText("扫描根目录"), { target: { value: "packages" } });
    fireEvent.change(screen.getByLabelText("排除前缀"), { target: { value: "archive\nlegacy" } });
    fireEvent.change(screen.getByLabelText("访问 Token"), { target: { value: "ghp_secret" } });
    fireEvent.click(screen.getByRole("combobox", { name: "同步调度" }));
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "每日" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "自动发布发现的版本" }));
    fireEvent.click(screen.getByRole("button", { name: "创建来源" }));

    expect(onSubmit).toHaveBeenCalledWith({
		spaceId: "skillspace_default",
      repositoryOwner: "acme",
      repositoryName: "skills",
      branch: "release",
      scanRoot: "packages",
      excludePaths: ["archive", "legacy"],
      token: "ghp_secret",
      autoPublish: true,
      schedule: "daily"
    });
  });

  it("shows the saved edit token and omits an empty value to preserve it", () => {
    const onSubmit = vi.fn();
    render(<SkillSourceForm initialToken="github_pat_saved" onCancel={vi.fn()} onSubmit={onSubmit} source={githubSource()} />);

    expect(screen.getByLabelText("GitHub 仓库地址")).toBeDisabled();
    expect(screen.getByLabelText("GitHub 仓库地址")).toHaveValue("https://github.com/acme/skills");
    expect(screen.getByLabelText("访问 Token")).toHaveValue("github_pat_saved");
    fireEvent.change(screen.getByLabelText("访问 Token"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存来源" }));

    expect(onSubmit).toHaveBeenCalledWith({
		spaceId: "skillspace_default",
      repositoryOwner: "acme",
      repositoryName: "skills",
      branch: "main",
      scanRoot: "skills/",
      excludePaths: ["archive/"],
      autoPublish: true,
      schedule: "hourly"
    });
  });
});

function githubSource(): GitHubSource {
  return {
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
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastSyncedCommitSha: null,
    lastErrorSummary: "",
    createdBy: "usr_admin",
    createdAt: "2026-07-30T08:00:00Z",
    updatedAt: "2026-07-31T08:00:00Z"
  };
}
