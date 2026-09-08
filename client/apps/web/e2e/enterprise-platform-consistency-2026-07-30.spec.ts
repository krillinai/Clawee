import type { Browser, Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures/runtime.js';
import {
  FakeEnterpriseDaemon,
  type FakeEnterpriseRequest,
  type FakeEnterpriseState
} from './support/fake-enterprise-daemon-2026-07-30.js';

type Platform = 'browser' | 'desktop';

type Checkpoint = {
  text: string;
  boxes: Record<string, {
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  screenshot: Buffer;
};

type PlatformResult = {
  checkpoints: Record<string, Checkpoint>;
  requests: FakeEnterpriseRequest[];
  state: FakeEnterpriseState;
  runtimeStatus: unknown;
  nativeDirectorySelections: number;
  unknownRequests: string[];
};

test('未勾选协议时 Browser/Desktop 登录均先确认再提交', async ({
  browser,
  runtime
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    '一致性规格内部固定创建 Browser/Desktop Chromium 上下文'
  );

  const fakeDaemon = new FakeEnterpriseDaemon();
  const loginRequests: FakeEnterpriseRequest[][] = [];

  for (const platform of ['browser', 'desktop'] satisfies Platform[]) {
    fakeDaemon.reset();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce'
    });
    const page = await context.newPage();
    await fakeDaemon.attach(page);
    await installPlatformEnvironment(page, platform);

    try {
      await page.goto(runtime.origin);
      await expect(page.getByRole('heading', { name: '欢迎使用 Clawee' })).toBeVisible();

      const submit = page.locator('.enterprise-email-submit');
      await expect(submit).toBeDisabled();
      await page.getByLabel('邮箱').fill('member@example.com');
      await expect(submit).toBeDisabled();
      await page.getByLabel('密码').fill('password-123');
      await expect(submit).toBeEnabled();
      await submit.click();
      const dialog = page.getByRole('alertdialog', { name: '服务协议及隐私政策' });
      await expect(dialog).toBeVisible();
      await expect(page.getByRole('checkbox')).not.toBeChecked();
      expect(fakeDaemon.requestLog().filter(request => (
        request.method === 'POST' && request.path === '/enterprise/login'
      ))).toHaveLength(0);

      await dialog.getByRole('button', { name: '取消' }).click();
      await expect(dialog).toBeHidden();
      await submit.click();
      await dialog.getByRole('button', { name: '同意并继续' }).click();

      await expect(page.getByRole('button', {
        name: 'Enterprise Member',
        exact: true
      })).toBeVisible();
      const submitted = fakeDaemon.requestLog().filter(request => (
        request.method === 'POST' && request.path === '/enterprise/login'
      ));
      expect(submitted).toHaveLength(1);
      loginRequests.push(submitted);
      expect(fakeDaemon.unknownRequestPaths()).toEqual([]);
    } finally {
      await context.close();
    }
  }

  expect(loginRequests[1]).toEqual(loginRequests[0]);
});

test('钉钉系统浏览器登录在 Browser/Desktop Bridge 下使用同一 Runtime 流程', async ({
  browser,
  page: comparisonPage,
  runtime
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    '一致性规格内部固定创建 Browser/Desktop Chromium 上下文'
  );
  const fakeDaemon = new FakeEnterpriseDaemon();
  const results: Array<{
    platform: Platform;
    checkpoint: Checkpoint;
    requests: FakeEnterpriseRequest[];
    openedUrls: string[];
  }> = [];

  for (const platform of ['browser', 'desktop'] satisfies Platform[]) {
    fakeDaemon.reset();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce'
    });
    const page = await context.newPage();
    await fakeDaemon.attach(page);
    await installPlatformEnvironment(page, platform);
    try {
      await page.goto(runtime.origin);
      await expect(page.getByRole('status', { name: '本地运行内核正常' }))
        .toBeVisible();
      const dingTalk = page.getByRole('button', { name: '钉钉登录' });
      await expect.poll(() => fakeDaemon.requestLog().filter(request => (
        request.method === 'POST'
        && request.path === '/enterprise/dingtalk/login/prepare'
      )).length).toBe(0);
      await expect(dingTalk).toBeEnabled();
      const checkpoint = await captureCheckpoint(page, [
        '.enterprise-access-gate',
        '.enterprise-auth-card',
        '.enterprise-dingtalk-action'
      ]);
      await page.getByRole('checkbox').check();
      await dingTalk.click();
      await expect.poll(() => fakeDaemon.requestLog().filter(request => (
        request.method === 'POST'
        && request.path === '/enterprise/dingtalk/login/prepare'
      )).length).toBe(1);
      await expect(page.getByRole('button', { name: '等待钉钉授权' }))
        .toBeDisabled();
      await expect(page.getByText('请在系统浏览器中完成授权')).toBeVisible();

      fakeDaemon.completeDingTalkLogin();
      await expect(page.getByRole('button', {
        name: 'Enterprise Member',
        exact: true
      })).toBeVisible();
      results.push({
        platform,
        checkpoint,
        requests: fakeDaemon.requestLog(),
        openedUrls: await page.evaluate(() => (
          [...((window as Window & {
            __claweeConsistencyExternalUrls?: string[];
          }).__claweeConsistencyExternalUrls ?? [])]
        ))
      });
      expect(fakeDaemon.unknownRequestPaths()).toEqual([]);
    } finally {
      await context.close();
    }
  }

  expect(results[1]!.openedUrls).toEqual(results[0]!.openedUrls);
  expect(results[0]!.openedUrls).toEqual([
    'https://enterprise.example/api/v1/auth/dingtalk/clawee/start?state=prepared'
  ]);
  expect(businessRequestSequence(results[1]!.requests)).toEqual(
    businessRequestSequence(results[0]!.requests)
  );
  for (const result of results) {
    expect(result.requests.filter(request => (
      request.method === 'POST'
      && request.path === '/enterprise/dingtalk/login/prepare'
    ))).toHaveLength(1);
    expect(result.requests.some(request => (
      request.method === 'POST'
      && request.path === '/enterprise/session/refresh'
    ))).toBe(false);
  }
  expect(results[1]!.checkpoint.text).toBe(results[0]!.checkpoint.text);
  expect(results[1]!.checkpoint.boxes).toEqual(results[0]!.checkpoint.boxes);
  const screenshotDifference = await compareScreenshotPixels(
    comparisonPage,
    results[0]!.checkpoint.screenshot,
    results[1]!.checkpoint.screenshot
  );
  expect(screenshotDifference.differentPixels).toBeLessThanOrEqual(50);
  expect(screenshotDifference.maxChannelDelta).toBeLessThanOrEqual(50);
});

test('侧栏通用页面在大视口及 Browser/Desktop Bridge 下保持一致', async ({
  browser,
  page,
  runtime
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    '一致性规格内部固定创建 1280x800 Chromium 上下文'
  );

  const fakeDaemon = new FakeEnterpriseDaemon();
  const browserResult = await runPlatform({
    browser,
    fakeDaemon,
    origin: runtime.origin,
    platform: 'browser',
    testInfo
  });
  const desktopResult = await runPlatform({
    browser,
    fakeDaemon,
    origin: runtime.origin,
    platform: 'desktop',
    testInfo
  });

  expect(browserResult.unknownRequests).toEqual([]);
  expect(desktopResult.unknownRequests).toEqual([]);
  expect(browserResult.state).toEqual({
    session: 'signed_in',
    installed: true,
    mcpInstalled: true,
    mcpEnabled: true,
    createdThread: true,
    uploadedKnowledgeDocument: true,
    savedSharedFile: true
  });
  expect(desktopResult.state).toEqual(browserResult.state);
  expect(desktopResult.runtimeStatus).toEqual(browserResult.runtimeStatus);
  expect(browserResult.runtimeStatus).toMatchObject({
    runtime: {
      runtimeId: 'codex-rust-v0.146.0-layout-1',
      source: 'embedded-package',
      version: '0.146.0',
      activationState: 'committed'
    }
  });
  expect(commonRequestInventory(desktopResult.requests)).toEqual(
    commonRequestInventory(browserResult.requests)
  );
  expect(businessRequestSequence(desktopResult.requests)).toEqual(
    businessRequestSequence(browserResult.requests)
  );
  expect(browserResult.nativeDirectorySelections).toBe(1);
  expect(desktopResult.nativeDirectorySelections).toBe(1);

  for (const checkpointName of Object.keys(browserResult.checkpoints)) {
    const browserCheckpoint = browserResult.checkpoints[checkpointName]!;
    const desktopCheckpoint = desktopResult.checkpoints[checkpointName]!;
    expect(desktopCheckpoint.text, `${checkpointName} 可见文案`).toBe(browserCheckpoint.text);
    expect(desktopCheckpoint.boxes, `${checkpointName} 关键尺寸`).toEqual(
      browserCheckpoint.boxes
    );
    const screenshotDifference = await compareScreenshotPixels(
      page,
      browserCheckpoint.screenshot,
      desktopCheckpoint.screenshot
    );
    expect(
      screenshotDifference.differentPixels,
      `${checkpointName} 截图差异像素`
    ).toBeLessThanOrEqual(50);
    expect(
      screenshotDifference.maxChannelDelta,
      `${checkpointName} 截图最大通道差值`
    ).toBeLessThanOrEqual(50);
  }
});

test('会话 MCP 快捷开关合并企业展示名且在 Browser/Desktop Bridge 下保持一致', async ({
  browser,
  page: comparisonPage,
  runtime
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    '一致性规格内部固定创建 1280x800 Chromium 上下文'
  );

  const fakeDaemon = new FakeEnterpriseDaemon();
  const nativeMcpName = 'enterprise_crm';
  const enterpriseMcpDisplayName = '客户关系管理';
  const adjacentMcpName = 'node_repl';
  const followingMcpName = 'openaiDeveloperDocs';
  const results: Array<{
    platform: Platform;
    text: string;
    boxes: Record<string, { x: number; y: number; width: number; height: number }>;
    screenshot: Buffer;
    enterpriseMcpRequestsBeforeNavigation: FakeEnterpriseRequest[];
    nativeMcpUpdates: FakeEnterpriseRequest[];
  }> = [];

  for (const platform of ['browser', 'desktop'] satisfies Platform[]) {
    fakeDaemon.reset();
    fakeDaemon.setMcpPreference({ installed: true, enabled: true });
    fakeDaemon.setNativeMcpServers([
      { name: adjacentMcpName, enabled: true },
      { name: followingMcpName, enabled: true }
    ]);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce'
    });
    const page = await context.newPage();
    await fakeDaemon.attach(page);
    await installPlatformEnvironment(page, platform);

    try {
      await page.goto(runtime.origin);
      await loginWithEmail(page);
      await expect(page.getByRole('button', {
        name: 'Enterprise Member',
        exact: true
      })).toBeVisible();
      const connectorIcon = page.getByRole('button', {
        name: `打开连接器列表，${enterpriseMcpDisplayName} MCP`
      });
      await expect(connectorIcon).toBeVisible();
      await connectorIcon.click();
      await expect(page.getByRole('switch', {
        name: `${enterpriseMcpDisplayName} MCP`
      })).toHaveAttribute('aria-checked', 'true');
      const quickSwitches = page.getByRole('group', {
        name: '连接器快捷开关'
      }).getByRole('switch');
      const labelsBeforeToggle = await quickSwitches.evaluateAll(items => (
        items.map(item => item.getAttribute('aria-label'))
      ));
      const adjacentIndex = labelsBeforeToggle.indexOf(`${adjacentMcpName} MCP`);
      expect(adjacentIndex).toBeGreaterThanOrEqual(0);
      await quickSwitches.nth(adjacentIndex).click();
      await expect(page.getByRole('switch', {
        name: `${adjacentMcpName} MCP`
      })).toHaveAttribute('aria-checked', 'false');
      expect(await quickSwitches.evaluateAll(items => (
        items.map(item => item.getAttribute('aria-label'))
      ))).toEqual(labelsBeforeToggle);
      await quickSwitches.nth(adjacentIndex).click();
      await expect(page.getByRole('switch', {
        name: `${adjacentMcpName} MCP`
      })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('switch', {
        name: `${followingMcpName} MCP`
      })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('button', {
        name: '选择更多连接器'
      })).toBeVisible();

      const selectors = [
        '.composer-enabled-connectors',
        '.composer-connector-card',
        '.composer-connector-quick-list'
      ];
      const boxes: Record<string, {
        x: number;
        y: number;
        width: number;
        height: number;
      }> = {};
      for (const selector of selectors) {
        const box = await page.locator(selector).boundingBox();
        expect(box, `缺少连接器目录尺寸目标 ${selector}`).not.toBeNull();
        boxes[selector] = {
          x: Math.round(box!.x),
          y: Math.round(box!.y),
          width: Math.round(box!.width),
          height: Math.round(box!.height)
        };
      }
      const submenu = page.locator('.composer-connector-card');
      const submenuText = normalizeText(await submenu.innerText());
      expect(submenuText).toContain(enterpriseMcpDisplayName);
      const screenshot = await submenu.screenshot({ animations: 'disabled' });
      await testInfo.attach(`${platform}-composer-connector-catalog.png`, {
        body: screenshot,
        contentType: 'image/png'
      });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '添加上下文' }).click();
      await page.getByRole('menuitem', { name: '连接器' }).click();
      await page.getByRole('menuitem', {
        name: new RegExp(`${enterpriseMcpDisplayName}.*已开启`)
      }).click();
      const composer = page.getByRole('textbox', { name: '输入任务' });
      await expect(composer).toHaveValue(
        `使用连接器「${enterpriseMcpDisplayName}」（MCP：${nativeMcpName}） `
      );
      await composer.fill('');
      const enterpriseMcpRequestsBeforeNavigation = fakeDaemon.requestLog().filter(request => (
        request.method === 'GET' && request.path === '/enterprise/mcp'
      ));
      await connectorIcon.click();
      await page.getByRole('button', {
        name: '选择更多连接器'
      }).click();
      await expect(page.getByRole('heading', {
        name: '连接器',
        exact: true
      })).toBeVisible();
      await expect(page).toHaveURL(/#\/connections$/);
      results.push({
        platform,
        text: submenuText,
        boxes,
        screenshot,
        enterpriseMcpRequestsBeforeNavigation,
        nativeMcpUpdates: fakeDaemon.requestLog().filter(request => (
          request.method === 'PATCH'
          && request.path === `/codex/mcp/${adjacentMcpName}`
        ))
      });
    } finally {
      await context.close();
    }
  }

  const browserResult = results.find(result => result.platform === 'browser')!;
  const desktopResult = results.find(result => result.platform === 'desktop')!;
  expect(browserResult.enterpriseMcpRequestsBeforeNavigation.length).toBeGreaterThan(0);
  expect(desktopResult.enterpriseMcpRequestsBeforeNavigation.length).toBeGreaterThan(0);
  expect(browserResult.nativeMcpUpdates).toHaveLength(2);
  expect(desktopResult.nativeMcpUpdates).toEqual(browserResult.nativeMcpUpdates);
  expect(desktopResult.text).toBe(browserResult.text);
  expect(desktopResult.boxes).toEqual(browserResult.boxes);
  const screenshotDifference = await compareScreenshotPixels(
    comparisonPage,
    browserResult.screenshot,
    desktopResult.screenshot
  );
  expect(screenshotDifference.differentPixels).toBeLessThanOrEqual(50);
  expect(screenshotDifference.maxChannelDelta).toBeLessThanOrEqual(50);
});

test('MCP 搜索空态和新增编辑器在 Browser/Desktop Bridge 下保持一致', async ({
  browser,
  page: comparisonPage,
  runtime
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    '一致性规格内部固定创建 1280x800 Chromium 上下文'
  );

  const fakeDaemon = new FakeEnterpriseDaemon();
  const results: Array<{
    platform: Platform;
    text: string;
    boxes: Record<string, { x: number; y: number; width: number; height: number }>;
    screenshot: Buffer;
  }> = [];

  for (const platform of ['browser', 'desktop'] satisfies Platform[]) {
    fakeDaemon.reset();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce'
    });
    const page = await context.newPage();
    await fakeDaemon.attach(page);
    await installPlatformEnvironment(page, platform);

    try {
      await page.goto(`${runtime.origin}/#/account`);
      await loginWithEmail(page);
      await expect(page.getByRole('heading', { name: 'Enterprise Member' }))
        .toBeVisible();
      await page.evaluate(() => {
        window.location.hash = '#/connections';
      });
      await expect(page.getByRole('heading', { name: '连接器' })).toBeVisible();

      const search = page.getByRole('searchbox', { name: '搜索连接器' });
      await search.fill('missing connector');
      await expect(page.getByText('没有找到匹配的 MCP')).toBeVisible();
      await expect(page.getByRole('button', { name: '清除搜索' })).toBeVisible();
      await expect(page.getByRole('button', { name: '新增自定义 MCP' })).toBeVisible();
      await page.getByRole('button', { name: '清除搜索' }).click();
      await expect(page.getByRole('heading', { name: '客户关系管理' })).toBeVisible();

      await page.locator('.connections-toolbar').getByRole('button', {
        name: /已开启/
      }).click();
      await expect(page.getByRole('button', { name: '查看全部' })).toBeVisible();
      await page.getByRole('button', { name: '查看全部' }).click();
      await expect(page.getByRole('heading', { name: '客户关系管理' })).toBeVisible();

      await search.fill('still missing');
      await page.getByRole('button', { name: '新增自定义 MCP' }).click();
      const editor = page.getByRole('form', { name: '新增 MCP' });
      const advanced = editor.locator('.settings-advanced-fields');
      await expect(editor).toBeVisible();
      await expect(editor.getByRole('button', { name: '本机命令' }))
        .toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByText('stdio', { exact: true })).toHaveCount(0);
      await expect(advanced).not.toHaveAttribute('open', '');
      await expect(editor.getByRole('button', { name: '添加变量' })).toBeHidden();

      await editor.getByRole('button', { name: '远程地址' }).click();
      await expect(editor.getByRole('button', { name: '远程地址' }))
        .toHaveAttribute('aria-pressed', 'true');
      await expect(editor.getByLabel('启动命令')).toHaveCount(0);
      await expect(editor.getByLabel('远程 MCP 地址')).toBeVisible();
      await expect(editor.getByLabel('远程协议')).toHaveValue('http');
      await advanced.locator('summary').click();
      await expect(advanced).toHaveAttribute('open', '');
      await editor.getByRole('button', { name: '添加变量' }).click();
      await expect(editor.getByLabel('环境变量名')).toBeVisible();
      await expect(editor.getByLabel('环境变量值')).toBeVisible();

      const selectors = [
        '.connections-page__inner',
        '.connections-empty__actions',
        '.settings-editor',
        '.settings-connection-mode',
        '.settings-editor > .settings-form-grid',
        '.settings-advanced-fields',
        '.settings-env-editor'
      ];
      const boxes: Record<string, {
        x: number;
        y: number;
        width: number;
        height: number;
      }> = {};
      for (const selector of selectors) {
        const box = await page.locator(selector).first().boundingBox();
        expect(box, `缺少 MCP 编辑器尺寸目标 ${selector}`).not.toBeNull();
        boxes[selector] = {
          x: Math.round(box!.x),
          y: Math.round(box!.y),
          width: Math.round(box!.width),
          height: Math.round(box!.height)
        };
      }
      const screenshot = await page.locator('.connections-page__inner').screenshot({
        animations: 'disabled'
      });
      await testInfo.attach(`${platform}-mcp-empty-editor.png`, {
        body: screenshot,
        contentType: 'image/png'
      });
      results.push({
        platform,
        text: normalizeText(await page.locator('.connections-page__inner').innerText()),
        boxes,
        screenshot
      });
      expect(fakeDaemon.unknownRequestPaths()).toEqual([]);
    } finally {
      await context.close();
    }
  }

  const browserResult = results.find(result => result.platform === 'browser')!;
  const desktopResult = results.find(result => result.platform === 'desktop')!;
  expect(desktopResult.text).toBe(browserResult.text);
  expect(desktopResult.boxes).toEqual(browserResult.boxes);
  const screenshotDifference = await compareScreenshotPixels(
    comparisonPage,
    browserResult.screenshot,
    desktopResult.screenshot
  );
  expect(screenshotDifference.differentPixels).toBeLessThanOrEqual(50);
  expect(screenshotDifference.maxChannelDelta).toBeLessThanOrEqual(50);
});

test('会话 MCP 图标直达的连接器快捷开关在 390px 视口下不溢出', async ({
  browser,
  runtime
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    '移动端连接器目录规格固定使用 390x844 Chromium 视口'
  );
  const fakeDaemon = new FakeEnterpriseDaemon();
  const nativeMcpName = 'enterprise_crm';
  const enterpriseMcpDisplayName = '客户关系管理';
  fakeDaemon.reset();
  fakeDaemon.setMcpPreference({ installed: true, enabled: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce'
  });
  const page = await context.newPage();
  await fakeDaemon.attach(page);
  await installPlatformEnvironment(page, 'browser');

  try {
    await page.goto(runtime.origin);
    await loginWithEmail(page);
    await expect(page.getByRole('textbox', { name: '输入任务' })).toBeVisible();
    await page.getByRole('button', {
      name: `打开连接器列表，${enterpriseMcpDisplayName} MCP`
    }).click();
    await expect(page.getByRole('switch', {
      name: `${enterpriseMcpDisplayName} MCP`
    })).toHaveAttribute('aria-checked', 'true');
    expect(fakeDaemon.requestLog().filter(request => (
      request.method === 'GET' && request.path === '/enterprise/mcp'
    )).length).toBeGreaterThan(0);

    const layout = await page.evaluate(() => {
      const submenu = document.querySelector<HTMLElement>('.composer-connector-card')!;
      const list = document.querySelector<HTMLElement>('.composer-connector-quick-list')!;
      const connector = document.querySelector<HTMLElement>('.composer-connector-quick-item')!;
      const title = document.querySelector<HTMLElement>('.composer-connector-quick-name')!;
      const status = document.querySelector<HTMLElement>('.composer-connector-switch')!;
      const rect = (element: HTMLElement) => {
        const value = element.getBoundingClientRect();
        return {
          left: value.left,
          right: value.right,
          top: value.top,
          bottom: value.bottom
        };
      };
      return {
        viewportWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        submenuClientWidth: submenu.clientWidth,
        submenuScrollWidth: submenu.scrollWidth,
        listClientWidth: list.clientWidth,
        listScrollWidth: list.scrollWidth,
        connectorClientWidth: connector.clientWidth,
        connectorScrollWidth: connector.scrollWidth,
        title: rect(title),
        status: rect(status)
      };
    });
    expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.submenuScrollWidth).toBeLessThanOrEqual(layout.submenuClientWidth);
    expect(layout.listScrollWidth).toBeLessThanOrEqual(layout.listClientWidth);
    expect(layout.connectorScrollWidth).toBeLessThanOrEqual(layout.connectorClientWidth);
    expect(rectanglesOverlap(layout.title, layout.status)).toBe(false);

    await testInfo.attach('mobile-composer-connector-catalog.png', {
      body: await page.locator('.composer-connector-card').screenshot({
        animations: 'disabled'
      }),
      contentType: 'image/png'
    });
    expect(fakeDaemon.unknownRequestPaths()).toEqual([]);
  } finally {
    await context.close();
  }
});

test('MCP 搜索空态和新增编辑器在 390px 视口下不溢出或重叠', async ({
  page,
  runtime
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-mobile',
    '移动端 MCP 编辑器规格固定使用 390x844 Chromium 视口'
  );

  const fakeDaemon = new FakeEnterpriseDaemon();
  await fakeDaemon.attach(page);
  await installPlatformEnvironment(page, 'browser');
  await page.goto(`${runtime.origin}/#/account`);
  await loginWithEmail(page);
  await expect(page.getByRole('heading', { name: 'Enterprise Member' })).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = '#/connections';
  });
  await expect(page.getByRole('heading', { name: '连接器' })).toBeVisible();

  await page.locator('.connections-toolbar').getByRole('button', {
    name: /已安装/
  }).click();
  await expect(page.getByRole('button', { name: '查看全部' })).toBeVisible();
  await page.getByRole('button', { name: '查看全部' }).click();

  const search = page.getByRole('searchbox', { name: '搜索连接器' });
  await search.fill('missing connector');
  await expect(page.getByText('没有找到匹配的 MCP')).toBeVisible();
  await expect(page.getByRole('button', { name: '清除搜索' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新增自定义 MCP' })).toBeVisible();
  await page.getByRole('button', { name: '新增自定义 MCP' }).click();

  const editor = page.getByRole('form', { name: '新增 MCP' });
  const advanced = editor.locator('.settings-advanced-fields');
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('button', { name: '本机命令' }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('stdio', { exact: true })).toHaveCount(0);
  await expect(advanced).not.toHaveAttribute('open', '');
  await expect(editor.getByRole('button', { name: '添加变量' })).toBeHidden();

  await editor.getByRole('button', { name: '远程地址' }).click();
  await expect(editor.getByLabel('启动命令')).toHaveCount(0);
  await expect(editor.getByLabel('远程 MCP 地址')).toBeVisible();
  await expect(editor.getByLabel('远程协议')).toHaveValue('http');
  await advanced.locator('summary').click();
  await editor.getByRole('button', { name: '添加变量' }).click();
  await expect(editor.getByLabel('环境变量名')).toBeVisible();
  await expect(editor.getByLabel('环境变量值')).toBeVisible();

  const layout = await page.evaluate(() => {
    const selectors = {
      page: '.connections-page',
      inner: '.connections-page__inner',
      emptyActions: '.connections-empty__actions',
      editor: '.settings-editor',
      mode: '.settings-connection-mode',
      form: '.settings-editor > .settings-form-grid',
      advanced: '.settings-advanced-fields',
      advancedContent: '.settings-advanced-fields__content',
      env: '.settings-env-editor',
      envRow: '.settings-env-editor > div'
    };
    const elements = Object.fromEntries(
      Object.entries(selectors).map(([name, selector]) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (element === null) throw new Error(`缺少 MCP 编辑器布局目标 ${selector}`);
        return [name, element];
      })
    ) as Record<keyof typeof selectors, HTMLElement>;
    const rect = (element: HTMLElement) => {
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom
      };
    };
    const modeButtons = elements.mode.querySelectorAll<HTMLElement>('button');
    const envInputs = elements.envRow.querySelectorAll<HTMLElement>('input');
    const removeEnv = elements.envRow.querySelector<HTMLElement>('button')!;
    return {
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      widths: Object.fromEntries(
        Object.entries(elements).map(([name, element]) => [
          name,
          {
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth
          }
        ])
      ) as Record<keyof typeof selectors, {
        clientWidth: number;
        scrollWidth: number;
      }>,
      editor: rect(elements.editor),
      modeButtons: Array.from(modeButtons, rect),
      envKey: rect(envInputs[0]!),
      envValue: rect(envInputs[1]!),
      removeEnv: rect(removeEnv)
    };
  });

  expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
  for (const [name, widths] of Object.entries(layout.widths)) {
    expect(
      widths.scrollWidth,
      `${name} 不应产生横向溢出`
    ).toBeLessThanOrEqual(widths.clientWidth);
  }
  expect(rectanglesOverlap(layout.modeButtons[0]!, layout.modeButtons[1]!)).toBe(false);
  expect(rectanglesOverlap(layout.envKey, layout.envValue)).toBe(false);
  expect(rectanglesOverlap(layout.envKey, layout.removeEnv)).toBe(false);
  expect(rectanglesOverlap(layout.envValue, layout.removeEnv)).toBe(false);
  for (const field of [layout.envKey, layout.envValue, layout.removeEnv]) {
    expect(field.left).toBeGreaterThanOrEqual(layout.editor.left);
    expect(field.right).toBeLessThanOrEqual(layout.editor.right);
  }
  expect(fakeDaemon.unknownRequestPaths()).toEqual([]);

  await testInfo.attach('mobile-mcp-empty-editor.png', {
    body: await page.locator('.connections-page__inner').screenshot({
      animations: 'disabled'
    }),
    contentType: 'image/png'
  });
});

test('企业知识库在 390px 视口下逐级浏览且不产生页面级溢出', async ({
  page,
  runtime
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-mobile',
    '移动端知识库规格固定使用 390x844 Chromium 视口'
  );

  const fakeDaemon = new FakeEnterpriseDaemon();
  await fakeDaemon.attach(page);
  await installPlatformEnvironment(page, 'browser');
  await page.goto(`${runtime.origin}/#/account`);
  await expect(page.getByRole('heading', { name: '欢迎使用 Clawee' })).toBeVisible();
  await loginWithEmail(page);
  await expect(page.getByRole('heading', { name: 'Enterprise Member' })).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = '#/knowledge';
  });
  await expect(page.getByRole('heading', { name: '企业知识库' })).toBeVisible();
  await expect(page.locator('.knowledge-library-pane')).toBeVisible();
  await expect(page.locator('.knowledge-documents-pane')).toBeHidden();

  await page.locator('.knowledge-library-list button').click();
  await expect(page.locator('.knowledge-library-pane')).toBeHidden();
  await expect(page.locator('.knowledge-documents-pane')).toBeVisible();
  await expect(page.getByText('员工手册.pdf')).toBeVisible();
  await page.getByLabel('选择知识库文档').setInputFiles({
    name: '发布流程.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 发布流程')
  });
  await expect(page.getByText('发布流程.md 已提交处理，请关注文档状态'))
    .toBeVisible();

  const layout = await page.evaluate(() => {
    const pageElement = document.querySelector<HTMLElement>('.knowledge-page')!;
    const header = document.querySelector<HTMLElement>('.knowledge-documents-header')!;
    const back = document.querySelector<HTMLElement>('.knowledge-mobile-back')!;
    const heading = document.querySelector<HTMLElement>('.knowledge-documents-heading')!;
    const upload = document.querySelector<HTMLElement>('.knowledge-upload-button')!;
    const content = document.querySelector<HTMLElement>('.knowledge-document-content')!;
    const rect = (element: HTMLElement) => {
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom
      };
    };
    return {
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: pageElement.clientWidth,
      pageScrollWidth: pageElement.scrollWidth,
      headerClientWidth: header.clientWidth,
      headerScrollWidth: header.scrollWidth,
      contentClientWidth: content.clientWidth,
      contentScrollWidth: content.scrollWidth,
      back: rect(back),
      heading: rect(heading),
      upload: rect(upload)
    };
  });

  expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.pageScrollWidth).toBeLessThanOrEqual(layout.pageClientWidth);
  expect(layout.headerScrollWidth).toBeLessThanOrEqual(layout.headerClientWidth);
  expect(layout.contentScrollWidth).toBeGreaterThan(layout.contentClientWidth);
  expect(rectanglesOverlap(layout.back, layout.heading)).toBe(false);
  expect(rectanglesOverlap(layout.heading, layout.upload)).toBe(false);

  await testInfo.attach('mobile-knowledge.png', {
    body: await page.locator('.clawee-shell').screenshot({
      animations: 'disabled'
    }),
    contentType: 'image/png'
  });

  await page.getByRole('button', { name: '返回知识库列表' }).click();
  await expect(page.locator('.knowledge-library-pane')).toBeVisible();
  await expect(page.locator('.knowledge-documents-pane')).toBeHidden();
  expect(fakeDaemon.unknownRequestPaths()).toEqual([]);
});

test('连接器在 390px 视口下可安装和开启且不产生溢出或重叠', async ({
  page,
  runtime
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-mobile',
    '移动端连接器规格固定使用 390x844 Chromium 视口'
  );

  const fakeDaemon = new FakeEnterpriseDaemon();
  await fakeDaemon.attach(page);
  await installPlatformEnvironment(page, 'browser');
  await page.goto(`${runtime.origin}/#/account`);
  await loginWithEmail(page);
  await expect(page.getByRole('heading', { name: 'Enterprise Member' })).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = '#/connections';
  });
  await expect(page.getByRole('heading', { name: '连接器' })).toBeVisible();
  const card = page.locator(
    '[data-testid="mcp-card"][data-connection-key="enterprise:crm-main"]'
  );
  await card.getByRole('button', { name: '安装' }).click();
  const installedCard = page.locator(
    '[data-testid="mcp-card"][data-connection-key="native:enterprise_crm"]'
  );
  const toggle = installedCard.getByRole('switch', {
    name: '客户关系管理 MCP'
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  const layout = await page.evaluate(() => {
    const pageElement = document.querySelector<HTMLElement>('.connections-page')!;
    const inner = document.querySelector<HTMLElement>('.connections-page__inner')!;
    const header = document.querySelector<HTMLElement>('.connections-header')!;
    const actions = document.querySelector<HTMLElement>('.connections-header__actions')!;
    const cardElement = document.querySelector<HTMLElement>(
      '[data-testid="mcp-card"][data-connection-key="native:enterprise_crm"]'
    )!;
    const footer = cardElement.querySelector<HTMLElement>('footer')!;
    const label = footer.querySelector<HTMLElement>('.connection-toggle-label')!;
    const toggleElement = footer.querySelector<HTMLElement>('.connection-switch')!;
    const rect = (element: HTMLElement) => {
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom
      };
    };
    return {
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: pageElement.clientWidth,
      pageScrollWidth: pageElement.scrollWidth,
      innerClientWidth: inner.clientWidth,
      innerScrollWidth: inner.scrollWidth,
      headerClientWidth: header.clientWidth,
      headerScrollWidth: header.scrollWidth,
      actionsClientWidth: actions.clientWidth,
      actionsScrollWidth: actions.scrollWidth,
      cardClientWidth: cardElement.clientWidth,
      cardScrollWidth: cardElement.scrollWidth,
      label: rect(label),
      toggle: rect(toggleElement)
    };
  });

  expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.pageScrollWidth).toBeLessThanOrEqual(layout.pageClientWidth);
  expect(layout.innerScrollWidth).toBeLessThanOrEqual(layout.innerClientWidth);
  expect(layout.headerScrollWidth).toBeLessThanOrEqual(layout.headerClientWidth);
  expect(layout.actionsScrollWidth).toBeLessThanOrEqual(layout.actionsClientWidth);
  expect(layout.cardScrollWidth).toBeLessThanOrEqual(layout.cardClientWidth);
  expect(rectanglesOverlap(layout.label, layout.toggle)).toBe(false);
  expect(fakeDaemon.snapshot()).toMatchObject({
    mcpInstalled: true,
    mcpEnabled: true
  });
  expect(fakeDaemon.unknownRequestPaths()).toEqual([]);

  await testInfo.attach('mobile-connections.png', {
    body: await page.locator('.clawee-shell').screenshot({
      animations: 'disabled'
    }),
    contentType: 'image/png'
  });
});

async function runPlatform(input: {
  browser: Browser;
  fakeDaemon: FakeEnterpriseDaemon;
  origin: string;
  platform: Platform;
  testInfo: TestInfo;
}): Promise<PlatformResult> {
  input.fakeDaemon.reset();
  const context = await input.browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce'
  });
  const page = await context.newPage();
  await input.fakeDaemon.attach(page);
  await installPlatformEnvironment(page, input.platform);

  try {
    await page.goto(input.origin);
    await expect(page.getByRole('status', { name: '本地运行内核正常' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '欢迎使用 Clawee' })).toBeVisible();
    await expect(page.getByText('扫码登录', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('group', { name: '扫码平台' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: '账户操作' })).toBeVisible();
    const checkpoints: Record<string, Checkpoint> = {
      account: await captureCheckpoint(page, [
        '.enterprise-access-gate',
        '.enterprise-account-page',
        '.enterprise-auth-card'
      ])
    };

    await loginWithEmail(page);
    await expect(page.getByRole('button', {
      name: 'Enterprise Member',
      exact: true
    })).toBeVisible();
    await verifyNativeProjectCapability(
      page,
      input.platform,
      input.fakeDaemon
    );
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '诊断', exact: true }).click();
    await expect(page.getByRole('heading', { name: '诊断' })).toBeVisible();
    await expect(page.getByText(
      'codex-rust-v0.146.0-layout-1',
      { exact: true }
    )).toBeVisible();
    await expect(page.getByText('embedded-package', { exact: true }))
      .toBeVisible();
    await expect(page.getByText('committed（已提交）')).toBeVisible();
    await expect(page.getByRole('button', { name: /选择.*Codex/i }))
      .toHaveCount(0);
    const runtimeStatus = await page.evaluate(async () => {
      const response = await fetch('/.clawee/runtime/codex/status');
      if (!response.ok) throw new Error(`Runtime status failed: ${response.status}`);
      return await response.json() as unknown;
    });
    checkpoints.diagnostics = await captureCheckpoint(page, [
      '.clawee-sidebar-pane',
      '.clawee-main-pane',
      '.settings-page',
      '.diagnostics-settings',
      '.diagnostics-block'
    ]);
    await page.getByRole('button', { name: '返回应用' }).click();
    await page.getByRole('button', {
      name: 'Enterprise Member',
      exact: true
    }).click();
    await expect(page.getByRole('heading', { name: 'Enterprise Member' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Enterprise Member' })).toBeVisible();

    await page.setViewportSize({ width: 1800, height: 1200 });
    await page.getByRole('button', { name: '数据看板', exact: true }).click();
    await expect(page.getByRole('heading', { name: '数据看板' })).toBeVisible();
    await expect(page.getByText('已采集 24 个稿件', { exact: true }))
      .toBeVisible();
    await expectFullWidthTabLayout(page, {
      pageSelector: '.dashboard-page',
      contentSelector: '.dashboard-page__inner'
    });
    checkpoints.dashboard = await captureCheckpoint(page, [
      '.clawee-sidebar-pane',
      '.clawee-main-pane',
      '.dashboard-page',
      '.dashboard-page__inner',
      '.dashboard-business'
    ]);
    await page.getByRole('button', {
      name: '打开哔哩哔哩运营详情看板'
    }).click();
    await expect(page.getByRole('heading', { name: '哔哩哔哩运营' }))
      .toBeVisible();
    await expect(page.getByText('企业新品内容复盘', { exact: true }))
      .toBeVisible();
    checkpoints.bilibiliDashboard = await captureCheckpoint(page, [
      '.clawee-sidebar-pane',
      '.clawee-main-pane',
      '.dashboard-detail-page',
      '.dashboard-detail-metrics',
      '.dashboard-detail-table'
    ]);
    await page.getByRole('button', { name: '返回数据看板' }).click();

    await page.getByRole('button', { name: 'Agent动态', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Agent动态' })).toBeVisible();
    await expect(page.getByTestId('total-tokens')).toHaveText('18,396,247');
    const tokenRanking = page.getByRole('table', { name: 'Token 使用排行' });
    await expect(tokenRanking).toBeVisible();
    await expect(tokenRanking.getByText('企业团队', { exact: true })).toBeVisible();
    await expect(tokenRanking.getByText('18,396,247', { exact: true }))
      .toBeVisible();
    await expect(page.getByRole('table', { name: 'Agent 列表' })).toBeVisible();
    await expectFullWidthTabLayout(page, {
      pageSelector: '.activity-page',
      contentSelector: '.activity-page__inner'
    });
    checkpoints.activity = await captureCheckpoint(page, [
      '.clawee-sidebar-pane',
      '.clawee-main-pane',
      '.activity-page',
      '.activity-metrics',
      '.activity-table-wrap'
    ]);
    await page.getByRole('button', { name: '查看 企业研究 Agent' }).click();
    await expect(page.getByRole('heading', { name: '企业研究 Agent' })).toBeVisible();
    await expect(page.getByText('WebSearch', { exact: true })).toBeVisible();
    await expect(page.getByText('1.8 秒', { exact: true })).toBeVisible();
    await expect(page.getByText(/private tool input/i)).toHaveCount(0);
    checkpoints.activityDetail = await captureCheckpoint(page, [
      '.clawee-sidebar-pane',
      '.clawee-main-pane',
      '.activity-page',
      '.activity-detail-header',
      '.activity-detail-grid'
    ]);

    await page.getByRole('button', { name: '连接器', exact: true }).click();
    await expect(page.getByRole('heading', { name: '连接器' })).toBeVisible();
    const mcpCard = page.locator(
      '[data-testid="mcp-card"][data-connection-key="enterprise:crm-main"]'
    );
    await expect(mcpCard.getByRole('heading', { name: '客户关系管理' })).toBeVisible();
    await expect(mcpCard.getByText('sales', { exact: true })).toBeVisible();
    await expect(mcpCard.getByText('按条件查询客户资料', { exact: true })).toBeVisible();
    await expect(mcpCard.getByText('服务正常')).toHaveCount(0);
    await mcpCard.getByRole('button', { name: '安装' }).click();
    const installedMcpCard = page.locator(
      '[data-testid="mcp-card"][data-connection-key="native:enterprise_crm"]'
    );
    const mcpSwitch = installedMcpCard.getByRole('switch', {
      name: '客户关系管理 MCP'
    });
    await expect(mcpSwitch).toHaveAttribute('aria-checked', 'false');
    await mcpSwitch.click();
    await expect(mcpSwitch).toHaveAttribute('aria-checked', 'true');
    await expectFullWidthTabLayout(page, {
      pageSelector: '.connections-page',
      contentSelector: '.connections-page__inner'
    });
    checkpoints.connections = await captureCheckpoint(page, [
      '.clawee-sidebar-pane',
      '.clawee-main-pane',
      '.connections-page',
      '.connections-summary',
      '[data-testid="mcp-card"][data-connection-key="native:enterprise_crm"]'
    ]);

    await page.getByRole('button', { name: '企业知识库', exact: true }).click();
    await expect(page.getByRole('heading', { name: '企业制度' })).toBeVisible();
    await expect(page.getByText('员工手册.pdf')).toBeVisible();
    await page.getByLabel('选择知识库文档').setInputFiles({
      name: '发布流程.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# 发布流程')
    });
    await expect(page.getByText('发布流程.md 已提交处理，请关注文档状态'))
      .toBeVisible();
    await expect(page.getByText('发布流程.md', { exact: true })).toBeVisible();
    await expectFullWidthTabLayout(page, {
      pageSelector: '.knowledge-page',
      contentSelector: '.knowledge-page__inner',
      workbenchSelector: '.knowledge-workbench'
    });
    checkpoints.knowledge = await captureCheckpoint(page, [
      '.clawee-sidebar-pane',
      '.clawee-main-pane',
      '.knowledge-page',
      '.knowledge-workbench',
      '.knowledge-document-table'
    ]);

    await page.getByRole('button', { name: '共享网盘', exact: true }).click();
    await expect(page.getByRole('heading', { name: '共享网盘' })).toBeVisible();
    await expect(page.getByText('design.md', { exact: true })).toBeVisible();
    await expect(page.getByText('当前项目：企业项目')).toBeVisible();
    await expect(page.getByRole('button', { name: '上传文件' })).toHaveCount(0);
    await page.getByRole('button', {
      name: '保存 design.md 到当前项目'
    }).click();
    await expect(page.getByRole('button', {
      name: '覆盖保存 design.md'
    })).toBeVisible();
    await page.getByRole('button', {
      name: '覆盖保存 design.md'
    }).click();
    await expect(page.getByText(
      'docs/design.md 已覆盖保存到项目“企业项目”'
    )).toBeVisible();
    const driveLayout = await page.evaluate(() => {
      const pageBox = document.querySelector('.shared-drive-page')
        ?.getBoundingClientRect();
      const innerBox = document.querySelector('.shared-drive-page__inner')
        ?.getBoundingClientRect();
      const workbenchBox = document.querySelector('.shared-drive-workbench')
        ?.getBoundingClientRect();
      if (pageBox === undefined || innerBox === undefined || workbenchBox === undefined) {
        throw new Error('shared drive layout is unavailable');
      }
      return {
        page: { width: pageBox.width, height: pageBox.height },
        inner: { width: innerBox.width, height: innerBox.height },
        workbench: { width: workbenchBox.width, height: workbenchBox.height }
      };
    });
    expect(driveLayout.inner.width).toBeCloseTo(driveLayout.page.width, 0);
    expect(driveLayout.inner.height).toBeGreaterThanOrEqual(driveLayout.page.height);
    expect(driveLayout.workbench.width).toBeGreaterThan(driveLayout.page.width * 0.9);
    expect(driveLayout.workbench.height).toBeGreaterThan(driveLayout.page.height - 180);
    checkpoints.drive = await captureCheckpoint(page, [
      '.clawee-sidebar-pane',
      '.clawee-main-pane',
      '.shared-drive-page',
      '.shared-drive-workbench',
      '.shared-drive-table'
    ]);

    await page.getByRole('button', { name: '定时任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '定时任务' })).toBeVisible();
    await expect(page.getByText('还没有定时任务')).toBeVisible();
    await expectFullWidthTabLayout(page, {
      pageSelector: '.schedules-view',
      contentSelector: '.schedules-view__inner'
    });
    checkpoints.schedules = await captureCheckpoint(page, [
      '.clawee-sidebar-pane',
      '.clawee-main-pane',
      '.schedules-view',
      '.schedules-view__inner',
      '.schedules-view__header'
    ]);

    await page.getByRole('button', { name: '企业Skill中心', exact: true }).click();
    await expect(page.getByRole('tab', {
      name: '企业Skills',
      selected: true
    })).toBeVisible();
    await expect(page.getByTestId('enterprise-skill-enterprise-skill')).toBeVisible();
    await expectFullWidthTabLayout(page, {
      pageSelector: '.plugins-page',
      contentSelector: '.plugins-source-header'
    });
    await expectFullWidthTabLayout(page, {
      pageSelector: '.plugins-source-content',
      contentSelector: '.enterprise-skill-hub'
    });
    checkpoints.hub = await captureCheckpoint(page, [
      '.clawee-sidebar-pane',
      '.clawee-main-pane',
      '.plugins-source-header',
      '.enterprise-skill-hub',
      '[data-testid="enterprise-skill-enterprise-skill"]'
    ]);
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.getByRole('button', { name: '查看 enterprise-name 详情' }).click();
    await expect(page.getByRole('dialog', { name: 'enterprise-name 详情' })).toBeVisible();
    await expect(page.getByText('改进企业知识检索和输出格式。')).toBeVisible();
    checkpoints.detail = await captureCheckpoint(page, [
      '.clawee-sidebar-pane',
      '.clawee-main-pane',
      '.enterprise-skill-detail'
    ]);
    await page.getByRole('button', { name: '关闭详情' }).click();

    const skillRow = page.getByTestId('enterprise-skill-enterprise-skill');
    await skillRow.getByRole('button', { name: '安装' }).click();
    await expect(skillRow.getByRole('button', { name: '使用' })).toBeEnabled();
    await skillRow.getByRole('button', { name: '使用' }).click();
    const projectDialog = page.getByRole('dialog', { name: '选择使用项目' });
    await projectDialog.getByRole('button', { name: '使用所选项目' }).click();

    await expect(page.getByRole('heading', { name: 'enterprise-name' })).toBeVisible();
    await expect(page.getByLabel('已选择 Skill enterprise-name')).toBeVisible();
    await expect(page.getByRole('group', {
      name: '企业项目 会话'
    }).getByRole('link', {
      name: 'enterprise-name'
    })).toBeVisible();
    await expect(page.getByLabel('最近会话').getByRole('button', {
      name: /enterprise-name/
    })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '输入任务' }))
      .toHaveValue('');
    await expect(page).toHaveURL(/#\/thread\/thread-enterprise-skill$/);
    checkpoints.conversation = await captureCheckpoint(page, [
      '.clawee-sidebar-pane',
      '.clawee-main-pane',
      '.conversation-page',
      '.composer-wrap'
    ]);

    for (const [name, checkpoint] of Object.entries(checkpoints)) {
      await input.testInfo.attach(`${input.platform}-${name}.png`, {
        body: checkpoint.screenshot,
        contentType: 'image/png'
      });
    }

    return {
      checkpoints,
      requests: input.fakeDaemon.requestLog(),
      state: input.fakeDaemon.snapshot(),
      runtimeStatus,
      nativeDirectorySelections: input.platform === 'desktop'
        ? await page.evaluate(() => (
            Number((window as Window & {
              __claweeConsistencyDirectorySelections?: number;
            }).__claweeConsistencyDirectorySelections ?? 0)
          ))
        : input.fakeDaemon.requestLog().filter(request => (
            request.method === 'POST'
            && request.path === '/projects/directory-selection'
          )).length,
      unknownRequests: input.fakeDaemon.unknownRequestPaths()
    };
  } finally {
    await context.close();
  }
}

async function loginWithEmail(page: Page): Promise<void> {
  await page.getByLabel('邮箱').fill('member@example.com');
  await page.getByLabel('密码').fill('password-123');
  await page.getByRole('checkbox').check();
  await page.locator('.enterprise-email-submit').click();
}

async function installPlatformEnvironment(page: Page, platform: Platform): Promise<void> {
  await page.addInitScript(({ currentPlatform }) => {
    if (sessionStorage.getItem('clawee.consistency.initialized') !== '1') {
      localStorage.clear();
      localStorage.setItem('clawee.preferences.dynamicBackground', 'false');
      localStorage.setItem('clawee.preferences.colorMode', 'dark');
      localStorage.setItem('clawee.preferences.defaultPermission', 'follow-project');
      sessionStorage.setItem('clawee.consistency.initialized', '1');
      sessionStorage.setItem('clawee.consistency.directorySelections', '0');
    }
    Object.defineProperty(window, '__claweeConsistencyDirectorySelections', {
      configurable: true,
      writable: true,
      value: Number(sessionStorage.getItem('clawee.consistency.directorySelections') ?? 0)
    });
    Object.defineProperty(window, '__claweeConsistencyExternalUrls', {
      configurable: true,
      writable: true,
      value: []
    });
    const recordExternalUrl = (url: string | URL) => {
      const target = window as Window & {
        __claweeConsistencyExternalUrls?: string[];
      };
      target.__claweeConsistencyExternalUrls?.push(String(url));
    };
    if (currentPlatform !== 'desktop') {
      window.open = ((url?: string | URL) => {
        if (url !== undefined) recordExternalUrl(url);
        return window;
      }) as typeof window.open;
      return;
    }

    const success = { ok: true as const };
    Object.defineProperty(window, 'claweeDesktop', {
      configurable: true,
      value: {
        kind: 'desktop',
        platform: 'darwin',
        readConnectionConfig: async () => ({ baseUrl: '/.clawee/runtime' }),
        subscribeConnectionConfig: () => () => undefined,
        restartRuntime: async () => success,
        reloadWorkspace: async () => success,
        workspaceReady: () => undefined,
        readDesktopPreferences: async () => ({ closeBehavior: 'hide' as const }),
        updateDesktopPreferences: async () => ({ closeBehavior: 'hide' as const }),
        selectProjectDirectory: async () => {
          const target = window as Window & {
            __claweeConsistencyDirectorySelections?: number;
          };
          target.__claweeConsistencyDirectorySelections =
            (target.__claweeConsistencyDirectorySelections ?? 0) + 1;
          sessionStorage.setItem(
            'clawee.consistency.directorySelections',
            String(target.__claweeConsistencyDirectorySelections)
          );
          return null;
        },
        resolveDroppedFilePath: () => null,
        openExternal: async (url: string) => recordExternalUrl(url),
        revealPath: async () => success,
        notify: async () => undefined,
        configureBackgroundNotifications: async () => success,
        subscribeNavigation: () => () => undefined
      }
    });
  }, { currentPlatform: platform });
}

async function verifyNativeProjectCapability(
  page: Page,
  platform: Platform,
  fakeDaemon: FakeEnterpriseDaemon
): Promise<void> {
  await page.getByRole('button', { name: '选择项目 企业项目' }).click();
  const existingFolder = page.getByRole('button', { name: '使用现有文件夹' });
  if (platform === 'desktop') {
    await expect(existingFolder).toBeVisible();
    await existingFolder.click();
    await expect.poll(() => page.evaluate(() => (
      Number((window as Window & {
        __claweeConsistencyDirectorySelections?: number;
      }).__claweeConsistencyDirectorySelections ?? 0)
    ))).toBe(1);
  } else {
    await expect(existingFolder).toBeVisible();
    await existingFolder.click();
    await expect.poll(() => fakeDaemon.requestLog().filter(request => (
      request.method === 'POST'
      && request.path === '/projects/directory-selection'
    )).length).toBe(1);
    await expect(page.getByRole('dialog', { name: '使用现有文件夹' }))
      .toHaveCount(0);
  }
}

async function captureCheckpoint(
  page: Page,
  selectors: string[]
): Promise<Checkpoint> {
  await page.evaluate(() => document.fonts.ready);
  const text = normalizeText(
    await page.locator(
      '.clawee-main-content, .enterprise-access-gate'
    ).first().innerText()
  );
  const boxes: Checkpoint['boxes'] = {};
  for (const selector of selectors) {
    const box = await page.locator(selector).first().boundingBox();
    expect(box, `缺少一致性尺寸目标 ${selector}`).not.toBeNull();
    boxes[selector] = {
      x: Math.round(box!.x),
      y: Math.round(box!.y),
      width: Math.round(box!.width),
      height: Math.round(box!.height)
    };
  }
  return {
    text,
    boxes,
    screenshot: await page.locator(
      '.clawee-shell, .enterprise-access-gate'
    ).first().screenshot({ animations: 'disabled' })
  };
}

async function expectFullWidthTabLayout(
  page: Page,
  input: {
    pageSelector: string;
    contentSelector: string;
    workbenchSelector?: string;
  }
): Promise<void> {
  const layout = await page.evaluate(({ pageSelector, contentSelector, workbenchSelector }) => {
    const pageBox = document.querySelector(pageSelector)?.getBoundingClientRect();
    const contentBox = document.querySelector(contentSelector)?.getBoundingClientRect();
    const workbenchBox = workbenchSelector === undefined
      ? undefined
      : document.querySelector(workbenchSelector)?.getBoundingClientRect();
    if (pageBox === undefined || contentBox === undefined) {
      throw new Error(`页面布局不可用：${pageSelector} / ${contentSelector}`);
    }
    if (workbenchSelector !== undefined && workbenchBox === undefined) {
      throw new Error(`工作台布局不可用：${workbenchSelector}`);
    }
    return {
      page: { x: pageBox.x, width: pageBox.width, height: pageBox.height },
      content: { x: contentBox.x, width: contentBox.width, height: contentBox.height },
      workbench: workbenchBox === undefined
        ? undefined
        : { width: workbenchBox.width, height: workbenchBox.height }
    };
  }, input);

  expect(Math.abs(layout.content.x - layout.page.x)).toBeLessThanOrEqual(1);
  expect(layout.content.width).toBeGreaterThan(layout.page.width * 0.9);
  if (layout.workbench !== undefined) {
    expect(layout.workbench.width).toBeGreaterThan(layout.page.width * 0.9);
    expect(layout.workbench.height).toBeGreaterThan(layout.page.height - 180);
  }
}

function normalizeText(value: string): string {
  return value
    .split('\n')
    .map(line => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n');
}

async function compareScreenshotPixels(
  page: Page,
  left: Buffer,
  right: Buffer
): Promise<{
  differentPixels: number;
  maxChannelDelta: number;
}> {
  return page.evaluate(async ({ leftBase64, rightBase64 }) => {
    const decode = async (value: string) => {
      const response = await fetch(`data:image/png;base64,${value}`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('无法创建截图比较画布');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return {
        width: canvas.width,
        height: canvas.height,
        data: context.getImageData(0, 0, canvas.width, canvas.height).data
      };
    };
    const leftImage = await decode(leftBase64);
    const rightImage = await decode(rightBase64);
    if (
      leftImage.width !== rightImage.width
      || leftImage.height !== rightImage.height
    ) {
      throw new Error(
        `截图尺寸不同：${leftImage.width}x${leftImage.height} / `
        + `${rightImage.width}x${rightImage.height}`
      );
    }

    let differentPixels = 0;
    let maxChannelDelta = 0;
    for (let offset = 0; offset < leftImage.data.length; offset += 4) {
      let pixelDifferent = false;
      for (let channel = 0; channel < 4; channel += 1) {
        const delta = Math.abs(
          leftImage.data[offset + channel]!
          - rightImage.data[offset + channel]!
        );
        if (delta > 0) pixelDifferent = true;
        if (delta > maxChannelDelta) maxChannelDelta = delta;
      }
      if (pixelDifferent) differentPixels += 1;
    }
    return { differentPixels, maxChannelDelta };
  }, {
    leftBase64: left.toString('base64'),
    rightBase64: right.toString('base64')
  });
}

function rectanglesOverlap(
  left: { left: number; right: number; top: number; bottom: number },
  right: { left: number; right: number; top: number; bottom: number }
): boolean {
  return !(
    left.right <= right.left
    || right.right <= left.left
    || left.bottom <= right.top
    || right.bottom <= left.top
  );
}

function requestInventory(requests: FakeEnterpriseRequest[]): string[] {
  return requests
    .map(request => (
      `${request.method} ${request.path} [${request.bodyKeys.join(',')}]`
    ))
    .sort();
}

function commonRequestInventory(requests: FakeEnterpriseRequest[]): string[] {
  return requestInventory(requests.filter(
    request => !request.path.startsWith('/projects/directory-selection')
  ));
}

function businessRequestSequence(requests: FakeEnterpriseRequest[]): string[] {
  return requests
    .filter(request => (
      request.path.startsWith('/enterprise/')
      || (request.method === 'POST' && request.path === '/threads')
    ))
    .map(request => (
      `${request.method} ${request.path} [${request.bodyKeys.join(',')}]`
    ));
}
