import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import { APIError } from "@/lib/api";
import { permissions } from "@/lib/rbac-api";
import {
  deleteSharedFile,
  getSharedSpace,
  getSharedFilePreview,
  listSharedFiles,
  SharedFileAPIError,
  uploadSharedFile
} from "@/lib/shared-files-api";

import { SharedSpaceFilesPage } from "./shared-space-files";

vi.mock("@/lib/shared-files-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shared-files-api")>("@/lib/shared-files-api");
  return { ...actual, deleteSharedFile: vi.fn(), getSharedSpace: vi.fn(), getSharedFilePreview: vi.fn(), listSharedFiles: vi.fn(), uploadSharedFile: vi.fn() };
});

const space = { spaceId: "space_1", name: "季度空间", description: "协作文件", memberCount: 1, fileCount: 1, sizeBytes: 5, createdBy: "admin", createdAt: "2026-08-01T00:00:00Z", updatedBy: "admin", updatedAt: "2026-08-05T00:00:00Z" };
const sharedFile = { fileId: "file_1", spaceId: "space_1", logicalPath: "docs/guide.txt", fileName: "guide.txt", sizeBytes: 5, contentType: "text/plain", revision: 2, updatedByUserId: "usr_admin", updatedByUserName: "管理员", updatedByAgentId: "", updatedAt: "2026-08-06T00:00:00Z" };

describe("SharedSpaceFilesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSharedSpace).mockResolvedValue(space);
    vi.mocked(listSharedFiles).mockResolvedValue({ items: [sharedFile], meta: { next_cursor: "", has_next: false } });
    vi.mocked(uploadSharedFile).mockResolvedValue({ ...sharedFile, created: true, sha256: "a".repeat(64) });
    vi.mocked(deleteSharedFile).mockResolvedValue(undefined);
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

  it("uploads multiple selected files sequentially with their own file names", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "上传文件" }));
    const dialog = await screen.findByRole("dialog", { name: "上传文件" });
    const firstFile = new File(["first"], "alpha.txt", { type: "text/plain" });
    const secondFile = new File(["second"], "beta.bin", { type: "application/octet-stream" });
    fireEvent.change(within(dialog).getByLabelText("本地文件"), { target: { files: [firstFile, secondFile] } });

    expect(within(dialog).queryByLabelText("逻辑路径")).not.toBeInTheDocument();
    expect(within(dialog).getByText("多选时按各自文件名保存到当前空间根目录。")).toBeInTheDocument();
    expect(within(dialog).getByText("alpha.txt")).toBeInTheDocument();
    expect(within(dialog).getByText("beta.bin")).toBeInTheDocument();

    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(uploadSharedFile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(uploadSharedFile).mock.calls[0]?.[0]).toEqual({ spaceId: "space_1", logicalPath: "alpha.txt", file: firstFile, expectedRevision: undefined });
    expect(vi.mocked(uploadSharedFile).mock.calls[1]?.[0]).toEqual({ spaceId: "space_1", logicalPath: "beta.bin", file: secondFile, expectedRevision: undefined });
    expect(await screen.findByText("已上传 2 个文件")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the upload dialog open with per-file results when some files fail", async () => {
    vi.mocked(uploadSharedFile)
      .mockResolvedValueOnce({ ...sharedFile, fileId: "file_alpha", fileName: "alpha.txt", logicalPath: "alpha.txt", created: true, sha256: "a".repeat(64) })
      .mockRejectedValueOnce(new SharedFileAPIError("request_failed", "存储空间不足"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "上传文件" }));
    const dialog = await screen.findByRole("dialog", { name: "上传文件" });
    const firstFile = new File(["first"], "alpha.txt", { type: "text/plain" });
    const secondFile = new File(["second"], "beta.txt", { type: "text/plain" });
    fireEvent.change(within(dialog).getByLabelText("本地文件"), { target: { files: [firstFile, secondFile] } });
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(uploadSharedFile).toHaveBeenCalledTimes(2));
    expect(await within(dialog).findByText("失败：存储空间不足")).toBeInTheDocument();
    expect(within(dialog).getByText("成功")).toBeInTheDocument();
    expect(within(dialog).getByText("alpha.txt")).toBeInTheDocument();
    expect(within(dialog).getByText("beta.txt")).toBeInTheDocument();
    expect(screen.getByText("已上传 1 个文件")).toBeInTheDocument();
    const form = within(dialog.querySelector("form") as HTMLElement);
    expect(form.getByRole("button", { name: "关闭" })).toBeInTheDocument();
    expect(form.queryByRole("button", { name: "上传" })).not.toBeInTheDocument();
    expect(uploadSharedFile).toHaveBeenCalledTimes(2);

    fireEvent.click(form.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("deletes a file after confirmation with the current revision", async () => {
    renderPage([permissions.sharedFilesDelete]);
    expect(await screen.findByText("guide.txt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除文件 guide.txt" }));
    const dialog = await screen.findByRole("dialog", { name: "删除文件" });
    expect(within(dialog).getByText(/文件删除后不可恢复/)).toBeInTheDocument();
    expect(within(dialog).getByText(/revision 2/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "永久删除" }));

    await waitFor(() => expect(deleteSharedFile).toHaveBeenCalledWith({ spaceId: "space_1", fileId: "file_1", expectedRevision: 2 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("文件“guide.txt”已永久删除")).toBeInTheDocument();
  });

  it("refreshes the file list and prompts when the delete revision conflicts", async () => {
    vi.mocked(deleteSharedFile).mockRejectedValue(new APIError("文件已被修改", 409, "revision_conflict"));
    renderPage([permissions.sharedFilesDelete]);
    expect(await screen.findByText("guide.txt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除文件 guide.txt" }));
    const dialog = await screen.findByRole("dialog", { name: "删除文件" });
    fireEvent.click(within(dialog).getByRole("button", { name: "永久删除" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("文件版本已变化");
    await waitFor(() => expect(listSharedFiles).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("dialog", { name: "删除文件" })).toBeInTheDocument();
  });

  it("keeps file content operations hidden for read-only administrators", async () => {
    renderPage([permissions.sharedFilesRead]);

    expect(await screen.findByText("guide.txt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传文件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "下载文件 guide.txt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传新版本 guide.txt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "预览文件 guide.txt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除文件 guide.txt" })).not.toBeInTheDocument();
    expect(screen.getByText("当前账号无下载权限，仅可查看文件信息。请联系管理员开通预览与下载权限。")).toBeInTheDocument();
  });

  it("previews safe text in a dialog and keeps the download link", async () => {
    vi.mocked(getSharedFilePreview).mockResolvedValue(new Response("<script>alert(1)</script>", { headers: { "Content-Type": "text/plain; charset=utf-8" } }));
    const view = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "预览文件 guide.txt" }));
    const dialog = await screen.findByRole("dialog", { name: "预览 guide.txt" });
    expect(await within(dialog).findByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(dialog.querySelector("script")).toBeNull();
    expect(within(dialog).getByRole("link", { name: "下载" })).toHaveAttribute("href", "/api/v1/admin/shared-files/content?file_id=file_1");
    expect(getSharedFilePreview).toHaveBeenCalledWith("file_1", expect.any(AbortSignal));
    view.unmount();
    expect(vi.mocked(getSharedFilePreview).mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  it("shows unsupported preview failures without removing download", async () => {
    vi.mocked(getSharedFilePreview).mockRejectedValue(new Error("暂不支持预览此文件，请下载后查看"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "预览文件 guide.txt" }));
    const dialog = await screen.findByRole("dialog", { name: "预览 guide.txt" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("暂不支持预览此文件");
    expect(within(dialog).getByRole("link", { name: "下载" })).toBeInTheDocument();
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
