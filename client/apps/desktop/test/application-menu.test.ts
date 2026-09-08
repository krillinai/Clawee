import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  createWindowsApplicationMenuTemplate,
  type WindowsApplicationMenuActions
} from '../src/main/application-menu.js';

describe('Windows application menu', () => {
  it('uses Chinese enterprise-facing top-level menus', () => {
    const template = createWindowsApplicationMenuTemplate(createActions());

    expect(template.map(item => item.label)).toEqual([
      '文件',
      '编辑',
      '视图',
      '窗口',
      '帮助'
    ]);
    expect(submenuLabels(template, '文件')).toEqual([
      '新建任务',
      '任务中心',
      '设置',
      '关闭窗口',
      '退出 Clawee'
    ]);
  });

  it('keeps developer-only commands out of production builds', () => {
    const production = createWindowsApplicationMenuTemplate(createActions());
    const development = createWindowsApplicationMenuTemplate(createActions({ development: true }));

    expect(submenuLabels(production, '视图')).not.toContain('强制重新加载');
    expect(submenuLabels(production, '视图')).not.toContain('开发者工具');
    expect(submenuLabels(development, '视图')).toContain('强制重新加载');
    expect(submenuLabels(development, '视图')).toContain('开发者工具');
  });

  it('routes product commands through the desktop navigation bridge', () => {
    const actions = createActions();
    const template = createWindowsApplicationMenuTemplate(actions);

    clickItem(template, '文件', '新建任务');
    clickItem(template, '文件', '任务中心');
    clickItem(template, '文件', '设置');

    expect(actions.navigate).toHaveBeenNthCalledWith(1, '#/');
    expect(actions.navigate).toHaveBeenNthCalledWith(2, '#/tasks');
    expect(actions.navigate).toHaveBeenNthCalledWith(3, '#/settings');
  });
});

function createActions(
  overrides: Partial<WindowsApplicationMenuActions> = {}
): WindowsApplicationMenuActions {
  return {
    development: false,
    navigate: vi.fn(),
    openLogs: vi.fn(),
    showAbout: vi.fn(),
    quit: vi.fn(),
    ...overrides
  };
}

function submenuLabels(
  template: MenuItemConstructorOptions[],
  parentLabel: string
): string[] {
  return submenu(template, parentLabel)
    .filter(item => item.type !== 'separator')
    .map(item => item.label ?? '');
}

function clickItem(
  template: MenuItemConstructorOptions[],
  parentLabel: string,
  itemLabel: string
): void {
  const item = submenu(template, parentLabel).find(candidate => candidate.label === itemLabel);
  expect(item).toBeDefined();
  const click = item?.click as (() => void) | undefined;
  expect(click).toBeTypeOf('function');
  click?.();
}

function submenu(
  template: MenuItemConstructorOptions[],
  parentLabel: string
): MenuItemConstructorOptions[] {
  const parent = template.find(item => item.label === parentLabel);
  expect(parent).toBeDefined();
  expect(Array.isArray(parent?.submenu)).toBe(true);
  return parent?.submenu as MenuItemConstructorOptions[];
}
