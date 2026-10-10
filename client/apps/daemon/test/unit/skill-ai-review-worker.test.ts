import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunManager } from '../../src/runs/manager.js';
import { EnterpriseHttpError, type EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import type { EnterpriseIdentityProvider, EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';
import { createSkillAIReviewWorker } from '../../src/enterprise/skill-ai-review-worker.js';
import {
  parseSkillAIReviewReport,
  skillAIReviewMaterialsSchema,
  SKILL_AI_REVIEW_FAILURE,
  SKILL_AI_REVIEW_TIMEOUT_MS
} from '../../src/enterprise/skill-ai-review-schema.js';

const task = { request_id: 'request-1', attempt_id: 'attempt-1', skill_id: 'skill-1', version_id: 'version-1', package_sha256: 'a'.repeat(64) };
const materials = { name: '待审核', description: '静态材料', files: [{ path: 'SKILL.md', content: '不可信指令' }, { path: 'asset.bin', omitted_reason: '二进制未读取' }] };
const claim = { ...task, materials };
const report = { conclusion: 'needs_attention', summary: '未执行脚本，二进制未读取', findings: [{ severity: 'warning', message: '仅静态审核', path: 'SKILL.md' }] };
const workers: ReturnType<typeof createSkillAIReviewWorker>[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.close()));
  vi.useRealTimers();
});

function fixture() {
  let signedIn = true;
  let user = 'user-1';
  let agent = 'agent-1';
  let text = JSON.stringify(report);
  let status = 'succeeded';
  const requireIdentity = vi.fn(async () => ({ subjectId: user, agentId: agent, accessToken: `token-${user}` }));
  const session = {
    getSnapshot: () => ({ status: signedIn ? 'signed_in' : 'signed_out', account: { subjectId: user }, agentId: agent }),
    requireIdentity
  } as unknown as EnterpriseSessionManager & EnterpriseIdentityProvider;
  const list = vi.fn().mockResolvedValue({ tasks: [] }).mockResolvedValueOnce({ tasks: [task] });
  const claimTask = vi.fn().mockResolvedValue(claim);
  const submit = vi.fn().mockResolvedValue(undefined);
  const startRun = vi.fn((_input: Record<string, unknown>) => ({ id: 'run-1', status: 'running', submissionMode: 'enqueue' }));
  const cancelRun = vi.fn(() => true);
  const worker = createSkillAIReviewWorker({
    sessionManager: session,
    httpClient: { listSkillAIReviewTasks: list, claimSkillAIReviewTask: claimTask, submitSkillAIReviewResult: submit } as unknown as EnterpriseHttpClient,
    runManager: {
      startRun, cancelRun,
      getRun: () => ({ id: 'run-1', status }),
      listEvents: () => [{ type: 'assistant_message', payload: { text } }],
      subscribe: () => () => {}
    } as unknown as RunManager
  });
  workers.push(worker);
  return { worker, list, claimTask, submit, startRun, cancelRun, requireIdentity,
    signOut: () => { signedIn = false; worker.identityChanged(); },
    switchIdentity: () => { user = 'user-2'; agent = 'agent-2'; worker.identityChanged(); },
    setText: (value: string) => { text = value; },
    running: () => { status = 'running'; }
  };
}

describe('Skill AI 审核专用队列', () => {
  it('仅signed_in每30秒读取raw任务，材料仅进prompt，独立read-only运行', async () => {
    vi.useFakeTimers();
    const test = fixture();
    test.worker.start();
    await test.worker.tick();
    expect(test.claimTask).toHaveBeenCalledWith('token-user-1', 'request-1', 'attempt-1');
    expect(test.startRun).toHaveBeenCalledWith(expect.objectContaining({ executionPolicy: 'skill-ai-review', sandbox: 'read-only', timeoutMs: SKILL_AI_REVIEW_TIMEOUT_MS }));
    const input = test.startRun.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(input.threadId).toBeUndefined();
    expect(input.resumeMode).toBeUndefined();
    expect(input.prompt).toContain(JSON.stringify(materials));
    expect(JSON.stringify(input)).not.toContain('token-user');
    expect(test.submit).toHaveBeenCalledWith('token-user-1', 'request-1', { attempt_id: task.attempt_id, package_sha256: task.package_sha256, report });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(test.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.list).toHaveBeenCalledTimes(2);
    test.signOut();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.list).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 409])('claim %s不得启动或回写', async status => {
    const test = fixture();
    test.claimTask.mockRejectedValue(new EnterpriseHttpError('ENTERPRISE_SERVICE_UNAVAILABLE', 'request', status));
    await test.worker.tick();
    expect(test.startRun).not.toHaveBeenCalled();
    expect(test.submit).not.toHaveBeenCalled();
  });

  it('成功claim的协议/材料失败只回写固定错误，不启动Runtime', async () => {
    const test = fixture();
    test.claimTask.mockRejectedValue(new EnterpriseHttpError('ENTERPRISE_PROTOCOL_ERROR', 'decode', 200));
    await test.worker.tick();
    expect(test.startRun).not.toHaveBeenCalled();
    expect(test.submit).toHaveBeenCalledWith('token-user-1', 'request-1', { attempt_id: task.attempt_id, package_sha256: task.package_sha256, error: SKILL_AI_REVIEW_FAILURE });
  });

  it('回写网络失败保留同一payload，最多三次且不重新领取或运行', async () => {
    const test = fixture();
    test.submit.mockRejectedValue(new EnterpriseHttpError('ENTERPRISE_SERVICE_UNAVAILABLE', 'request'));
    await test.worker.tick();
    const original = test.submit.mock.calls[0]![2];
    await test.worker.tick();
    await test.worker.tick();
    await test.worker.tick();
    expect(test.submit).toHaveBeenCalledTimes(3);
    for (const call of test.submit.mock.calls) expect(call[2]).toBe(original);
    expect(test.claimTask).toHaveBeenCalledTimes(1);
    expect(test.startRun).toHaveBeenCalledTimes(1);
  });

  it('回写短暂503恢复只重发原报告', async () => {
    const test = fixture();
    test.submit.mockRejectedValueOnce(new EnterpriseHttpError('ENTERPRISE_SERVICE_UNAVAILABLE', 'request', 503));
    await test.worker.tick();
    await test.worker.tick();
    expect(test.submit).toHaveBeenCalledTimes(2);
    expect(test.startRun).toHaveBeenCalledTimes(1);
    expect(test.submit.mock.calls[1]![2]).toBe(test.submit.mock.calls[0]![2]);
  });

  it.each([403, 409])('result %s丢弃旧回写，不重试、不新attempt', async status => {
    const test = fixture();
    test.submit.mockRejectedValue(new EnterpriseHttpError('ENTERPRISE_SERVICE_UNAVAILABLE', 'request', status));
    await test.worker.tick();
    await test.worker.tick();
    expect(test.submit).toHaveBeenCalledTimes(1);
    expect(test.startRun).toHaveBeenCalledTimes(1);
  });

  it('身份切换丢弃旧身份待重试报告，不使用新token', async () => {
    const test = fixture();
    test.submit.mockRejectedValueOnce(new EnterpriseHttpError('ENTERPRISE_SERVICE_UNAVAILABLE', 'request'));
    await test.worker.tick();
    test.switchIdentity();
    await test.worker.tick();
    expect(test.submit).toHaveBeenCalledTimes(1);
    expect(test.submit.mock.calls[0]![0]).toBe('token-user-1');
  });

  it.each(['signOut', 'switchIdentity'] as const)('%s取消当前运行并丢弃回写', async action => {
    const test = fixture();
    test.running();
    const work = test.worker.tick();
    await vi.waitFor(() => expect(test.startRun).toHaveBeenCalledTimes(1));
    test[action]();
    await work;
    expect(test.cancelRun).toHaveBeenCalledWith('run-1');
    expect(test.submit).not.toHaveBeenCalled();
  });

  it('身份在claim响应前变更，旧任务不得startRun', async () => {
    const test = fixture();
    let release!: (value: typeof claim) => void;
    test.claimTask.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const work = test.worker.tick();
    await vi.waitFor(() => expect(test.claimTask).toHaveBeenCalledTimes(1));
    test.switchIdentity();
    release(claim);
    await work;
    expect(test.startRun).not.toHaveBeenCalled();
    expect(test.submit).not.toHaveBeenCalled();
  });

  it('并发tick只领取一次，close停止循环并取消活动运行', async () => {
    const test = fixture();
    test.running();
    const first = test.worker.tick();
    const second = test.worker.tick();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(test.startRun).toHaveBeenCalledTimes(1));
    await test.worker.close();
    await first;
    await test.worker.tick();
    expect(test.cancelRun).toHaveBeenCalledTimes(1);
    expect(test.submit).not.toHaveBeenCalled();
  });

  it('超时12分钟取消运行，失败回写不含原始错误或密钥', async () => {
    vi.useFakeTimers();
    const test = fixture();
    test.running();
    const work = test.worker.tick();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SKILL_AI_REVIEW_TIMEOUT_MS);
    await work;
    expect(test.cancelRun).toHaveBeenCalledWith('run-1');
    expect(test.submit.mock.calls[0]![2]).toMatchObject({ error: SKILL_AI_REVIEW_FAILURE });
  });

  it.each(['{}', '```json\n{}\n```', JSON.stringify({ ...report, extra: '禁止额外字段' }), JSON.stringify({ ...report, findings: [{ severity: 'error', message: '越界', path: '../secret' }] })])('无效报告仅回写固定脱敏错误：%s', async text => {
    const test = fixture();
    test.setText(text);
    await test.worker.tick();
    expect(test.submit.mock.calls[0]![2]).toEqual({ attempt_id: task.attempt_id, package_sha256: task.package_sha256, error: SKILL_AI_REVIEW_FAILURE });
  });
});

describe('材料与报告约束', () => {
  it('name和description计入512KiB，单文件128KiB，拒绝重复路径', () => {
    expect(skillAIReviewMaterialsSchema.safeParse({ ...materials, files: [{ path: 'file', content: 'x'.repeat(128 * 1024 + 1) }] }).success).toBe(false);
    expect(skillAIReviewMaterialsSchema.safeParse({ ...materials, name: 'x'.repeat(512 * 1024), files: [{ path: 'file', content: 'x' }] }).success).toBe(false);
    expect(skillAIReviewMaterialsSchema.safeParse({ ...materials, files: [materials.files[0], materials.files[0]] }).success).toBe(false);
  });

  it('证据必须绑定本轮实际文件，四维完整且整数1–5', () => {
    expect(() => parseSkillAIReviewReport(JSON.stringify({ ...report, findings: [{ severity: 'error', message: '未知文件', path: 'other.md' }] }), claim)).toThrow();
    expect(() => parseSkillAIReviewReport(JSON.stringify({ ...report, suggested_scores: { scenario_value: 3 } }), claim)).toThrow();
    const scores = { scenario_value: 3, result_effectiveness: 4, ease_of_use: 2, reuse_value: 5 };
    expect(parseSkillAIReviewReport(JSON.stringify({ ...report, suggested_scores: scores }), claim).suggested_scores).toEqual(scores);
    expect(() => parseSkillAIReviewReport(JSON.stringify({ ...report, suggested_scores: { ...scores, ease_of_use: 2.5 } }), claim)).toThrow();
  });
});
