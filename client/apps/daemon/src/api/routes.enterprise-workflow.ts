import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { EnterpriseHttpClient } from '../enterprise/http-client-2026-07-30.js';
import { EnterpriseHttpError } from '../enterprise/http-client-2026-07-30.js';
import type { EnterpriseSessionManager } from '../enterprise/session-manager-2026-07-30.js';
import { createWorkflowRunHistory, type WorkflowRunContext } from '../enterprise/workflow-run-history.js';
import type { RunManager } from '../runs/manager.js';
import type { ThreadManager } from '../threads/types.js';
import { apiError } from './errors.js';

const objectSchema = z.record(z.string(), z.unknown()).refine(value =>
  Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024
);
const startSchema = z.object({ initialInput: objectSchema, idempotencyKey: z.string().min(1).max(200) }).strict();
const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(4096), idempotencyKey: z.string().min(1).max(200) }).strict();
const prepareSchema = z.object({ projectId: z.string().min(1) }).strict();
const executeSchema = z.object({ projectId: z.string().min(1), threadId: z.string().min(1), customInput: z.string().max(1024 * 1024), model: z.string().nullable().optional(), reasoning: z.enum(['default', 'low', 'medium', 'high', 'xhigh']).nullable().optional() }).strict();
type Association = { task_id: string; user_id: string; run_id: string; complete_key: string; state: string };

export async function registerEnterpriseWorkflowRoutes(server: FastifyInstance, options: {
  session: EnterpriseSessionManager;
  http: EnterpriseHttpClient;
  runs: RunManager;
  threads: ThreadManager;
  db: Database.Database;
  origin(): string;
  canExecute(): boolean;
}): Promise<void> {
  const { session, http, runs, db } = options;
  const workflowHistory = createWorkflowRunHistory(db);
  const read = db.prepare<[string], Association>('SELECT task_id,user_id,run_id,complete_key,state FROM enterprise_workflow_runs WHERE task_id=?');
  const pending = db.prepare<[], Association>("SELECT task_id,user_id,run_id,complete_key,state FROM enterprise_workflow_runs WHERE state='pending'");
  const save = db.prepare('INSERT INTO enterprise_workflow_runs (task_id,user_id,run_id,complete_key,state) VALUES (?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET user_id=excluded.user_id,run_id=excluded.run_id,complete_key=excluded.complete_key,state=excluded.state,updated_at=CURRENT_TIMESTAMP');
  const setState = db.prepare('UPDATE enterprise_workflow_runs SET state=?,updated_at=CURRENT_TIMESTAMP WHERE task_id=? AND run_id=?');
  const updateState = db.transaction((state: string, row: Association) => {
    setState.run(state, row.task_id, row.run_id);
    workflowHistory.setState(row.run_id, state);
  });
  const bindRun = db.transaction((taskId: string, userId: string, runId: string, context: WorkflowRunContext) => {
    save.run(taskId, userId, runId, randomUUID(), 'pending');
    workflowHistory.save(runId, taskId, userId, context);
  });

  async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const accessToken = await session.requireAccessToken();
    const credential = await http.revealAccountMcpToken(accessToken);
    const agentId = session.getSnapshot().agentId;
    if (!agentId) throw new Error('当前 Agent 不可用');
    const client = new Client({ name: 'clawee-workflow', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', options.origin()), {
      requestInit: { headers: { Authorization: `Bearer ${credential.token}`, 'X-Claw-Agent-ID': agentId } }
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name, arguments: args });
      if (result.isError || !result.structuredContent || typeof result.structuredContent !== 'object') {
        const content = Array.isArray(result.content) ? result.content[0] : undefined;
        throw new Error(content && 'text' in content ? String(content.text) : '工作流任务状态已变化');
      }
      return result.structuredContent as Record<string, unknown>;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  let reconciling = false;
  async function reconcile() {
    if (reconciling || session.getSnapshot().status !== 'signed_in') return;
    const currentUser = session.getSnapshot().account?.subjectId;
    reconciling = true;
    try {
      for (const row of pending.all()) {
        if (row.user_id !== currentUser) continue;
        const run = runs.getRun(row.run_id);
        if (!run) { updateState('failed', row); continue; }
        if (run.status === 'failed' || run.status === 'canceled') {
          updateState('failed', row);
          continue;
        }
        if (run.status !== 'succeeded') continue;
        const text = runs.listEvents(row.run_id).filter(event => event.type === 'assistant_message')
          .map(event => event.payload && 'text' in event.payload ? String(event.payload.text) : '').at(-1) ?? '';
        try {
          await callTool('workflow_complete_task', { task_id: row.task_id, output: { text }, idempotency_key: row.complete_key });
          updateState('completed', row);
        } catch (error) {
          // Only transport failures are retried with the stored key.
          if (error instanceof Error && ['conflict', 'not_found', 'forbidden', 'invalid_request', 'payload_too_large'].includes(error.message)) {
            const state = error.message === 'conflict' || error.message === 'not_found' ? 'conflict' : 'failed';
            updateState(state, row);
          }
        }
      }
    } finally { reconciling = false; }
  }
  const timer = setInterval(() => { void reconcile(); }, 2000);
  timer.unref();
  server.addHook('preClose', async () => clearInterval(timer));

  async function forward(reply: FastifyReply, method: 'GET' | 'POST', path: string, body?: unknown) {
    try {
      if (!http.workflowRequest) throw new Error('工作流服务不可用');
      const response = await http.workflowRequest(await session.requireAccessToken(), method, `/api/v1/app/${path}`, body);
      return response;
    } catch (error) {
      if (error instanceof EnterpriseHttpError) {
        return reply.code(error.statusCode ?? 503).send(apiError(error.code, '工作流请求失败'));
      }
      return reply.code(503).send(apiError('ENTERPRISE_SERVICE_UNAVAILABLE', '工作流服务暂不可用'));
    }
  }

  server.get<{ Querystring: { cursor?: string } }>('/enterprise/workflow-templates', (request, reply) => forward(reply, 'GET', `workflow-templates?cursor=${encodeURIComponent(request.query.cursor ?? '')}`));
  server.get('/enterprise/workflow-capability', async () => ({ canExecute: options.canExecute() }));
  server.get<{ Params: { id: string } }>('/enterprise/workflow-templates/:id', (request, reply) => forward(reply, 'GET', `workflow-templates/${encodeURIComponent(request.params.id)}`));
  server.post<{ Params: { id: string }; Body: unknown }>('/enterprise/workflow-templates/:id/instances', (request, reply) => {
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '发起内容无效'));
    return forward(reply, 'POST', `workflow-templates/${encodeURIComponent(request.params.id)}/instances`, { initial_input: parsed.data.initialInput, idempotency_key: parsed.data.idempotencyKey });
  });
  server.get<{ Querystring: { status?: string; cursor?: string } }>('/enterprise/workflow-instances', (request, reply) => {
    const query = new URLSearchParams();
    if (request.query.status) query.set('status', request.query.status);
    if (request.query.cursor) query.set('cursor', request.query.cursor);
    return forward(reply, 'GET', `workflow-instances?${query.toString()}`);
  });
  server.get<{ Params: { id: string } }>('/enterprise/workflow-instances/:id', (request, reply) => forward(reply, 'GET', `workflow-instances/${encodeURIComponent(request.params.id)}`));
  server.get<{ Querystring: { cursor?: string } }>('/enterprise/workflow-tasks', (request, reply) => forward(reply, 'GET', `workflow-tasks?cursor=${encodeURIComponent(request.query.cursor ?? '')}`));
  server.get<{ Params: { id: string } }>('/enterprise/workflow-tasks/:id', (request, reply) => forward(reply, 'GET', `workflow-tasks/${encodeURIComponent(request.params.id)}`));
  server.post<{ Params: { id: string }; Body: unknown }>('/enterprise/workflow-tasks/:id/decision', (request, reply) => {
    const parsed = decisionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '审批内容无效'));
    return forward(reply, 'POST', `workflow-tasks/${encodeURIComponent(request.params.id)}/decision`, { decision: parsed.data.decision, comment: parsed.data.comment, idempotency_key: parsed.data.idempotencyKey });
  });
  server.post<{ Params: { id: string }; Body: unknown }>('/enterprise/workflow-tasks/:id/prepare', async (request, reply) => {
    if (!options.canExecute()) return reply.code(503).send(apiError('ENTERPRISE_SERVICE_UNAVAILABLE', '本地 Agent 不可用'));
    const parsed = prepareSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '工作目录无效'));
    try {
      const task = await callTool('workflow_get_task', { task_id: request.params.id });
      const existing = read.get(request.params.id);
      if (existing?.state === 'pending') return reply.code(409).send(apiError('VALIDATION_FAILED', '任务已经执行'));
      let nodeTitle = String(task.instruction).trim().slice(0, 60);
      if (typeof task.instance_id === 'string' && http.workflowRequest) {
        try {
          const response = await http.workflowRequest(await session.requireAccessToken(), 'GET', `/api/v1/app/workflow-instances/${encodeURIComponent(task.instance_id)}`);
          const instance = response.data as { nodes?: Array<{ node_id: string; title: string }> };
          nodeTitle = instance.nodes?.find(node => node.node_id === task.node_id)?.title || nodeTitle;
        } catch { /* The instruction remains a usable title if metadata is unavailable. */ }
      }
      const thread = options.threads.createConversationThread({
        projectId: parsed.data.projectId,
        title: `工作流 · ${nodeTitle}`,
        profile: 'default', sandbox: 'danger-full-access'
      });
      return { threadId: thread.id, instruction: String(task.instruction), input: typeof (task.input as { text?: unknown } | undefined)?.text === 'string' ? (task.input as { text: string }).text : '', firstNode: task.node_order === 0 };
    } catch (error) {
      return reply.code(409).send(apiError('VALIDATION_FAILED', error instanceof Error ? error.message : '任务不可执行'));
    }
  });
  server.post<{ Params: { id: string }; Body: unknown }>('/enterprise/workflow-tasks/:id/execute', async (request, reply) => {
    if (!options.canExecute()) return reply.code(503).send(apiError('ENTERPRISE_SERVICE_UNAVAILABLE', '本地 Agent 不可用'));
    const parsed = executeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '任务内容无效'));
    const existing = read.get(request.params.id);
    const userId = session.getSnapshot().account?.subjectId;
    if (!userId) return reply.code(401).send(apiError('ENTERPRISE_UNAUTHORIZED', '企业会话不可用'));
    if (existing && existing.user_id === userId && existing.state === 'pending') return { runId: existing.run_id, threadId: runs.getRun(existing.run_id)?.threadId, status: 'pending' };
    try {
      const task = await callTool('workflow_get_task', { task_id: request.params.id });
      const thread = options.threads.getThread(parsed.data.threadId);
      if (!thread || thread.purpose !== 'conversation' || thread.projectId !== parsed.data.projectId || thread.status !== 'active') {
        return reply.code(409).send(apiError('VALIDATION_FAILED', '会话不可用'));
      }
      if (runs.listRunsByThread(thread.id).length > 0) return reply.code(409).send(apiError('VALIDATION_FAILED', '会话已存在任务'));
      // The read and start below are synchronous on the daemon event loop.
      const concurrent = read.get(request.params.id);
      if (concurrent && concurrent.user_id === userId && concurrent.state === 'pending') {
        return { runId: concurrent.run_id, threadId: runs.getRun(concurrent.run_id)?.threadId, status: 'pending' };
      }
      const input = task.input as { text?: unknown } | undefined;
      const instanceId = typeof task.instance_id === 'string' ? task.instance_id : '';
      const nodeOrder = typeof task.node_order === 'number' ? task.node_order : 0;
      const context: WorkflowRunContext = {
        instanceId, workflowName: '工作流', nodeTitle: String(task.instruction).trim().slice(0, 60),
        nodeOrder, instruction: String(task.instruction),
        input: typeof input?.text === 'string' ? input.text : '',
        customInput: parsed.data.customInput
      };
      if (instanceId && http.workflowRequest) {
        try {
          const instanceResponse = await http.workflowRequest(await session.requireAccessToken(), 'GET', `/api/v1/app/workflow-instances/${encodeURIComponent(instanceId)}`);
          const instance = instanceResponse.data as { nodes?: Array<{ node_id: string; title: string }>; template_id?: string };
          const node = instance.nodes?.find(item => item.node_id === task.node_id);
          if (node?.title) context.nodeTitle = node.title;
          if (instance.template_id) {
            const templateResponse = await http.workflowRequest(await session.requireAccessToken(), 'GET', `/api/v1/app/workflow-templates/${encodeURIComponent(instance.template_id)}`);
            const template = templateResponse.data as { name?: string };
            if (template.name) context.workflowName = template.name;
          }
        } catch { /* Task execution does not depend on optional display metadata. */ }
      }
      let run;
      try {
        run = runs.startRun({
          prompt: [String(task.instruction), typeof input?.text === 'string' && input.text !== parsed.data.customInput ? `${nodeOrder === 0 ? '初始输入' : '上一步输入'}：\n${input.text}` : '', `个性化任务要求：\n${parsed.data.customInput}`].filter(Boolean).join('\n\n'),
          cwd: thread.cwd, profile: thread.profile, sandbox: thread.sandbox, threadId: thread.id,
          model: parsed.data.model ?? undefined, reasoning: parsed.data.reasoning ?? undefined
        });
      } catch (error) {
        throw error;
      }
      bindRun(request.params.id, userId, run.id, context);
      return reply.code(202).send({ runId: run.id, threadId: thread.id, status: run.status });
    } catch (error) {
      return reply.code(409).send(apiError('VALIDATION_FAILED', error instanceof Error ? error.message : '任务不可执行'));
    }
  });
  server.get<{ Params: { id: string } }>('/enterprise/workflow-tasks/:id/execution', async (request) => {
    await reconcile();
    const row = read.get(request.params.id);
    if (!row || row.user_id !== session.getSnapshot().account?.subjectId) return { status: 'idle' };
    return { status: row.state, runId: row.run_id, runStatus: runs.getRun(row.run_id)?.status };
  });
}
