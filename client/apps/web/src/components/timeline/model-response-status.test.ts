import { describe, expect, it } from 'vitest';
import { collapseModelResponseErrors } from './model-response-status.js';
import type { TimelineItem } from './timeline-model.js';

function retry(id: string, patch: Partial<Extract<TimelineItem, { kind: 'diagnostic' }>> = {}): Extract<TimelineItem, { kind: 'diagnostic' }> {
  return { kind: 'diagnostic', id, runId: 'run_1', severity: 'warning', message: 'retry', content: '{}', source: 'runtime',
    modelResponse: { errorCode: 'responseStreamDisconnected', reason: '模型接口返回限流（HTTP 429）', suggestion: '请稍后重试', retrying: true, diagnostics: { additional_details: 'HTTP 429' } }, ...patch };
}
const done = (status: string): TimelineItem => ({ kind: 'done', id: 'done', runId: 'run_1', status, terminationReason: 'stream_error', content: '{}', source: 'runtime' });

describe('模型响应故障展示投影', () => {
  it('连续重试只更新一条提示，不修改原始事件或其他警告', () => {
    const unrelated = retry('other', { modelResponse: undefined, content: '{"code":"OTHER_WARNING"}' });
    const original = [retry('first'), unrelated, retry('second'), retry('third')];
    const result = collapseModelResponseErrors(original);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'first', modelResponseState: 'retrying', message: expect.stringContaining('429') });
    expect(result[1]).toBe(unrelated);
    expect(original).toHaveLength(4);
    expect(original[0]).not.toHaveProperty('modelResponseState');
  });
  it('工具事件不表示恢复，只有模型文本才结束当前重试', () => {
    const tool: TimelineItem = { kind: 'tool_step', id: 'tool', runId: 'run_1', name: 'exec', content: '{}', source: 'runtime' };
    expect(collapseModelResponseErrors([retry('first'), tool])[0]).toMatchObject({ modelResponseState: 'retrying' });
    const message: TimelineItem = { kind: 'assistant_message', id: 'message', runId: 'run_1', text: 'hello', source: 'runtime' };
    const result = collapseModelResponseErrors([retry('first'), message, retry('next')]);
    expect(result[0]).toMatchObject({ modelResponseState: 'recovered', message: '模型响应已恢复，任务继续执行' });
    expect(result[2]).toMatchObject({ id: 'next', modelResponseState: 'retrying' });
  });
  it.each([['failed', '本次任务失败'], ['canceled', '任务已取消'], ['succeeded', '未确认响应是否恢复']])('终态 %s 不遗留正在重试', (status, text) => {
    const result = collapseModelResponseErrors([retry('first'), done(status)]);
    expect(result[0]).toMatchObject({ message: expect.stringContaining(text) });
    expect((result[0] as ReturnType<typeof retry>).message).not.toContain('正在重试');
  });
  it('不同任务不混并，旧版本重连事件也能合并', () => {
    const legacy = retry('legacy', { modelResponse: undefined, content: '{"code":"CODEX_STREAM_RETRYING"}' });
    const result = collapseModelResponseErrors([legacy, { ...legacy, id: 'legacy2' }, retry('other-run', { runId: 'run_2' })]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ modelResponseState: 'retrying', message: expect.stringContaining('具体原因未返回') });
  });
  it('重试耗尽保留最后已知具体原因，取消后不显示任务失败', () => {
    const terminal = retry('terminal', { modelResponse: { errorCode: 'responseTooManyFailedAttempts', reason: '模型请求重试次数已耗尽，具体原因未返回',
      suggestion: '请联系管理员', retrying: false, diagnostics: { error_message: 'retry exhausted' } } });
    expect(collapseModelResponseErrors([retry('first'), terminal, done('failed')])[0]).toMatchObject({ message: '多次重试后仍未恢复，本次任务失败；最后已知原因：模型接口返回限流（HTTP 429）' });
    expect(collapseModelResponseErrors([retry('first'), terminal, done('canceled')])[0]).toMatchObject({ modelResponseState: 'canceled', message: expect.stringContaining('任务已取消') });
  });
  it('重试耗尽后同时保留具体底层错误和最终错误', () => {
    const first = retry('first', { modelResponse: { errorCode: 'other', reason: 'Codex Runtime 返回错误', suggestion: '请稍后重试',
      retrying: true, diagnostics: {}, runtimeMessage: 'Response protection failed', runtimeDetails: 'Unexpected event' } });
    const terminal = retry('terminal', { modelResponse: { errorCode: 'responseTooManyFailedAttempts', reason: '模型请求重试次数已耗尽，具体原因未返回',
      suggestion: '请联系管理员', retrying: false, diagnostics: {}, runtimeMessage: 'retry limit exceeded', runtimeDetails: 'Attempts exhausted' } });
    expect(collapseModelResponseErrors([first, terminal, done('failed')])[0]).toMatchObject({ modelResponse: {
      runtimeMessage: 'Response protection failed\nretry limit exceeded', runtimeDetails: 'Unexpected event\nAttempts exhausted'
    } });
  });
  it('最终错误含明确证书原因时采用新证据，不被上次限流覆盖', () => {
    const terminal = retry('terminal', { modelResponse: { errorCode: 'responseTooManyFailedAttempts', reason: '模型连接证书校验失败',
      suggestion: '请检查证书配置', retrying: false, diagnostics: { additional_details: 'invalid peer certificate' } } });
    expect(collapseModelResponseErrors([retry('first'), terminal, done('failed')])[0]).toMatchObject({
      message: '多次重试后仍未恢复，本次任务失败；最后已知原因：模型连接证书校验失败'
    });
  });
  it('失败终态未附带错误时保留之前的 Codex 底层错误', () => {
    const first = retry('first', { modelResponse: { errorCode: 'other', reason: 'Codex Runtime 返回错误', suggestion: '请稍后重试',
      retrying: true, diagnostics: {}, runtimeMessage: 'Response protection failed' } });
    const terminal = retry('terminal', { modelResponse: { errorCode: 'RUNTIME_ERROR', reason: 'Runtime 请求失败，具体原因未明确',
      suggestion: '请联系管理员', retrying: false, diagnostics: {} } });
    expect(collapseModelResponseErrors([first, terminal, done('failed')])[0]).toMatchObject({ modelResponseState: 'failed', modelResponse: {
      reason: 'Codex Runtime 返回错误', runtimeMessage: 'Response protection failed'
    } });
  });
});
