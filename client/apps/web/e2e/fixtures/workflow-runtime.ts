import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelAccessState } from '@clawee/protocol';
import { test as runtimeTest, expect } from './runtime.js';
import {
  ControlledWorkflowGateway,
  workflowAccount,
  workflowPassword
} from '../support/workflow-gateway.js';

export const test = runtimeTest.extend<{ workflowGateway: ControlledWorkflowGateway; workflowModelConfigured: boolean }>({
  workflowModelConfigured: [true, { option: true }],
  workflowGateway: async ({ runtime, workflowModelConfigured }, use, testInfo) => {
    const gateway = new ControlledWorkflowGateway(workflowModelConfigured);
    const origin = await gateway.start();
    let modelAccess: ModelAccessState | undefined;
    try {
      await runtime.api('POST', '/enterprise/logout');
      await runtime.api('POST', '/enterprise/gateway', { gateway: origin });
      const session = await runtime.api<{
        status: string;
        account?: { subjectId: string };
        agentId?: string;
      }>('POST', '/enterprise/login', { email: workflowAccount.email, password: workflowPassword });
      expect(session.status).toBe('signed_in');
      expect(session.account?.subjectId).toBe(workflowAccount.account_id);
      expect(session.agentId).toMatch(/^clawee_/);
      await expect.poll(async () => {
        modelAccess = await runtime.api<ModelAccessState>('GET', '/runtime/model-service');
        return modelAccess.status;
      }).toBe(workflowModelConfigured ? 'ready' : 'configuration_required');
      if (!workflowModelConfigured) expect(modelAccess).toEqual({ status: 'configuration_required', mode: 'enterprise_managed' });
      await use(gateway);
    } finally {
      gateway.setOffline(false);
      const logDir = '/tmp/clawee-t03-repair-20261009';
      mkdirSync(logDir, { recursive: true });
      const testId = createHash('sha256').update(`${testInfo.project.name}:${testInfo.title}:${testInfo.retry}`).digest('hex').slice(0, 12);
      const path = join(logDir, `d-full-workflow-e2e-${testId}-${Date.now()}.json`);
      writeFileSync(path, `${JSON.stringify({
        test: testInfo.title,
        project: testInfo.project.name,
        status: testInfo.status,
        modelConfigured: workflowModelConfigured,
        modelAccess,
        annotations: testInfo.annotations,
        evidenceBoundary: '真实本地 daemon 与共享 Web，受控模拟 Gateway；不代表真实 Go／DB 联调',
        startRequests: gateway.startRequests,
        instances: gateway.instances,
        unexpectedRequests: gateway.unexpectedRequests,
        modelInvocations: runtime.readInvocationCount()
      }, null, 2)}\n`);
      await testInfo.attach('受控工作流证据', { path, contentType: 'application/json' });
      await runtime.apiResult('POST', '/enterprise/logout').catch(() => undefined);
      await gateway.close();
    }
  },
  browserGuard: async ({ page, runtime }, use, testInfo) => {
    const pageErrors: string[] = [];
    const consoleErrors: Array<{ text: string; url: string }> = [];
    const httpErrors: Array<{ status: number; method: string; url: string }> = [];
    const createFailures: Array<{ method: string; url: string; requestId: unknown; error: string | undefined }> = [];
    const createUrl = `${runtime.origin}/.clawee/runtime/schedules`;
    page.on('pageerror', error => {
      if (!error.message.includes("document is sandboxed and lacks the 'allow-same-origin' flag")) pageErrors.push(error.message);
    });
    page.on('console', message => {
      if (message.type() !== 'error') return;
      if (message.text().includes("Blocked script execution in 'about:srcdoc'") && message.text().includes("'allow-scripts'")) return;
      consoleErrors.push({ text: message.text(), url: message.location().url });
    });
    page.on('response', response => {
      if (response.status() >= 500) httpErrors.push({ status: response.status(), method: response.request().method(), url: response.url() });
    });
    page.on('requestfailed', request => {
      if (request.method() !== 'POST' || request.url() !== createUrl) return;
      createFailures.push({
        method: request.method(), url: request.url(),
        requestId: (request.postDataJSON() as Record<string, unknown> | null)?.requestId,
        error: request.failure()?.errorText
      });
    });
    await use();
    const expectedUrls = testInfo.annotations
      .filter(annotation => annotation.type === 't03-expected-run-now-503')
      .map(annotation => `${runtime.origin}/.clawee/runtime/schedules/${annotation.description}/run-now`);
    const expectedCreateFailures = testInfo.annotations.filter(annotation => annotation.type === 't03-expected-create-response-lost');
    const logDir = '/tmp/clawee-t03-repair-20261009';
    mkdirSync(logDir, { recursive: true });
    const testId = createHash('sha256').update(`${testInfo.project.name}:${testInfo.title}:${testInfo.retry}`).digest('hex').slice(0, 12);
    const path = join(logDir, `d-full-browser-${testId}-${Date.now()}.json`);
    writeFileSync(path, `${JSON.stringify({ expectedUrls, expectedCreateFailures, pageErrors, consoleErrors, httpErrors, createFailures }, null, 2)}\n`);
    await testInfo.attach('T03 浏览器错误核对', { path, contentType: 'application/json' });
    expect(expectedCreateFailures.length, '仅可声明单个主动丢失的创建响应').toBeLessThanOrEqual(1);
    for (const failure of expectedCreateFailures) expect(failure.description).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(createFailures, '仅允许指定 requestId 的创建响应被主动丢失一次').toEqual(expectedCreateFailures.map(failure => ({
      method: 'POST', url: createUrl, requestId: failure.description, error: 'net::ERR_FAILED'
    })));
    expect(pageErrors, '不允许未处理的页面异常').toEqual([]);
    expect(httpErrors, '仅允许明确声明的一次工作流发起 503').toEqual(expectedUrls.map(url => ({ status: 503, method: 'POST', url })));
    expect(consoleErrors, '仅允许明确声明的发起 503 或单个创建响应丢失提示').toEqual([...expectedUrls.map(url => ({
      text: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)', url
    })), ...expectedCreateFailures.map(() => ({ text: 'Failed to load resource: net::ERR_FAILED', url: createUrl }))]);
  }
});

export { expect };
