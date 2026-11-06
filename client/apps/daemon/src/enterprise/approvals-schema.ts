import { z } from 'zod';
import { instanceSchema, taskSchema } from './workflow-schema.js';

export const approvalKindSchema = z.enum(['skill', 'workflow', 'workflow_instance']);
export const approvalFiltersSchema = z.object({
  view: z.enum(['todo', 'done', 'initiated']).default('todo'),
  type: z.enum(['all', 'skill', 'workflow']).default('all'),
  status: z.enum(['all', 'pending', 'approved', 'rejected', 'invalidated', 'running', 'succeeded', 'terminated']).default('all'),
  cursor: z.string().max(8192).optional()
}).strict();
const score = z.number().int().min(1).max(5);
const scoresSchema = z.object({ scenario_value: score.optional(), result_effectiveness: score.optional(), ease_of_use: score.optional(), reuse_value: score.optional() }).strict();
export const skillDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']), comment: z.string().max(2000), scores: scoresSchema
}).strict().refine(value => value.decision === 'approved'
  ? Object.values(value.scores).filter(value => value !== undefined).length === 4
  : Boolean(value.comment.trim()));
const itemSchema = z.object({
  kind: approvalKindSchema, id: z.string().min(1), type: z.enum(['skill', 'workflow']), title: z.string(),
  business_status: z.string(), my_status: z.enum(['pending', 'approved', 'rejected', '']),
  created_at: z.string(), acted_at: z.string().optional(), can_process: z.boolean(),
  workflow_stage: z.string().optional(), can_retry_ai: z.boolean().optional(), version_id: z.string().optional(), version: z.string().optional()
}).passthrough();
const aiReviewSchema = z.object({
  status: z.string(), attempt_id: z.string(), report: z.object({
    conclusion: z.string(), summary: z.string(), findings: z.array(z.object({ severity: z.string(), message: z.string(), path: z.string().optional() })),
    suggested_scores: scoresSchema.optional()
  }).nullable().optional()
}).passthrough();
const approvalSchema = z.object({
  request_id: z.string().optional(), status: z.string(), total: z.number(), approved: z.number(), ai_review: aiReviewSchema.nullable().optional(),
  score_summary: z.object({ scenario_value: z.number(), result_effectiveness: z.number(), ease_of_use: z.number(), reuse_value: z.number(), total: z.number() }).nullable().optional(),
  approvers: z.array(z.object({ user_id: z.string(), name: z.string(), status: z.string(), comment: z.string(), decided_at: z.string().nullable(), scores: scoresSchema.nullable().optional() }))
}).passthrough();
const detailSchema = z.object({
  item: itemSchema,
  skill: z.object({ skill: z.object({ name: z.string(), description: z.string() }).passthrough(), versions: z.array(z.object({
    version_id: z.string(), version: z.string(), description: z.string(), changelog: z.string(), local_approval: approvalSchema.optional()
  }).passthrough()) }).optional(),
  workflow: instanceSchema.optional(), task: taskSchema.optional()
});
const fileSchema = z.object({ path: z.string(), size: z.number() });
const approvalFilesResponseSchema = z.union([
  z.object({ items: z.array(fileSchema) }),
  z.object({
    data: z.array(fileSchema),
    meta: z.object({ next_cursor: z.string(), has_next: z.boolean() }).passthrough()
  }).transform(value => ({ items: value.data }))
]);

export function approvalResponseSchema(method: 'GET' | 'POST', path: string): z.ZodType<unknown> {
  if (method === 'POST') return z.object({ data: z.unknown() }).refine(value => Object.hasOwn(value, 'data'));
  const pathname = path.split('?')[0]!;
  if (pathname.endsWith('/files')) return approvalFilesResponseSchema;
  if (pathname.endsWith('/file')) return z.object({ data: fileSchema.extend({ content: z.string() }) });
  if (pathname === '/api/v1/app/approvals') return z.object({ data: z.array(itemSchema), meta: z.object({ next_cursor: z.string(), has_next: z.boolean() }) });
  return z.object({ data: detailSchema });
}
