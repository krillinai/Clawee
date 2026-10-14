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
const workbenchCss = readCss('src/features/dashboard/workbench.css');
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

  it('工作台模块卡片有独立边界和间距，移动端保持单列', () => {
    expect(compact(cssBlocks(workbenchCss, '.workbench-page .dashboard-business-grid')[0]!)).toContain('gap:16px;');
    const blocks = cssBlocks(workbenchCss, '.workbench-page .dashboard-business-grid .dashboard-business-card');
    expect(compact(blocks[0]!)).toContain('border:1pxsolidvar(--border);');
    expect(compact(blocks.at(-1)!)).toContain('padding:16px;');
    expect(compact(cssBlocks(workbenchCss, '.workbench-page .dashboard-business-grid').at(-1)!)).toContain('grid-template-columns:minmax(0,1fr);');
    expect(workbenchCss).toMatch(/@media\s*\(max-width:\s*600px\)/);
  });

  it('模块与对话紧邻共享一条拖拽分割线，移动端隐藏分割线', () => {
    expect(compact(cssBlocks(workbenchCss, '.workbench-module-layout')[0]!)).toContain('gap:0;');
    expect(compact(cssBlocks(workbenchCss, '.workbench-conversation-panel')[0]!)).toContain('grid-column:3;');
    expect(cssBlocks(workbenchCss, '.workbench-conversation-panel')[0]).not.toMatch(/border-left:/);
    expect(compact(cssBlocks(workbenchCss, '.workbench-module-resize-handle::after')[0]!)).toContain('width:12px;');
    expect(compact(cssBlocks(workbenchCss, '.workbench-module-resize-handle').at(-1)!)).toContain('display:none;');
  });

  it('工作台模块两侧填满可用区域，不受看板或对话的居中宽度上限限制', () => {
    const layout = compact(cssBlocks(workbenchCss, '.workbench-module-layout')[0]!);
    expect(layout).toContain('width:100%;');
    expect(layout).toContain('height:100%;');
    const dashboard = compact(cssBlocks(workbenchCss, '.workbench-module-workspace .dashboard-detail-inner')[0]!);
    expect(dashboard).toContain('width:100%;');
    expect(dashboard).toContain('max-width:none;');
    expect(dashboard).toContain('min-height:100%;');
    expect(dashboard).toContain('margin:0;');
    const panel = compact(cssBlocks(workbenchCss, '.workbench-conversation-panel')[0]!);
    expect(panel).toContain('width:100%;');
    expect(panel).toContain('height:100%;');
    const composer = compact(cssBlocks(workbenchCss, '.workbench-conversation-composer .composer-stack')[0]!);
    expect(composer).toContain('width:100%;');
    expect(composer).toContain('margin:0;');
    expect(compact(cssBlocks(workbenchCss, '.workbench-conversation-messages .timeline-virtual-item')[0]!)).toContain('max-width:none;');
  });
});
