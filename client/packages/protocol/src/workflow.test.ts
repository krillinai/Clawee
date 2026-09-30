import { describe, expect, it } from 'vitest';
import { workflowNodeCandidates, workflowTaskCandidates, type EnterpriseWorkflowNode } from './workflow.js';

const node: EnterpriseWorkflowNode = { node_id: 'one', order: 0, type: 'agent', title: '执行', instruction: '执行', assignee_user_id: 'a' };

describe('工作流候选名单', () => {
  it('兼容旧单账户并合并直接账户', () => {
    expect(workflowTaskCandidates({ assignee_user_id: 'a' })).toEqual(['a']);
    expect(workflowNodeCandidates({ ...node, assignee_user_ids: ['b', 'a', 'b'] })).toEqual(['b', 'a']);
  });
  it('以固定快照为准，不缩减为旧首负责人', () => {
    expect(workflowTaskCandidates({ assignee_user_id: 'a', assignee_user_ids: ['b', 'c', 'b'] })).toEqual(['b', 'c']);
    expect(workflowNodeCandidates({ ...node, resolved_user_ids: ['b', 'c', 'b'] })).toEqual(['b', 'c']);
    expect(workflowTaskCandidates({ assignee_user_id: 'a', assignee_user_ids: [] })).toEqual([]);
  });
});
