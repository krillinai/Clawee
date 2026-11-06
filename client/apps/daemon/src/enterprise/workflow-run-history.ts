import type Database from 'better-sqlite3';
import type { EnterpriseWorkflowCompletion, ThreadHistoryItem } from '@clawee/protocol';

export type WorkflowRunContext = {
  instanceId: string;
  workflowName: string;
  nodeTitle: string;
  nodeOrder: number;
  instruction: string;
  input: string;
  customInput?: string;
  continuation?: boolean;
  completion?: EnterpriseWorkflowCompletion;
};

type ContextRow = {
  task_id: string;
  context_json: string;
  state: string;
  updated_at: string;
};

type WorkflowRun = { id: string; status: string; createdAt: string; updatedAt: string };

export function createWorkflowRunHistory(db: Database.Database) {
  const insert = db.prepare('INSERT INTO enterprise_workflow_run_contexts (run_id,task_id,user_id,context_json,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
  const update = db.prepare('UPDATE enterprise_workflow_run_contexts SET state=?,updated_at=? WHERE run_id=?');
  const updateCompletion = db.prepare("UPDATE enterprise_workflow_run_contexts SET context_json=json_set(context_json,'$.completion',json(?)) WHERE run_id=?");
  const read = db.prepare<[string, string], ContextRow>('SELECT task_id,context_json,state,updated_at FROM enterprise_workflow_run_contexts WHERE run_id=? AND user_id=?');

  return {
    save(runId: string, taskId: string, userId: string, context: WorkflowRunContext) {
      const now = new Date().toISOString();
      insert.run(runId, taskId, userId, JSON.stringify(context), 'pending', now, now);
    },
    setState(runId: string, state: string, completion?: EnterpriseWorkflowCompletion) {
      if (completion) updateCompletion.run(JSON.stringify(completion), runId);
      update.run(state, new Date().toISOString(), runId);
    },
    completion(runId: string, userId: string): EnterpriseWorkflowCompletion | undefined {
      const row = read.get(runId, userId);
      return row?.state === 'completed' ? (JSON.parse(row.context_json) as WorkflowRunContext).completion : undefined;
    },
    items(runs: readonly WorkflowRun[], userId?: string): ThreadHistoryItem[] {
      if (!userId) return [];
      return runs.flatMap(run => {
        const row = read.get(run.id, userId);
        if (!row) return [];
        const { completion, continuation, ...context } = JSON.parse(row.context_json) as WorkflowRunContext;
        const start: ThreadHistoryItem = {
          id: `workflow-start:${run.id}`, type: 'workflow_start', runId: run.id,
          taskId: row.task_id, ...context, createdAt: run.createdAt
        };
        const status = row.state === 'pending'
          ? run.status === 'succeeded' ? 'awaiting_confirmation'
            : ['failed', 'canceled', 'orphaned'].includes(run.status) ? 'failed' : undefined
          : row.state === 'failed' && run.status === 'succeeded' ? 'awaiting_confirmation' : row.state;
        const starts = continuation ? [] : [start];
        if (!status || status === 'continued') return starts;
        return [...starts, {
          id: `workflow-status:${run.id}`, type: 'workflow_status', runId: run.id,
          taskId: row.task_id, status,
          ...(status === 'completed' && completion ? { completion } : {}),
          createdAt: row.state === 'pending' ? run.updatedAt : row.updated_at
        } satisfies ThreadHistoryItem];
      });
    }
  };
}
