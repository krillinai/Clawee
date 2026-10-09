import { afterEach, describe, expect, it, vi } from "vitest";
import { workflowAdmin } from "./workflow-api";

afterEach(() => vi.unstubAllGlobals());

describe("工作流 API", () => {
  it("管理端发起复用JSON接口并传递初始对象及幂等键", async () => {
    const data = { instance_id: "instance-1", task_id: "task-1", status: "running" };
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(workflowAdmin.start("template/1", { text: "输入", nested: { value: 1 } }, "fixed-key")).resolves.toMatchObject(data);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/admin/workflow-templates/template%2F1/instances");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(init?.body as string)).toEqual({ initial_input: { text: "输入", nested: { value: 1 } }, idempotency_key: "fixed-key" });
  });

  it.each([400, 403, 404, 409, 413, 500])("发起错误（%s）原样交给调用方，不自动创建重试请求", async status => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "start_rejected", message: "发起被拒绝" } }, { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(workflowAdmin.start("template-1", {}, "same-key")).rejects.toMatchObject({ status, code: "start_rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("网络结果未知时调用方可使用同输入同key重试", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("网络中断")).mockResolvedValueOnce(Response.json({ data: { instance_id: "instance-1", task_id: "task-1", status: "running" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(workflowAdmin.start("template-1", { value: "原输入" }, "same-key")).rejects.toThrow("网络中断");
    await workflowAdmin.start("template-1", { value: "原输入" }, "same-key");
    expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
  });
  it("账户和角色搜索沿用工作流接口，编码搜索条件", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ role_id: "role_1", name: "审核组" }], meta: { next_cursor: "" } }));
    vi.stubGlobal("fetch", fetchMock);
    await workflowAdmin.assignees("张三 / a");
    await expect(workflowAdmin.roles("审核组 / r")).resolves.toMatchObject({ items: [{ role_id: "role_1", name: "审核组" }] });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/admin/workflow-assignees?q=%E5%BC%A0%E4%B8%89%20%2F%20a", "/api/v1/admin/workflow-assignee-roles?q=%E5%AE%A1%E6%A0%B8%E7%BB%84%20%2F%20r"
    ]);
  });

  it("保存账户和角色并集，兼容旧单账户，禁止回写实例候选快照", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: { id: "template-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const item = { name: "审核", description: "", expected_revision: 0, nodes: [{ node_id: "review", order: 0, type: "approval" as const, title: "审核", instruction: "审核", assignee_user_id: "a", assignee_user_ids: ["b", "a", "b"], assignee_role_ids: ["r", "r"], resolved_user_ids: ["forged"] }] };
    await workflowAdmin.save(item);
    await workflowAdmin.save({ ...item, id: "template/1", expected_revision: 2 });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([["/api/v1/admin/workflow-templates", "POST"], ["/api/v1/admin/workflow-templates/template%2F1", "PUT"]]);
    const node = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).nodes[0];
    expect(node).toMatchObject({ assignee_user_id: "a", assignee_user_ids: ["b", "a"], assignee_role_ids: ["r"] });
    expect(node).not.toHaveProperty("resolved_user_ids");
  });

  it("实例详情不丢弃多人快照和实际处理人", async () => {
    const data = { id: "instance/1", nodes: [{ resolved_user_ids: ["a", "b"] }], tasks: [{ assignee_user_ids: ["a", "b"], handled_by: "b" }], user_names: { a: "张三", b: "李四" } };
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(workflowAdmin.instance("instance/1")).resolves.toMatchObject(data);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/admin/workflow-instances/instance%2F1");
  });
});
