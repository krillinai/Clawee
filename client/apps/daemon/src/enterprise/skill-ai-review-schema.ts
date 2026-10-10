import { z } from 'zod';

export const SKILL_AI_REVIEW_FAILURE = 'AI 审核未完成，请重试或明确转人工审核';
export const SKILL_AI_REVIEW_TIMEOUT_MS = 12 * 60 * 1000;

const boundedText = (bytes: number) => z.string().refine(value =>
  value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= bytes
);

export const skillAIReviewTaskSchema = z.object({
  request_id: boundedText(256),
  attempt_id: boundedText(256),
  skill_id: boundedText(256),
  version_id: boundedText(256),
  package_sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export function isSkillAIReviewPath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\')
    && !path.includes('\0') && !/^[A-Za-z]:/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export const skillAIReviewMaterialsSchema = z.object({
  name: z.string(),
  description: z.string(),
  files: z.array(z.object({
    path: z.string().refine(isSkillAIReviewPath),
    content: z.string().optional(),
    omitted_reason: boundedText(4096).optional()
  }).strict().refine(file => (file.content !== undefined) !== (file.omitted_reason !== undefined)))
}).strict().superRefine((materials, context) => {
  let total = Buffer.byteLength(materials.name + materials.description, 'utf8');
  const paths = new Set<string>();
  for (const file of materials.files) {
    const bytes = Buffer.byteLength(file.content ?? '', 'utf8');
    total += bytes;
    if (bytes > 128 * 1024 || paths.has(file.path)) {
      context.addIssue({ code: 'custom', message: '审核材料超限或重复' });
    }
    paths.add(file.path);
  }
  if (total > 512 * 1024) context.addIssue({ code: 'custom', message: '审核材料超限' });
});

export const skillAIReviewClaimSchema = skillAIReviewTaskSchema.extend({
  materials: skillAIReviewMaterialsSchema
}).strict();

export const skillAIReviewReportSchema = z.object({
  conclusion: z.enum(['recommend_approve', 'recommend_reject', 'needs_attention']),
  summary: boundedText(8192),
  findings: z.array(z.object({
    severity: z.enum(['info', 'warning', 'error']),
    message: boundedText(4096),
    path: z.string().refine(isSkillAIReviewPath).optional()
  }).strict()).max(100),
  suggested_scores: z.object({
    scenario_value: z.number().int().min(1).max(5),
    result_effectiveness: z.number().int().min(1).max(5),
    ease_of_use: z.number().int().min(1).max(5),
    reuse_value: z.number().int().min(1).max(5)
  }).strict().optional()
}).strict();

export type SkillAIReviewTask = z.infer<typeof skillAIReviewTaskSchema>;
export type SkillAIReviewClaim = z.infer<typeof skillAIReviewClaimSchema>;
export type SkillAIReviewReport = z.infer<typeof skillAIReviewReportSchema>;
export type SkillAIReviewResult = {
  attempt_id: string;
  package_sha256: string;
} & ({ report: SkillAIReviewReport; error?: never } | { error: string; report?: never });

export function parseSkillAIReviewReport(text: string, claim: SkillAIReviewClaim): SkillAIReviewReport {
  if (Buffer.byteLength(text, 'utf8') > 128 * 1024) throw new Error(SKILL_AI_REVIEW_FAILURE);
  const report = skillAIReviewReportSchema.parse(JSON.parse(text));
  const paths = new Set(claim.materials.files.map(file => file.path));
  if (report.findings.some(finding => finding.path !== undefined && !paths.has(finding.path))) {
    throw new Error(SKILL_AI_REVIEW_FAILURE);
  }
  return report;
}
