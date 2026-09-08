import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteKnowledgeDocument,
  listKnowledgeBases,
  listKnowledgeDocuments,
  syncKnowledgeDocuments,
  uploadKnowledgeDocument,
  type KnowledgeBase,
  type KnowledgeDocument
} from "@/lib/knowledge-api";

import { KnowledgeBaseDocumentsPage } from "./knowledge-base-documents";

vi.mock("@/lib/knowledge-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/knowledge-api")>("@/lib/knowledge-api");
  return {
    ...actual,
    deleteKnowledgeDocument: vi.fn(),
    listKnowledgeBases: vi.fn(),
    listKnowledgeDocuments: vi.fn(),
    syncKnowledgeDocuments: vi.fn(),
    uploadKnowledgeDocument: vi.fn()
  };
});

const deleteKnowledgeDocumentMock = vi.mocked(deleteKnowledgeDocument);
const listKnowledgeBasesMock = vi.mocked(listKnowledgeBases);
const listKnowledgeDocumentsMock = vi.mocked(listKnowledgeDocuments);
const syncKnowledgeDocumentsMock = vi.mocked(syncKnowledgeDocuments);
const uploadKnowledgeDocumentMock = vi.mocked(uploadKnowledgeDocument);

const activeBase = knowledgeBase({ knowledgeBaseId: "kb-active", name: "公司制度库", documentCount: 1 });
const deletingBase = knowledgeBase({ knowledgeBaseId: "kb-deleting", name: "待删除资料库", status: "deleting" });
const readyDocument = knowledgeDocument({
  documentId: "doc-ready",
  knowledgeBaseId: activeBase.knowledgeBaseId,
  name: "员工手册.pdf"
});

describe("KnowledgeBaseDocumentsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listKnowledgeBasesMock.mockResolvedValue([activeBase, deletingBase]);
    listKnowledgeDocumentsMock.mockResolvedValue([readyDocument]);
    uploadKnowledgeDocumentMock.mockResolvedValue(readyDocument);
    syncKnowledgeDocumentsMock.mockResolvedValue([readyDocument]);
    deleteKnowledgeDocumentMock.mockResolvedValue(undefined);
  });

  it("renders document management as a standalone page with a return path", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "公司制度库文档" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回知识库" })).toHaveAttribute("href", "/admin/knowledge-bases");
    expect(await screen.findByText("员工手册.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows document errors without an empty state", async () => {
    listKnowledgeDocumentsMock.mockRejectedValueOnce(new Error("documents unavailable"));
    renderPage();

    expect(await screen.findByText(/文档加载失败：documents unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("暂无文档")).not.toBeInTheDocument();
  });

  it("automatically syncs once when the page opens with processing documents", async () => {
    listKnowledgeDocumentsMock.mockResolvedValueOnce([{ ...readyDocument, status: "processing" }]);
    renderPage();

    await waitFor(() => expect(syncKnowledgeDocumentsMock).toHaveBeenCalledTimes(1));
    expect(syncKnowledgeDocumentsMock).toHaveBeenCalledWith(activeBase.knowledgeBaseId);
    expect(await screen.findByText("文档状态同步成功")).toBeInTheDocument();
    expect(syncKnowledgeDocumentsMock).toHaveBeenCalledTimes(1);
  });

  it("does not automatically sync when every document is settled", async () => {
    renderPage();

    expect(await screen.findByText("员工手册.pdf")).toBeInTheDocument();
    expect(syncKnowledgeDocumentsMock).not.toHaveBeenCalled();
  });

  it("opens the upload dialog, shows progress, closes it and reports success", async () => {
    const deferred = createDeferred<KnowledgeDocument>();
    uploadKnowledgeDocumentMock.mockReturnValueOnce(deferred.promise);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "上传文档" }));
    const dialog = await screen.findByRole("dialog", { name: "上传文档" });
    const fileInput = within(dialog).getByLabelText("选择知识库文档");
    const file = new File(["content"], "制度.pdf", { type: "application/pdf" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);

    expect(await within(dialog).findByRole("button", { name: "上传中..." })).toBeDisabled();
    deferred.resolve({ ...readyDocument, name: file.name });

    expect(await screen.findByText("文档上传成功")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "上传文档" })).not.toBeInTheDocument());
  });

  it("explains disabled document actions for unavailable knowledge bases", async () => {
    renderPage("kb-deleting");

    expect(await screen.findByText(/当前状态为“删除中”/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传文档" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "同步状态" })).toBeDisabled();
  });

  it("shows delete errors and pending feedback inside the confirmation dialog", async () => {
    const deferred = createDeferred<void>();
    deleteKnowledgeDocumentMock.mockReturnValueOnce(deferred.promise);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "删除文档 员工手册.pdf" }));
    const confirm = screen.getByRole("dialog", { name: "删除文档" });
    fireEvent.click(within(confirm).getByRole("button", { name: "确认删除" }));

    expect(await within(confirm).findByRole("button", { name: "删除中..." })).toBeDisabled();
    deferred.reject(new Error("document is in use"));
    expect(await within(confirm).findByText(/删除失败：document is in use/)).toBeInTheDocument();
  });
});

function renderPage(knowledgeBaseId = "kb-active") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/admin/knowledge-bases/documents?knowledge_base_id=${knowledgeBaseId}`]}>
        <Routes>
          <Route path="/admin/knowledge-bases/documents" element={<KnowledgeBaseDocumentsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function knowledgeBase(overrides: Partial<KnowledgeBase>): KnowledgeBase {
  return {
    knowledgeBaseId: "kb-default",
    name: "默认知识库",
    description: "",
    providerType: "bailian",
    status: "active",
    errorMessage: "",
    documentCount: 0,
    createdBy: "usr_admin",
    createdAt: "2026-07-26T00:00:00Z",
    updatedAt: "2026-07-26T00:00:00Z",
    ...overrides
  };
}

function knowledgeDocument(overrides: Partial<KnowledgeDocument>): KnowledgeDocument {
  return {
    documentId: "doc-default",
    knowledgeBaseId: "kb-default",
    name: "默认文档.pdf",
    sizeBytes: 2048,
    mimeType: "application/pdf",
    status: "ready",
    errorMessage: "",
    uploadedBy: "usr_uploader",
    createdAt: "2026-07-26T00:00:00Z",
    updatedAt: "2026-07-26T00:00:00Z",
    ...overrides
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
