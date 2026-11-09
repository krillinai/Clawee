import { z } from 'zod';
import type { SkillContributionResponse } from '@clawee/protocol';

export const contributionQuerySchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  report: z.enum(['uploads', 'first_approvals', 'employees']).optional(),
  employee_id: z.string().min(1).max(256).optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  min_total_score: z.coerce.number().finite().min(0).max(20).optional(),
  page: z.coerce.number().int().min(1).max(1000000).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional()
}).strict();

const scores = z.object({
  scenario_value: z.number(), result_effectiveness: z.number(),
  ease_of_use: z.number(), reuse_value: z.number(), total: z.number()
});
const employee = z.object({
  employee_id: z.string(), employee_name: z.string(), uploads: z.number(),
  first_approvals: z.number(), scored_count: z.number(), average_score: z.number().nullable()
});
const record = z.object({
  id: z.string(), employee_id: z.string(), employee_name: z.string(),
  skill_id: z.string(), skill_name: z.string(), version_id: z.string(),
  version: z.string().nullable(), space_id: z.string(), source: z.string(),
  approval_id: z.string().nullable(), occurred_at: z.string(), status: z.string().nullable(),
  scoring_standard_version: z.string().nullable(), scores: scores.nullable(),
  approvers: z.array(z.object({
    user_id: z.string(), name: z.string(), status: z.string(), comment: z.string(),
    decided_at: z.string().nullable().optional(),
    scores: scores.omit({ total: true }).partial().nullable().optional()
  })),
  entity_available: z.boolean(), history_status: z.string()
});
const responseData = z.object({
    timezone: z.string(), generated_at: z.string(),
    coverage: z.object({ first_approvals_from: z.string(), uploads_from: z.string().nullable(), notice: z.string() }),
    summary: z.object({ uploads: z.number(), first_approvals: z.number(), contributors: z.number(), scored_count: z.number(), average_score: z.number().nullable() }).optional(),
    items: z.array(z.union([record, employee])).optional(), total: z.number()
});

export function contributionResponseSchema(endpoint: 'summary' | 'records' | 'detail'): z.ZodType<{ data: SkillContributionResponse }, z.ZodTypeDef, unknown> {
  if (endpoint === 'summary') {
    return z.object({ data: responseData.extend({
      query: contributionQuerySchema.pick({ start_date: true, end_date: true, employee_id: true })
        .extend({ report: z.literal('') }).transform(({ report: _report, ...query }) => query),
      summary: responseData.shape.summary.unwrap()
    }) });
  }
  if (endpoint === 'detail') {
    return z.object({ data: responseData.extend({
      query: z.object({ start_date: z.literal(''), end_date: z.literal(''), report: z.literal('') })
        .strict().transform(() => ({})),
      items: z.array(record)
    }) });
  }
  return z.object({ data: responseData.extend({
    query: contributionQuerySchema.required({ start_date: true, end_date: true, report: true }),
    items: responseData.shape.items.unwrap()
  }) });
}
