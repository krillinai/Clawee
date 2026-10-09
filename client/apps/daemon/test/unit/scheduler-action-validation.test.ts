import { describe, expect, it } from 'vitest';
import { parseCreateScheduleRequest, parseUpdateScheduleRequest } from '../../src/scheduler/validator.js';

const options = {
  now: '2026-10-09T00:00:00.000Z',
  defaultCwd: '/tmp',
  profileValidator: { validateProfileForRun: () => ({ ok: true as const }) }
};
const request = { name: '测试', cron: '0 9 * * *', prompt: '执行', cwd: '/tmp' };

describe('schedule action validation', () => {
  it.each(['unknown', 'workflow_start', null])('rejects action %s on ordinary Agent creation', action => {
    expect(parseCreateScheduleRequest({ ...request, action }, options).ok).toBe(false);
  });
  it('rejects workflow configuration on ordinary Agent creation', () => {
    expect(parseCreateScheduleRequest({ ...request, workflow: { templateId: 'template' } }, options).ok).toBe(false);
  });
  it.each([{ action: 'workflow_start' }, { workflow: { templateId: 'template', initialInput: {} } }])('rejects action conversion on ordinary update', fields => {
    expect(parseUpdateScheduleRequest(fields, options).ok).toBe(false);
  });
  it('keeps omitted and explicit agent_run creation compatible', () => {
    expect(parseCreateScheduleRequest(request, options).ok).toBe(true);
    expect(parseCreateScheduleRequest({ ...request, action: 'agent_run' }, options).ok).toBe(true);
  });
});
