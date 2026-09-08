import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerAccount } from "@/lib/auth-api";
import { ThemeProvider } from "@/components/theme-provider";

import { RegisterPage } from "./register";

vi.mock("@/lib/auth-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth-api")>("@/lib/auth-api");
  return { ...actual, registerAccount: vi.fn() };
});

const registerAccountMock = vi.mocked(registerAccount);

describe("RegisterPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerAccountMock.mockResolvedValue({
      user: { userId: "usr_1", email: "user@example.com", name: "Alice", status: "active" },
      redirectTo: "/app"
    });
  });

  it("名称为空时不允许注册，并提交去除首尾空格的名称", async () => {
    render(
      <ThemeProvider>
        <MemoryRouter><RegisterPage /></MemoryRouter>
      </ThemeProvider>
    );

    fireEvent.change(screen.getByLabelText("邮箱地址"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "passw0rd!" } });
    const nameInput = screen.getByLabelText("姓名");
    const submit = screen.getByRole("button", { name: "注册并进入" });

    expect(nameInput).toBeRequired();
    expect(submit).toBeDisabled();
    fireEvent.change(nameInput, { target: { value: "   " } });
    expect(submit).toBeDisabled();
    fireEvent.change(nameInput, { target: { value: "  Alice  " } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(registerAccountMock).toHaveBeenCalledWith({
      email: "user@example.com",
      name: "Alice",
      password: "passw0rd!"
    }));
  });

  it("显示后端返回的邮箱重复信息", async () => {
    registerAccountMock.mockRejectedValueOnce(new Error("该邮箱已注册"));
    render(
      <ThemeProvider>
        <MemoryRouter><RegisterPage /></MemoryRouter>
      </ThemeProvider>
    );

    fireEvent.change(screen.getByLabelText("邮箱地址"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "Alice" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "passw0rd!" } });
    fireEvent.click(screen.getByRole("button", { name: "注册并进入" }));

    expect(await screen.findByText("该邮箱已注册")).toBeInTheDocument();
  });
});
