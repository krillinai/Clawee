import { APIError } from "./api";
import { skillReviewWorkflowApi, type SkillReviewWorkflowRun } from "./skill-review-workflow-api";
import { workflowAdmin, type WorkflowInstance } from "./workflow-api";

export type WorkflowTaskListItem = { kind: "workflow"; value: WorkflowInstance } | { kind: "skill-review"; value: SkillReviewWorkflowRun };
type SourcePage<T> = { items: T[]; cursor: string; done: boolean };
export type WorkflowTaskCursor = { workflows: SourcePage<WorkflowInstance>; skills: SourcePage<SkillReviewWorkflowRun> };

// 保留两路游标和未消费的记录，避免两路时间分布不同时跨页漏掉任务。
export async function listWorkflowTasks(status: string, includeSkills: boolean, cursor?: WorkflowTaskCursor) {
  const workflows = cursor ? { ...cursor.workflows, items: [...cursor.workflows.items] } : { items: [], cursor: "", done: status === "error" || status === "revision_required" };
  const skills = cursor ? { ...cursor.skills, items: [...cursor.skills.items] } : { items: [], cursor: "", done: !includeSkills };
  const items: WorkflowTaskListItem[] = [];
  while (items.length < 20) {
    await Promise.all([
      !workflows.items.length && !workflows.done ? workflowAdmin.instances(status, workflows.cursor).then(page => {
        workflows.items = page.items;
        workflows.cursor = page.meta.next_cursor;
        workflows.done = !page.meta.next_cursor;
      }) : undefined,
      !skills.items.length && !skills.done ? skillReviewWorkflowApi.runs("", skills.cursor, status).then(page => {
        skills.items = page.items;
        skills.cursor = page.meta.next_cursor;
        skills.done = !page.meta.next_cursor;
      }).catch(error => {
        if (!(error instanceof APIError) || error.status !== 404) throw error;
        skills.done = true;
      }) : undefined
    ]);
    const workflow = workflows.items[0];
    const skill = skills.items[0];
    if (!workflow && !skill) {
      if (workflows.done && skills.done) break;
      continue;
    }
    if (workflow && (!skill || Date.parse(workflow.started_at) >= Date.parse(skill.created_at))) {
      items.push({ kind: "workflow", value: workflow });
      workflows.items.shift();
    } else if (skill) {
      items.push({ kind: "skill-review", value: skill });
      skills.items.shift();
    }
  }
  const hasNext = workflows.items.length > 0 || skills.items.length > 0 || !workflows.done || !skills.done;
  return { items, next: hasNext ? { workflows, skills } : undefined };
}
