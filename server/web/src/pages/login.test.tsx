import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authMethods, login } from "@/lib/auth-api";
import { ThemeProvider } from "@/components/theme-provider";

import { dingtalkStartURL, LoginPage, oauthErrorMessage } from "./login";

vi.mock("@/lib/auth-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth-api")>("@/lib/auth-api");
  return { ...actual, authMethods: vi.fn(), login: vi.fn() };
});

const loginMock = vi.mocked(login);
const authMethodsMock = vi.mocked(authMethods);

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loginMock.mockResolvedValue({
      user: {
        userId: "usr_admin",
        email: "admin@example.com",
        name: "Admin",
        status: "active",
        adminPermissions: ["console:account:read"]
      },
      redirectTo: "/admin"
    });
    authMethodsMock.mockResolvedValue({ password: true, dingtalk: { enabled: false } });
  });

  it("enters the admin console by default after login", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/login"]}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/admin" element={<div>管理后台首页</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    );

    fireEvent.change(screen.getByLabelText("邮箱地址"), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "passw0rd!" } });
    fireEvent.submit(screen.getByRole("button", { name: "登录" }).closest("form")!);

    expect(await screen.findByText("管理后台首页")).toBeInTheDocument();
  });

  it("returns to the requested admin page after re-login", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[{ pathname: "/login", state: { from: "/admin/accounts" } }]}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/admin/accounts" element={<div>账号管理目标页</div>} />
              <Route path="/app" element={<div>前台首页</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    );

    fireEvent.change(screen.getByLabelText("邮箱地址"), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "passw0rd!" } });
    fireEvent.submit(screen.getByRole("button", { name: "登录" }).closest("form")!);

    expect(await screen.findByText("账号管理目标页")).toBeInTheDocument();
    await waitFor(() => expect(loginMock).toHaveBeenCalledTimes(1));
  });

  it("shows a stable oauth error without exposing upstream text", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/login?oauth_provider=dingtalk&oauth_error=not_enterprise_member"]}>
            <LoginPage />
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    );

    expect(await screen.findByText("当前钉钉账号不是可用企业成员")).toBeInTheDocument();
  });

  it("shows dingtalk only when methods enables it", async () => {
    authMethodsMock.mockResolvedValue({ password: true, dingtalk: { enabled: true } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter><LoginPage /></MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    );
    expect(await screen.findByRole("button", { name: "钉钉登录" })).toBeInTheDocument();
  });

  it("keeps password login when methods lookup fails", async () => {
    authMethodsMock.mockRejectedValue(new Error("unavailable"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter><LoginPage /></MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    );
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    await waitFor(() => expect(authMethodsMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "钉钉登录" })).not.toBeInTheDocument();
  });

  it("builds dingtalk start URLs only from allowed application paths", () => {
    expect(dingtalkStartURL(undefined)).toBe("/api/v1/auth/dingtalk/start?redirect=%2Fadmin");
    expect(dingtalkStartURL({ from: "/admin/accounts" })).toBe("/api/v1/auth/dingtalk/start?redirect=%2Fadmin%2Faccounts");
    expect(dingtalkStartURL({ from: "//evil.example" })).toBe("/api/v1/auth/dingtalk/start?redirect=%2Fadmin");
    expect(dingtalkStartURL({ from: "/profile" })).toBe("/api/v1/auth/dingtalk/start?redirect=%2Fadmin");
  });

  it("maps every stable oauth error without exposing unknown text", () => {
    expect(oauthErrorMessage("dingtalk_disabled")).toBe("钉钉登录暂未启用");
    expect(oauthErrorMessage("oauth_provider_denied")).toBe("已取消钉钉授权");
    expect(oauthErrorMessage("oauth_state_invalid")).toBe("登录请求已失效，请重试");
    expect(oauthErrorMessage("dingtalk_upstream_unavailable")).toBe("钉钉服务暂时不可用");
    expect(oauthErrorMessage("not_enterprise_member")).toBe("当前钉钉账号不是可用企业成员");
    expect(oauthErrorMessage("dingtalk_email_missing")).toBe("企业资料未配置邮箱，请联系管理员");
    expect(oauthErrorMessage("account_binding_required")).toBe("请先使用原密码登录并绑定钉钉");
    expect(oauthErrorMessage("auto_provision_disabled")).toBe("账户尚未开通，请联系管理员");
    expect(oauthErrorMessage("system_not_initialized")).toBe("系统尚未初始化");
    expect(oauthErrorMessage("account_disabled")).toBe("账户已被禁用");
    expect(oauthErrorMessage("identity_conflict")).toBe("钉钉身份已绑定其他账户");
    expect(oauthErrorMessage("unauthorized")).toBe("登录状态已失效，请重新登录");
    expect(oauthErrorMessage("unknown upstream secret")).toBe("登录失败，请稍后重试");
  });
});
