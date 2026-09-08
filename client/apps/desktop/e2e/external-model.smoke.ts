import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createEmbeddedRuntimeFixture, runtimeRequest, waitForEmbeddedRuntimeReady } from './embedded-runtime-fixture.js';
import { closePackagedApp, type PackagedApp } from './packaged-app.js';

test('自托管 Gateway 与包内 Runtime 使用外部模型完成任务', async () => {
  const configPath = process.env.CLAWEE_EXTERNAL_MODEL_CONFIG;
  const stackPath = process.env.CLAWEE_EXTERNAL_STACK_CONFIG;
  test.skip(!configPath || !stackPath, '需显式提供仓库外的测试模型和隔离服务端配置');
  const model = JSON.parse(readFileSync(configPath!, 'utf8'));
  const stack = JSON.parse(readFileSync(stackPath!, 'utf8'));
  const fixture = await createEmbeddedRuntimeFixture();
  let app: PackagedApp | undefined;
  try {
    writeFileSync(join(fixture.root, 'enterprise/config.toml'), `gateway = ${JSON.stringify(stack.gateway)}\n`, { mode: 0o600 });
    app = await fixture.launch();
    await waitForEmbeddedRuntimeReady(app.page);
    const login = await runtimeRequest(app.page, 'POST', '/enterprise/login', { email: stack.email, password: stack.password });
    expect(login.status).toBe(200);
    await expect.poll(async () => (await runtimeRequest<{ status: string }>(app!.page, 'GET', '/runtime/model-service')).body.status).toBe('configuration_required');
    const configured = await runtimeRequest<{ status: string; code?: string }>(app.page, 'POST', '/runtime/model-service/configure', { baseUrl: model.base_url, model: model.model, apiKey: model.api_key });
    // 只断言状态，不将含凭据的请求或响应写入测试报告。
    expect(configured.status, configured.body.code).toBe(200);
    expect(configured.body.status).toBe('ready');
    await app.page.reload();
    await waitForEmbeddedRuntimeReady(app.page);
    const project = await runtimeRequest<{ project: { id: string } }>(app.page, 'POST', '/projects', { cwd: fixture.workspace, name: '外部模型验收', sandbox: 'read-only' });
    expect(project.status).toBe(201);
    const thread = await runtimeRequest<{ thread: { id: string } }>(app.page, 'POST', '/threads', { projectId: project.body.project.id, title: '外部模型验收', sandbox: 'read-only' });
    expect(thread.status).toBe(201);
    await app.page.evaluate(id => { window.location.hash = `#/thread/${encodeURIComponent(id)}`; }, thread.body.thread.id);
    const run = await runtimeRequest<{ id: string }>(app.page, 'POST', '/runs', { threadId: thread.body.thread.id, prompt: 'Reply with exactly CLAWEE-REAL-MODEL-OK. Do not call any tools.' });
    expect(run.status).toBe(202);
    await expect.poll(async () => (await runtimeRequest<{ status: string }>(app!.page, 'GET', `/runs/${run.body.id}`)).body.status, { timeout: 150_000 }).toBe('succeeded');
    await expect(app.page.getByText('CLAWEE-REAL-MODEL-OK', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  } finally {
    if (app) await closePackagedApp(app);
    await fixture.dispose();
  }
});
