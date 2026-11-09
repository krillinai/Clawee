import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteAccountAvatar, uploadAccountAvatar } from "@/lib/auth-api";

import { ThemeProvider } from "./theme-provider";
import { AccountPane, dingtalkBindURL, startDingTalkBinding } from "./account-pane";

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth-api")>(),
  uploadAccountAvatar: vi.fn(),
  deleteAccountAvatar: vi.fn()
}));

const baseAccount = { userId: "usr_1", email: "user@example.com", name: "User", status: "active" };

describe("AccountPane", () => {
  afterEach(() => vi.clearAllMocks());

  function renderPane(account: Parameters<typeof AccountPane>[0]["account"]) {
    return render(<ThemeProvider><MemoryRouter><AccountPane account={account} /></MemoryRouter></ThemeProvider>);
  }

  it("账户区显示实际角色名称而不是内部编码", () => {
    renderPane({ ...baseAccount, adminRoles: ["admin", "role_generated"], adminRoleNames: ["系统管理员", "安全审计员"] });
    expect(screen.getByText("系统管理员、安全审计员")).toHaveAttribute("class", "truncate");
    expect(screen.getByTitle("系统管理员、安全审计员")).toBeInTheDocument();
    expect(screen.queryByText("admin, role_generated")).not.toBeInTheDocument();
  });

  it("角色名称缺失时使用中文身份，不显示内部编码", () => {
    renderPane({ ...baseAccount, adminRoles: ["role_generated"], adminPermissions: ["console:rbac:read"] });
    expect(screen.getByText("后台用户")).toBeInTheDocument();
    expect(screen.queryByText("role_generated")).not.toBeInTheDocument();
  });

  it("图片失败后在更换头像时重新加载，并支持恢复默认头像", async () => {
    vi.mocked(uploadAccountAvatar).mockResolvedValueOnce({});
    vi.mocked(deleteAccountAvatar).mockResolvedValueOnce();
    const { container } = renderPane({ ...baseAccount, avatarUrl: "/api/v1/auth/avatar/usr_1" });
    const image = container.querySelector("img")!;
    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "更换头像" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "User" }));
    const dialog = screen.getByRole("dialog", { name: "头像设置" });

    const file = new File(["png"], "avatar.png", { type: "image/png" });
    const input = within(dialog).getByLabelText("选择头像图片");
    const chooseFile = vi.spyOn(input, "click");
    fireEvent.click(within(dialog).getByRole("button", { name: "更换头像" }));
    expect(chooseFile).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(uploadAccountAvatar).toHaveBeenCalledWith(file));
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("?v="));
    expect(within(dialog).getByRole("img", { name: "当前头像" }).getAttribute("src")).toContain("?v=");

    fireEvent.click(screen.getByRole("button", { name: "恢复默认头像" }));
    await waitFor(() => expect(deleteAccountAvatar).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "完成" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("dialog", { name: "头像设置" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "User" })).toHaveFocus());
  });

  it("头像操作失败在模态框内提示，并允许重试", async () => {
    vi.mocked(deleteAccountAvatar).mockRejectedValueOnce(new Error("头像恢复失败"));
    renderPane(baseAccount);
    fireEvent.click(screen.getByRole("button", { name: "User" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复默认头像" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("头像恢复失败");
    expect(screen.getByRole("button", { name: "更换头像" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "恢复默认头像" })).toBeEnabled();
  });

  it("头像处理期间禁用操作并阻止关闭，完成后可退出", async () => {
    let finish!: () => void;
    vi.mocked(deleteAccountAvatar).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    renderPane(baseAccount);
    fireEvent.click(screen.getByRole("button", { name: "User" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复默认头像" }));
    expect(screen.getByRole("button", { name: "处理中..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复默认头像" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "完成" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "头像设置" })).toBeInTheDocument();
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "完成" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("dialog", { name: "头像设置" })).not.toBeInTheDocument();
  });

  it("钉钉未启用时更多菜单不显示绑定入口", () => {
    renderPane({ ...baseAccount, dingtalkEnabled: false });
    fireEvent.click(screen.getByRole("button", { name: "账户操作" }));
    expect(screen.queryByText("绑定钉钉")).not.toBeInTheDocument();
    expect(screen.queryByText("已绑定钉钉")).not.toBeInTheDocument();
  });

  it("启用且未绑定时仅在更多菜单显示绑定入口", () => {
    const assign = vi.fn();
    renderPane({ ...baseAccount, dingtalkEnabled: true, dingtalkBound: false });
    expect(screen.queryByRole("button", { name: "绑定钉钉" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "账户操作" }));
    expect(screen.getByRole("button", { name: "绑定钉钉" })).toBeInTheDocument();
    startDingTalkBinding(assign);
    expect(assign).toHaveBeenCalledWith(dingtalkBindURL);
  });

  it.each([false, true])("钉钉启用状态为 %s 时反馈入口收进更多菜单", (dingtalkEnabled) => {
    render(
      <ThemeProvider><MemoryRouter>
        <AccountPane
          account={{ ...baseAccount, dingtalkEnabled, dingtalkBound: false }}
          accountActions={<button type="button">提交异常反馈</button>}
        />
      </MemoryRouter></ThemeProvider>
    );
    expect(screen.queryByRole("button", { name: "提交异常反馈" })).not.toBeInTheDocument();
    expect(screen.getByText(baseAccount.email)).toBeVisible();
    expect(screen.getByRole("link", { name: "下载客户端" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "账户操作" }));
    expect(screen.getByRole("button", { name: "提交异常反馈" })).toBeVisible();
  });

  it.each([
    [false, false], [false, true], [true, false], [true, true]
  ])("已绑定账户仅显示状态，不提供解绑（钉钉启用 %s，本地密码 %s）", (dingtalkEnabled, localPasswordConfigured) => {
    renderPane({ ...baseAccount, dingtalkEnabled, dingtalkBound: true, localPasswordConfigured });
    expect(screen.queryByText("已绑定钉钉")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "账户操作" }));
    expect(screen.getByText("已绑定钉钉")).toBeVisible();
    expect(screen.queryByRole("button", { name: "绑定钉钉" })).not.toBeInTheDocument();
    expect(screen.queryByText(/解绑/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "解绑钉钉账户" })).not.toBeInTheDocument();
  });
});
