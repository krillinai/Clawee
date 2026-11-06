import type { SkillContributionDownload, SkillContributionQuery } from '@clawee/protocol';

const queryKeys = new Set(['start_date', 'end_date', 'report', 'employee_id', 'status', 'min_total_score']);

export function contributionToolBody(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 6) return undefined;
  if (typeof value === 'string') {
    try { return contributionToolBody(JSON.parse(value), depth + 1); } catch { return undefined; }
  }
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) { const found = contributionToolBody(item, depth + 1); if (found) return found; }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if ('download' in record || ('query' in record && 'timezone' in record)) return record;
  for (const key of ['structuredContent', 'structured_content', 'result', 'response', 'content', 'text']) {
    const found = contributionToolBody(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function contributionDownload(value: unknown): SkillContributionDownload | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = value as Record<string, unknown>;
  if (descriptor.type !== 'skill_contributions_csv' || Object.keys(descriptor).some(key => key !== 'type' && key !== 'query')) return undefined;
  if (!descriptor.query || typeof descriptor.query !== 'object' || Array.isArray(descriptor.query)) return undefined;
  const query = descriptor.query as Record<string, unknown>;
  if (Object.keys(query).some(key => !queryKeys.has(key))) return undefined;
  if (typeof query.start_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(query.start_date) || typeof query.end_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(query.end_date)) return undefined;
  if (!['uploads', 'first_approvals', 'employees'].includes(String(query.report))) return undefined;
  if (query.employee_id !== undefined && (typeof query.employee_id !== 'string' || !query.employee_id)) return undefined;
  if (query.status !== undefined && !['pending', 'approved', 'rejected'].includes(String(query.status))) return undefined;
  if (query.min_total_score !== undefined && (typeof query.min_total_score !== 'number' || !Number.isFinite(query.min_total_score) || query.min_total_score < 0 || query.min_total_score > 20)) return undefined;
  if (query.report === 'employees' && (query.status !== undefined || query.min_total_score !== undefined)) return undefined;
  return { type: 'skill_contributions_csv', query: query as SkillContributionQuery };
}

export function contributionQueryLabel(query: SkillContributionQuery): string {
  const report = { uploads: '上传明细', first_approvals: '首次通过', employees: '员工汇总' };
  return [query.start_date, query.end_date ? `至 ${query.end_date}` : undefined, query.report ? report[query.report] : undefined, query.employee_id ? `员工 ${query.employee_id}` : undefined, query.status, query.min_total_score !== undefined ? `总分 ≥ ${query.min_total_score}` : undefined].filter(Boolean).join(' · ');
}
