import { mkdirSync } from 'node:fs';
import { expect, test } from './fixtures/runtime.js';

// Visual check of the run process block: renders a scripted run through the
// real web app and daemon, and saves screenshots of each stage.
// Run with: CLAWEE_VISUAL_DIR=/tmp/out pnpm exec playwright test run-process-visual
const outputDir = process.env.CLAWEE_VISUAL_DIR;

test.skip(outputDir === undefined, 'visual capture only, set CLAWEE_VISUAL_DIR to run');

test('run process block stages', async ({ page, runtime }, testInfo) => {
  const prefix = `${outputDir}/${testInfo.project.name}`;
  mkdirSync(outputDir!, { recursive: true });
  const shot = (name: string) => page.screenshot({ path: `${prefix}-${name}.png` });

  runtime.configureInvocations([{
    steps: [
      { kind: 'reasoning', text: '先看一下项目结构，确认测试和构建入口在哪里，再决定从哪里改起。', pauseMs: 600 },
      { kind: 'command', command: 'ls -la', durationMs: 500, pauseMs: 300 },
      { kind: 'command', command: 'rg -n "followOutput" src/components/timeline', durationMs: 500, pauseMs: 300 },
      { kind: 'mcp', server: 'docs', tool: 'search', arguments: { query: 'react-virtuoso atBottomThreshold' }, durationMs: 700, pauseMs: 300 },
      { kind: 'reasoning', text: '滚动跟随的阈值太小，内容稍有变化就会在跟随和停止之间切换。我会放宽阈值，并让运行中的过程块在内部滚动。', pauseMs: 600 },
      { kind: 'command', command: 'sed -n 1500,1560p src/components/timeline/Timeline.tsx', durationMs: 500, pauseMs: 300 },
      { kind: 'command', command: 'pnpm --filter @clawee/web exec vitest run src/components/timeline/Timeline.test.tsx --reporter=dot', durationMs: 4_000, pauseMs: 300 },
      { kind: 'command', command: 'pnpm --filter @clawee/web typecheck', durationMs: 1_500, pauseMs: 300 }
    ],
    message: '已经完成修改：过程块在运行中改为内部滚动，并放宽了对话区的到底判定。时间线测试和类型检查都已通过。',
    completionDelayMs: 300
  }]);

  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('优化对话过程区的滚动和信息展示');
  await page.getByRole('button', { name: '发送' }).click();

  const process = page.locator('.timeline-process').last();
  await expect(process.getByText(/^正在运行 pnpm --filter @clawee\/web exec vitest/u)).toBeVisible({ timeout: 20_000 });
  await shot('1-running-expanded');

  await expect(page.getByText('已经完成修改')).toBeVisible({ timeout: 20_000 });
  await expect(process).toHaveClass(/is-complete/, { timeout: 20_000 });
  await shot('3-complete-collapsed');

  await process.locator(':scope > details > summary').click();
  await expect(process.locator('.process-tool-group').first()).toBeVisible();
  await shot('4-complete-expanded');
});

test('run process with progress notes and a failing command', async ({ page, runtime }, testInfo) => {
  const prefix = `${outputDir}/${testInfo.project.name}-failure`;
  mkdirSync(outputDir!, { recursive: true });
  runtime.configureInvocations([{
    steps: [
      { kind: 'reasoning', text: '正在定位时间线组件', pauseMs: 200 },
      { kind: 'command', command: 'rg -n "followOutput" src', output: 'src/components/timeline/Timeline.tsx:1535: followOutput', durationMs: 300 },
      { kind: 'reasoning', text: '正在运行时间线测试', pauseMs: 200 },
      { kind: 'command', command: 'pnpm exec vitest run src/components/timeline', exitCode: 1,
        output: ' FAIL  src/components/timeline/Timeline.test.tsx > keeps the newest step pinned\nAssertionError: expected 200 to be 900\n ❯ src/components/timeline/Timeline.test.tsx:1012:28\n\n Test Files  1 failed (1)\n      Tests  1 failed | 75 passed (76)', durationMs: 800 },
      { kind: 'reasoning', text: '测试失败是因为内部滚动没有跟到底部，修正判定后再运行一次。', pauseMs: 200 },
      { kind: 'command', command: 'pnpm exec vitest run src/components/timeline', output: ' Test Files  1 passed (1)\n      Tests  76 passed (76)', durationMs: 800 }
    ],
    message: '已修复：内部滚动现在会跟到最新一步，时间线测试全部通过。',
    completionDelayMs: 200
  }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('修复过程区内部滚动');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('已修复：')).toBeVisible({ timeout: 20_000 });
  const process = page.locator('.timeline-process').last();
  await expect(process).toHaveClass(/is-complete/, { timeout: 20_000 });
  await process.locator(':scope > details > summary').click();
  await expect(process.locator('.process-tool-group').first()).toBeVisible();
  await page.screenshot({ path: `${prefix}-1-complete-expanded.png` });
  const output = process.locator('.process-tool-group:not([open]) > summary').first();
  if (await output.count() > 0) {
    await output.click();
    await page.screenshot({ path: `${prefix}-2-output-open.png` });
  }
});

test('run process names each local command', async ({ page, runtime }, testInfo) => {
  const prefix = `${outputDir}/${testInfo.project.name}-commands`;
  mkdirSync(outputDir!, { recursive: true });
  runtime.configureInvocations([{
    steps: [
      { kind: 'reasoning', text: '我会先检索近 7 天的 AI 相关新闻，核对发布日期和原始来源，再整理成按时间排序的大事件清单。', pauseMs: 200 },
      { kind: 'command', command: "/bin/zsh -lc 'cat ~/.codex/skills/web-tools-guide/SKILL.md'", durationMs: 200 },
      { kind: 'reasoning', text: '我会使用 web-tools-guide 技能核对新闻来源。先检查可用的公开新闻检索渠道。', pauseMs: 200 },
      { kind: 'command', command: 'command -v opencli', durationMs: 200 },
      { kind: 'command', command: 'curl -sL https://www.cnbc.com/ai/', durationMs: 200 },
      { kind: 'command', command: "python3 - <<'PY'\nimport urllib.request\nPY", durationMs: 200 },
      { kind: 'reasoning', text: '第一批数据到手，官方源和媒体源都可用。我再补几个来源，重点覆盖模型发布、政策监管和芯片算力这几条主线。', pauseMs: 200 },
      { kind: 'command', command: 'curl -sL https://blogs.nvidia.com/feed/', durationMs: 200 },
      { kind: 'command', command: 'curl -sL https://www.chinanews.com.cn/rss/scroll-news.xml', durationMs: 200 },
      { kind: 'reasoning', text: '数据面已经比较全了。我再对几条关键事件做原文核对，避免转述失真。', pauseMs: 200 },
      { kind: 'command', command: 'open https://about.fb.com/news/', durationMs: 200 }
    ],
    message: '以下是近 7 天值得关注的 8 件 AI 新闻大事。',
    completionDelayMs: 200
  }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('帮我生成一个关于近7天的AI新闻大事件的清单');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('以下是近 7 天')).toBeVisible({ timeout: 20_000 });
  const process = page.locator('.timeline-process').last();
  await expect(process).toHaveClass(/is-complete/, { timeout: 20_000 });
  await process.locator(':scope > details > summary').click();
  await expect(process.locator('.process-tool-group').first()).toBeVisible();
  await page.screenshot({ path: `${prefix}-1-complete-expanded.png` });
  await process.locator('.process-tool-group > summary').nth(2).click();
  await page.screenshot({ path: `${prefix}-2-group-open.png` });
});

test('run process with empty reasoning between tool calls', async ({ page, runtime }, testInfo) => {
  const prefix = `${outputDir}/${testInfo.project.name}-gaps`;
  mkdirSync(outputDir!, { recursive: true });
  runtime.configureInvocations([{
    steps: [
      { kind: 'reasoning', text: '信息量很大，我把被截断的部分补齐，并检索几个关键议题的更多报道。', pauseMs: 100 },
      { kind: 'command', command: "/bin/zsh -lc \"python3 - <<'PY'\nprint(1)\nPY\"", durationMs: 100 },
      { kind: 'reasoning', text: '', pauseMs: 100 },
      { kind: 'command', command: "/bin/zsh -lc \"sed -n '1,80p' notes.md | grep -E '(a|e)'\"", durationMs: 100 },
      { kind: 'reasoning', text: '', pauseMs: 100 },
      { kind: 'reasoning', text: '主要事件脉络已经清晰。我再补几条关键报道的细节，确保摘要准确。', pauseMs: 100 },
      { kind: 'command', command: "python3 - <<'PY'\nprint(2)\nPY", durationMs: 100 },
      { kind: 'reasoning', text: '', pauseMs: 100 },
      { kind: 'command', command: "python3 - <<'PY'\nprint(3)\nPY", durationMs: 100 }
    ],
    message: '以下是截至 2026-10-15 的近 7 天 AI 大事件清单。',
    completionDelayMs: 100
  }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('近 7 天 AI 大事件');
  await page.getByRole('button', { name: '发送' }).click();
  const process = page.locator('.timeline-process').last();
  await expect(process).toHaveClass(/is-complete/, { timeout: 20_000 });
  await process.locator(':scope > details > summary').click();
  await expect(process.locator('.process-tool-group').first()).toBeVisible();
  await page.screenshot({ path: `${prefix}-1-complete-expanded.png` });
});

test('reply citations show site favicons', async ({ page, runtime }, testInfo) => {
  const prefix = `${outputDir}/${testInfo.project.name}-citations`;
  mkdirSync(outputDir!, { recursive: true });
  const dot = (color: string) => Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${color}"/></svg>`
  );
  const icons: Record<string, string> = { 'www.cnbc.com': '#1a5fd6', 'about.fb.com': '#0866ff', 'blog.google': '#34a853' };
  const requests: Array<{ url: string; referer?: string }> = [];
  await page.route('**/favicon.ico', route => {
    const url = new URL(route.request().url());
    requests.push({ url: url.href, referer: route.request().headers().referer });
    const color = icons[url.hostname];
    return color === undefined
      ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ contentType: 'image/svg+xml', body: dot(color) });
  });
  runtime.configureInvocations([{
    message: [
      '| 日期 | 大事件 | 核心内容与看点 |',
      '| --- | --- | --- |',
      '| 10 月 12 日 | Meta 发布 Muse Wonder | 新模型面向个人和专业 Agent 任务。[Meta 公告](https://about.fb.com/news/2026/10/muse/) |',
      '| 10 月 12 日 | Character.ai 申请破产保护 | 据 CNBC 13 日报道。[CNBC](https://www.cnbc.com/2026/10/13/character-ai.html) |',
      '| 10 月 13 日 | Google 扩大开放 Gemini 4 Argon | 本周是扩大开放。[Google 公告](https://blog.google/technology/gemini/) |',
      '| 10 月 14 日 | 山东发布七个垂直领域大模型 | 覆盖装备、化工等领域。[中国新闻网](https://www.chinanews.com.cn/cj/2026/10-14/1.shtml) |'
    ].join('\n')
  }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('近 7 天 AI 大事件');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByRole('link', { name: 'CNBC' })).toBeVisible({ timeout: 20_000 });
  // External requests are blocked in this sandbox, so icons may fall back to the globe here.
  await expect(page.locator('.md-link .md-link-site-icon')).toHaveCount(4);
  await page.screenshot({ path: `${prefix}-1-reply.png` });
  expect(requests.every(request => request.referer === undefined)).toBe(true);
});
