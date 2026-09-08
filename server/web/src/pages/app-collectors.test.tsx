import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMyCollectorRegistrationCode,
  deleteMyCollector,
  fetchMyCollectorRegistrationCode,
  listMyCollectors,
  revokeMyCollectorToken,
} from "@/lib/office-api";

import { AppCollectorsPage } from "./app-collectors";

vi.mock("@/lib/office-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/office-api")>("@/lib/office-api");
  return {
    ...actual,
    createMyCollectorRegistrationCode: vi.fn(),
    deleteMyCollector: vi.fn(),
    fetchMyCollectorRegistrationCode: vi.fn(),
    listMyCollectors: vi.fn(),
    revokeMyCollectorToken: vi.fn(),
  };
});

const createRegistrationCodeMock = vi.mocked(createMyCollectorRegistrationCode);
const deleteMyCollectorMock = vi.mocked(deleteMyCollector);
const fetchRegistrationCodeMock = vi.mocked(fetchMyCollectorRegistrationCode);
const listMyCollectorsMock = vi.mocked(listMyCollectors);
const revokeMyCollectorTokenMock = vi.mocked(revokeMyCollectorToken);

describe("AppCollectorsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    listMyCollectorsMock.mockResolvedValue([
      {
        collector_id: "collector_1",
        device_id: "device_1",
        device_name: "开发机",
        hostname: "dev-host",
        os: "darwin",
        arch: "arm64",
        collector_version: "1.0.0",
        registered_agent_count: 1,
        token_created_at: "2026-08-04T10:00:00Z",
        last_seen_at: "2026-08-04T11:30:00Z",
        status: "online",
        token_status: "active",
      },
    ]);
    createRegistrationCodeMock.mockResolvedValue({
      registration_code: "reg_mine",
      install_url: "http://app.local/office/collectors/install?code=reg_mine",
      install_command: "curl -fsSL 'http://app.local/office/collectors/install.sh?code=reg_mine' | sh",
      install_powershell_command: "irm 'http://app.local/office/collectors/install.ps1?code=reg_mine' | iex",
      created_at: "2026-08-04T10:00:00Z",
      expires_at: "2099-08-04T10:10:00Z",
    });
    fetchRegistrationCodeMock.mockResolvedValue({
      exists: false,
      used_count: 0,
      revoked: false,
    });
  });

  it("restores and displays the persistent registration code above the list", async () => {
    fetchRegistrationCodeMock.mockResolvedValue({
      exists: true,
      registration_code: "reg_mine",
      install_url: "http://app.local/office/collectors/install?code=reg_mine",
      install_command: "curl -fsSL 'http://app.local/office/collectors/install.sh?code=reg_mine' | sh",
      install_powershell_command: "irm 'http://app.local/office/collectors/install.ps1?code=reg_mine' | iex",
      created_at: "2026-08-04T10:00:00Z",
      used_count: 2,
      last_used_at: "2026-08-04T11:00:00Z",
      revoked: false,
    });
    renderPage();

    expect(await screen.findByText("开发机")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "设备 ID" })).toBeInTheDocument();
    expect(screen.getByText("device_1")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "最近心跳时间" })).toBeInTheDocument();
    expect(screen.getByText("2026/08/04 19:30:00")).toBeInTheDocument();
    expect(screen.getByText("采集器注册码")).toBeInTheDocument();
    expect(await screen.findByText("reg_mine")).toBeInTheDocument();
    expect(await screen.findByText("curl -fsSL 'http://app.local/office/collectors/install.sh?code=reg_mine' | sh")).toBeInTheDocument();
    expect(screen.getByText("irm 'http://app.local/office/collectors/install.ps1?code=reg_mine' | iex")).toBeInTheDocument();
    expect(screen.getByText("http://app.local/office/collectors/install?code=reg_mine")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "责任账号" })).not.toBeInTheDocument();

    const shellCommand = screen.getByRole("region", { name: "Shell 一键安装命令" });
    fireEvent.click(within(shellCommand).getByRole("button", { name: "复制" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "curl -fsSL 'http://app.local/office/collectors/install.sh?code=reg_mine' | sh",
    );
  });

  it("keeps the collector list visible when registration code generation fails", async () => {
    createRegistrationCodeMock.mockRejectedValue(new Error("create failed"));
    renderPage();

    expect(await screen.findByText("开发机")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成注册码" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("生成采集器注册码失败，请稍后重试。");
    expect(screen.getByText("开发机")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成注册码" })).toBeInTheDocument();
  });

  it("keeps the registration panel available when the collector list fails to load", async () => {
    listMyCollectorsMock.mockRejectedValue(new Error("load failed"));
    renderPage();

    expect(await screen.findByText("Collector 加载失败")).toBeInTheDocument();
    expect(screen.getByText("采集器注册码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成注册码" })).toBeEnabled();
  });

  it("allows deleting only disabled collectors", async () => {
    listMyCollectorsMock.mockResolvedValue([
      {
        collector_id: "collector_active",
        device_id: "device_active",
        device_name: "在线开发机",
        hostname: "active-host",
        os: "darwin",
        arch: "arm64",
        collector_version: "1.0.0",
        registered_agent_count: 1,
        token_created_at: "2026-08-04T10:00:00Z",
        status: "online",
        token_status: "active",
      },
      {
        collector_id: "collector_disabled",
        device_id: "device_disabled",
        device_name: "已停用开发机",
        hostname: "disabled-host",
        os: "darwin",
        arch: "arm64",
        collector_version: "1.0.0",
        registered_agent_count: 1,
        token_created_at: "2026-08-04T10:00:00Z",
        status: "revoked",
        token_status: "revoked",
      },
    ]);
    deleteMyCollectorMock.mockResolvedValue();
    renderPage();

    expect(await screen.findByRole("button", { name: "删除 collector_disabled" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "删除 collector_active" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除 collector_disabled" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(deleteMyCollectorMock).toHaveBeenCalledWith("collector_disabled"));
  });

  it("allows revoking an offline collector token from the list", async () => {
    listMyCollectorsMock.mockResolvedValue([
      {
        collector_id: "collector_online",
        device_id: "device_online",
        device_name: "在线开发机",
        hostname: "online-host",
        os: "darwin",
        arch: "arm64",
        collector_version: "1.0.0",
        registered_agent_count: 1,
        token_created_at: "2026-08-04T10:00:00Z",
        status: "online",
        token_status: "active",
      },
      {
        collector_id: "collector_offline",
        device_id: "device_offline",
        device_name: "离线开发机",
        hostname: "offline-host",
        os: "darwin",
        arch: "arm64",
        collector_version: "1.0.0",
        registered_agent_count: 1,
        token_created_at: "2026-08-04T10:00:00Z",
        status: "offline",
        token_status: "active",
      },
      {
        collector_id: "collector_disabled",
        device_id: "device_disabled",
        device_name: "已停用开发机",
        hostname: "disabled-host",
        os: "darwin",
        arch: "arm64",
        collector_version: "1.0.0",
        registered_agent_count: 1,
        token_created_at: "2026-08-04T10:00:00Z",
        status: "revoked",
        token_status: "revoked",
      },
    ]);
    revokeMyCollectorTokenMock.mockResolvedValue();
    renderPage();

    const revokeButton = await screen.findByRole("button", { name: "撤销 collector_offline Token" });
    expect(revokeButton).toBeEnabled();
    expect(screen.queryByRole("button", { name: "撤销 collector_online Token" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "撤销 collector_disabled Token" })).not.toBeInTheDocument();

    fireEvent.click(revokeButton);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "撤销采集器 Token" })).toBeInTheDocument();
    expect(within(dialog).getByText(/如需再次使用，需要重新注册/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认撤销" }));

    await waitFor(() => expect(revokeMyCollectorTokenMock).toHaveBeenCalledWith("collector_offline"));
  });

  it("keeps the revoke dialog open when revoking fails", async () => {
    listMyCollectorsMock.mockResolvedValue([
      {
        collector_id: "collector_offline",
        device_id: "device_offline",
        device_name: "离线开发机",
        hostname: "offline-host",
        os: "darwin",
        arch: "arm64",
        collector_version: "1.0.0",
        registered_agent_count: 1,
        token_created_at: "2026-08-04T10:00:00Z",
        status: "offline",
        token_status: "active",
      },
    ]);
    revokeMyCollectorTokenMock.mockRejectedValue(new Error("revoke failed"));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "撤销 collector_offline Token" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认撤销" }));

    expect(await within(screen.getByRole("dialog")).findByText("撤销失败：revoke failed")).toBeInTheDocument();
  });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/app/collectors"]}>
        <AppCollectorsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
