import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import { permissions } from "@/lib/rbac-api";
import {
  getSharedSpace,
  listSharedFiles,
  uploadSharedFile
} from "@/lib/shared-files-api";

import { SharedSpaceFilesPage } from "./shared-space-files";

vi.mock("@/lib/shared-files-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shared-files-api")>("@/lib/shared-files-api");
  return { ...actual, getSharedSpace: vi.fn(), listSharedFiles: vi.fn(), uploadSharedFile: vi.fn() };
});

const space = { spaceId: "space_1", name: "季度空间", description: "协作文件", memberCount: 1, fileCount: 1, sizeBytes: 5, createdBy: "admin", createdAt: "2026-08-01T00:00:00Z", updatedBy: "admin", updatedAt: "2026-08-05T00:00:00Z" };
const sharedFile = { fileId: "file_1", spaceId: "space_1", logicalPath: "docs/guide.txt", fileName: "guide.txt", sizeBytes: 5, contentType: "text/plain", revision: 2, updatedByUserId: "usr_admin", updatedByUserName: "管理员", updatedByAgentId: "", updatedAt: "2026-08-06T00:00:00Z" };

describe("SharedSpaceFilesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSharedSpace).mockResolvedValue(space);
    vi.mocked(listSharedFiles).mockResolvedValue({ items: [sharedFile], meta: { next_cursor: "", has_next: false } });
    vi.mocked(uploadSharedFile).mockResolvedValue({ ...sharedFile, created: true, sha256: "a".repeat(64) });
  });

  it("renders file management as a standalone page with a return path", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "季度空间文件" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回网盘" })).toHaveAttribute("href", "/admin/shared-files");
    expect(await screen.findByText("guide.txt")).toBeInTheDocument();
    expect(screen.getByText("管理员")).toBeInTheDocument();
    expect(screen.queryByText("usr_admin")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("downloads, uploads, and replaces files for managers", async () => {
    renderPage();
    expect(await screen.findByRole("link", { name: "下载文件 guide.txt" })).toHaveAttribute("href", "/api/v1/admin/shared-files/content?file_id=file_1");

    fireEvent.click(screen.getByRole("button", { name: "上传文件" }));
    let dialog = await screen.findByRole("dialog", { name: "上传文件" });
    const createdFile = new File(["new"], "new.txt", { type: "text/plain" });
    fireEvent.change(within(dialog).getByLabelText("本地文件"), { target: { files: [createdFile] } });
    expect(within(dialog).getByLabelText("逻辑路径")).toHaveValue("new.txt");
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(uploadSharedFile).toHaveBeenCalledWith({ spaceId: "space_1", logicalPath: "new.txt", file: createdFile, expectedRevision: undefined }));

    fireEvent.click(screen.getByRole("button", { name: "上传新版本 guide.txt" }));
    dialog = await screen.findByRole("dialog", { name: "上传文件新版本" });
    const replacement = new File(["next"], "guide.txt", { type: "text/plain" });
    fireEvent.change(within(dialog).getByLabelText("本地文件"), { target: { files: [replacement] } });
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(uploadSharedFile).toHaveBeenLastCalledWith({ spaceId: "space_1", logicalPath: "docs/guide.txt", file: replacement, expectedRevision: 2 }));
  });

  it("keeps file content operations hidden for read-only administrators", async () => {
    renderPage([permissions.sharedFilesRead]);

    expect(await screen.findByText("guide.txt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传文件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "下载文件 guide.txt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传新版本 guide.txt" })).not.toBeInTheDocument();
  });
});

function renderPage(adminPermissions?: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const page = (
    <MemoryRouter initialEntries={["/admin/shared-files/detail?space_id=space_1"]}>
      <Routes>
        <Route path="/admin/shared-files/detail" element={<SharedSpaceFilesPage />} />
      </Routes>
    </MemoryRouter>
  );
  return render(
    <QueryClientProvider client={queryClient}>
      {adminPermissions ? (
        <AdminPermissionsProvider account={{ userId: "reader", email: "reader@example.com", name: "只读管理员", status: "active", adminPermissions }}>
          {page}
        </AdminPermissionsProvider>
      ) : page}
    </QueryClientProvider>
  );
}
