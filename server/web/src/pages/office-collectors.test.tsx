import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRegistrationCode, deleteCollector, fetchCollectorOverview, fetchRegistrationCode, revokeCollectorToken } from "@/lib/office-api";
import { fixtureCollectorsOverview } from "@/test/office-fixtures";

import { OfficeCollectorsPage } from "./office-collectors";

vi.mock("@/lib/office-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/office-api")>("@/lib/office-api");
  return {
    ...actual,
    createRegistrationCode: vi.fn(),
    deleteCollector: vi.fn(),
    fetchRegistrationCode: vi.fn(),
    revokeCollectorToken: vi.fn(),
    fetchCollectorOverview: vi.fn(),
  };
});

const fetchCollectorOverviewMock = vi.mocked(fetchCollectorOverview);
const createRegistrationCodeMock = vi.mocked(createRegistrationCode);
const deleteCollectorMock = vi.mocked(deleteCollector);
const fetchRegistrationCodeMock = vi.mocked(fetchRegistrationCode);
const revokeCollectorTokenMock = vi.mocked(revokeCollectorToken);

vi.mock("@/lib/accounts-api", () => ({ listAccounts: vi.fn().mockResolvedValue([{ userId: "usr_1", email: "owner@example.com", name: "责任人", role: "user", status: "active", agent: null }]) }));

describe("OfficeCollectorsPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the collector list and create registration code area", async () => {
    fetchCollectorOverviewMock.mockResolvedValue(fixtureCollectorsOverview);
    createRegistrationCodeMock.mockResolvedValue({
      registration_code: "reg_new",
      install_url: "http://admin.local/office/collectors/install?code=reg_new",
      install_script_url: "http://admin.local/office/collectors/install.sh?code=reg_new",
      install_command: "curl -fsSL 'http://admin.local/office/collectors/install.sh?code=reg_new' | sh",
      created_at: "2026-06-03T12:00:00Z",
      expires_at: "2026-06-10T12:00:00Z",
    });
    fetchRegistrationCodeMock.mockResolvedValue({
      exists: true,
      registration_code: "reg_saved",
      install_url: "http://admin.local/office/collectors/install?code=reg_saved",
      install_command: "curl -fsSL 'http://admin.local/office/collectors/install.sh?code=reg_saved' | sh",
      install_powershell_command: "irm 'http://admin.local/office/collectors/install.ps1?code=reg_saved' | iex",
      created_at: "2026-06-03T12:00:00Z",
      used_count: 4,
      last_used_at: "2026-06-04T12:00:00Z",
      revoked: false,
    });
    revokeCollectorTokenMock.mockResolvedValue();

    renderWithQueryClient(<OfficeCollectorsPage />);

    expect(await screen.findByRole("heading", { name: "采集器管理" })).toBeInTheDocument();
    expect(screen.getByText("采集器列表")).toBeInTheDocument();
    expect(screen.getByText("采集器注册码")).toBeInTheDocument();
    fireEvent.change(await screen.findByRole("combobox", { name: "责任账号" }), { target: { value: "usr_1" } });
    expect(await screen.findByText("reg_saved")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    expect(await screen.findByText("http://admin.local/office/collectors/install?code=reg_saved")).toBeInTheDocument();
    expect(screen.getByText("工程负责人 MacBook")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveClass("table-fixed");
    expect(screen.getAllByRole("button", { name: "复制" })[0]).toHaveClass("bg-secondary");
    expect(screen.getByRole("button", { name: "重新生成" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤销 collector_build_02 Token" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "撤销 collector_mac_01 Token" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "复制 collector_mac_01" })).not.toBeInTheDocument();
  });

  it("keeps the registration entry visible when collector data fails to load", async () => {
    fetchCollectorOverviewMock.mockRejectedValue(new Error("load failed"));

    renderWithQueryClient(<OfficeCollectorsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("采集器数据加载失败");
    expect(screen.getByText("采集器注册码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成注册码" })).toBeInTheDocument();
  });

  it("allows deleting only disabled collectors", async () => {
    const disabledCollector = {
      ...fixtureCollectorsOverview.collectors[1],
      status: "revoked" as const,
      token_status: "revoked" as const,
    };
    fetchCollectorOverviewMock.mockResolvedValue({
      ...fixtureCollectorsOverview,
      collectors: [fixtureCollectorsOverview.collectors[0], disabledCollector],
    });
    deleteCollectorMock.mockResolvedValue();

    renderWithQueryClient(<OfficeCollectorsPage />);

    expect(await screen.findByRole("button", { name: `删除 ${disabledCollector.collector_id}` })).toBeEnabled();
    expect(screen.queryByRole("button", { name: `删除 ${fixtureCollectorsOverview.collectors[0].collector_id}` })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `删除 ${disabledCollector.collector_id}` }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "删除采集器" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(deleteCollectorMock).toHaveBeenCalledWith(disabledCollector.collector_id));
  });

  it("restores the selected collector from the detail route query", async () => {
    fetchCollectorOverviewMock.mockResolvedValue(fixtureCollectorsOverview);

    renderWithQueryClient(
      <OfficeCollectorsPage />,
      "/admin/collectors/detail?collector_id=collector_mac_01",
    );

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "工程负责人 MacBook" })).toBeInTheDocument();
    expect(within(drawer).getAllByText("collector_mac_01")).not.toHaveLength(0);
  });
});

function renderWithQueryClient(node: React.ReactNode, initialEntry = "/admin/collectors") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}
