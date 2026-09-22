import type Database from 'better-sqlite3';
import type { ThreadHistoryItem } from '@clawee/protocol';

export type WorkflowRunContext = {
  instanceId: string;
  workflowName: string;
  nodeTitle: string;
  nodeOrder: number;
  instruction: string;
  input: string;
  customInput?: string;
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
  const read = db.prepare<[string, string], ContextRow>('SELECT task_id,context_json,state,updated_at FROM enterprise_workflow_run_contexts WHERE run_id=? AND user_id=?');

  return {
    save(runId: string, taskId: string, userId: string, context: WorkflowRunContext) {
      const now = new Date().toISOString();
      insert.run(runId, taskId, userId, JSON.stringify(context), 'pending', now, now);
    },
    setState(runId: string, state: string) {
      update.run(state, new Date().toISOString(), runId);
    },
    items(runs: readonly WorkflowRun[], userId?: string): ThreadHistoryItem[] {
      if (!userId) return [];
      return runs.flatMap(run => {
        const row = read.get(run.id, userId);
        if (!row) return [];
        const context = JSON.parse(row.context_json) as WorkflowRunContext;
        const start: ThreadHistoryItem = {
          id: `workflow-start:${run.id}`, type: 'workflow_start', runId: run.id,
          taskId: row.task_id, ...context, createdAt: run.createdAt
        };
        const status = row.state === 'pending'
          ? run.status === 'succeeded' ? 'syncing'
            : ['failed', 'canceled', 'orphaned'].includes(run.status) ? 'failed' : undefined
          : row.state === 'failed' && run.status === 'succeeded' ? 'sync_failed' : row.state;
        if (!status) return [start];
        return [start, {
          id: `workflow-status:${run.id}`, type: 'workflow_status', runId: run.id,
          taskId: row.task_id, status,
          createdAt: row.state === 'pending' ? run.updatedAt : row.updated_at
        } satisfies ThreadHistoryItem];
      });
    }
  };
}
