import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { APIError } from "@/lib/api";
import { currentAccount } from "@/lib/auth-api";
import { approvalsApp, type ApprovalDetail, type ApprovalItem } from "@/lib/approvals-api";
import { AppApprovalDetailPage, AppApprovalsPage } from "./app-approvals";

vi.mock("@/lib/auth-api", async () => ({ ...await vi.importActual<typeof import("@/lib/auth-api")>("@/lib/auth-api"), currentAccount: vi.fn() }));
vi.mock("@/lib/approvals-api", () => ({ approvalsApp: { list: vi.fn(), detail: vi.fn(), files: vi.fn(), file: vi.fn(), packageURL: vi.fn((id: string) => `/api/v1/app/approvals/skill/${id}/package`), skillDecision: vi.fn(), workflowDecision: vi.fn() } }));

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const account = (userId: string) => ({ user: { userId, name: userId, email: `${userId}@test.invalid`, status: "active" }, redirectTo: "/app" });
const item = (id: string, overrides: Partial<ApprovalItem> = {}): ApprovalItem => ({ kind: "workflow", id, type: "workflow", title: `审批 ${id}`, business_status: "running", my_status: "pending", created_at: "2026-10-09T09:00:00Z", can_process: true, ...overrides });
const detail = (id: string, overrides: Partial<ApprovalItem> = {}): ApprovalDetail => ({
  item: item(id, overrides),
  workflow: { id: `instance-${id}`, template_id: "template", template_revision: 1, started_by: "starter", started_at: "2026-10-09T09:00:00Z", status: "running", nodes: [{ node_id: "review", title: "人工审批", type: "approval", order: 0, instruction: "核对输入" }], tasks: [] },
  task: { task_id: id, node_id: "review", type: "approval", status: "pending", input: { text: `输入 ${id}` } }
});

function TestNavigation() {
  const navigate = useNavigate();
  return <><button onClick={() => navigate("/app/approvals/workflow/b")}>切到 b</button><button onClick={() => navigate("/app/approvals/skill/b")}>切到 Skill b</button><button onClick={() => navigate("/app/approvals")}>返回列表</button><button onClick={() => navigate("/app/approvals?view=initiated&type=workflow&status=running")}>切换地址筛选</button></>;
}

function chooseTab(name: string) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.pointerDown(tab);
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

function mount(path = "/app/approvals") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["auth", "me"], account("me"));
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><TestNavigation /><Routes>
    <Route path="/app/approvals" element={<AppApprovalsPage />} />
    <Route path="/app/approvals/:kind/:id" element={<AppApprovalDetailPage />} />
  </Routes></MemoryRouter></QueryClientProvider>);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentAccount).mockResolvedValue(account("me"));
  vi.mocked(approvalsApp.list).mockResolvedValue({ items: [], meta: { has_next: false, next_cursor: "" } });
  vi.mocked(approvalsApp.detail).mockImplementation(async (_kind, id) => detail(id));
  vi.mocked(approvalsApp.files).mockResolvedValue({ items: [] });
  vi.mocked(approvalsApp.workflowDecision).mockResolvedValue({});
  vi.mocked(approvalsApp.skillDecision).mockResolvedValue({});
});

describe("个人审批列表", () => {
  it("三视图、混合类型、两种状态与实例详情入口", async () => {
    vi.mocked(approvalsApp.list).mockResolvedValue({ items: [item("round", { kind: "skill", type: "skill", version: "1", my_status: "approved", business_status: "pending" }), item("instance", { kind: "workflow_instance", can_process: false, my_status: "" })], meta: { has_next: false, next_cursor: "" } });
    mount();
    expect(await screen.findByRole("link", { name: "查看审批 round" })).toHaveAttribute("href", expect.stringContaining("/app/approvals/skill/round"));
    expect(screen.getByRole("link", { name: "查看审批 instance" })).toHaveAttribute("href", expect.stringContaining("/app/approvals/workflow_instance/instance"));
    expect(screen.getByText("本人已通过")).toBeInTheDocument();
    expect(screen.getByText("待审核")).toBeInTheDocument();
    chooseTab("已办");
    await waitFor(() => expect(approvalsApp.list).toHaveBeenLastCalledWith(expect.objectContaining({ view: "done", cursor: "" }), expect.anything()));
    chooseTab("我发起");
    await waitFor(() => expect(approvalsApp.list).toHaveBeenLastCalledWith(expect.objectContaining({ view: "initiated", cursor: "" }), expect.anything()));
  });

  it("下一页仅使用服务端游标，切换筛选回首页且迟到页不覆盖", async () => {
    const late = deferred<Awaited<ReturnType<typeof approvalsApp.list>>>();
    vi.mocked(approvalsApp.list).mockResolvedValueOnce({ items: [item("first")], meta: { has_next: true, next_cursor: "server-tie-key" } }).mockReturnValueOnce(late.promise).mockResolvedValue({ items: [item("filtered")], meta: { has_next: false, next_cursor: "" } });
    mount();
    await screen.findByRole("link", { name: "查看审批 first" });
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(approvalsApp.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "server-tie-key" }), expect.anything()));
    chooseTab("已办");
    await screen.findByRole("link", { name: "查看审批 filtered" });
    await act(async () => late.resolve({ items: [item("stale")], meta: { has_next: false, next_cursor: "" } }));
    expect(screen.queryByRole("link", { name: "查看审批 stale" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(approvalsApp.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "" }), expect.anything()));
  });

  it.each([403, 404, 409, 500])("列表 %s 不展示旧数据且可刷新", async status => {
    vi.mocked(approvalsApp.list).mockRejectedValueOnce(new APIError("内部错误不可展示", status, "failed"));
    mount();
    expect(await screen.findByRole("alert")).not.toHaveTextContent("内部错误不可展示");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("暂无审批记录")).toBeInTheDocument();
  });
});

describe("审批详情隔离和处理", () => {
  it.each([200, 403, 404, 409, 500])("换详情后迟到 %s 不覆盖新记录", async status => {
    const late = deferred<ApprovalDetail>();
    vi.mocked(approvalsApp.detail).mockReturnValueOnce(late.promise).mockResolvedValue(detail("b"));
    mount("/app/approvals/workflow/a");
    await waitFor(() => expect(approvalsApp.detail).toHaveBeenCalledWith("workflow", "a", expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: "切到 b" }));
    await screen.findByRole("heading", { name: "审批 b" });
    await act(async () => { if (status === 200) late.resolve(detail("a")); else late.reject(new APIError("旧请求错误", status, "stale")); });
    expect(screen.getByRole("heading", { name: "审批 b" })).toBeInTheDocument();
    expect(screen.queryByText("旧请求错误")).not.toBeInTheDocument();
    expect(screen.queryByText("输入 a")).not.toBeInTheDocument();
  });

  it.each([200, 403, 404, 409, 500])("换详情后旧提交 %s 不影响新行、表单或反馈", async status => {
    const late = deferred<unknown>();
    vi.mocked(approvalsApp.workflowDecision).mockReturnValueOnce(late.promise);
    mount("/app/approvals/workflow/a");
    fireEvent.click(await screen.findByRole("button", { name: "通过" }));
    fireEvent.change(screen.getByLabelText("审批意见"), { target: { value: "a 的输入" } });
    fireEvent.click(screen.getByRole("button", { name: "确认通过" }));
    fireEvent.click(screen.getByRole("button", { name: "切到 b" }));
    fireEvent.click(await screen.findByRole("button", { name: "通过" }));
    await act(async () => { if (status === 200) late.resolve({}); else late.reject(new APIError("a 提交错误", status, "stale")); });
    expect(screen.getByLabelText("审批意见")).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(approvalsApp.detail).toHaveBeenCalledTimes(2);
  });

  it("提交禁重复，500 后保留原输入和幂等键重试，成功刷新", async () => {
    const late = deferred<unknown>();
    vi.mocked(approvalsApp.workflowDecision).mockReturnValueOnce(late.promise).mockResolvedValue({});
    mount("/app/approvals/workflow/a");
    fireEvent.click(await screen.findByRole("button", { name: "驳回" }));
    fireEvent.change(screen.getByLabelText("审批意见"), { target: { value: "原意见" } });
    fireEvent.click(screen.getByRole("button", { name: "确认驳回" }));
    expect(screen.getByRole("button", { name: "提交中..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    expect(approvalsApp.workflowDecision).toHaveBeenCalledTimes(1);
    await act(async () => late.reject(new APIError("敏感错误", 500, "failed")));
    expect(screen.getByLabelText("审批意见")).toHaveValue("原意见");
    expect(screen.getByLabelText("审批意见")).toBeDisabled();
    expect(screen.getByRole("alert")).not.toHaveTextContent("敏感错误");
    fireEvent.click(screen.getByRole("button", { name: "重试原提交" }));
    await waitFor(() => expect(approvalsApp.workflowDecision).toHaveBeenCalledTimes(2));
    expect(vi.mocked(approvalsApp.workflowDecision).mock.calls[1]).toEqual(vi.mocked(approvalsApp.workflowDecision).mock.calls[0]);
    expect(vi.mocked(approvalsApp.workflowDecision).mock.calls[0][1]).toMatchObject({ decision: "reject", comment: "原意见", idempotency_key: expect.any(String) });
    await waitFor(() => expect(approvalsApp.detail).toHaveBeenCalledTimes(2));
  });

  it.each([403, 404, 409])("提交 %s 立即撤下旧操作并刷新详情", async status => {
    vi.mocked(approvalsApp.workflowDecision).mockRejectedValueOnce(new APIError("失效", status, "conflict"));
    vi.mocked(approvalsApp.detail).mockResolvedValueOnce(detail("a")).mockResolvedValue(detail("a", { can_process: false, my_status: "approved" }));
    mount("/app/approvals/workflow/a");
    fireEvent.click(await screen.findByRole("button", { name: "通过" }));
    fireEvent.click(screen.getByRole("button", { name: "确认通过" }));
    await waitFor(() => expect(approvalsApp.detail).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "通过" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByLabelText("审批意见")).not.toBeInTheDocument());
  });

  it.each([200, 403, 404, 409, 500])("切换身份后迟到详情 %s 和前身份缓存不泄露", async status => {
    const late = deferred<ApprovalDetail>();
    vi.mocked(approvalsApp.detail).mockReturnValueOnce(late.promise).mockResolvedValue(detail("new-account", { can_process: false }));
    const client = mount("/app/approvals/workflow/a");
    await waitFor(() => expect(approvalsApp.detail).toHaveBeenCalledTimes(1));
    await act(async () => client.setQueryData(["auth", "me"], account("other")));
    await screen.findByRole("heading", { name: "审批 new-account" });
    await act(async () => { if (status === 200) late.resolve(detail("old-account")); else late.reject(new APIError("前身份错误", status, "stale")); });
    expect(screen.queryByText("输入 old-account")).not.toBeInTheDocument();
    expect(screen.queryByText("前身份错误")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "审批 new-account" })).toBeInTheDocument();
  });

  it("身份切换与登出清空旧意见，切回本人重新读取而非复用审批缓存", async () => {
    const client = mount("/app/approvals/workflow/a");
    fireEvent.click(await screen.findByRole("button", { name: "通过" }));
    fireEvent.change(screen.getByLabelText("审批意见"), { target: { value: "旧身份意见" } });
    await act(async () => client.setQueryData(["auth", "me"], account("other")));
    await waitFor(() => expect(approvalsApp.detail).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText("审批意见")).not.toBeInTheDocument();
    await act(async () => client.setQueryData(["auth", "me"], account("me")));
    await waitFor(() => expect(approvalsApp.detail).toHaveBeenCalledTimes(3));
    fireEvent.click(await screen.findByRole("button", { name: "通过" }));
    expect(screen.getByLabelText("审批意见")).toHaveValue("");
    await act(async () => client.setQueryData(["auth", "me"], { user: null }));
    await waitFor(() => expect(screen.queryByLabelText("审批意见")).not.toBeInTheDocument());
  });

  it("实例与 agent 节点没有处理或执行入口", async () => {
    vi.mocked(approvalsApp.detail).mockResolvedValue({ ...detail("instance"), item: item("instance", { kind: "workflow_instance", can_process: true }), task: { ...detail("instance").task!, type: "agent" } });
    mount("/app/approvals/workflow_instance/instance");
    await screen.findByRole("heading", { name: "审批 instance" });
    expect(screen.queryByRole("button", { name: "通过" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /执行|启动/ })).not.toBeInTheDocument();
  });
});

function skillDetail(id: string, overrides: Partial<ApprovalItem> = {}): ApprovalDetail {
  return {
    item: item(id, { kind: "skill", type: "skill", title: `Skill ${id}`, version_id: `version-${id}`, version: "1", business_status: "pending", ...overrides }),
    skill: {
      canReview: true,
      skill: { skillId: "skill", name: `Skill ${id}`, description: "原轮目标版本", currentVersionId: "published-version", createdBy: "starter", createdAt: "2026-10-09T09:00:00Z", updatedAt: "2026-10-09T09:00:00Z" },
      versions: [{ versionId: `version-${id}`, skillId: "skill", version: "1", description: "", changelog: "", packageSha256: "digest", source: null, createdAt: "2026-10-09T09:00:00Z", approvalStatus: "pending", localApproval: { requestId: id, status: "pending", total: 2, approved: 0, approvers: [{ userId: "me", name: "本人", status: "pending", comment: "", decidedAt: null }, { userId: "other", name: "其他评审人", status: "pending", comment: "", decidedAt: null }] } }]
    }
  };
}

async function chooseOption(label: string, value: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: value }));
}

async function fillScores() {
  for (const label of ["场景价值", "结果有效", "使用友好", "复用价值"]) await chooseOption(label, "4 分");
}

describe("Skill 原轮详情和评分", () => {
  it("同一 Skill 版本切换审核轮次不保留前一轮评分，文件仍绑定各自请求", async () => {
    vi.mocked(approvalsApp.detail).mockImplementation(async (_kind, id) => {
      const target = skillDetail(id, { version_id: "shared-version" });
      target.skill!.versions[0].versionId = "shared-version";
      return target;
    });
    mount("/app/approvals/skill/a");
    fireEvent.click(await screen.findByRole("button", { name: "通过" }));
    await chooseOption("场景价值", "5 分");
    fireEvent.change(screen.getByLabelText("审批意见"), { target: { value: "a 轮评分" } });
    fireEvent.click(screen.getByRole("button", { name: "切到 Skill b" }));
    fireEvent.click(await screen.findByRole("button", { name: "通过" }));
    expect(screen.getByRole("combobox", { name: "场景价值" })).toHaveTextContent("未评分");
    expect(screen.getByLabelText("审批意见")).toHaveValue("");
    expect(approvalsApp.files).toHaveBeenCalledWith("a");
    expect(approvalsApp.files).toHaveBeenCalledWith("b");
    expect(screen.getByRole("link", { name: "下载 ZIP 包安装" })).toHaveAttribute("href", "/api/v1/app/approvals/skill/b/package");
  });

  it("刷新后不复用本轮之前缓存的文件，撤权响应不展示旧正文", async () => {
    vi.mocked(approvalsApp.detail).mockResolvedValue(skillDetail("a"));
    vi.mocked(approvalsApp.files).mockResolvedValue({ items: [{ path: "SKILL.md", size: 20 }] });
    vi.mocked(approvalsApp.file).mockResolvedValueOnce({ path: "SKILL.md", size: 20, content: "# 撤权前正文" }).mockRejectedValue(new APIError("撤权", 403, "forbidden"));
    mount("/app/approvals/skill/a");
    await screen.findByRole("heading", { name: "撤权前正文" });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(approvalsApp.file).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "撤权前正文" })).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("暂无访问权限");
  });

  it("仅目标版本及原轮、个人通过整单待审，无 admin 入口或假总分，文件绑定 request", async () => {
    const original = skillDetail("old", { can_process: false, my_status: "approved" });
    original.skill!.versions[0].localApproval!.approvers[0] = { userId: "me", name: "本人", status: "approved", comment: "原轮意见", decidedAt: null };
    original.skill!.versions.push({ ...original.skill!.versions[0], versionId: "published-version", version: "9", localApproval: { ...original.skill!.versions[0].localApproval!, requestId: "new-round" } });
    vi.mocked(approvalsApp.detail).mockResolvedValue(original);
    vi.mocked(approvalsApp.files).mockResolvedValue({ items: [{ path: "SKILL.md", size: 20 }] });
    vi.mocked(approvalsApp.file).mockResolvedValue({ path: "SKILL.md", size: 20, content: "# 原轮说明" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mount("/app/approvals/skill/old");
    expect(await screen.findByText("原轮意见")).toBeInTheDocument();
    expect(screen.getByText(/本人已通过，整单仍待其他评审人处理/)).toBeInTheDocument();
    expect(screen.queryByLabelText("正式评分汇总")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /设为当前|审批通过|提交钉钉|重新提交审核|通过|驳回/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载 ZIP 包安装" })).toHaveAttribute("href", "/api/v1/app/approvals/skill/old/package");
    expect(await screen.findByRole("heading", { name: "原轮说明" })).toBeInTheDocument();
    expect(approvalsApp.files).toHaveBeenCalledWith("old");
    expect(approvalsApp.file).toHaveBeenCalledWith("old", "SKILL.md");
    expect(screen.queryByText("v9")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("不能绑定原轮时只显示元数据，不下载或处理其他版本", async () => {
    const wrong = skillDetail("old");
    wrong.skill!.versions[0].localApproval!.requestId = "new-round";
    vi.mocked(approvalsApp.detail).mockResolvedValue(wrong);
    mount("/app/approvals/skill/old");
    expect(await screen.findByText("审核内容不可用")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "下载 ZIP 包安装" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "通过" })).not.toBeInTheDocument();
    expect(approvalsApp.files).not.toHaveBeenCalled();
  });

  it("复用四维标准，漏填不可通过、驳回空白不可提交", async () => {
    vi.mocked(approvalsApp.detail).mockResolvedValue(skillDetail("a"));
    mount("/app/approvals/skill/a");
    fireEvent.click(await screen.findByRole("button", { name: "通过" }));
    expect(screen.getByText(/评分标准 manual-v1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认通过" })).toBeDisabled();
    await chooseOption("场景价值", "4 分");
    expect(screen.getByRole("button", { name: "确认通过" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "驳回" }));
    fireEvent.change(screen.getByLabelText("审批意见"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "确认驳回" })).toBeDisabled();
    expect(approvalsApp.skillDecision).not.toHaveBeenCalled();
  });

  it("Skill 提交防重复、500 保留原评分意见重试，成功刷新原轮", async () => {
    vi.mocked(approvalsApp.detail).mockResolvedValue(skillDetail("a"));
    const late = deferred<unknown>();
    vi.mocked(approvalsApp.skillDecision).mockReturnValueOnce(late.promise).mockResolvedValue({});
    mount("/app/approvals/skill/a");
    fireEvent.click(await screen.findByRole("button", { name: "通过" }));
    await fillScores();
    fireEvent.change(screen.getByLabelText("审批意见"), { target: { value: "原评分意见" } });
    fireEvent.click(screen.getByRole("button", { name: "确认通过" }));
    expect(screen.getByRole("button", { name: "提交中..." })).toBeDisabled();
    expect(approvalsApp.skillDecision).toHaveBeenCalledTimes(1);
    await act(async () => late.reject(new APIError("内部详情", 500, "failed")));
    expect(screen.getByLabelText("审批意见")).toHaveValue("原评分意见");
    for (const label of ["场景价值", "结果有效", "使用友好", "复用价值"]) expect(screen.getByRole("combobox", { name: label })).toHaveTextContent("4 分");
    fireEvent.click(screen.getByRole("button", { name: "确认通过" }));
    await waitFor(() => expect(approvalsApp.detail).toHaveBeenCalledTimes(2));
    expect(vi.mocked(approvalsApp.skillDecision).mock.calls[1]).toEqual(vi.mocked(approvalsApp.skillDecision).mock.calls[0]);
    expect(approvalsApp.skillDecision).toHaveBeenCalledWith("a", { decision: "approved", comment: "原评分意见", scores: { scenario_value: 4, result_effectiveness: 4, ease_of_use: 4, reuse_value: 4 } });
  });

  it.each([403, 404, 409])("Skill 提交 %s 撤下旧评分表单并重新读取", async status => {
    vi.mocked(approvalsApp.detail).mockResolvedValueOnce(skillDetail("a")).mockResolvedValue(skillDetail("a", { can_process: false }));
    vi.mocked(approvalsApp.skillDecision).mockRejectedValueOnce(new APIError("不可提交", status, "stale"));
    mount("/app/approvals/skill/a");
    fireEvent.click(await screen.findByRole("button", { name: "驳回" }));
    fireEvent.change(screen.getByLabelText("审批意见"), { target: { value: "原意见" } });
    fireEvent.click(screen.getByRole("button", { name: "确认驳回" }));
    await waitFor(() => expect(approvalsApp.detail).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "场景价值" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "通过" })).not.toBeInTheDocument();
  });

  it.each([200, 403, 404, 409, 500])("身份切换后 Skill 迟到提交 %s 不泄漏前评分和意见", async status => {
    vi.mocked(approvalsApp.detail).mockResolvedValue(skillDetail("a"));
    const late = deferred<unknown>();
    vi.mocked(approvalsApp.skillDecision).mockReturnValueOnce(late.promise);
    const client = mount("/app/approvals/skill/a");
    fireEvent.click(await screen.findByRole("button", { name: "通过" }));
    await fillScores();
    fireEvent.change(screen.getByLabelText("审批意见"), { target: { value: "前身份评分意见" } });
    fireEvent.click(screen.getByRole("button", { name: "确认通过" }));
    await act(async () => client.setQueryData(["auth", "me"], account("other")));
    await waitFor(() => expect(approvalsApp.detail).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: "通过" }));
    await act(async () => { if (status === 200) late.resolve({}); else late.reject(new APIError("旧身份错误", status, "stale")); });
    expect(screen.getByLabelText("审批意见")).toHaveValue("");
    for (const label of ["场景价值", "结果有效", "使用友好", "复用价值"]) expect(screen.getByRole("combobox", { name: label })).toHaveTextContent("未评分");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(approvalsApp.detail).toHaveBeenCalledTimes(2);
  });

  it.each([200, 403, 404, 409, 500])("切换 Skill 详情后迟到文件 %s 不覆盖目标轮内容", async status => {
    vi.mocked(approvalsApp.detail).mockImplementation(async (_kind, id) => skillDetail(id));
    vi.mocked(approvalsApp.files).mockResolvedValue({ items: [{ path: "SKILL.md", size: 20 }] });
    const late = deferred<Awaited<ReturnType<typeof approvalsApp.file>>>();
    vi.mocked(approvalsApp.file).mockReturnValueOnce(late.promise).mockResolvedValue({ path: "SKILL.md", size: 20, content: "# b 的说明" });
    mount("/app/approvals/skill/a");
    await waitFor(() => expect(approvalsApp.file).toHaveBeenCalledWith("a", "SKILL.md"));
    fireEvent.click(screen.getByRole("button", { name: "切到 Skill b" }));
    await screen.findByRole("heading", { name: "b 的说明" });
    await act(async () => { if (status === 200) late.resolve({ path: "SKILL.md", size: 20, content: "# a 的旧说明" }); else late.reject(new APIError("a 的文件错误", status, "stale")); });
    expect(screen.getByRole("heading", { name: "b 的说明" })).toBeInTheDocument();
    expect(screen.queryByText("a 的文件错误")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "a 的旧说明" })).not.toBeInTheDocument();
  });
});

describe("列表过滤与身份边界", () => {
  it("类型和整单状态切换各自重置分页；地址变化也不携带旧筛选游标", async () => {
    vi.mocked(approvalsApp.list).mockResolvedValue({ items: [item("row")], meta: { has_next: true, next_cursor: "only-old-filter" } });
    mount();
    await screen.findByRole("link", { name: "查看审批 row" });
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(approvalsApp.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "only-old-filter" }), expect.anything()));
    await chooseOption("类型", "Skill 审核");
    await waitFor(() => expect(approvalsApp.list).toHaveBeenLastCalledWith(expect.objectContaining({ type: "skill", cursor: "" }), expect.anything()));
    await chooseOption("整单状态", "待审核");
    await waitFor(() => expect(approvalsApp.list).toHaveBeenLastCalledWith(expect.objectContaining({ type: "skill", status: "pending", cursor: "" }), expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(approvalsApp.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "only-old-filter" }), expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: "切换地址筛选" }));
    await waitFor(() => expect(approvalsApp.list).toHaveBeenLastCalledWith({ view: "initiated", type: "workflow", status: "running", cursor: "" }, expect.anything()));
  });

  it.each([200, 403, 404, 409, 500])("身份切换后列表迟到 %s 不展示前身份记录", async status => {
    const late = deferred<Awaited<ReturnType<typeof approvalsApp.list>>>();
    vi.mocked(approvalsApp.list).mockReturnValueOnce(late.promise).mockResolvedValue({ items: [item("new-user")], meta: { next_cursor: "", has_next: false } });
    const client = mount();
    await waitFor(() => expect(approvalsApp.list).toHaveBeenCalledTimes(1));
    await act(async () => client.setQueryData(["auth", "me"], account("other")));
    await screen.findByRole("link", { name: "查看审批 new-user" });
    await act(async () => { if (status === 200) late.resolve({ items: [item("old-user")], meta: { next_cursor: "", has_next: false } }); else late.reject(new APIError("前用户列表错误", status, "stale")); });
    expect(screen.queryByRole("link", { name: "查看审批 old-user" })).not.toBeInTheDocument();
    expect(screen.queryByText("前用户列表错误")).not.toBeInTheDocument();
  });
});

describe("详情失败后的刷新", () => {
  it.each([403, 404, 409, 500])("详情 %s 隐藏旧操作，手动刷新可恢复", async status => {
    vi.mocked(approvalsApp.detail).mockRejectedValueOnce(new APIError("服务器内部地址", status, "failed")).mockResolvedValue(detail("a"));
    mount("/app/approvals/workflow/a");
    expect(await screen.findByRole("alert")).not.toHaveTextContent("服务器内部地址");
    expect(screen.queryByRole("button", { name: "通过" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByRole("button", { name: "通过" })).toBeInTheDocument();
  });

  it("已加载详情刷新失败也不保留旧可操作记录", async () => {
    vi.mocked(approvalsApp.detail).mockResolvedValueOnce(detail("a")).mockRejectedValue(new APIError("撤销", 403, "forbidden"));
    mount("/app/approvals/workflow/a");
    await screen.findByRole("button", { name: "通过" });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "通过" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "审批 a" })).not.toBeInTheDocument();
  });
});
