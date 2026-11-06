import { expect, test } from '@playwright/test';
import { permissions } from '../src/lib/rbac-api';

test.use({ headless: true });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`MCP 能力选择器滚动与授权 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const warnings: string[] = [];
    const errors: string[] = [];
    const mutations: unknown[] = [];
    page.on('console', message => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
    page.on('pageerror', error => errors.push(error.message));
    const timestamp = new Date().toISOString();
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = { items: [] };
      if (path === '/api/v1/auth/me') data = {
        account: { user_id: 'usr_test', email: 'test@example.com', name: '测试账号', status: 'active' },
        admin_permissions: [permissions.agentRead, permissions.mcpGrantRead, permissions.mcpGrantCreate],
        applications: { admin: true, frontend: true }
      };
      else if (path === '/api/v1/admin/status') data = { features: {} };
      else if (path === '/api/v1/admin/mcp/agents') data = { items: [{
        agent_id: 'agent_test', bound_user_id: 'usr_test', bound_user_name: '测试账号', name: '测试 Agent',
        status: 'active', created_at: timestamp, updated_at: timestamp
      }] };
      else if (path === '/api/v1/admin/mcp/capabilities') data = { items: Array.from({ length: 30 }, (_, index) => ({
        id: `cap_${index}`, upstream_server_id: 'server_test', type: 'tool', exposed_name: `tool_${index}`,
        upstream_name: `tool_${index}`, status: 'active', created_at: timestamp, updated_at: timestamp
      })) };
      else if (path === '/api/v1/admin/mcp/grants' && route.request().method() === 'POST') {
        mutations.push(route.request().postDataJSON());
        data = {};
      }
      await route.fulfill({ json: { data } });
    });

    await page.goto('/admin/mcp/agents');
    await page.getByRole('button', { name: '查看授权', exact: true }).click();
    await page.getByRole('button', { name: '添加授权', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加授权', exact: true });
    await dialog.getByRole('combobox', { name: /^capability_id/ }).click();
    const list = dialog.getByRole('listbox');
    await expect(list.getByRole('option')).toHaveCount(30);
    expect(await list.evaluate(node => node.closest('form'))).toBeNull();
    expect(await list.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await list.hover();
    expect(await list.evaluate(node => node.scrollTop)).toBe(0);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(120);
    await page.mouse.wheel(0, -120);
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(0);

    const touchMovePrevented = await list.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      const startTouch = new Touch({ identifier: 1, target: node, clientX: bounds.x + 50, clientY: bounds.y + 200 });
      node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [startTouch], changedTouches: [startTouch] }));
      const moveTouch = new Touch({ identifier: 1, target: node, clientX: bounds.x + 50, clientY: bounds.y + 80 });
      const event = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [moveTouch], changedTouches: [moveTouch] });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(touchMovePrevented).toBe(false);

    await list.getByRole('option', { name: /tool_0\b/ }).click();
    await list.getByRole('option', { name: /tool_1\b/ }).click();
    await page.getByPlaceholder('搜索 capability_id / exposed_name').press('Escape');
    await expect(list).not.toBeVisible();
    await expect(dialog.getByRole('combobox', { name: /^capability_id/ })).toBeFocused();
    await dialog.getByRole('button', { name: '提交授权', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(mutations).toEqual([{ user_id: 'usr_test', capability_id: 'cap_1', grant_type: 'tool' }]);
    expect(warnings.filter(message => message.includes('Description') || message.includes('aria-describedby'))).toEqual([]);
    expect(errors).toEqual([]);
  });
}
