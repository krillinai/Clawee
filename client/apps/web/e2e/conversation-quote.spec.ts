import { expect, test } from './fixtures/runtime.js';

test('选中回复片段后引用到已有正文，继续编辑并发送完整内容', async ({ page, runtime }) => {
  const threadId = runtime.ordinaryThreadId;
  await page.route(`**/.clawee/runtime/threads/${threadId}/history**`, route => route.fulfill({
    json: { threadId, items: [{ id: 'quote-answer', type: 'assistant_message',
      text: '前文需要引用的文字后文', createdAt: new Date(0).toISOString() }], hasMore: false }
  }));
  await runtime.openApp(page);
  await page.goto(`${runtime.origin}/#/thread/${threadId}`);
  const reply = page.getByText('前文需要引用的文字后文', { exact: true });
  await expect(reply).toBeVisible();
  const textbox = page.getByRole('textbox', { name: '输入任务' });
  await textbox.fill('已有问题');
  await reply.evaluate(node => {
    const range = document.createRange();
    range.setStart(node.firstChild!, 2);
    range.setEnd(node.firstChild!, 9);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('button', { name: '引用', exact: true }).click();
  const quoted = '已有问题\n\n引用回复：\n> 需要引用的文字\n\n';
  await expect(textbox).toHaveValue(quoted);
  await expect(textbox).toBeFocused();
  await textbox.pressSequentially('请解释这段');
  const requestPromise = page.waitForRequest(request => request.method() === 'POST'
    && new URL(request.url()).pathname.endsWith('/runs'));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  expect((await requestPromise).postDataJSON().prompt).toBe(`${quoted}请解释这段`);
  await expect(textbox).toHaveValue('');
});
