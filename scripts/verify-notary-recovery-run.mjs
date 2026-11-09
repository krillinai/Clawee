import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function verifyNotaryRecoveryRun({ run, jobs, artifacts, repository }) {
  assert.equal(run.repository.full_name, repository, '恢复来源仓库不匹配');
  assert.equal(run.head_repository.full_name, repository, '不能恢复 Fork 产物');
  assert.equal(run.path, '.github/workflows/release.yml', '恢复来源不是 Release 工作流');
  assert(['push', 'workflow_dispatch'].includes(run.event), '恢复来源事件不可信');
  assert.equal(run.status, 'completed', '来源工作流尚未结束');
  assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  const requireJob = (name, conclusions) => {
    const matches = jobs.filter(job => job.name === name);
    assert.equal(matches.length, 1, `恢复来源 Job 缺失或重复：${name}`);
    assert(conclusions.includes(matches[0].conclusion), `恢复来源 Job 未通过：${name}`);
  };
  for (const name of ['target', 'preflight / client', 'preflight / record', 'gate']) {
    requireJob(name, ['success']);
  }
  for (const target of ['macos-arm64, macos-14, mac, arm64', 'macos-x64, macos-15-intel, mac, x64']) {
    requireJob(`desktop (${target})`, ['success', 'failure']);
  }
  requireJob('desktop (windows-x64-unsigned, windows-latest, win, x64)', ['success']);
  for (const name of [
    'clawee-desktop-notary-macos-arm64', 'clawee-desktop-notary-macos-x64',
    'clawee-desktop-release-windows-x64-unsigned'
  ]) {
    const matches = artifacts.filter(artifact => artifact.name === name);
    assert.equal(matches.length, 1, `恢复来源 Artifact 缺失或重复：${name}`);
    assert.equal(matches[0].expired, false, `恢复来源 Artifact 已过期：${name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    'run-id': { type: 'string' }, repository: { type: 'string' }, 'github-output': { type: 'string' }
  } });
  assert.match(values['run-id'] ?? '', /^\d+$/);
  assert.match(values.repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const runPath = `repos/${values.repository}/actions/runs/${values['run-id']}`;
  const load = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 60_000 }));
  const pages = endpoint => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', endpoint], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024
  }));
  const run = load(runPath);
  const jobs = pages(`${runPath}/attempts/${run.run_attempt}/jobs?per_page=100`).flatMap(page => page.jobs);
  const artifacts = pages(`${runPath}/artifacts?per_page=100`).flatMap(page => page.artifacts);
  verifyNotaryRecoveryRun({ run, jobs, artifacts, repository: values.repository });
  if (values['github-output']) appendFileSync(values['github-output'], `run-attempt=${run.run_attempt}\n`);
  console.log('公证恢复来源验证通过；产物仍须校验标签、SHA、Team、架构和文件哈希');
}
