import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteAccountAvatar, unbindDingTalk, uploadAccountAvatar } from "@/lib/auth-api";

import { ThemeProvider } from "./theme-provider";
import { AccountPane, dingtalkBindURL, startDingTalkBinding } from "./account-pane";

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth-api")>(),
  unbindDingTalk: vi.fn(),
  uploadAccountAvatar: vi.fn(),
  deleteAccountAvatar: vi.fn()
}));

const unbindDingTalkMock = vi.mocked(unbindDingTalk);

const baseAccount = { userId: "usr_1", email: "user@example.com", name: "User", status: "active" };

describe("AccountPane", () => {
  afterEach(() => vi.clearAllMocks());

  function renderPane(account: Parameters<typeof AccountPane>[0]["account"]) {
    return render(<ThemeProvider><MemoryRouter><AccountPane account={account} /></MemoryRouter></ThemeProvider>);
  }

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

  it("hides dingtalk controls when the provider is disabled", () => {
    renderPane({ ...baseAccount, dingtalkEnabled: false });
    expect(screen.queryByText("绑定钉钉")).not.toBeInTheDocument();
    expect(screen.queryByText("已绑定钉钉")).not.toBeInTheDocument();
  });

  it("starts binding when enabled and unbound", () => {
    const assign = vi.fn();
    renderPane({ ...baseAccount, dingtalkEnabled: true, dingtalkBound: false });
    expect(screen.getByRole("button", { name: "绑定钉钉" })).toBeInTheDocument();
    startDingTalkBinding(assign);
    expect(assign).toHaveBeenCalledWith(dingtalkBindURL);
  });

  it("shows unbind for a bound account even when the provider is disabled", () => {
    renderPane({ ...baseAccount, dingtalkEnabled: false, dingtalkBound: true, localPasswordConfigured: true });
    expect(screen.getByText("已绑定钉钉")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解绑钉钉" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "更多钉钉操作" }));

    expect(screen.getByRole("button", { name: "解绑钉钉" })).toHaveTextContent("解绑钉钉");
    expect(screen.queryByRole("button", { name: "绑定钉钉" })).not.toBeInTheDocument();
  });

  it("requires the current password before unbinding", async () => {
    unbindDingTalkMock.mockResolvedValueOnce();
    renderPane({ ...baseAccount, dingtalkEnabled: true, dingtalkBound: true, localPasswordConfigured: true });

    fireEvent.click(screen.getByRole("button", { name: "更多钉钉操作" }));
    fireEvent.click(screen.getByRole("button", { name: "解绑钉钉" }));
    const dialog = screen.getByRole("dialog", { name: "解绑钉钉账户" });
    fireEvent.change(within(dialog).getByLabelText("当前密码"), { target: { value: "passw0rd!" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认解绑" }));

    await waitFor(() => expect(unbindDingTalkMock).toHaveBeenCalledWith("passw0rd!"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "解绑钉钉账户" })).not.toBeInTheDocument());
    expect(screen.queryByText("已绑定钉钉")).not.toBeInTheDocument();
  });

  it("blocks unbinding when no local password is configured", () => {
    renderPane({ ...baseAccount, dingtalkEnabled: true, dingtalkBound: true, localPasswordConfigured: false });
    expect(screen.queryByRole("button", { name: "解绑钉钉" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "更多钉钉操作" }));

    expect(screen.getByRole("button", { name: "解绑钉钉" })).toBeDisabled();
    expect(screen.getByText("当前账户仅支持钉钉登录，请先联系管理员设置本地密码。")).toBeInTheDocument();
  });

  it("keeps the dialog open when unbinding fails", async () => {
    unbindDingTalkMock.mockRejectedValueOnce(new Error("当前密码错误"));
    renderPane({ ...baseAccount, dingtalkEnabled: true, dingtalkBound: true, localPasswordConfigured: true });

    fireEvent.click(screen.getByRole("button", { name: "更多钉钉操作" }));
    fireEvent.click(screen.getByRole("button", { name: "解绑钉钉" }));
    const dialog = screen.getByRole("dialog", { name: "解绑钉钉账户" });
    fireEvent.change(within(dialog).getByLabelText("当前密码"), { target: { value: "wrong-password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认解绑" }));

    expect(await within(dialog).findByText("当前密码错误")).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
  });
});
