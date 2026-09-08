import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createKnowledgeAccountGrant,
  createKnowledgeBase,
  deleteKnowledgeBase,
  listKnowledgeBases,
  listKnowledgeMemberCandidates,
  listKnowledgeMembers,
  removeKnowledgeAccountGrant,
  replaceKnowledgeAccountGrant,
  updateKnowledgeBase,
  type KnowledgeBase
} from "@/lib/knowledge-api";
import { AdminPermissionsProvider } from "@/components/admin-permissions";
import { permissions } from "@/lib/rbac-api";
import { APIError } from "@/lib/api";

import { KnowledgeBasesPage } from "./knowledge-bases";

vi.mock("@/lib/knowledge-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/knowledge-api")>("@/lib/knowledge-api");
  return {
    ...actual,
    createKnowledgeAccountGrant: vi.fn(),
    createKnowledgeBase: vi.fn(),
    deleteKnowledgeBase: vi.fn(),
    listKnowledgeMemberCandidates: vi.fn(),
    listKnowledgeMembers: vi.fn(),
    removeKnowledgeAccountGrant: vi.fn(),
    replaceKnowledgeAccountGrant: vi.fn(),
    updateKnowledgeBase: vi.fn(),
    listKnowledgeBases: vi.fn()
  };
});

const createKnowledgeAccountGrantMock = vi.mocked(createKnowledgeAccountGrant);
const createKnowledgeBaseMock = vi.mocked(createKnowledgeBase);
const deleteKnowledgeBaseMock = vi.mocked(deleteKnowledgeBase);
const listKnowledgeBasesMock = vi.mocked(listKnowledgeBases);
const listKnowledgeMemberCandidatesMock = vi.mocked(listKnowledgeMemberCandidates);
const listKnowledgeMembersMock = vi.mocked(listKnowledgeMembers);
const removeKnowledgeAccountGrantMock = vi.mocked(removeKnowledgeAccountGrant);
const replaceKnowledgeAccountGrantMock = vi.mocked(replaceKnowledgeAccountGrant);
const updateKnowledgeBaseMock = vi.mocked(updateKnowledgeBase);

const activeBase = knowledgeBase({
  knowledgeBaseId: "kb-active",
  name: "公司制度库",
  description: "公司制度和员工手册",
  status: "active",
  documentCount: 1
});
const deletingBase = knowledgeBase({
  knowledgeBaseId: "kb-deleting",
  name: "待删除资料库",
  status: "deleting"
});
describe("KnowledgeBasesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listKnowledgeBasesMock.mockResolvedValue([activeBase, deletingBase]);
    createKnowledgeBaseMock.mockResolvedValue(knowledgeBase({ knowledgeBaseId: "kb-new", name: "新知识库" }));
    deleteKnowledgeBaseMock.mockResolvedValue(undefined);
    listKnowledgeMembersMock.mockResolvedValue({
      items: [{ userId: "usr_1", email: "owner@example.com", name: "知识用户", accountStatus: "active", actions: ["read", "mcp"], updatedAt: "2026-08-04T00:00:00Z" }],
      meta: { next_cursor: "", has_next: false }
    });
    listKnowledgeMemberCandidatesMock.mockResolvedValue({
      items: [{ userId: "usr_2", email: "editor@example.com", name: "文档维护者" }],
      meta: { next_cursor: "", has_next: false }
    });
    createKnowledgeAccountGrantMock.mockResolvedValue([]);
    replaceKnowledgeAccountGrantMock.mockResolvedValue([]);
    removeKnowledgeAccountGrantMock.mockResolvedValue(undefined);
    updateKnowledgeBaseMock.mockResolvedValue({ ...activeBase, name: "新制度库", description: "新说明" });
  });

  it("keeps loading, error and empty list states mutually exclusive", async () => {
    listKnowledgeBasesMock.mockRejectedValueOnce(new Error("load failed"));

    renderPage();

    expect(await screen.findByText(/知识库加载失败：load failed/)).toBeInTheDocument();
    expect(screen.queryByText("暂无知识库")).not.toBeInTheDocument();
  });

  it("filters knowledge bases by status and uses localized status labels", async () => {
    renderPage();

    expect(await screen.findByText("公司制度库")).toBeInTheDocument();
    expect(screen.getByText("删除中")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("combobox", { name: "筛选知识库状态" }));
    fireEvent.click(await within(screen.getByRole("listbox")).findByRole("option", { name: "可用" }));

    expect(screen.getByText("公司制度库")).toBeInTheDocument();
    expect(screen.queryByText("待删除资料库")).not.toBeInTheDocument();
  });

  it("shows create errors and pending feedback inside the create dialog", async () => {
    const deferred = createDeferred<KnowledgeBase>();
    createKnowledgeBaseMock.mockReturnValueOnce(deferred.promise);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "创建知识库" }));
    const dialog = screen.getByRole("dialog", { name: "创建知识库" });
    fireEvent.change(within(dialog).getByLabelText("知识库名称"), { target: { value: "制度库" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    expect(await within(dialog).findByRole("button", { name: "创建中..." })).toBeDisabled();
    deferred.reject(new Error("名称已存在"));
    expect(await within(dialog).findByText(/创建失败：名称已存在/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("知识库名称")).toHaveValue("制度库");
  });

  it("composes the create form with shadcn field primitives", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "创建知识库" }));
    const dialog = screen.getByRole("dialog", { name: "创建知识库" });
    const fieldGroup = dialog.querySelector('[data-slot="field-group"]');

    expect(dialog).toHaveClass("max-w-[507px]");
    expect(fieldGroup).toBeInTheDocument();
    expect(fieldGroup?.querySelectorAll('[data-slot="field"]')).toHaveLength(3);
    expect(within(dialog).getByText("必填，最多 100 字")).toHaveAttribute("data-slot", "field-description");
    expect(within(dialog).getByText("可选，最多 1000 字")).toHaveAttribute("data-slot", "field-description");
  });

  it("opens document management only from the document management button", async () => {
    renderRoutedPage();

    fireEvent.click(await screen.findByText("公司制度库"));
    expect(screen.queryByText("文档管理目标页")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "管理公司制度库文档" }));

    expect(await screen.findByText("文档管理目标页")).toBeInTheDocument();
  });

  it("keeps document management out of the detail drawer", async () => {
    renderRoutedPage();

    fireEvent.click(await screen.findByRole("button", { name: "查看公司制度库详情" }));
    const drawer = await screen.findByRole("dialog", { name: "公司制度库" });

    expect(screen.queryByText("文档管理目标页")).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("heading", { name: "文档" })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("link", { name: "管理文档" })).not.toBeInTheDocument();
    expect(within(drawer).queryByLabelText("选择知识库文档")).not.toBeInTheDocument();
  });

  it("edits knowledge base name and description from the detail drawer", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "查看公司制度库详情" }));
    const drawer = await screen.findByRole("dialog", { name: "公司制度库" });
    fireEvent.click(within(drawer).getByRole("button", { name: "编辑知识库基础信息" }));

    const dialog = await screen.findByRole("dialog", { name: "编辑知识库" });
    expect(within(dialog).getByLabelText("知识库名称")).toHaveValue("公司制度库");
    expect(within(dialog).getByLabelText("知识库说明")).toHaveValue("公司制度和员工手册");
    fireEvent.change(within(dialog).getByLabelText("知识库名称"), { target: { value: " 新制度库 " } });
    fireEvent.change(within(dialog).getByLabelText("知识库说明"), { target: { value: " 新说明 " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(updateKnowledgeBaseMock).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-active",
      name: "新制度库",
      description: "新说明"
    }));
    expect(await screen.findByText("知识库“新制度库”已更新")).toBeInTheDocument();
  });

  it("does not show knowledge base edit controls without manage permission", async () => {
    renderPage([permissions.knowledgeRead]);

    fireEvent.click(await screen.findByRole("button", { name: "查看公司制度库详情" }));
    const drawer = await screen.findByRole("dialog", { name: "公司制度库" });
    expect(within(drawer).queryByRole("button", { name: "编辑知识库基础信息" })).not.toBeInTheDocument();
  });

  it("adds an account grant with required read and optional upload actions", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "管理公司制度库成员授权" }));
    const drawer = await screen.findByRole("dialog", { name: "公司制度库" });
    expect(await within(drawer).findByText("owner@example.com")).toBeInTheDocument();
    fireEvent.click(await within(drawer).findByRole("button", { name: "添加成员授权" }));
    const dialog = await screen.findByRole("dialog", { name: "添加成员授权" });
    fireEvent.click(within(dialog).getByRole("button", { name: "选择授权成员" }));
    fireEvent.click(await screen.findByRole("option", { name: /文档维护者.*editor@example.com/ }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "上传文档" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "添加 1 位成员" }));

    await waitFor(() => expect(createKnowledgeAccountGrantMock).toHaveBeenCalledWith({
      userId: "usr_2",
      knowledgeBaseId: "kb-active",
      actions: ["read", "upload"]
    }));
  });

  it("edits the account MCP permission from the knowledge base detail", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "管理公司制度库成员授权" }));
    const drawer = await screen.findByRole("dialog", { name: "公司制度库" });
    fireEvent.click(await within(drawer).findByRole("button", { name: "编辑知识用户成员授权" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑成员授权" });
    expect(within(dialog).getByRole("checkbox", { name: "MCP 调用" })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "上传文档" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(replaceKnowledgeAccountGrantMock).toHaveBeenCalledWith({
      userId: "usr_1",
      knowledgeBaseId: "kb-active",
      actions: ["read", "upload", "mcp"]
    }));
  });

  it("shows the specific reason below the generic knowledge base delete error", async () => {
    deleteKnowledgeBaseMock.mockRejectedValueOnce(new APIError(
      "当前状态不允许执行该操作",
      409,
      "conflict",
      [{ reason: "该知识库仍有账户授权，请先在知识库详情中撤销相关账户授权。" }]
    ));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "查看公司制度库详情" }));
    const drawer = await screen.findByRole("dialog", { name: "公司制度库" });
    fireEvent.click(within(drawer).getByRole("button", { name: "删除知识库" }));
    const dialog = await screen.findByRole("dialog", { name: "删除知识库" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));

    expect(await within(dialog).findByText("删除失败：当前状态不允许执行该操作。")).toBeInTheDocument();
    expect(within(dialog).getByText("具体原因：该知识库仍有账户授权，请先在知识库详情中撤销相关账户授权。")).toBeInTheDocument();
  });
});

function renderPage(adminPermissions?: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const page = (
    <MemoryRouter initialEntries={["/admin/knowledge-bases"]}>
      <KnowledgeBasesPage />
    </MemoryRouter>
  );

  return render(
    <QueryClientProvider client={queryClient}>
      {adminPermissions ? (
        <AdminPermissionsProvider account={{
          userId: "usr_reader",
          email: "reader@example.com",
          name: "只读管理员",
          status: "active",
          adminPermissions
        }}>
          {page}
        </AdminPermissionsProvider>
      ) : page}
    </QueryClientProvider>
  );
}

function renderRoutedPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/admin/knowledge-bases"]}>
        <Routes>
          <Route path="/admin/knowledge-bases" element={<KnowledgeBasesPage />} />
          <Route
            path="/admin/knowledge-bases/documents"
            element={<div>文档管理目标页</div>}
          />
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
