import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = name => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

test('预检在源测试失败、候选产物缺失或取消时拒绝发布', () => {
  const script = workflow('release-preflight').jobs.record.steps[0].run;
  const execute = (candidates, overrides = {}) => spawnSync('bash', ['-c', `gh() { return 0; }\n${script}`], {
    env: {
      ...process.env,
      VERIFY_RESULT: 'success', BUILD_CANDIDATES: String(candidates),
      PACKAGE_RESULT: candidates ? 'success' : 'skipped',
      CONTAINER_RESULT: candidates ? 'success' : 'skipped',
      ...overrides
    }
  }).status;
  for (const candidates of [false, true]) {
    assert.equal(execute(candidates), 0);
    for (const key of ['VERIFY_RESULT', 'PACKAGE_RESULT', 'CONTAINER_RESULT']) {
      for (const result of ['failure', 'cancelled']) assert.notEqual(execute(candidates, { [key]: result }), 0);
    }
  }
  assert.notEqual(execute(true, { PACKAGE_RESULT: 'skipped' }), 0);
  assert.notEqual(execute(false, { CONTAINER_RESULT: 'success' }), 0);
});

test('正式发布先验证固定标签源码和候选产物，再发布镜像与服务端包', () => {
  const release = workflow('release');
  assert.match(release.jobs.target.steps[0].with.ref, /^refs\/tags\//);
  assert.equal(release.jobs.preflight.with.build_candidates, true);
  assert.deepEqual(release.jobs.image.needs, ['target', 'preflight']);
  assert.deepEqual(release.jobs.publish.needs, ['target', 'preflight', 'image']);
  assert.equal(release.jobs.publish.environment, 'release');
  assert.equal(release.jobs.publish.steps[0].with.pattern, 'clawee-server-release-linux-*');
  assert(!JSON.stringify(release).includes('TENCENT_CLOUD_SECRET'));
  assert(!JSON.stringify(release).includes('MACOS_CERTIFICATE'));
  assert(!JSON.stringify(release).includes('client/'));
});

test('普通 PR 自动检查且不使用发布凭据', () => {
  for (const name of ['server-ci', 'source-security']) {
    const definition = workflow(name);
    assert('pull_request' in definition.on);
    assert(definition.on.push.branches.includes('main'));
    assert(!('pull_request_target' in definition.on));
    assert(!JSON.stringify(definition).includes('secrets.'));
  }
});
