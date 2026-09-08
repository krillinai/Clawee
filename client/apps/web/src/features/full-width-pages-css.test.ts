import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readCss(path: string) {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

function cssBlocks(source: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(
    source.matchAll(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'g')),
    match => match.groups?.body ?? ''
  );
}

function compact(value: string) {
  return value.replace(/\s+/g, '');
}

function expectFullWidth(source: string, selector: string) {
  const blocks = cssBlocks(source, selector);
  expect(blocks.length, `缺少 ${selector} 样式`).toBeGreaterThan(0);
  expect(blocks.some(block => compact(block).includes('width:100%;'))).toBe(true);
  expect(blocks.join('\n')).not.toMatch(/width:\s*min\(/);
}

const activityCss = readCss('src/features/activity/activity.css');
const connectionsCss = readCss('src/features/connections/connections.css');
const dashboardLayoutCss = readCss('src/features/dashboard/dashboard-layout.css');
const driveCss = readCss('src/features/drive/shared-drive.css');
const knowledgeCss = readCss('src/features/knowledge/knowledge.css');
const pluginsCss = readCss('src/features/plugins/skill-market.css');
const schedulesCss = readCss('src/features/schedules/schedules-view.css');

describe('侧栏 Tab 页面自适应布局', () => {
  it('所有通用页面最终都使用完整内容区宽度', () => {
    expectFullWidth(activityCss, '.activity-page__inner');
    expectFullWidth(connectionsCss, '.connections-page__inner');
    expectFullWidth(dashboardLayoutCss, '.dashboard-page__inner');
    expectFullWidth(driveCss, '.shared-drive-page__inner');
    expectFullWidth(knowledgeCss, '.knowledge-page__inner');
    expectFullWidth(pluginsCss, '.plugins-source-header');
    expectFullWidth(pluginsCss, '.skill-market');
    expectFullWidth(pluginsCss, '.enterprise-skill-hub');
    expectFullWidth(schedulesCss, '.schedules-view__inner');
  });

  it('知识库和共享网盘工作台填充最大化后的剩余高度', () => {
    expect(knowledgeCss).toMatch(/\.knowledge-page__inner\s*\{[^}]*height:\s*100%;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(knowledgeCss).toMatch(/\.knowledge-workbench\s*\{[^}]*flex:\s*1 0 620px;[^}]*min-height:\s*620px;/s);
    expect(driveCss).toMatch(/\.shared-drive-page__inner\s*\{[^}]*height:\s*100%;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(driveCss).toMatch(/\.shared-drive-workbench\s*\{[^}]*flex:\s*1 0 590px;[^}]*min-height:\s*590px;/s);
  });

  it('数据看板在移动端仍保持全宽并使用紧凑内边距', () => {
    const dashboardBlocks = cssBlocks(dashboardLayoutCss, '.dashboard-page__inner');
    expect(compact(dashboardBlocks.at(-1)!)).toContain('width:100%;');
    expect(compact(dashboardBlocks.at(-1)!)).toContain('padding:24px14px56px;');
  });
});
