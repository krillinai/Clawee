import { createHash, randomUUID } from 'node:crypto';
import type { EnterpriseWorkflowArtifact, EnterpriseWorkflowTask, EnterpriseWorkflowInstance, EnterpriseWorkflowCompletion, EnterpriseWorkflowDeliveryFile, EnterpriseWorkflowExecution } from '@clawee/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { EnterpriseHttpClient } from '../enterprise/http-client-2026-07-30.js';
import { EnterpriseHttpError, enterpriseHttpErrorDetails } from '../enterprise/http-client-2026-07-30.js';
import { EnterpriseSessionError, type EnterpriseSessionManager } from '../enterprise/session-manager-2026-07-30.js';
import { createWorkflowRunHistory, type WorkflowRunContext } from '../enterprise/workflow-run-history.js';
import { AttachmentServiceError, type AttachmentService } from '../attachments/service.js';
import type { RuntimeCapabilityMatrix } from '../codex/capabilities.js';
import type { RunManager } from '../runs/manager.js';
import type { ThreadManager } from '../threads/types.js';
import type { WorkspaceFileService } from '../workspace-files/service.js';
import type { EnterpriseSharedDriveManager } from '../enterprise/shared-drive-manager-2026-08-06.js';
import { AgentCapabilityTokenError, type AgentCapabilityTokenStore } from '../agent-tools/capability-token.js';
import { readBearerToken } from '../agent-tools/internal-routes.js';
import { apiError } from './errors.js';
import { ENTERPRISE_SHARED_FILE_MAX_BYTES } from '../enterprise/config-2026-07-30.js';

const objectSchema = z.record(z.string(), z.unknown()).refine(value =>
  Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024
);
const startSchema = z.object({ initialInput: objectSchema, idempotencyKey: z.string().min(1).max(200) }).strict();
const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(4096), idempotencyKey: z.string().min(1).max(200) }).strict();
const prepareSchema = z.object({ projectId: z.string().min(1) }).strict();
const executeSchema = z.object({ projectId: z.string().min(1), threadId: z.string().min(1), customInput: z.string().max(1024 * 1024), model: z.string().nullable().optional(), reasoning: z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(), draftId: z.string().min(1).optional(), attachmentIds: z.array(z.string().min(1)).max(8).optional() }).strict().refine(value => (value.attachmentIds?.length ?? 0) === 0 || value.draftId !== undefined, { message: 'draftId is required when attachmentIds are provided' });
const draftSchema = z.object({ version: z.number().int().nonnegative(), text: z.string().optional(), useLatest: z.boolean().optional(), selectedPaths: z.array(z.string()).max(100).optional() }).strict().refine(value => value.text === undefined || Buffer.byteLength(JSON.stringify({ text: value.text })) <= 1024 * 1024);
const submitSchema = z.object({ version: z.number().int().nonnegative() }).strict();
type Association = { task_id: string; user_id: string; run_id: string; complete_key: string; state: string; gateway_origin: string; agent_id: string; attachments_json: string; thread_id: string; delivery_json: string };
type Delivery = {
  text: string; edited: boolean; version: number; sourceRunId: string; files: EnterpriseWorkflowDeliveryFile[];
  submission?: { text: string; files: EnterpriseWorkflowDeliveryFile[] };
};

function deliveryOf(row: Association): Delivery {
  return { text: '', edited: false, version: 0, sourceRunId: '', files: [], ...JSON.parse(row.delivery_json || '{}') };
}

export async function registerEnterpriseWorkflowRoutes(server: FastifyInstance, options: {
  session: EnterpriseSessionManager;
  http: EnterpriseHttpClient;
  runs: RunManager;
  threads: ThreadManager;
  db: Database.Database;
  origin(): string;
  canExecute(): boolean;
  canRunAgent?(): boolean;
  capabilities?: AgentCapabilityTokenStore;
  runtimeCapabilities?: RuntimeCapabilityMatrix;
  attachmentService?: AttachmentService;
  workspaceFiles?: WorkspaceFileService;
  sharedDrive?: EnterpriseSharedDriveManager;
}): Promise<void> {
  const { session, http, runs, db } = options;
  const workflowHistory = createWorkflowRunHistory(db);
  const read = db.prepare<[string], Association>('SELECT * FROM enterprise_workflow_runs WHERE task_id=?');
  const pending = db.prepare<[], Association>("SELECT * FROM enterprise_workflow_runs WHERE state='pending'");
  const save = db.prepare('INSERT INTO enterprise_workflow_runs (task_id,user_id,run_id,complete_key,state,gateway_origin,agent_id,attachments_json,thread_id) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET run_id=excluded.run_id,state=excluded.state,updated_at=CURRENT_TIMESTAMP');
  const setState = db.prepare('UPDATE enterprise_workflow_runs SET state=?,updated_at=CURRENT_TIMESTAMP WHERE task_id=? AND run_id=?');
  const completing = new Set<string>();
  const registering = new Set<string>();
  db.prepare("UPDATE enterprise_workflow_run_contexts SET state='failed',updated_at=CURRENT_TIMESTAMP WHERE run_id IN (SELECT run_id FROM enterprise_workflow_runs WHERE state='uploading')").run();
  db.prepare("UPDATE enterprise_workflow_runs SET state='failed',updated_at=CURRENT_TIMESTAMP WHERE state='uploading'").run();
  db.prepare("UPDATE enterprise_workflow_run_contexts SET state='submit_failed',updated_at=CURRENT_TIMESTAMP WHERE run_id IN (SELECT run_id FROM enterprise_workflow_runs WHERE state='submitting')").run();
  db.prepare("UPDATE enterprise_workflow_runs SET state='submit_failed',updated_at=CURRENT_TIMESTAMP WHERE state='submitting'").run();
  const updateState = db.transaction((state: string, row: Association, completion?: EnterpriseWorkflowCompletion) => {
    setState.run(state, row.task_id, row.run_id);
    workflowHistory.setState(row.run_id, state, completion);
  });
  const bindRun = db.transaction((taskId: string, userId: string, runId: string, context: WorkflowRunContext, threadId: string) => {
    const identity = currentIdentity();
    const previous = read.get(taskId);
    if (previous) {
      owned(previous, identity);
      if (['submitting', 'submit_failed', 'completed', 'conflict'].includes(previous.state) || deliveryOf(previous).submission) throw new Error('节点已提交或正在提交');
      if (isRunActive(runs.getRun(previous.run_id)?.status) || registering.has(previous.run_id)) throw new Error('当前会话仍在执行');
      workflowHistory.setState(previous.run_id, 'continued');
    }
    save.run(taskId, userId, runId, randomUUID(), 'pending', identity.origin, identity.agentId, '[]', threadId);
    workflowHistory.save(runId, taskId, userId, context);
  });

  function currentIdentity() {
    const snapshot = session.getSnapshot();
    if (snapshot.status !== 'signed_in' || !snapshot.account?.subjectId || !snapshot.agentId) throw new Error('企业会话不可用');
    return { userId: snapshot.account.subjectId, agentId: snapshot.agentId, origin: options.origin() };
  }

  function assertIdentity(identity: ReturnType<typeof currentIdentity>) {
    const current = currentIdentity();
    if (current.userId !== identity.userId || current.agentId !== identity.agentId || current.origin !== identity.origin) throw new Error('企业会话已变化，请重试');
  }

  function owned(row: Association | undefined, identity = currentIdentity()): Association {
    if (!row || row.user_id !== identity.userId || row.gateway_origin !== identity.origin || row.agent_id !== identity.agentId) throw new Error('工作流会话身份不匹配，请重新确认企业账户');
    return row;
  }

  function isRunActive(status?: string) {
    return Boolean(status && !['succeeded', 'failed', 'canceled', 'orphaned'].includes(status));
  }

  function latestText(row: Association) {
    return runs.listEvents(row.run_id).filter(event => event.type === 'assistant_message')
      .map(event => event.payload && 'text' in event.payload ? String(event.payload.text) : '').at(-1) ?? '';
  }

  function persistDelivery(row: Association, delivery: Delivery) {
    db.prepare('UPDATE enterprise_workflow_runs SET delivery_json=?,updated_at=CURRENT_TIMESTAMP WHERE task_id=? AND run_id=?').run(JSON.stringify(delivery), row.task_id, row.run_id);
  }

  function execution(row: Association): EnterpriseWorkflowExecution {
    const delivery = deliveryOf(row);
    return {
      status: row.state, runId: row.run_id, threadId: row.thread_id || runs.getRun(row.run_id)?.threadId,
      runStatus: runs.getRun(row.run_id)?.status, completion: workflowHistory.completion(row.run_id, row.user_id),
      delivery: { text: delivery.text, edited: delivery.edited, version: delivery.version, sourceRunId: delivery.sourceRunId,
        files: delivery.files, latestText: latestText(row), locked: Boolean(delivery.submission) || ['submitting', 'completed', 'conflict'].includes(row.state) }
    };
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const identity = currentIdentity();
    const accessToken = await session.requireAccessToken();
    assertIdentity(identity);
    const credential = await http.revealAccountMcpToken(accessToken);
    assertIdentity(identity);
    const client = new Client({ name: 'clawee-workflow', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', identity.origin), {
      requestInit: { headers: { Authorization: `Bearer ${credential.token}`, 'X-Claw-Agent-ID': identity.agentId } }
    });
    try {
      await client.connect(transport);
      assertIdentity(identity);
      const result = await client.callTool({ name, arguments: args });
      assertIdentity(identity);
      if (result.isError || !result.structuredContent || typeof result.structuredContent !== 'object') {
        const content = Array.isArray(result.content) ? result.content[0] : undefined;
        throw new Error(content && 'text' in content ? String(content.text) : '工作流任务状态已变化');
      }
      return result.structuredContent as Record<string, unknown>;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  function reconcile() {
    const snapshot = session.getSnapshot();
    if (snapshot.status !== 'signed_in' || !snapshot.account?.subjectId || !snapshot.agentId) return;
    const identity = currentIdentity();
      for (const candidate of pending.all()) {
        const row = read.get(candidate.task_id);
        if (!row || row.state !== 'pending') continue;
        if (row.user_id !== identity.userId || row.gateway_origin !== identity.origin || row.agent_id !== identity.agentId) continue;
        const run = runs.getRun(row.run_id);
        if (!run) { updateState('failed', row); continue; }
        if (['failed', 'canceled', 'orphaned'].includes(run.status)) {
          updateState('failed', row);
          continue;
        }
        if (run.status !== 'succeeded') continue;
        const delivery = deliveryOf(row);
        if (delivery.sourceRunId !== row.run_id) {
          if (!delivery.edited) delivery.text = latestText(row);
          delivery.sourceRunId = row.run_id;
          delivery.version += 1;
          persistDelivery(row, delivery);
        }
        updateState('awaiting_confirmation', row);
      }
  }
  const timer = setInterval(reconcile, 2000);
  timer.unref();
  server.addHook('preClose', async () => clearInterval(timer));

  async function forward(reply: FastifyReply, method: 'GET' | 'POST', path: string, body?: unknown) {
    if (session.getSnapshot().status !== 'signed_in') return reply.code(401).send(apiError('ENTERPRISE_UNAUTHORIZED', '企业会话不可用，请重新登录'));
    const requestIdentity = () => {
      const snapshot = session.getSnapshot();
      return JSON.stringify([options.origin(), snapshot.status, snapshot.account?.subjectId, snapshot.agentId]);
    };
    const owner = requestIdentity();
    try {
      if (!http.workflowRequest) throw new Error('工作流服务不可用');
      const accessToken = await session.requireAccessToken();
      if (owner !== requestIdentity()) return reply.code(409).send(apiError('ENTERPRISE_UNAUTHORIZED', '企业账户已变化，请刷新'));
      const response = await http.workflowRequest(accessToken, method, `/api/v1/app/${path}`, body);
      if (owner !== requestIdentity()) return reply.code(409).send(apiError('ENTERPRISE_UNAUTHORIZED', '企业账户已变化，请刷新'));
      return response;
    } catch (error) {
      if (error instanceof EnterpriseSessionError) return reply.code(error.statusCode).send(apiError(error.code, '企业会话不可用，请重新登录'));
      if (error instanceof EnterpriseHttpError) {
        const message = error.upstreamCode === 'invalid_assignees'
          ? '节点负责人不存在、已禁用，或角色没有有效成员，请联系管理员调整模板'
          : error.statusCode === 409 ? '任务状态或幂等键已变化，可能已由其他候选处理，请刷新工作流' : '工作流请求失败';
        return reply.code(error.stage === 'decode' ? 502 : error.statusCode ?? 503).send(apiError(error.code, message, enterpriseHttpErrorDetails(error)));
      }
      return reply.code(503).send(apiError('ENTERPRISE_SERVICE_UNAVAILABLE', '工作流服务暂不可用'));
    }
  }

  server.get<{ Querystring: { cursor?: string } }>('/enterprise/workflow-templates', (request, reply) => forward(reply, 'GET', `workflow-templates?cursor=${encodeURIComponent(request.query.cursor ?? '')}`));
  server.get('/enterprise/workflow-capability', async (_request, reply) => {
    if (session.getSnapshot().status !== 'signed_in') return reply.code(401).send(apiError('ENTERPRISE_UNAUTHORIZED', '企业会话不可用，请重新登录'));
    return { canExecute: options.canExecute() && (options.canRunAgent?.() ?? true) };
  });
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
      const identity = currentIdentity();
      const task = await callTool('workflow_get_task', { task_id: request.params.id });
      assertIdentity(identity);
      const existing = read.get(request.params.id);
      if (existing) {
        owned(existing, identity);
        if (['completed', 'conflict'].includes(existing.state)) throw new Error('节点已完成或状态已变化');
        const existingThread = options.threads.getThread(existing.thread_id || runs.getRun(existing.run_id)?.threadId || '');
        if (!existingThread || existingThread.status !== 'active') throw new Error('原工作流会话不可用');
        return { threadId: existingThread.id, instruction: String(task.instruction), input: '', firstNode: false, resuming: true };
      }
      let nodeTitle = String(task.instruction).trim().slice(0, 60);
      if (typeof task.instance_id === 'string' && http.workflowRequest) {
        try {
          const response = await http.workflowRequest(await session.requireAccessToken(), 'GET', `/api/v1/app/workflow-instances/${encodeURIComponent(task.instance_id)}`);
          const instance = response.data as { nodes?: Array<{ node_id: string; title: string }> };
          nodeTitle = instance.nodes?.find(node => node.node_id === task.node_id)?.title || nodeTitle;
        } catch { /* The instruction remains a usable title if metadata is unavailable. */ }
      }
      assertIdentity(identity);
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
    if (options.canRunAgent?.() === false) return reply.code(428).send(apiError('MODEL_SERVICE_CONFIGURATION_REQUIRED', '请先配置并验证 Codex 模型服务'));
    if (!options.canExecute()) return reply.code(503).send(apiError('ENTERPRISE_SERVICE_UNAVAILABLE', '本地 Agent 不可用'));
    const parsed = executeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '任务内容无效'));
    const userId = session.getSnapshot().account?.subjectId;
    if (!userId) return reply.code(401).send(apiError('ENTERPRISE_UNAUTHORIZED', '企业会话不可用'));
    try {
      const identity = currentIdentity();
      const task = await callTool('workflow_get_task', { task_id: request.params.id });
      assertIdentity(identity);
      reconcile();
      const existing = read.get(request.params.id);
      if (existing) {
        owned(existing, identity);
        if ((existing.thread_id || runs.getRun(existing.run_id)?.threadId) !== parsed.data.threadId) throw new Error('请在原工作流会话中继续执行');
        if (['submitting', 'submit_failed', 'completed', 'conflict'].includes(existing.state) || deliveryOf(existing).submission) throw new Error('节点已提交或正在提交');
        if (isRunActive(runs.getRun(existing.run_id)?.status)) return { runId: existing.run_id, threadId: parsed.data.threadId, status: 'pending' };
      }
      const thread = options.threads.getThread(parsed.data.threadId);
      if (!thread || thread.purpose !== 'conversation' || thread.projectId !== parsed.data.projectId || thread.status !== 'active') {
        return reply.code(409).send(apiError('VALIDATION_FAILED', '会话不可用'));
      }
      if (!existing && runs.listRunsByThread(thread.id).length > 0) return reply.code(409).send(apiError('VALIDATION_FAILED', '会话已存在任务'));
      if (runs.hasActiveRunForThread?.(thread.id)) throw new Error('当前会话仍在执行');
      const input = task.input as { text?: unknown } | undefined;
      const instanceId = typeof task.instance_id === 'string' ? task.instance_id : '';
      const nodeOrder = typeof task.node_order === 'number' ? task.node_order : 0;
      const effectiveCustomInput = nodeOrder === 0
        && parsed.data.customInput.trim().length === 0
        && typeof input?.text === 'string'
        ? input.text
        : parsed.data.customInput;
      const context: WorkflowRunContext = {
        instanceId, workflowName: '工作流', nodeTitle: String(task.instruction).trim().slice(0, 60),
        nodeOrder, instruction: String(task.instruction),
        input: typeof input?.text === 'string' ? input.text : '',
        customInput: effectiveCustomInput, continuation: Boolean(existing)
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
      assertIdentity(identity);
      const concurrent = read.get(request.params.id);
      if (concurrent && concurrent.run_id !== existing?.run_id) return { runId: concurrent.run_id, threadId: concurrent.thread_id, status: 'pending' };
      if (concurrent && ['submitting', 'submit_failed', 'completed', 'conflict'].includes(concurrent.state)) throw new Error('节点已提交或正在提交');
      if (!existing && runs.listRunsByThread(thread.id).length > 0) return reply.code(409).send(apiError('VALIDATION_FAILED', '会话已存在任务'));
      const attachmentIds = parsed.data.attachmentIds ?? [];
      let attachmentContext: { imagePaths: string[]; textContext?: string } = { imagePaths: [] };
      if (attachmentIds.length > 0) {
        if (!options.attachmentService || !parsed.data.draftId) {
          throw new AttachmentServiceError('ATTACHMENT_STORAGE_FAILED', '附件服务暂不可用', 503);
        }
        attachmentContext = await options.attachmentService.resolveForRun({
          ids: attachmentIds,
          draftId: parsed.data.draftId
        });
        if (attachmentContext.imagePaths.length > 0) {
          const supportsImages = thread.codexThreadId
            ? options.runtimeCapabilities?.resumeImages === true
            : options.runtimeCapabilities?.execImages === true;
          if (!supportsImages) {
            throw new AttachmentServiceError(
              'CODEX_IMAGE_INPUT_UNSUPPORTED',
              '当前 Codex 版本不支持图片输入',
              409
            );
          }
        }
      }
      let run;
      try {
        const workflowPrompt = existing ? effectiveCustomInput : [String(task.instruction), nodeOrder === 0 || typeof input?.text !== 'string' ? '' : `上一步输入：\n${input.text}`, `${nodeOrder === 0 ? '任务要求' : '个性化任务要求'}：\n${effectiveCustomInput}`, task.shared_space_id ? `工作流共享上下文：\n${JSON.stringify({ shared_space_id: task.shared_space_id, instance_path_prefix: task.instance_path_prefix, upstream_artifacts: task.upstream_artifacts })}\n可使用 clawee_workflow_read_file 读取上游文件，使用 clawee_workflow_upload_file 登记本地待交付附件，附件不会立即上传。最终结果仅在用户确认完成节点后上传归档。` : '最终结果仅在用户确认完成节点后提交，回复结束不代表节点完成。'].filter(Boolean).join('\n\n');
        const prompt = attachmentContext.textContext === undefined
          ? workflowPrompt
          : `${attachmentContext.textContext}\n\n${workflowPrompt}`;
        run = runs.startRun({
          prompt,
          cwd: thread.cwd, profile: thread.profile, sandbox: thread.sandbox, threadId: thread.id,
          model: parsed.data.model ?? undefined, reasoning: parsed.data.reasoning ?? undefined,
          imagePaths: attachmentContext.imagePaths,
          attachmentIds
        }, runId => { assertIdentity(identity); bindRun(request.params.id, userId, runId, context, thread.id); });
        if (attachmentIds.length > 0) {
          await options.attachmentService!.commit({
            ids: attachmentIds,
            draftId: parsed.data.draftId!,
            threadId: thread.id,
            runId: run.id
          });
        }
      } catch (error) {
        if (run !== undefined) {
          runs.cancelRun(run.id);
          const bound = read.get(request.params.id);
          if (bound?.run_id === run.id) updateState('failed', bound);
        }
        throw error;
      }
      return reply.code(202).send({ runId: run.id, threadId: thread.id, status: run.status });
    } catch (error) {
      if (error instanceof AttachmentServiceError) {
        return reply.code(error.statusCode).send(apiError(error.code, error.message, error.details));
      }
      return reply.code(409).send(apiError('VALIDATION_FAILED', error instanceof Error ? error.message : '任务不可执行'));
    }
  });
  server.get<{ Params: { id: string } }>('/enterprise/workflow-tasks/:id/execution', async (request) => {
    reconcile();
    const row = read.get(request.params.id);
    if (row && row.user_id === session.getSnapshot().account?.subjectId && row.state === 'pending' && (!row.gateway_origin || !row.agent_id)) return { status: 'legacy_pending', runId: row.run_id, runStatus: runs.getRun(row.run_id)?.status };
    if (!row || row.user_id !== session.getSnapshot().account?.subjectId || row.gateway_origin !== options.origin() || row.agent_id !== session.getSnapshot().agentId) return { status: 'idle' };
    return execution(row);
  });

  server.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'POST' || request.routeOptions.url !== '/runs') return;
    const body = request.body as { threadId?: unknown } | undefined;
    if (typeof body?.threadId !== 'string') return;
    const row = db.prepare<[string], Association>('SELECT * FROM enterprise_workflow_runs WHERE thread_id=?').get(body.threadId);
    if (row && row.state !== 'completed') return reply.code(409).send(apiError('VALIDATION_FAILED', '请通过工作流会话继续执行；提交期间不能生成新回复'));
  });

  server.post<{ Params: { id: string }; Body: unknown }>('/enterprise/workflow-tasks/:id/draft', async (request, reply) => {
    const parsed = draftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '交付内容无效或超过大小限制'));
    try {
      reconcile();
      const row = owned(read.get(request.params.id));
      const delivery = deliveryOf(row);
      if (delivery.submission || ['submitting', 'completed', 'conflict'].includes(row.state)) throw new Error('提交内容已锁定');
      if (delivery.version !== parsed.data.version) throw new Error('交付草稿已变化，请刷新后重试');
      if (parsed.data.useLatest) {
        if (runs.getRun(row.run_id)?.status !== 'succeeded') throw new Error('最新回复尚未完成');
        delivery.text = latestText(row);
        delivery.edited = false;
      } else if (parsed.data.text !== undefined) {
        delivery.text = parsed.data.text;
        delivery.edited = true;
      }
      if (parsed.data.selectedPaths) {
        if (parsed.data.selectedPaths.some(path => !delivery.files.some(file => file.path === path))) throw new Error('附件不属于当前节点');
        delivery.files = delivery.files.map(file => ({ ...file, selected: parsed.data.selectedPaths!.includes(file.path) }));
      }
      if (Buffer.byteLength(JSON.stringify({ text: delivery.text })) > 1024 * 1024) throw new Error('交付文本超过大小限制');
      delivery.version += 1;
      persistDelivery(row, delivery);
      return execution(read.get(row.task_id)!);
    } catch (error) { return reply.code(409).send(apiError('VALIDATION_FAILED', error instanceof Error ? error.message : '保存交付草稿失败')); }
  });

  async function inspectFile(threadId: string, path: string): Promise<EnterpriseWorkflowDeliveryFile> {
    if (!options.workspaceFiles) throw new Error('工作流文件服务不可用');
    const local = await options.workspaceFiles.download({ threadId, path });
    try {
      if (local.size > ENTERPRISE_SHARED_FILE_MAX_BYTES) throw new Error('附件超过大小限制');
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of local.stream) {
        size += Buffer.byteLength(chunk);
        if (size > ENTERPRISE_SHARED_FILE_MAX_BYTES) throw new Error('附件超过大小限制');
        hash.update(chunk);
      }
      if (size !== local.size) throw new Error('待交付文件已变化');
      return { path, name: local.name, sizeBytes: size, sha256: hash.digest('hex'), selected: true };
    } finally { local.stream.destroy(); }
  }

  server.post<{ Params: { id: string }; Body: unknown }>('/enterprise/workflow-tasks/:id/submit', async (request, reply) => {
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '提交版本无效'));
    let submitting: Association | undefined;
    try {
      const identity = currentIdentity();
      reconcile();
      const row = owned(read.get(request.params.id), identity);
      if (row.state === 'completed') return execution(row);
      if (completing.has(row.task_id) || registering.has(row.run_id)) throw new Error('节点正在处理，请稍后重试');
      const delivery = deliveryOf(row);
      if (delivery.version !== parsed.data.version) throw new Error('交付草稿已变化，请重新确认');
      if (!['awaiting_confirmation', 'submit_failed', 'failed'].includes(row.state) || (!delivery.sourceRunId && !delivery.edited)) throw new Error('节点尚无可提交的结果');
      const threadId = row.thread_id || runs.getRun(row.run_id)?.threadId;
      if (!threadId || isRunActive(runs.getRun(row.run_id)?.status) || runs.hasActiveRunForThread?.(threadId)) throw new Error('当前会话仍在执行');
      if (!delivery.text.trim() && !delivery.files.some(file => file.selected) && JSON.parse(row.attachments_json).length === 0) throw new Error('交付结果不能为空');
      if (Buffer.byteLength(JSON.stringify({ text: delivery.text })) > 1024 * 1024) throw new Error('交付文本超过大小限制，请编辑后重试');
      completing.add(row.task_id);
      submitting = row;
      updateState('submitting', row);
      const task = await callTool('workflow_get_task', { task_id: row.task_id });
      assertIdentity(identity);
      if (!delivery.submission && (task.type !== 'agent' || task.status !== 'pending')) throw new Error('conflict');
      if (!delivery.submission) {
        for (const file of delivery.files.filter(file => file.selected)) {
          const actual = await inspectFile(threadId, file.path);
          assertIdentity(identity);
          if (actual.sha256 !== file.sha256 || actual.sizeBytes !== file.sizeBytes || actual.name !== file.name) throw new Error('待交付文件已变化，请重新登记并确认附件');
        }
        delivery.submission = { text: delivery.text, files: delivery.files.filter(file => file.selected) };
        persistDelivery(row, delivery);
      }
      const attachments = JSON.parse(row.attachments_json) as EnterpriseWorkflowArtifact[];
      for (const file of delivery.submission.files) {
        if (attachments.some(ref => (ref.file_name ?? ref.logical_path.split('/').at(-1)) === file.name && ref.sha256 === file.sha256)) continue;
        if (!options.workspaceFiles || !options.sharedDrive?.uploadWorkflowFile) throw new Error('工作流文件服务不可用');
        const local = await options.workspaceFiles.download({ threadId, path: file.path });
        try {
          const ref = await options.sharedDrive.uploadWorkflowFile({
            taskId: row.task_id, idempotencyKey: row.complete_key, fileName: file.name,
            expectedSizeBytes: file.sizeBytes, expectedSha256: file.sha256, content: local.stream,
            assertIdentity: () => assertIdentity(identity)
          });
          assertIdentity(identity);
          attachments.push(ref);
          db.prepare('UPDATE enterprise_workflow_runs SET attachments_json=? WHERE task_id=? AND run_id=?').run(JSON.stringify(attachments), row.task_id, row.run_id);
        } finally { local.stream.destroy(); }
      }
      const result = await callTool('workflow_complete_task', { task_id: row.task_id, output: { text: delivery.submission.text }, idempotency_key: row.complete_key, attachments });
      assertIdentity(identity);
      let completion: EnterpriseWorkflowCompletion = { handledBy: identity.userId };
      if (http.workflowRequest && typeof result.instance_id === 'string') {
        try {
          const response = await http.workflowRequest(await session.requireAccessToken(), 'GET', `/api/v1/app/workflow-instances/${encodeURIComponent(result.instance_id)}`);
          assertIdentity(identity);
          const instance = response.data as EnterpriseWorkflowInstance;
          const completedTask = instance.id === result.instance_id ? instance.tasks?.find(item => item.task_id === row.task_id) : undefined;
          if (completedTask?.status === 'completed' && completedTask.handled_by) {
            const name = instance.user_names?.[completedTask.handled_by]?.trim();
            completion = { handledBy: completedTask.handled_by, ...(name ? { handledByName: name } : {}) };
          }
        } catch {}
      }
      assertIdentity(identity);
      updateState('completed', row, completion);
      return execution(read.get(row.task_id)!);
    } catch (error) {
      if (submitting) {
        const conflict = error instanceof Error && ['conflict', 'not_found', 'forbidden', 'revision_conflict'].includes(error.message);
        const frozen = Boolean(deliveryOf(read.get(submitting.task_id)!).submission);
        updateState(conflict ? 'conflict' : frozen ? 'submit_failed' : 'awaiting_confirmation', submitting);
      }
      return reply.code(409).send(apiError('VALIDATION_FAILED', error instanceof Error ? error.message === 'conflict' ? '节点状态已变化，可能已由其他负责人完成' : error.message : '提交失败，请重试'));
    } finally { if (submitting) completing.delete(submitting.task_id); }
  });

  server.post<{ Params: { id: string } }>('/enterprise/workflow-tasks/:id/execution/recover', async (request, reply) => {
    try {
      const identity = currentIdentity();
      const row = read.get(request.params.id);
      if (!row || row.user_id !== identity.userId || row.state !== 'pending' || row.gateway_origin || row.agent_id) throw new Error('历史执行记录不可恢复');
      const task = await callTool('workflow_get_task', { task_id: row.task_id });
      assertIdentity(identity);
      const context = db.prepare<[string, string], { context_json: string }>('SELECT context_json FROM enterprise_workflow_run_contexts WHERE run_id=? AND user_id=?').get(row.run_id, identity.userId);
      const savedContext = context && JSON.parse(context.context_json) as WorkflowRunContext;
      if (!savedContext?.instanceId || savedContext.instanceId !== task.instance_id || task.type !== 'agent' || task.status !== 'pending') throw new Error('历史记录与当前企业任务不匹配，不能恢复');
      db.prepare("UPDATE enterprise_workflow_runs SET gateway_origin=?,agent_id=?,updated_at=CURRENT_TIMESTAMP WHERE task_id=? AND run_id=? AND state='pending' AND gateway_origin='' AND agent_id=''").run(identity.origin, identity.agentId, row.task_id, row.run_id);
      await reconcile();
      return { status: read.get(row.task_id)?.state ?? 'failed', runId: row.run_id };
    } catch (error) { return reply.code(409).send(apiError('VALIDATION_FAILED', error instanceof Error ? error.message : '历史结果恢复失败')); }
  });

  for (const operation of ['upload', 'read'] as const) {
    server.post<{ Body: unknown }>(`/internal/agent-tools/workflow/files/${operation}`, async (request, reply) => {
      let registeringRun: string | undefined;
      try {
        if (!options.capabilities || !options.workspaceFiles) throw new Error('工作流文件服务不可用');
        const grant = options.capabilities.authorize(readBearerToken(request.headers.authorization), { scope: operation === 'upload' ? 'workflow:upload' : 'workflow:read' });
        const row = db.prepare<[string], Association>('SELECT * FROM enterprise_workflow_runs WHERE run_id=?').get(grant.runId);
        const identity = currentIdentity();
        const run = runs.getRun(grant.runId);
        const thread = options.threads.getThread(grant.threadId);
        if (!row || row.state !== 'pending' || row.user_id !== identity.userId || row.gateway_origin !== identity.origin || row.agent_id !== identity.agentId || run?.threadId !== thread?.id || !thread?.projectId || run?.cwd !== thread.cwd || run?.status !== 'running' || completing.has(row.task_id)) throw new Error('工作流运行身份已变化');
        const schema = operation === 'upload' ? z.object({ path: z.string().min(1) }).strict() : z.object({ fileId: z.string().min(1) }).strict();
        const args = schema.parse(request.body);
        if ('path' in args) {
          if (registering.has(row.run_id)) throw new Error('附件正在登记，请稍后重试');
          registering.add(row.run_id);
          registeringRun = row.run_id;
        }
        const task = await callTool('workflow_get_task', { task_id: row.task_id }) as unknown as EnterpriseWorkflowTask;
        assertIdentity(identity);
        if ('path' in args) {
          const file = await inspectFile(thread.id, args.path);
          assertIdentity(identity);
          const current = owned(read.get(row.task_id), identity);
          if (current.run_id !== row.run_id || deliveryOf(current).submission || !['pending', 'awaiting_confirmation'].includes(current.state)) throw new Error('工作流运行已变化');
          const delivery = deliveryOf(current);
          if (delivery.files.some(item => item.name === file.name && item.path !== file.path)) throw new Error('待交付附件不能同名');
          delivery.files = [...delivery.files.filter(item => item.path !== file.path), file];
          if (delivery.files.length + JSON.parse(current.attachments_json).length > 100) throw new Error('附件数量超过限制');
          delivery.version += 1;
          persistDelivery(current, delivery);
          return { staged: true, file, message: '已登记本地待交付附件，等待用户确认后上传' };
        }
        const refs = [...(task.upstream_artifacts ?? []), ...JSON.parse(row.attachments_json) as EnterpriseWorkflowArtifact[]];
        const ref = refs.find(item => item.file_id === args.fileId);
        if (!ref) throw new Error('文件不属于当前工作流上下文');
        if (!options.sharedDrive) throw new Error('工作流文件服务不可用');
        return await options.sharedDrive.downloadToProject({ fileId: ref.file_id, projectId: thread.projectId, overwrite: false, expectedArtifact: ref, assertIdentity: () => assertIdentity(identity) });
      } catch (error) {
        const status = error instanceof AgentCapabilityTokenError ? error.statusCode : 409;
        return reply.code(status).send(apiError('VALIDATION_FAILED', error instanceof Error ? error.message : '工作流文件操作失败'));
      } finally {
        if (registeringRun) registering.delete(registeringRun);
      }
    });
  }

  server.post<{ Params: { id: string; fileId: string }; Body: unknown }>('/enterprise/workflow-instances/:id/files/:fileId/download', async (request, reply) => {
    try {
      const parsed = prepareSchema.parse(request.body);
      const identity = currentIdentity();
      if (!http.workflowRequest || !options.sharedDrive) throw new Error('工作流文件服务不可用');
      const response = await http.workflowRequest(await session.requireAccessToken(), 'GET', `/api/v1/app/workflow-instances/${encodeURIComponent(request.params.id)}`);
      assertIdentity(identity);
      const instance = response.data as EnterpriseWorkflowInstance;
      const ref = instance.tasks?.flatMap(task => task.artifacts ?? []).find(item => item.file_id === request.params.fileId);
      if (!ref) throw new Error('文件不属于当前实例正式结果');
      return await options.sharedDrive.downloadToProject({ fileId: ref.file_id, projectId: parsed.projectId, overwrite: false, expectedArtifact: ref, assertIdentity: () => assertIdentity(identity) });
    } catch (error) { return reply.code(409).send(apiError('VALIDATION_FAILED', error instanceof Error ? error.message : '文件下载失败')); }
  });
}
