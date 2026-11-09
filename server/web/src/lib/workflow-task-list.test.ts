import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "./api";
import { skillReviewWorkflowApi, type SkillReviewWorkflowRun } from "./skill-review-workflow-api";
import { workflowAdmin, type WorkflowInstance } from "./workflow-api";
import { listWorkflowTasks } from "./workflow-task-list";

vi.mock("./workflow-api", () => ({ workflowAdmin: { instances: vi.fn() } }));
vi.mock("./skill-review-workflow-api", () => ({ skillReviewWorkflowApi: { runs: vi.fn() } }));

const at = (minute: number) => new Date(Date.UTC(2026, 9, 21, 0, minute)).toISOString();
const workflow = (minute: number): WorkflowInstance => ({ id: `w${minute}`, template_id: "t", template_revision: 1, nodes: [], status: "running", started_by: "admin", started_at: at(minute) });
const skill = (minute: number): SkillReviewWorkflowRun => ({ request_id: `s${minute}`, skill_id: "s", skill_name: "测试 Skill", version_id: "v", version: "1", uploaded_by: "writer", workflow_stage: "ai_running", approved: 0, total: 1, created_at: at(minute) });
const page = <T,>(items: T[], next_cursor = "") => ({ items, meta: { next_cursor } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(workflowAdmin.instances).mockResolvedValue(page([]));
  vi.mocked(skillReviewWorkflowApi.runs).mockResolvedValue(page([]));
});

describe("统一流程任务分页", () => {
  it("跨来源按时间排序，分页保留另一来源尚未消费的记录", async () => {
    vi.mocked(workflowAdmin.instances).mockResolvedValueOnce(page(Array.from({ length: 20 }, (_, i) => workflow(60 - i)), "workflow-next")).mockResolvedValueOnce(page([workflow(40)]));
    vi.mocked(skillReviewWorkflowApi.runs).mockResolvedValue(page([skill(30), skill(20)]));
    const first = await listWorkflowTasks("all", true);
    expect(first.items).toHaveLength(20);
    expect(first.items.every(item => item.kind === "workflow")).toBe(true);
    expect(first.next?.skills.items).toHaveLength(2);
    const snapshot = structuredClone(first.next);
    const second = await listWorkflowTasks("all", true, first.next);
    expect(second.items.map(item => item.kind === "workflow" ? item.value.id : item.value.request_id)).toEqual(["w40", "s30", "s20"]);
    expect(second.next).toBeUndefined();
    expect(first.next).toEqual(snapshot);
    expect(skillReviewWorkflowApi.runs).toHaveBeenCalledTimes(1);
    expect(workflowAdmin.instances).toHaveBeenLastCalledWith("all", "workflow-next");
  });

  it("一页内耗尽某路记录后继续读取该路，排序不被另一来源打断", async () => {
    vi.mocked(workflowAdmin.instances).mockResolvedValue(page([workflow(5)]));
    vi.mocked(skillReviewWorkflowApi.runs).mockResolvedValueOnce(page([skill(30)], "skill-next")).mockResolvedValueOnce(page([skill(20), skill(10)]));
    const result = await listWorkflowTasks("running", true);
    expect(result.items.map(item => item.kind === "workflow" ? item.value.id : item.value.request_id)).toEqual(["s30", "s20", "s10", "w5"]);
    expect(skillReviewWorkflowApi.runs).toHaveBeenLastCalledWith("", "skill-next", "running");
  });

  it("时间相同的两类任务不会互相覆盖", async () => {
    vi.mocked(workflowAdmin.instances).mockResolvedValue(page([workflow(1)]));
    vi.mocked(skillReviewWorkflowApi.runs).mockResolvedValue(page([skill(1)]));
    const result = await listWorkflowTasks("all", true);
    expect(result.items.map(item => item.kind)).toEqual(["workflow", "skill-review"]);
  });

  it("缺少 Skill 权限时只查询普通流程", async () => {
    vi.mocked(workflowAdmin.instances).mockResolvedValue(page([workflow(1)]));
    expect((await listWorkflowTasks("all", false)).items).toHaveLength(1);
    expect(skillReviewWorkflowApi.runs).not.toHaveBeenCalled();
  });

  it.each(["error", "revision_required"])("%s 只查询 Skill 审核，保留有效状态参数", async status => {
    await listWorkflowTasks(status, true);
    expect(workflowAdmin.instances).not.toHaveBeenCalled();
    expect(skillReviewWorkflowApi.runs).toHaveBeenCalledWith("", "", status);
  });

  it("未配置 Skill Hub 时仍可读取普通流程", async () => {
    vi.mocked(workflowAdmin.instances).mockResolvedValue(page([workflow(1)]));
    vi.mocked(skillReviewWorkflowApi.runs).mockRejectedValue(new APIError("不存在", 404, "not_found"));
    expect((await listWorkflowTasks("all", true)).items).toHaveLength(1);
  });

  it("权限或加载失败时返回错误，避免静默缺少任务", async () => {
    vi.mocked(skillReviewWorkflowApi.runs).mockRejectedValue(new APIError("无权限", 403, "forbidden"));
    await expect(listWorkflowTasks("all", true)).rejects.toMatchObject({ status: 403 });
  });
});
