import type { Page } from '@playwright/test';
import {
  expect,
  test,
  type FakeCodexThread
} from './fixtures/runtime.js';

test('browser first launch uses the Runtime default project without desktop-only actions', async ({
  page,
  runtime
}) => {
  const projects: Array<Record<string, unknown>> = [];
  const projectApiCalls: Array<{ method: string; path: string }> = [];

  await page.route('**/.clawee/runtime/projects**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    projectApiCalls.push({ method: request.method(), path: url.pathname });

    if (url.pathname.endsWith('/projects/migrations/local-storage-v1')) {
      await route.fulfill({
        json: {
          status: 'applied',
          projectIdMap: {},
          assignedThreadIds: [],
          unassignedThreadIds: []
        }
      });
      return;
    }
    if (url.pathname.endsWith('/projects/default') && request.method() === 'POST') {
      if (projects.length === 0) {
        projects.push(e2eProject('project-default', '默认项目', '/tmp/Clawee/Default Project'));
      }
      await route.fulfill({ json: { project: projects[0] } });
      return;
    }
    if (url.pathname.endsWith('/projects/managed') && request.method() === 'POST') {
      const body = request.postDataJSON() as { name: string };
      const project = e2eProject(
        `project-${body.name}`,
        body.name,
        `/tmp/Clawee/${body.name}`
      );
      projects.unshift(project);
      await route.fulfill({ status: 201, json: { project } });
      return;
    }
    if (url.pathname.endsWith('/projects') && request.method() === 'GET') {
      await route.fulfill({ json: { projects } });
      return;
    }
    await route.fallback();
  });
  await page.route('**/.clawee/runtime/threads**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/threads')) {
      await route.fulfill({ json: { threads: [] } });
      return;
    }
    await route.fallback();
  });
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('clawee.preferences.dynamicBackground', 'false');
  });

  await page.goto(runtime.origin);

  await expect(page.getByRole('button', {
    name: '选择项目 默认项目'
  })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '输入任务' })).toBeEnabled();
  expect(projectApiCalls.filter(call => (
    call.method === 'POST' && call.path.endsWith('/projects/default')
  ))).toHaveLength(1);

  await page.getByRole('button', { name: '选择项目 默认项目' }).click();
  await page.getByRole('button', { name: '新建项目' }).click();
  await expect(page.getByRole('dialog', { name: '创建项目' })).toBeVisible();
  await page.getByRole('textbox', { name: '项目名称' }).fill('browser-project');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();

  await expect(page.getByRole('button', {
    name: '选择项目 browser-project'
  })).toBeVisible();
  expect(projectApiCalls.filter(call => (
    call.method === 'POST' && call.path.endsWith('/projects/managed')
  ))).toHaveLength(1);
});

test('restored conversations wait for history before entering the empty layout', async ({
  page,
  runtime
}) => {
  let releaseHistory: (() => void) | undefined;
  const historyGate = new Promise<void>(resolve => {
    releaseHistory = resolve;
  });
  await page.route('**/.clawee/runtime/threads/*/history?**', async route => {
    await historyGate;
    await route.fallback();
  });

  await runtime.openApp(page);
  await page.goto(`${runtime.origin}/#/thread/${runtime.ordinaryThreadId}`);

  await expect(page.getByRole('status', { name: '正在加载会话历史' })).toBeVisible();
  await expect(page.locator('.conversation-page')).not.toHaveClass(/is-empty/);
  await expect(page.getByText('需要帮你做点什么')).toHaveCount(0);
  await expect(page.getByText('数据分析')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /选择项目/ })).toHaveCount(0);

  releaseHistory?.();

  await expect(page.getByRole('status', { name: '正在加载会话历史' })).toHaveCount(0);
  await expect(page.locator('.conversation-page')).toHaveClass(/is-empty/);
  await expect(page.getByText('需要帮你做点什么')).toBeVisible();
  await expect(page.getByText('数据分析')).toBeVisible();
  await expect(page.getByRole('button', { name: /选择项目/ })).toBeVisible();
});

test('Clawee owns projects and mapped sessions across reloads', async ({ page, runtime }) => {
  runtime.configureInvocations([{
    threadId: 'codex-owned-e2e',
    message: '刷新后仍从 Codex 会话恢复的回答'
  }]);

  await runtime.openApp(page);
  await expect(page.getByText('本机目录')).toHaveCount(0);
  await openSidebar(page);
  const projectButton = page.getByRole('button', { name: 'workspace', exact: true });
  let projectConversations = page.getByRole('group', { name: 'workspace 会话' });
  await expect(projectButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: '折叠项目 workspace' })).toHaveCount(0);

  await projectButton.click();
  await openSidebar(page);
  await expect(projectButton).toHaveAttribute('aria-expanded', 'false');
  await expect(projectConversations).toHaveCount(0);

  await projectButton.click();
  await openSidebar(page);
  projectConversations = page.getByRole('group', { name: 'workspace 会话' });
  await expect(projectButton).toHaveAttribute('aria-expanded', 'true');
  await expect(projectConversations.getByRole('link', { name: '普通会话' })).toBeVisible();
  await expect(page.getByLabel('最近会话').getByRole('button', {
    name: /普通会话/
  })).toBeVisible();
  await projectConversations.getByRole('link', { name: '普通会话' }).click();
  await expect(page.getByRole('heading', { name: '普通会话' })).toBeVisible();

  const prompt = '验证 Clawee 项目和 Codex 会话映射';
  await page.getByRole('textbox', { name: '输入任务' }).fill(prompt);
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('刷新后仍从 Codex 会话恢复的回答')).toBeVisible();

  const mapped = await runtime.api<{
    thread: {
      id: string;
      projectId: string | null;
      codexThreadId: string | null;
      cwd: string;
    };
  }>('GET', `/threads/${encodeURIComponent(runtime.ordinaryThreadId)}`);
  expect(mapped.thread).toMatchObject({
    id: runtime.ordinaryThreadId,
    projectId: runtime.projectId,
    codexThreadId: 'codex-owned-e2e',
    cwd: runtime.projectDir
  });

  await page.reload();
  await expect(page.getByRole('status', { name: '本地运行内核正常' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '普通会话' })).toBeVisible();
  await expect(page.getByText(prompt)).toBeVisible();
  await expect(page.getByText('刷新后仍从 Codex 会话恢复的回答')).toBeVisible();
  await expect(page.getByText('本机目录')).toHaveCount(0);
  await openSidebar(page);
  await expect(page.getByRole('group', { name: 'workspace 会话' }).getByRole('link', {
    name: '普通会话'
  })).toBeVisible();
});

test('conversation image and PDF attachments remain visible after the run completes and reloads', async ({
  page,
  runtime
}) => {
  runtime.configureInvocations([{
    threadId: 'codex-image-history-e2e',
    message: 'image received'
  }]);
  await runtime.openApp(page);
  await page.goto(`${runtime.origin}/#/thread/${runtime.ordinaryThreadId}`);

  await page.getByLabel('选择文件').setInputFiles([
    {
      name: 'screen.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn6zkAAAAAASUVORK5CYII=',
        'base64'
      )
    },
    {
      name: 'requirements.pdf',
      mimeType: 'application/pdf',
      buffer: createTextPdf('Browser PDF requirements')
    }
  ]);
  await expect(page.getByRole('img', { name: 'screen.png' })).toBeVisible();
  await expect(page.getByTitle('requirements.pdf')).toBeVisible();
  await page.getByRole('textbox', { name: '输入任务' }).fill('describe these attachments');
  await page.getByRole('button', { name: '发送' }).click();

  await expect.poll(async () => {
    const response = await runtime.api<{
      runs: Array<{ status: string }>;
    }>('GET', `/threads/${encodeURIComponent(runtime.ordinaryThreadId)}/runs?limit=50`);
    return response.runs[0]?.status;
  }).toBe('succeeded');

  await page.reload();
  await expect(page.getByRole('status', { name: '本地运行内核正常' })).toBeVisible();
  await expect(page.getByText('describe these attachments')).toBeVisible();
  await expect(page.getByRole('img', { name: 'screen.png' })).toBeVisible();
  await expect(page.getByText('requirements.pdf', { exact: true })).toBeVisible();
  await expect(page.getByText('[Clawee 用户附件上下文]')).toHaveCount(0);
});

function createTextPdf(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  body += offsets.slice(1).map(offset => (
    `${String(offset).padStart(10, '0')} 00000 n \n`
  )).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

test('unknown Codex sessions stay isolated from lists, search, and deep links', async ({
  page,
  runtime
}) => {
  const sameCwd = codexThread(
    'codex-external-same-cwd',
    '外部未知同目录会话',
    runtime.projectDir
  );
  const otherCwd = codexThread(
    'codex-external-other-cwd',
    '外部未知其他目录会话',
    `${runtime.projectDir}-other`
  );
  runtime.configureCodex({
    threads: [sameCwd, otherCwd],
    searchResults: [
      { thread: sameCwd, snippet: '外部未知同目录会话' },
      { thread: otherCwd, snippet: '外部未知其他目录会话' }
    ]
  });

  const before = await runtime.api<{ threads: Array<{ id: string }> }>(
    'GET',
    '/threads?status=active&limit=50'
  );
  await runtime.openApp(page);
  await openSidebar(page);
  await expect(page.getByText('外部未知同目录会话')).toHaveCount(0);
  await expect(page.getByText('外部未知其他目录会话')).toHaveCount(0);

  const search = await runtime.api<{ results: unknown[] }>(
    'GET',
    `/search/conversations?query=${encodeURIComponent('外部未知')}&limit=20`
  );
  expect(search.results).toEqual([]);

  await page.getByRole('button', { name: '搜索' }).click();
  await page.getByRole('searchbox', { name: '搜索会话' }).fill('外部未知');
  await expect(page.getByText('没有找到匹配的会话')).toBeVisible();

  const unknownRuntimeId = 'thread_codex_external_same';
  for (const path of [
    `/threads/${unknownRuntimeId}`,
    `/threads/${unknownRuntimeId}/history?limit=50`,
    `/threads/${unknownRuntimeId}/runs?limit=50`
  ]) {
    const result = await runtime.apiResult('GET', path);
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({
      error: { code: 'THREAD_NOT_FOUND' }
    });
  }

  const after = await runtime.api<{ threads: Array<{ id: string }> }>(
    'GET',
    '/threads?status=active&limit=50'
  );
  expect(after.threads.map(thread => thread.id)).toEqual(
    before.threads.map(thread => thread.id)
  );
  await expect.poll(() => runtime.readCodexMethods()).toContain('thread/search');
  expect(runtime.readCodexMethods()).not.toContain('thread/list');
});

test('legacy localStorage projects migrate once without restoring local home', async ({
  page,
  runtime
}) => {
  const legacyProjects = [
    {
      id: 'local-home',
      name: '本机目录',
      cwd: '~',
      sandbox: 'follow-global',
      profile: 'default',
      model: null,
      reasoning: null
    },
    {
      id: 'legacy-workspace',
      name: '旧工作区',
      cwd: runtime.projectDir,
      sandbox: 'follow-global',
      profile: 'default',
      model: null,
      reasoning: null
    }
  ];

  await runtime.openApp(page, {
    legacyProjects,
    currentProjectId: 'legacy-workspace'
  });
  await openSidebar(page);
  await expect(page.getByRole('button', { name: 'workspace', exact: true }))
    .toHaveAttribute('data-current-project', 'true');
  await expect(page.getByText('本机目录')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /普通会话/ })).toBeVisible();

  const stored = await page.evaluate(() => localStorage.getItem('clawee.projects.v1'));
  expect(stored).toBe(JSON.stringify(legacyProjects));

  const repeated = await runtime.api<{
    status: string;
    projectIdMap: Record<string, string>;
  }>('POST', '/projects/migrations/local-storage-v1', { projects: [] });
  expect(repeated.status).toBe('already_applied');
  expect(repeated.projectIdMap['legacy-workspace']).toBe(runtime.projectId);
  expect(repeated.projectIdMap).not.toHaveProperty('local-home');

  const projects = await runtime.api<{
    projects: Array<{ id: string; name: string }>;
  }>('GET', '/projects?status=all');
  expect(projects.projects).toEqual([
    expect.objectContaining({
      id: runtime.projectId,
      name: 'workspace'
    })
  ]);
});

function codexThread(id: string, name: string, cwd: string): FakeCodexThread {
  const now = Math.floor(Date.now() / 1_000);
  return {
    id,
    preview: name,
    name,
    createdAt: now,
    updatedAt: now,
    recencyAt: now,
    cwd
  };
}

function e2eProject(id: string, name: string, cwd: string): Record<string, unknown> {
  return {
    id,
    name,
    cwd,
    canonicalCwd: cwd,
    directoryState: 'available',
    profile: 'default',
    model: null,
    reasoning: null,
    sandbox: 'follow-global',
    status: 'active',
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    archivedAt: null
  };
}

async function openSidebar(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: '打开导航' });
  if (await trigger.isVisible()) await trigger.click();
}
