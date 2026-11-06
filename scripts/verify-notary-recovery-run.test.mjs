import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyNotaryRecoveryRun } from './verify-notary-recovery-run.mjs';

function evidence() {
  return {
    repository: 'krillinai/Clawee',
    run: {
      repository: { full_name: 'krillinai/Clawee' },
      head_repository: { full_name: 'krillinai/Clawee' },
      path: '.github/workflows/release.yml', event: 'workflow_dispatch',
      status: 'completed', run_attempt: 1
    },
    jobs: [
      'target', 'preflight / client', 'preflight / record', 'gate',
      'desktop (windows-x64-unsigned, windows-latest, win, x64)'
    ].map(name => ({ name, conclusion: 'success' })).concat([
      { name: 'desktop (macos-arm64, macos-14, mac, arm64)', conclusion: 'failure' },
      { name: 'desktop (macos-x64, macos-15-intel, mac, x64)', conclusion: 'success' }
    ]),
    artifacts: [
      'clawee-desktop-notary-macos-arm64', 'clawee-desktop-notary-macos-x64',
      'clawee-desktop-release-windows-x64-unsigned'
    ].map(name => ({ name, expired: false }))
  };
}

test('允许预检通过、macOS 收尾失败且 Windows 已完成的原 Release', () => {
  verifyNotaryRecoveryRun(evidence());
});

for (const [name, mutate] of [
  ['Fork', input => { input.run.head_repository.full_name = 'other/repo'; }],
  ['其他仓库', input => { input.run.repository.full_name = 'other/repo'; }],
  ['PR', input => { input.run.event = 'pull_request'; }],
  ['其他工作流', input => { input.run.path = '.github/workflows/ci.yml'; }],
  ['未结束任务', input => { input.run.status = 'in_progress'; }],
  ['缺失预检', input => { input.jobs = input.jobs.filter(job => job.name !== 'preflight / client'); }],
  ['预检失败', input => { input.jobs[1].conclusion = 'failure'; }],
  ['门禁失败', input => { input.jobs[3].conclusion = 'failure'; }],
  ['Windows 未完成', input => { input.jobs[4].conclusion = 'failure'; }],
  ['macOS 被跳过', input => { input.jobs[5].conclusion = 'skipped'; }],
  ['重复 Job', input => { input.jobs.push(input.jobs[0]); }],
  ['缺失留存', input => { input.artifacts.pop(); }],
  ['过期留存', input => { input.artifacts[0].expired = true; }],
  ['重复留存', input => { input.artifacts.push(input.artifacts[0]); }]
]) {
  test(`拒绝${name}`, () => {
    const input = evidence();
    mutate(input);
    assert.throws(() => verifyNotaryRecoveryRun(input));
  });
}
