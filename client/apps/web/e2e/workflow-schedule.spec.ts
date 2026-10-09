import type { Locator, Page } from '@playwright/test';
import type { RunScheduleNowResponse, ScheduleListResponse, ScheduleOperationListResponse, ScheduleResponse } from '@clawee/protocol';
import { test, expect } from './fixtures/workflow-runtime.js';
import type { RuntimeFixture } from './fixtures/runtime.js';
import { otherWorkflowAccount, workflowAccount, workflowPassword, workflowTemplate } from './support/workflow-gateway.js';

test('T03 受控 Gateway：真实 UI 创建、立即发起、查看记录和实例、启停及删除，不执行模型', async ({ page, runtime, workflowGateway }) => {
  await openWorkflow(page, runtime);
  const invocationCount = runtime.readInvocationCount();
  const schedule = await createWorkflowPlan(page, runtime, 'T03 本机立即发起');
  const detail = planDetail(page);
  const response = page.waitForResponse(result => result.url().endsWith(`/schedules/${schedule.id}/run-now`) && result.request().method() === 'POST');
  await detail.getByRole('button', { name: '立即发起', exact: true }).click();
  const result = await (await response).json() as RunScheduleNowResponse;
  expect(result.run).toBeNull();
  expect(result.workflowInstanceId).toBeTruthy();
  await expect.poll(() => workflowGateway.instances.length).toBe(1);
  expect(workflowGateway.instances[0]?.tasks).toHaveLength(1);
  expect(workflowGateway.instances[0]?.tasks[0]?.status).toBe('pending');
  expect(workflowGateway.startRequests[0]).toMatchObject({
    subjectId: workflowAccount.account_id,
    initialInput: { text: 'T03 UI 初始输入' }
  });
  await assertOperation(runtime, schedule.id, result.workflowInstanceId!);
  await expect(detail.getByRole('heading', { name: '触发记录', exact: true })).toBeVisible();
  await expect(detail.getByText(`触发：${result.triggerId}`, { exact: true }).first()).toBeVisible();
  await detail.getByRole('button', { name: '查看关联实例', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: `实例 ${result.workflowInstanceId}`, exact: true })).toBeVisible();
  await expect(page.getByText('生成待审核材料', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('待执行', { exact: true })).toBeVisible();
  await expect(page.getByText('未执行', { exact: true })).toBeVisible();
  await openWorkflow(page, runtime);
  await openPlans(page);
  await planButton(page, schedule.name).click();
  await detail.getByRole('button', { name: '暂停计划', exact: true }).click();
  await expect.poll(async () => (await runtime.api<ScheduleResponse>('GET', `/schedules/${schedule.id}`)).enabled).toBe(false);
  await detail.getByRole('button', { name: '启用计划', exact: true }).click();
  await expect.poll(async () => (await runtime.api<ScheduleResponse>('GET', `/schedules/${schedule.id}`)).enabled).toBe(true);
  await detail.getByRole('button', { name: '删除计划', exact: true }).click();
  await detail.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(planButton(page, schedule.name)).toHaveCount(0);
  expect((await runtime.apiResult('GET', `/schedules/${schedule.id}`)).status).toBe(404);
  expect(runtime.readInvocationCount()).toBe(invocationCount);
  expect(workflowGateway.unexpectedRequests).toEqual([]);
});

test('T03 受控 Gateway：本机短 Cron 到点发起仅创建待办，暂停后不再触发', async ({ page, runtime, workflowGateway }) => {
  await openWorkflow(page, runtime);
  const invocationCount = runtime.readInvocationCount();
  const schedule = await createWorkflowPlan(page, runtime, 'T03 本机 Cron 发起', '*/5 * * * * *');
  await expect.poll(() => workflowGateway.instances.length, { timeout: 20_000, intervals: [100, 250, 500] }).toBeGreaterThan(0);
  await page.getByRole('button', { name: '定时计划', exact: true }).click();
  await planButton(page, schedule.name).click();
  await planDetail(page).getByRole('button', { name: '暂停计划', exact: true }).click();
  await expect.poll(async () => (await runtime.api<ScheduleResponse>('GET', `/schedules/${schedule.id}`)).enabled).toBe(false);
  const count = workflowGateway.instances.length;
  await assertOperation(runtime, schedule.id, workflowGateway.instances[0]!.id);
  await page.getByRole('button', { name: '刷新计划与记录', exact: true }).click();
  await expect(planDetail(page).getByRole('button', { name: '查看关联实例', exact: true }).first()).toBeVisible();
  const keyCount = new Set(workflowGateway.startRequests.map(request => request.key)).size;
  expect(keyCount).toBe(count);
  expect(workflowGateway.instances.every(instance => instance.tasks.length === 1 && instance.tasks[0]?.status === 'pending')).toBe(true);
  const nextBoundary = Math.ceil(Date.now() / 5000) * 5000 + 1000;
  await expect.poll(() => Date.now(), { timeout: 8000, intervals: [250] }).toBeGreaterThanOrEqual(nextBoundary);
  expect(workflowGateway.instances).toHaveLength(count);
  expect(runtime.readInvocationCount()).toBe(invocationCount);
  expect(workflowGateway.unexpectedRequests).toEqual([]);
});

test('T03 受控 Gateway：发起已接受但响应中断，UI 重试使用原 key 和输入，不重复实例', async ({ page, runtime, workflowGateway }) => {
  await openWorkflow(page, runtime);
  const invocationCount = runtime.readInvocationCount();
  const schedule = await createWorkflowPlan(page, runtime, 'T03 未知结果重试');
  workflowGateway.loseNextStartResponse();
  test.info().annotations.push({ type: 't03-expected-run-now-503', description: schedule.id });
  const unavailableResponse = page.waitForResponse(result => result.url().endsWith(`/schedules/${schedule.id}/run-now`) && result.request().method() === 'POST');
  await planDetail(page).getByRole('button', { name: '立即发起', exact: true }).click();
  expect((await unavailableResponse).status()).toBe(503);
  await expect.poll(() => workflowGateway.instances.length).toBe(1);
  await expect(planDetail(page).getByRole('button', { name: '重试原触发', exact: true })).toBeVisible();
  const first = workflowGateway.startRequests[0]!;
  const operations = await runtime.api<ScheduleOperationListResponse>('GET', `/schedules/${schedule.id}/operations`);
  const triggerId = operations.operations.find(operation => operation.status === 'failed')?.triggerId;
  expect(triggerId).toBeTruthy();
  const retryResponse = page.waitForResponse(result => result.url().endsWith(`/schedules/${schedule.id}/run-now`) && result.request().method() === 'POST');
  await planDetail(page).getByRole('button', { name: '重试原触发', exact: true }).click();
  expect((await retryResponse).request().postDataJSON()).toEqual({ triggerId });
  await expect.poll(() => workflowGateway.startRequests.length).toBe(2);
  expect(workflowGateway.startRequests[1]).toEqual(first);
  expect(workflowGateway.instances).toHaveLength(1);
  await assertOperation(runtime, schedule.id, workflowGateway.instances[0]!.id);
  await expect(planDetail(page).getByRole('button', { name: '查看关联实例', exact: true })).toBeVisible();
  await expect(planDetail(page).getByRole('button', { name: '重试原触发', exact: true })).toHaveCount(0);
  expect(runtime.readInvocationCount()).toBe(invocationCount);
  expect(workflowGateway.unexpectedRequests).toEqual([]);
});

test('T03 受控 Gateway：Gateway 断线记录失败，恢复后 UI 重试仍不执行模型', async ({ page, runtime, workflowGateway }) => {
  await openWorkflow(page, runtime);
  const invocationCount = runtime.readInvocationCount();
  const schedule = await createWorkflowPlan(page, runtime, 'T03 断线后重试');
  workflowGateway.setOffline(true);
  test.info().annotations.push({ type: 't03-expected-run-now-503', description: schedule.id });
  const unavailableResponse = page.waitForResponse(result => result.url().endsWith(`/schedules/${schedule.id}/run-now`) && result.request().method() === 'POST');
  await planDetail(page).getByRole('button', { name: '立即发起', exact: true }).click();
  expect((await unavailableResponse).status()).toBe(503);
  await expect.poll(async () => {
    const result = await runtime.api<ScheduleOperationListResponse>('GET', `/schedules/${schedule.id}/operations`);
    return result.operations.some(operation => operation.status === 'failed' && Boolean(operation.triggerId));
  }).toBe(true);
  expect(workflowGateway.instances).toHaveLength(0);
  await expect(planDetail(page).getByRole('button', { name: '重试原触发', exact: true })).toBeVisible();
  workflowGateway.setOffline(false);
  await planDetail(page).getByRole('button', { name: '重试原触发', exact: true }).click();
  await expect.poll(() => workflowGateway.instances.length).toBe(1);
  await assertOperation(runtime, schedule.id, workflowGateway.instances[0]!.id);
  expect(runtime.readInvocationCount()).toBe(invocationCount);
  expect(workflowGateway.unexpectedRequests).toEqual([]);
});

test('T03 受控 Gateway：切换账号后不展示或接管前账号计划，原账号重新登录可恢复', async ({ page, runtime, workflowGateway }) => {
  await openWorkflow(page, runtime);
  const invocationCount = runtime.readInvocationCount();
  const schedule = await createWorkflowPlan(page, runtime, 'T03 归属账户计划');
  await runtime.api('POST', '/enterprise/logout');
  await runtime.api('POST', '/enterprise/login', { email: otherWorkflowAccount.email, password: workflowPassword });
  await page.reload();
  await expect(page.getByRole('heading', { name: '工作流', exact: true })).toBeVisible();
  await openPlans(page);
  await expect(planButton(page, schedule.name)).toHaveCount(0);
  const list = await runtime.api<ScheduleListResponse>('GET', '/schedules');
  expect(list.schedules.some(item => item.id === schedule.id)).toBe(false);
  for (const [method, path, body] of [
    ['GET', `/schedules/${schedule.id}`, undefined],
    ['GET', `/schedules/${schedule.id}/operations`, undefined],
    ['PATCH', `/schedules/${schedule.id}`, { name: '其他账号不应可修改' }],
    ['POST', `/schedules/${schedule.id}/run-now`, undefined],
    ['DELETE', `/schedules/${schedule.id}`, undefined]
  ] as const) {
    expect([401, 403, 404]).toContain((await runtime.apiResult(method, path, body)).status);
  }
  expect(workflowGateway.startRequests).toHaveLength(0);
  await runtime.api('POST', '/enterprise/logout');
  await runtime.api('POST', '/enterprise/login', { email: workflowAccount.email, password: workflowPassword });
  await page.reload();
  await openPlans(page);
  await expect(planButton(page, schedule.name)).toBeVisible();
  expect((await runtime.api<ScheduleResponse>('GET', `/schedules/${schedule.id}`)).name).toBe(schedule.name);
  expect(runtime.readInvocationCount()).toBe(invocationCount);
  expect(workflowGateway.unexpectedRequests).toEqual([]);
});

test('T03-R1 受控 Gateway：创建响应丢失后真实 UI 以原 requestId 和内容重试，仅持久化一个计划', async ({ page, runtime, workflowGateway }) => {
  await openWorkflow(page, runtime);
  const name = 'T03 创建响应丢失重试';
  const form = await fillWorkflowPlan(page, name);
  const createUrl = `${runtime.origin}/.clawee/runtime/schedules`;
  const bodies: string[] = [];
  let persisted: ScheduleResponse | undefined;
  await page.route(createUrl, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const body = route.request().postData();
    expect(body).not.toBeNull();
    bodies.push(body!);
    if (bodies.length !== 1) { await route.continue(); return; }
    const original = await route.fetch();
    expect(original.status()).toBe(201);
    persisted = await original.json() as ScheduleResponse;
    const request = JSON.parse(body!) as Record<string, unknown>;
    expect(request.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    test.info().annotations.push({ type: 't03-expected-create-response-lost', description: request.requestId as string });
    await route.abort('failed');
  });
  try {
    await form.getByRole('button', { name: '保存计划', exact: true }).click();
    await expect.poll(() => persisted?.id).toBeTruthy();
    expect(persisted).toMatchObject({ name, action: 'workflow_start', threadId: null, enabled: true });
    const beforeRetry = await runtime.api<ScheduleListResponse>('GET', '/schedules?action=workflow_start');
    expect(beforeRetry.schedules.filter(item => item.name === name)).toEqual([persisted]);
    await expect(page.getByRole('region', { name: '本机工作流计划', exact: true })).toContainText(/结果未知|尚未确认/);
    for (const label of ['计划名称', 'Cron', '时区']) await expect(form.getByLabel(label, { exact: true })).toBeDisabled();
    await expect(form.getByRole('textbox', { name: '初始输入（JSON 对象）', exact: true })).toBeDisabled();
    await expect(form.getByRole('checkbox', { name: '启用计划', exact: true })).toBeDisabled();
    const retryResponse = page.waitForResponse(result => result.url() === createUrl && result.request().method() === 'POST');
    await form.getByRole('button', { name: '重试创建计划', exact: true }).click();
    const retried = await retryResponse;
    expect(retried.status()).toBe(201);
    expect((await retried.json() as ScheduleResponse).id).toBe(persisted!.id);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    await expect(planButton(page, name)).toHaveCount(1);
    await expect(planDetail(page).getByRole('heading', { name, exact: true })).toBeVisible();
    const afterRetry = await runtime.api<ScheduleListResponse>('GET', '/schedules?action=workflow_start');
    expect(afterRetry.schedules.filter(item => item.name === name).map(item => item.id)).toEqual([persisted!.id]);
    const operations = await runtime.api<ScheduleOperationListResponse>('GET', `/schedules/${persisted!.id}/operations`);
    expect(operations.operations.filter(operation => operation.operation === 'create')).toHaveLength(1);
    expect(operations.operations.find(operation => operation.operation === 'create')?.status).toBe('succeeded');
    await test.info().attach('R1 原创建请求与重试证据', {
      body: Buffer.from(JSON.stringify({ bodies: bodies.map(body => JSON.parse(body)), persisted, afterRetry, operations }, null, 2)),
      contentType: 'application/json'
    });
    expect(workflowGateway.instances).toHaveLength(0);
    expect(workflowGateway.startRequests).toHaveLength(0);
    expect(runtime.readInvocationCount()).toBe(0);
    expect(workflowGateway.unexpectedRequests).toEqual([]);
  } finally {
    await page.unroute(createUrl);
  }
});

test.describe('QA-MG01 无模型工作流入口', () => {
  test.use({ workflowModelConfigured: false });

  test('T03 受控 Gateway：模型未配置仍可在真实 UI 创建并发起计划，Agent 门禁保持且可回模型设置', async ({ page, runtime, workflowGateway }) => {
    expect(await runtime.api('GET', '/runtime/model-service')).toEqual({ status: 'configuration_required', mode: 'enterprise_managed' });
    const session = await runtime.api<{ status: string; account?: { subjectId: string } }>('GET', '/enterprise/session');
    expect(session).toMatchObject({ status: 'signed_in', account: { subjectId: workflowAccount.account_id } });
    expect(runtime.readInvocationCount()).toBe(0);
    await page.goto(runtime.origin);
    if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible()) {
      await page.getByRole('button', { name: '打开导航', exact: true }).click();
    }
    await page.getByRole('button', { name: '进入工作流（无需模型）', exact: true }).click();
    await expect(page.getByRole('heading', { name: '工作流', exact: true })).toBeVisible();
    const schedule = await createWorkflowPlan(page, runtime, 'T03 无模型本机发起');
    const response = page.waitForResponse(result => result.url().endsWith(`/schedules/${schedule.id}/run-now`) && result.request().method() === 'POST');
    await planDetail(page).getByRole('button', { name: '立即发起', exact: true }).click();
    const started = await response;
    expect(started.status()).toBe(202);
    const result = await started.json() as RunScheduleNowResponse;
    expect(result.run).toBeNull();
    expect(result.workflowInstanceId).toBeTruthy();
    await expect.poll(() => workflowGateway.instances.length).toBe(1);
    await assertOperation(runtime, schedule.id, result.workflowInstanceId!);
    await planDetail(page).getByRole('button', { name: '查看最近实例', exact: true }).click();
    await expect(page.getByRole('heading', { name: `实例 ${result.workflowInstanceId}`, exact: true })).toBeVisible();
    await expect(page.getByText('待执行', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(发起 Agent 执行|重试 Agent 执行)$/ })).toHaveCount(0);
    expect(await runtime.api('GET', '/enterprise/workflow-capability')).toEqual({ canExecute: false });
    const taskId = workflowGateway.instances[0]!.tasks[0]!.task_id;
    for (const action of ['prepare', 'execute'] as const) {
      const body = action === 'prepare' ? { projectId: runtime.projectId } : {
        projectId: runtime.projectId, threadId: runtime.ordinaryThreadId, customInput: '无模型时不得执行'
      };
      const blocked = await runtime.apiResult('POST', `/enterprise/workflow-tasks/${taskId}/${action}`, body);
      expect(blocked.status).toBe(428);
      expect(blocked.body).toMatchObject({ error: { code: 'MODEL_SERVICE_CONFIGURATION_REQUIRED' } });
    }
    const ordinaryRun = await runtime.apiResult('POST', '/runs', {
      threadId: runtime.ordinaryThreadId, prompt: '无模型时不得执行', cwd: runtime.projectDir,
      profile: 'default', sandbox: 'workspace-write'
    });
    expect(ordinaryRun.status).toBe(428);
    expect(ordinaryRun.body).toMatchObject({ error: { code: 'MODEL_SERVICE_CONFIGURATION_REQUIRED' } });
    await page.getByRole('button', { name: '返回模型设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '配置 Codex 模型服务', exact: true })).toBeVisible();
    await expect(page.getByLabel('API Key', { exact: true })).toBeVisible();
    expect(runtime.readInvocationCount()).toBe(0);
    expect(workflowGateway.instances[0]!.tasks[0]!.status).toBe('pending');
    expect(workflowGateway.unexpectedRequests).toEqual([]);
  });
  test('T03-R2 受控 Gateway：真实 Gateway origin 响应延迟时不能变更，身份稳定后 UI 发起成功且不执行模型', async ({ page, runtime, workflowGateway }) => {
    const configuration = await runtime.api<{ gateway: string }>('GET', '/enterprise/gateway');
    const session = await runtime.api<{ agentId: string }>('GET', '/enterprise/session');
    const gatewayUrl = `${runtime.origin}/.clawee/runtime/enterprise/gateway`;
    const mutations: Array<{ method: string; url: string; body: unknown }> = [];
    const delayedConfigurations: unknown[] = [];
    let releaseGateway!: () => void;
    const gatewayRelease = new Promise<void>(resolve => { releaseGateway = resolve; });
    page.on('request', request => {
      if (['GET', 'HEAD'].includes(request.method())) return;
      if (!request.url().startsWith(`${runtime.origin}/.clawee/runtime/`)) return;
      const path = new URL(request.url()).pathname;
      if (!/\/(schedules|enterprise\/workflow-(templates|instances|tasks))(\/|$)/.test(path)) return;
      mutations.push({ method: request.method(), url: request.url(), body: request.postDataJSON() });
    });
    await page.route(gatewayUrl, async route => {
      if (route.request().method() !== 'GET') { await route.continue(); return; }
      const actual = await route.fetch();
      expect(actual.status()).toBe(200);
      const body = await actual.json() as { gateway: string };
      expect(new URL(body.gateway).origin).toBe(new URL(configuration.gateway).origin);
      delayedConfigurations.push(body);
      await gatewayRelease;
      await route.fulfill({ response: actual });
    });
    try {
      await page.goto(runtime.origin);
      await expect.poll(() => delayedConfigurations.length).toBeGreaterThan(0);
      const entry = page.getByRole('button', { name: '进入工作流（无需模型）', exact: true });
      await expect(entry).toBeVisible();
      const entered = await entry.isEnabled();
      if (entered) await entry.click();
      else await expect(entry).toBeDisabled();
      await expect(page.getByRole('status').filter({ hasText: '正在确认工作流身份，请稍候' })).toHaveText('正在确认工作流身份，请稍候');
      for (const name of ['创建定时计划', '保存计划', '立即发起', '发起任务', '重试发起', '批准', '驳回', '暂停计划', '启用计划', '删除计划', '重试原触发', '发起 Agent 执行', '重试 Agent 执行']) {
        for (const button of await page.getByRole('button', { name, exact: true }).all()) {
          if (await button.isVisible()) await expect(button).toBeDisabled();
        }
      }
      expect(mutations).toEqual([]);
      expect(workflowGateway.startRequests).toHaveLength(0);
      expect(workflowGateway.instances).toHaveLength(0);
      const mutationsWhileOriginPending = [...mutations];
      const stableResponse = page.waitForResponse(result => result.url() === gatewayUrl && result.request().method() === 'GET');
      releaseGateway();
      expect((await stableResponse).status()).toBe(200);
      if (!entered) await entry.click();
      await expect(page.getByRole('heading', { name: '工作流', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '模板', exact: true }).click();
      await page.getByRole('button', { name: new RegExp(workflowTemplate.name) }).click();
      await page.getByRole('textbox', { name: '任务要求', exact: true }).fill('T03 origin 稳定后的首次发起');
      const startUrl = `${runtime.origin}/.clawee/runtime/enterprise/workflow-templates/${workflowTemplate.id}/instances`;
      const startResponse = page.waitForResponse(result => result.url() === startUrl && result.request().method() === 'POST');
      await page.getByRole('button', { name: '发起任务', exact: true }).click();
      const started = await startResponse;
      expect(started.status()).toBe(200);
      const result = await started.json() as { data: { instance_id: string } };
      await expect(page.getByRole('heading', { name: `实例 ${result.data.instance_id}`, exact: true })).toBeVisible();
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.url).toBe(startUrl);
      expect(workflowGateway.startRequests).toHaveLength(1);
      expect(workflowGateway.startRequests[0]).toMatchObject({
        subjectId: workflowAccount.account_id, agentId: session.agentId,
        initialInput: { text: 'T03 origin 稳定后的首次发起' },
        key: (started.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey
      });
      expect(workflowGateway.instances).toHaveLength(1);
      expect(workflowGateway.instances[0]!.tasks).toHaveLength(1);
      expect(workflowGateway.instances[0]!.tasks[0]!.status).toBe('pending');
      await test.info().attach('R2 真实 origin 延迟与稳定后变更证据', {
        body: Buffer.from(JSON.stringify({ gatewayUrl, delayedConfigurations, mutationsWhileOriginPending, mutations }, null, 2)),
        contentType: 'application/json'
      });
      expect(runtime.readInvocationCount()).toBe(0);
      expect(workflowGateway.unexpectedRequests).toEqual([]);
    } finally {
      releaseGateway();
      await page.unroute(gatewayUrl);
    }
  });
});

async function openWorkflow(page: Page, runtime: RuntimeFixture): Promise<void> {
  await runtime.openApp(page);
  await expect.poll(async () => await page.getByRole('button', { name: '打开导航', exact: true }).isVisible()
    || await page.getByRole('button', { name: '工作流', exact: true }).isVisible()).toBe(true);
  if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible()) {
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
  }
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  await expect(page.getByRole('heading', { name: '工作流', exact: true })).toBeVisible();
}

async function createWorkflowPlan(page: Page, runtime: RuntimeFixture, name: string, cron = '0 0 1 1 *'): Promise<ScheduleResponse> {
  const form = await fillWorkflowPlan(page, name, cron);
  const response = page.waitForResponse(result => result.url().endsWith('/schedules') && result.request().method() === 'POST');
  await form.getByRole('button', { name: '保存计划', exact: true }).click();
  const creation = await response;
  expect(creation.status()).toBe(201);
  expect((creation.request().postDataJSON() as Record<string, unknown>).requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const schedule = await creation.json() as ScheduleResponse;
  expect(schedule).toMatchObject({ action: 'workflow_start', threadId: null, name, cron, timezone: 'Asia/Shanghai', workflow: { templateId: workflowTemplate.id, initialInput: { text: 'T03 UI 初始输入' } } });
  await expect(planButton(page, name)).toBeVisible();
  await expect(planDetail(page).getByRole('heading', { name, exact: true })).toBeVisible();
  const list = await runtime.api<ScheduleListResponse>('GET', '/schedules');
  expect(list.schedules.find(item => item.id === schedule.id)?.threadId).toBeNull();
  return schedule;
}

async function fillWorkflowPlan(page: Page, name: string, cron = '0 0 1 1 *'): Promise<Locator> {
  await page.getByRole('button', { name: '模板', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(workflowTemplate.name) }).click();
  await page.getByRole('button', { name: '创建定时计划', exact: true }).click();
  const form = page.getByRole('form', { name: '创建工作流定时计划', exact: true });
  await form.getByLabel('计划名称', { exact: true }).fill(name);
  await form.getByLabel('Cron', { exact: true }).fill(cron);
  await form.getByLabel('时区', { exact: true }).fill('Asia/Shanghai');
  await form.getByRole('textbox', { name: '初始输入（JSON 对象）', exact: true }).fill(JSON.stringify({ text: 'T03 UI 初始输入' }));
  return form;
}

function planButton(page: Page, name: string): Locator {
  return page.getByRole('region', { name: '工作流计划列表', exact: true }).getByRole('button').filter({ has: page.getByText(name, { exact: true }) });
}

function planDetail(page: Page): Locator {
  return page.getByRole('region', { name: '工作流计划详情', exact: true });
}

async function openPlans(page: Page): Promise<void> {
  const response = page.waitForResponse(result => new URL(result.url()).pathname.endsWith('/schedules') && result.request().method() === 'GET');
  await page.getByRole('button', { name: '定时计划', exact: true }).click();
  const listed = await response;
  expect(listed.status()).toBe(200);
  expect(new URL(listed.url()).searchParams.get('action')).toBe('workflow_start');
  await expect(page.getByRole('region', { name: '本机工作流计划', exact: true })).toBeVisible();
}

async function assertOperation(runtime: RuntimeFixture, scheduleId: string, instanceId: string): Promise<void> {
  await expect.poll(async () => {
    const result = await runtime.api<ScheduleOperationListResponse>('GET', `/schedules/${scheduleId}/operations`);
    return result.operations.some(operation => operation.status === 'succeeded' && operation.workflowInstanceId === instanceId && Boolean(operation.triggerId) && !operation.runId);
  }).toBe(true);
}
