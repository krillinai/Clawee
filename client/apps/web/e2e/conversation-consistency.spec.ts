import { expect, test } from './fixtures/runtime.js';

test('长会话连续滚动跨越虚拟列表边界时不会被旧锚点拉回', async ({ page, runtime }) => {
  const thread = runtime.ordinaryThreadId;
  await page.route(`**/.clawee/runtime/threads/${thread}/history**`, route => route.fulfill({
    json: {
      threadId: thread,
      items: Array.from({ length: 120 }, (_, index) => ({
        id: `scroll-answer-${index}`, type: 'assistant_message',
        text: `连续阅读 ${index}\n\n${'这是一段用于检查虚拟列表滚动的正文。'.repeat(4)}`,
        createdAt: new Date(Date.UTC(2026, 9, 16, 0, 0, index)).toISOString()
      })),
      hasMore: false
    }
  }));
  await runtime.openApp(page);
  await page.goto(`${runtime.origin}/#/thread/${thread}`);
  await expect(page.getByText('连续阅读 119', { exact: true })).toBeVisible();
  const scroller = page.locator('.timeline-virtuoso');
  await scroller.hover();
  await page.mouse.wheel(0, -80);
  await expect(page.locator('.timeline-virtual-shell')).toHaveAttribute('data-reading-mode', 'free');

  const movements = await scroller.evaluate(async node => {
    const movements: number[] = [];
    // 模拟一次手势后的连续滚动帧，不为每一帧重复派发 wheel。
    for (let index = 0; index < 18; index += 1) {
      const top = node.getBoundingClientRect().top;
      const anchor = [...node.querySelectorAll<HTMLElement>('[data-timeline-id]')]
        .find(item => item.getBoundingClientRect().top >= top)!;
      const before = anchor.getBoundingClientRect().top;
      node.scrollTop -= 45;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      movements.push(anchor.isConnected ? anchor.getBoundingClientRect().top - before : 0);
    }
    return movements;
  });
  // 虚拟列表测量高度时可校正 scrollTop，正文应仍按输入方向移动。
  expect(movements.filter(distance => distance <= 2), JSON.stringify(movements)).toEqual([]);
  expect(movements.reduce((total, distance) => total + distance, 0)).toBeGreaterThan(650);
});

test('自由阅读的连续滚动遇到流式正文更新时仍沿输入方向移动', async ({ page, runtime }) => {
  const text = Array.from({ length: 80 }, (_, index) => `流式滚动 ${index}：验证持续输出中的阅读。`).join('\n\n');
  runtime.configureInvocations([{ steps: [
    { kind: 'message_delta', text, barrier: 'scrolling' },
    { kind: 'message_delta', text: '\n\n滚动期间新增正文', barrier: 'scroll-done' },
    { kind: 'message_complete', text: `${text}\n\n滚动期间新增正文` }
  ] }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('验证输出时连续滚动');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('流式滚动 79：验证持续输出中的阅读。', { exact: true })).toBeVisible();
  const scroller = page.locator('.timeline-virtuoso');
  await scroller.hover();
  await page.mouse.wheel(0, -80);
  await expect(page.locator('.timeline-virtual-shell')).toHaveAttribute('data-reading-mode', 'free');
  await page.exposeFunction('continueScrollingOutput', () => runtime.releaseStage('scrolling'));
  const movements = await scroller.evaluate(async node => {
    const distances: number[] = [];
    for (let index = 0; index < 18; index += 1) {
      const item = node.querySelector('.timeline-assistant_message')!;
      const before = item.getBoundingClientRect().top;
      node.scrollTop -= 15;
      if (index === 5) await (window as unknown as { continueScrollingOutput(): Promise<void> }).continueScrollingOutput();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      distances.push(item.getBoundingClientRect().top - before);
    }
    return distances;
  });
  expect(movements.filter(distance => distance <= 1), JSON.stringify(movements)).toEqual([]);
  expect(movements.reduce((total, distance) => total + distance, 0)).toBeGreaterThan(240);
  await expect(page.getByRole('button', { name: '有新内容' })).toBeVisible();
  runtime.releaseStage('scroll-done');
});

test('near-bottom free reading keeps the return action visible', async ({ page, runtime }) => {
  const text = Array.from({ length: 70 }, (_, index) => `scroll marker ${index}: keep enough content to scroll.`).join('\n\n');
  runtime.configureInvocations([{ steps: [{ kind: 'message_complete', text }] }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: /输入任务/ }).fill('Test scrolling');
  await page.getByRole('button', { name: /发送/, exact: true }).click();
  await expect(page.getByText('scroll marker 69: keep enough content to scroll.', { exact: true })).toBeVisible();

  const shell = page.locator('.timeline-virtual-shell');
  const scroller = page.locator('.timeline-virtuoso');
  await scroller.hover();
  await page.mouse.wheel(0, -36);
  await expect(shell).toHaveAttribute('data-reading-mode', 'free');
  await expect.poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeGreaterThan(12);
  await expect.poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(64);
  await expect(page.getByRole('button', { name: /回到底部/ })).toBeVisible();
  await page.getByRole('button', { name: /回到底部/ }).click();
  await expect(shell).toHaveAttribute('data-reading-mode', 'follow');
});

test('手动向下滚动的后续帧到达底部时隐藏回底按钮', async ({ page, runtime }) => {
  const text = Array.from({ length: 70 }, (_, index) => `回底检查 ${index}：验证惯性滚动结束时的阅读状态。`).join('\n\n');
  runtime.configureInvocations([{ steps: [{ kind: 'message_complete', text }] }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('验证手动回底');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('回底检查 69：验证惯性滚动结束时的阅读状态。', { exact: true })).toBeVisible();

  const shell = page.locator('.timeline-virtual-shell');
  const scroller = page.locator('.timeline-virtuoso');
  await scroller.hover();
  await page.mouse.wheel(0, -600);
  await expect.poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeGreaterThan(500);
  await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible();

  await scroller.evaluate(node => {
    // 一个向下手势引发原生平滑滚动，后续帧不再派发 wheel。
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
    node.scrollTo({ top: node.scrollHeight - node.clientHeight, behavior: 'smooth' });
  });

  await expect.poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(1);
  await expect(shell).toHaveAttribute('data-reading-mode', 'follow');
  await expect(page.getByRole('button', { name: '回到底部' })).not.toBeVisible();
});

test('small upward wheels at the end move the list and do not snap back', async ({ page, runtime }) => {
  const text = Array.from({ length: 70 }, (_, index) => `scroll marker ${index}: keep enough content to scroll.`).join('\n\n');
  runtime.configureInvocations([{ steps: [{ kind: 'message_complete', text }] }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('Test small scrolling');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('scroll marker 69: keep enough content to scroll.', { exact: true })).toBeVisible();

  const scroller = page.locator('.timeline-virtuoso');
  await scroller.hover();
  const initial = await scroller.evaluate(node => node.scrollTop);
  await page.mouse.wheel(0, -8);
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeLessThan(initial - 3);
  const first = await scroller.evaluate(node => node.scrollTop);
  await page.waitForTimeout(250);
  expect(await scroller.evaluate(node => node.scrollTop)).toBeLessThan(initial - 3);
  await page.mouse.wheel(0, -8);
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeLessThan(first - 3);
});

test('scrolling down over the composer at the end does not pause following', async ({ page, runtime }) => {
  runtime.configureInvocations([{ steps: [{ kind: 'message_complete', text: 'Answer at the end.' }] }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('Test composer wheel');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('Answer at the end.')).toBeVisible();

  const composer = page.getByRole('textbox', { name: '输入任务' });
  await composer.hover();
  await page.mouse.wheel(0, 36);
  await page.waitForTimeout(250);
  await expect(page.locator('.timeline-virtual-shell')).toHaveAttribute('data-reading-mode', 'follow');
  await expect(page.getByRole('button', { name: '回到底部' })).not.toBeVisible();
});

test('scrolling up over the composer moves the conversation', async ({ page, runtime }) => {
  const text = Array.from({ length: 70 }, (_, index) => `scroll marker ${index}: keep enough content to scroll.`).join('\n\n');
  runtime.configureInvocations([{ steps: [{ kind: 'message_complete', text }] }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('Test composer upward wheel');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('scroll marker 69: keep enough content to scroll.', { exact: true })).toBeVisible();

  const scroller = page.locator('.timeline-virtuoso');
  const initial = await scroller.evaluate(node => node.scrollTop);
  await page.getByRole('textbox', { name: '输入任务' }).hover();
  await page.mouse.wheel(0, -36);
  await expect(page.locator('.timeline-virtual-shell')).toHaveAttribute('data-reading-mode', 'free');
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeLessThan(initial - 20);
});

test('a short conversation stays in follow mode when there is nothing to scroll', async ({ page, runtime }) => {
  runtime.configureInvocations([{ steps: [{ kind: 'message_complete', text: 'Short answer.' }] }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('Short question');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('Short answer.')).toBeVisible();

  const scroller = page.locator('.timeline-virtuoso');
  expect(await scroller.evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(0);
  await scroller.hover();
  await page.mouse.wheel(0, -8);
  await page.waitForTimeout(250);
  await expect(page.locator('.timeline-virtual-shell')).toHaveAttribute('data-reading-mode', 'follow');
  await expect(page.getByRole('button', { name: '回到底部' })).not.toBeVisible();
});

test('正文增量、完成和过程收起保留气泡与主动阅读位置', async ({ page, runtime }, testInfo) => {
  const text = Array.from({ length: 90 }, (_, i) => `阅读标记 ${i}：这一段用于验证长回答中的阅读位置和连续输出。`).join('\n\n');
  const continued = '\n\n第二阶段正文';
  runtime.configureInvocations([{
    steps: [
      { kind: 'reasoning', text: '核对资料与输出。' },
      { kind: 'message_delta', text, barrier: 'delta-1' },
      { kind: 'message_delta', text: continued, barrier: 'delta-2' },
      { kind: 'message_complete', text: text + continued, barrier: 'complete' }
    ]
  }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('验证长回答阅读');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const shell = page.locator('.timeline-virtual-shell');
  const scroller = page.locator('.timeline-virtuoso');
  await expect(page.getByText('阅读标记 89：', { exact: false })).toBeVisible();
  await scroller.hover();
  await page.mouse.wheel(0, -8);
  await expect(shell).toHaveAttribute('data-reading-mode', 'free');
  await page.mouse.wheel(0, -1200);
  await expect(shell).toHaveAttribute('data-reading-mode', 'free');
  // Momentum can keep moving the scroller after the last wheel/touch event.
  const beforeMomentum = await scroller.evaluate(node => node.scrollTop);
  await scroller.evaluate(node => { node.scrollTop -= 200; });
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeLessThan(beforeMomentum - 190);
  const marker = await page.locator('.timeline-assistant_message p').evaluateAll(nodes => {
    const node = nodes.find(item => { const box = item.getBoundingClientRect(); return box.top > 160 && box.bottom < window.innerHeight - 120; });
    return node?.textContent;
  });
  expect(marker).toBeTruthy();
  const paragraph = page.getByText(marker!, { exact: true });
  await expect(paragraph).toBeVisible();
  const top = (await paragraph.boundingBox())!.y;
  const identity = await paragraph.evaluate(node => {
    const body = node.closest('.timeline-assistant_message')!;
    (window as unknown as { conversationBody: Element }).conversationBody = body;
    (window as unknown as { conversationParent: Element }).conversationParent = body.parentElement!;
    const selection = window.getSelection()!;
    const range = document.createRange(); range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range);
    return selection.toString();
  });
  const stable = async () => {
    await expect(shell).toHaveAttribute('data-reading-mode', 'free');
    await expect.poll(async () => Math.abs((await paragraph.boundingBox())!.y - top)).toBeLessThanOrEqual(8);
    expect(await paragraph.evaluate(node => {
      const state = window as unknown as { conversationBody: Element; conversationParent: Element };
      return node.closest('.timeline-assistant_message') === state.conversationBody && state.conversationBody.parentElement === state.conversationParent;
    })).toBe(true);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(identity);
  };
  runtime.releaseStage('delta-1');
  await expect(page.getByRole('button', { name: '有新内容' })).toBeVisible();
  await stable();
  runtime.releaseStage('delta-2');
  await expect(page.locator('.timeline-assistant_message')).toHaveAttribute('data-message-state', 'complete');
  await stable();
  runtime.releaseStage('complete');
  await expect(page.getByRole('button', { name: '停止', exact: true })).not.toBeVisible();
  await stable();
  await expect(page.locator('.timeline-assistant_message')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('free-reading.png') });
  await page.getByRole('button', { name: '有新内容' }).click();
  await expect(shell).toHaveAttribute('data-reading-mode', 'follow');
  await expect(page.getByText('第二阶段正文', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('follow-reading.png') });
});

test('键盘、触摸和滚动条导航后可主动回底并继续跟随增量', async ({ page, runtime }) => {
  const text = Array.from({ length: 60 }, (_, i) => `连续输出 ${i}：保留阅读意图与正文。`).join('\n\n');
  runtime.configureInvocations([{ steps: [
    { kind: 'message_delta', text, barrier: 'follow-1' },
    { kind: 'message_delta', text: '\n\n回底后新增正文', barrier: 'follow-2' },
    { kind: 'message_complete', text: `${text}\n\n回底后新增正文` }
  ] }]);
  await runtime.openApp(page);
  await page.getByRole('textbox', { name: '输入任务' }).fill('验证阅读手势');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const shell = page.locator('.timeline-virtual-shell');
  const scroller = page.locator('.timeline-virtuoso');
  await expect(page.getByText('连续输出 59：保留阅读意图与正文。', { exact: true })).toBeVisible();
  await scroller.focus();
  await page.keyboard.press('PageUp');
  await expect(shell).toHaveAttribute('data-reading-mode', 'free');
  await page.getByRole('button', { name: '回到底部' }).click();
  await expect(shell).toHaveAttribute('data-reading-mode', 'follow');
  await shell.evaluate(node => {
    for (const [type, clientY] of [['touchstart', 300], ['touchmove', 320]] as const) {
      const touch = new Touch({ identifier: 1, target: node, clientX: 100, clientY });
      node.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: [touch] }));
    }
  });
  await expect(shell).toHaveAttribute('data-reading-mode', 'free');
  await page.getByRole('button', { name: '回到底部' }).click();
  await shell.dispatchEvent('pointerdown');
  await scroller.evaluate(node => { node.scrollTop -= 200; node.dispatchEvent(new Event('scroll')); });
  await expect(shell).toHaveAttribute('data-reading-mode', 'free');
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup')));
  await page.getByRole('button', { name: '回到底部' }).click();
  runtime.releaseStage('follow-1');
  await expect(page.getByText('回底后新增正文', { exact: true })).toBeVisible();
  await expect(shell).toHaveAttribute('data-reading-mode', 'follow');
  await expect(page.getByRole('button', { name: '有新内容' })).not.toBeVisible();
  runtime.releaseStage('follow-2');
});

test('图片加载、旧页前插和会话切回保持真实列表锚点', async ({ page, runtime }) => {
  const thread = runtime.ordinaryThreadId;
  const text = Array.from({ length: 50 }, (_, i) => `窗口阅读 ${i}：验证图片与旧页布局变化后的内容位置。`).join('\n\n');
  const latest = [
    { id: 'window-user', type: 'user_message', text: '窗口任务', turnId: 'window-turn', createdAt: '2026-10-16T00:00:00Z', attachments: [{
      id: 'window-image', fileName: '阅读图片.png', mime: 'image/png', size: 68, sha256: '', storageKey: 'window-image', status: 'ready', createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z'
    }] },
    { id: 'window-answer', type: 'assistant_message', text, turnId: 'window-turn', rawEventId: 'window-answer', createdAt: '2026-10-16T00:00:01Z' }
  ];
  let releaseImage!: () => void;
  const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
  let releaseOlder!: () => void;
  let olderRequested = false;
  const olderGate = new Promise<void>(resolve => { releaseOlder = resolve; });
  await page.route('**/.clawee/runtime/attachments/window-image/content?**', async route => {
    await imageGate;
    await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn6zkAAAAAASUVORK5CYII=', 'base64') });
  });
  await page.route(`**/.clawee/runtime/threads/${thread}/history**`, async route => {
    const before = new URL(route.request().url()).searchParams.get('before');
    if (before) {
      olderRequested = true;
      await olderGate;
      await route.fulfill({ json: { threadId: thread, items: [
        { id: 'window-old', type: 'user_message', text: '更早的窗口任务', createdAt: '2026-10-15T00:00:00Z' }, ...latest
      ], hasMore: false } });
    } else await route.fulfill({ json: { threadId: thread, items: latest, hasMore: true, nextCursor: 'window-before' } });
  });
  await runtime.openApp(page);
  await page.goto(`${runtime.origin}/#/thread/${thread}`);
  const shell = page.locator('.timeline-virtual-shell');
  const scroller = page.locator('.timeline-virtuoso');
  await expect(page.getByText('窗口阅读 49：', { exact: false })).toBeVisible();
  await scroller.hover();
  await page.mouse.wheel(0, -100_000);
  await expect(page.getByText('窗口阅读 0：验证图片与旧页布局变化后的内容位置。', { exact: true })).toBeInViewport();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThanOrEqual(150);
  const marker = await page.locator('.timeline-assistant_message p').evaluateAll(nodes => nodes.find(node => {
    const box = node.getBoundingClientRect();
    return box.top > 160 && box.bottom < window.innerHeight - 150;
  })?.textContent);
  expect(marker).toBeTruthy();
  const paragraph = page.getByText(marker!, { exact: true });
  await expect(shell).toHaveAttribute('data-reading-mode', 'free');
  const top = (await paragraph.boundingBox())!.y;
  releaseImage();
  await expect(page.getByRole('img', { name: '阅读图片.png' })).toBeAttached();
  await expect.poll(async () => Math.abs((await paragraph.boundingBox())!.y - top)).toBeLessThanOrEqual(8);
  if (!olderRequested) await page.getByRole('button', { name: '加载更早记录' }).dispatchEvent('click');
  await expect.poll(() => olderRequested).toBe(true);
  releaseOlder();
  await expect(page.getByRole('button', { name: '加载更早记录' })).not.toBeAttached();
  await expect.poll(async () => Math.abs((await paragraph.boundingBox())!.y - top)).toBeLessThanOrEqual(8);
  await page.goto(`${runtime.origin}/#/new`);
  await expect(page.getByRole('textbox', { name: '输入任务' })).toBeVisible();
  await page.goto(`${runtime.origin}/#/thread/${thread}`);
  await expect(shell).toHaveAttribute('data-reading-mode', 'free');
  await expect(paragraph).toBeVisible();
  await expect.poll(async () => Math.abs((await paragraph.boundingBox())!.y - top)).toBeLessThanOrEqual(8);
});
