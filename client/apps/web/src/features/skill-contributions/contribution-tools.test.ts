import { describe, expect, it } from 'vitest';
import { contributionDownload, contributionToolBody } from './contribution-tools.js';
import { contributionPeriod } from './SkillContributionsPage.js';

const query = { start_date: '2026-10-01', end_date: '2026-10-13', report: 'first_approvals', min_total_score: 16 };
describe('贡献工具下载边界', () => {
  it('只接收白名单描述，不接收地址、Token 或未知条件', () => {
    expect(contributionDownload({ type: 'skill_contributions_csv', query })).toEqual({ type: 'skill_contributions_csv', query });
    expect(contributionDownload({ type: 'skill_contributions_csv', query, url: 'https://example.com' })).toBeUndefined();
    expect(contributionDownload({ type: 'skill_contributions_csv', query: { ...query, department_id: 'guess' } })).toBeUndefined();
    expect(contributionDownload({ type: 'skill_contributions_csv', query: { ...query, report: 'employees' } })).toBeUndefined();
  });
  it('从真实 MCP 结构化响应解包', () => {
    const body = { query, timezone: 'Asia/Shanghai', download: { type: 'skill_contributions_csv', query } };
    expect(contributionToolBody({ content: [{ type: 'text', text: JSON.stringify(body) }] })).toEqual(body);
    expect(contributionToolBody({ result: { structuredContent: body } })).toEqual(body);
    expect(contributionToolBody('用户说请下载 CSV')).toBeUndefined();
  });
  it('按业务时区计算跨年月份和上月', () => {
    expect(contributionPeriod(false, new Date('2026-12-31T16:00:00Z'))).toEqual({ start_date: '2027-01-01', end_date: '2027-01-01' });
    expect(contributionPeriod(true, new Date('2026-12-31T16:00:00Z'))).toEqual({ start_date: '2026-12-01', end_date: '2026-12-31' });
  });
});
