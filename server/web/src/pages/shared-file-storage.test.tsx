import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import { permissions } from "@/lib/rbac-api";
import {
  activateStorageProfile,
  createOSSProfile,
  getStorageMigration,
  getStorageState,
  probeStorageProfile,
  retryStorageMigration,
  testOSSProfile
} from "@/lib/shared-file-storage-api";

import { SharedFileStoragePage } from "./shared-file-storage";

vi.mock("@/lib/shared-file-storage-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shared-file-storage-api")>("@/lib/shared-file-storage-api");
  return {
    ...actual,
    activateStorageProfile: vi.fn(),
    cancelStorageMigration: vi.fn(),
    createOSSProfile: vi.fn(),
    createStorageMigration: vi.fn(),
    getStorageMigration: vi.fn(),
    getStorageState: vi.fn(),
    probeStorageProfile: vi.fn(),
    retireStorageProfile: vi.fn(),
    retryStorageMigration: vi.fn(),
    testOSSProfile: vi.fn(),
    updateOSSProfile: vi.fn()
  };
});

const localProfile = {
  profileId: "shared_files_local_default",
  name: "服务器本地存储",
  provider: "local" as const,
  endpoint: "",
  region: "",
  bucket: "",
  objectPrefix: "",
  credentialMode: "" as const,
  credentialsConfigured: false,
  accessKeyIdHint: "",
  status: "enabled" as const,
  health: "available" as const,
  fileCount: 2,
  sizeBytes: 10
};

const ossProfile = {
  ...localProfile,
  profileId: "storage_profile_1",
  name: "生产 OSS",
  provider: "aliyun_oss" as const,
  endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
  region: "cn-hangzhou",
  bucket: "clawee-prod",
  objectPrefix: "clawee/shared-files",
  credentialMode: "ecs_ram_role" as const,
  credentialsConfigured: true,
  fileCount: 0
};

describe("SharedFileStoragePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.mocked(getStorageState).mockResolvedValue({
      activeProfileId: localProfile.profileId,
      revision: 1,
      profiles: [localProfile, ossProfile]
    });
    vi.mocked(testOSSProfile).mockResolvedValue({ result: "success", tested_at: "2026-09-12T00:00:00Z" });
    vi.mocked(createOSSProfile).mockResolvedValue(ossProfile);
    vi.mocked(activateStorageProfile).mockResolvedValue({ active_profile_id: ossProfile.profileId, revision: 2 });
  });

  it("tests before saving a new OSS profile", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "新建 OSS Profile" }));
    const dialog = screen.getByRole("dialog", { name: "新建 OSS Profile" });
    const save = within(dialog).getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "新 OSS" } });
    fireEvent.change(within(dialog).getByLabelText("Bucket"), { target: { value: "new-bucket" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(testOSSProfile).toHaveBeenCalled());
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(createOSSProfile).toHaveBeenCalledWith(expect.objectContaining({
      name: "新 OSS",
      bucket: "new-bucket",
      credentialMode: "ecs_ram_role"
    })));
  });

  it("requires explicit confirmation before activation", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "激活" }));
    const dialog = screen.getByRole("dialog", { name: "确认激活存储" });
    expect(dialog).toHaveTextContent("仅影响后续上传和替换，不自动迁移已有文件");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认激活" }));
    await waitFor(() => expect(activateStorageProfile).toHaveBeenCalledWith(ossProfile.profileId, 1));
  });

  it("probes the saved profile when keeping existing credentials", async () => {
    const accessKeyProfile = { ...ossProfile, credentialMode: "access_key" as const, accessKeyIdHint: "1234" };
    vi.mocked(getStorageState).mockResolvedValue({
      activeProfileId: localProfile.profileId,
      revision: 1,
      profiles: [localProfile, accessKeyProfile]
    });
    vi.mocked(probeStorageProfile).mockResolvedValue({ result: "success", tested_at: "2026-09-12T00:00:00Z" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "编辑生产 OSS" }));
    const dialog = screen.getByRole("dialog", { name: "编辑 OSS Profile" });
    fireEvent.click(within(dialog).getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(probeStorageProfile).toHaveBeenCalledWith(accessKeyProfile.profileId));
    expect(testOSSProfile).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it("shows redacted failures and retries cleanup-pending migrations", async () => {
    sessionStorage.setItem("shared-file-storage-migration", "migration_1");
    vi.mocked(getStorageMigration).mockResolvedValue({
      migrationId: "migration_1",
      sourceProfileId: localProfile.profileId,
      targetProfileId: ossProfile.profileId,
      status: "completed_with_cleanup_pending",
      totalCount: 2,
      successCount: 1,
      failedCount: 1,
      skippedCount: 0,
      cleanupPendingCount: 1,
      createdAt: "2026-09-12T00:00:00Z",
      failedItems: [{ fileId: "file_1", attemptCount: 3, errorCode: "storage_unavailable", errorMessage: "存储暂时不可用" }]
    });
    vi.mocked(retryStorageMigration).mockResolvedValue(undefined);
    renderPage();
    expect(await screen.findByText("存储暂时不可用")).toBeInTheDocument();
    expect(screen.getByText("已尝试 3 次")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试失败项" }));
    await waitFor(() => expect(retryStorageMigration).toHaveBeenCalledWith("migration_1"));
    await waitFor(() => expect(getStorageMigration).toHaveBeenCalledTimes(2), { timeout: 2500 });
  });

  it("does not offer retry for cleanup tasks that are still pending", async () => {
    sessionStorage.setItem("shared-file-storage-migration", "migration_1");
    vi.mocked(getStorageMigration).mockResolvedValue({
      migrationId: "migration_1",
      sourceProfileId: localProfile.profileId,
      targetProfileId: ossProfile.profileId,
      status: "completed_with_cleanup_pending",
      totalCount: 1,
      successCount: 1,
      failedCount: 0,
      skippedCount: 0,
      cleanupPendingCount: 1,
      createdAt: "2026-09-12T00:00:00Z",
      failedItems: []
    });
    renderPage();
    expect(await screen.findByText("待清理")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试失败项" })).not.toBeInTheDocument();
  });

  it("hides configuration actions without storage management permission", async () => {
    renderPage([permissions.sharedFilesStorageRead]);
    expect(await screen.findByText("生产 OSS")).toBeInTheDocument();
    expect(screen.getByText("Region: cn-hangzhou")).toBeInTheDocument();
    expect(screen.getByText("Prefix: clawee/shared-files")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建 OSS Profile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "激活" })).not.toBeInTheDocument();
  });
});

function renderPage(adminPermissions?: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const page = <MemoryRouter><SharedFileStoragePage /></MemoryRouter>;
  const account = { userId: "admin", email: "admin@example.com", name: "管理员", status: "active", adminPermissions };
  return render(
    <QueryClientProvider client={queryClient}>
      {adminPermissions ? <AdminPermissionsProvider account={account}>{page}</AdminPermissionsProvider> : page}
    </QueryClientProvider>
  );
}
