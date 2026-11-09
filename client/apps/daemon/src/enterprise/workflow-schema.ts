import { z } from 'zod';

const userIds = z.array(z.string().min(1));
const objectValue = z.record(z.string(), z.unknown());
export const workflowArtifactSchema = z.object({
  file_id: z.string().min(1), logical_path: z.string().min(1), revision: z.number().int().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  file_name: z.string().optional(), content_type: z.string().optional(), size_bytes: z.number().int().nonnegative().optional()
}).strict();
const sharedContext = {
  shared_space_id: z.string().optional(), instance_path_prefix: z.string().optional(), node_path_prefix: z.string().optional(),
  upstream_artifacts: z.array(workflowArtifactSchema).optional()
};
const nodeSchema = z.object({
  node_id: z.string().min(1), order: z.number().int(), type: z.enum(['agent', 'approval']), title: z.string(), instruction: z.string(),
  assignee_user_id: z.string().optional(), assignee_user_ids: userIds.optional(), assignee_role_ids: userIds.optional(), assignee_initiator: z.boolean().optional(), resolved_user_ids: userIds.optional()
}).passthrough();

export const taskSchema = z.object({
  ...sharedContext, artifacts: z.array(workflowArtifactSchema).optional(),
  task_id: z.string().min(1), instance_id: z.string().min(1), node_id: z.string().min(1), node_order: z.number().int().optional(),
  type: z.enum(['agent', 'approval']), status: z.string(), instruction: z.string(), input: objectValue,
  assignee_user_id: z.string().optional(), assignee_user_ids: userIds.optional(), output: objectValue.optional(),
  decision: z.string().optional(), comment: z.string().optional(), handled_by: z.string().optional(), completed_at: z.string().nullable().optional()
}).passthrough();

const templateSchema = z.object({
  shared_space_id: z.string().optional(),
  id: z.string().min(1), name: z.string(), description: z.string(), status: z.string(), revision: z.number().int(), nodes: z.array(nodeSchema),
  user_names: z.record(z.string(), z.string()).optional()
}).passthrough();

export const instanceSchema = z.object({
  ...sharedContext,
  id: z.string().min(1), template_id: z.string().min(1), status: z.string(), nodes: z.array(nodeSchema), started_at: z.string(),
  tasks: z.array(taskSchema).optional(), user_names: z.record(z.string(), z.string()).optional()
}).passthrough();

const resultSchema = z.object({
  ...sharedContext,
  instance_id: z.string().min(1), task_id: z.string(), status: z.string(), next_task: taskSchema.extend({ input: objectValue.nullable() }).optional()
}).passthrough();

export function workflowResponseSchema(method: 'GET' | 'POST', path: string): z.ZodType<{ data: unknown; meta?: unknown }> {
  if (method === 'POST') return z.object({ data: resultSchema });
  const pathname = path.split('?')[0] ?? path;
  const resource = pathname.split('/')[4];
  const schema = resource === 'workflow-templates' ? templateSchema : resource === 'workflow-instances' ? instanceSchema : taskSchema;
  const detail = pathname.split('/').length > 5;
  return detail ? z.object({ data: schema }) : z.object({ data: z.array(schema), meta: z.object({ next_cursor: z.string(), has_next: z.boolean() }) });
}
