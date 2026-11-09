import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DocumentArtifact } from './DocumentArtifact.js';

const path = 'outputs/培训方案.pptx';

function setup(actions = {
  open: vi.fn(async () => undefined),
  reveal: vi.fn(async () => undefined),
  revealLabel: '在 Finder 中显示'
}) {
  const onPreview = vi.fn();
  render(<DocumentArtifact path={path} fileName="培训方案.pptx" typeLabel="演示文稿" onPreview={onPreview} actions={actions} />);
  return { ...actions, onPreview, user: userEvent.setup() };
}

describe('文档成果操作', () => {
  it('卡片默认预览，没有原生能力时隐藏下拉入口', async () => {
    const onPreview = vi.fn();
    render(<DocumentArtifact path={path} fileName="培训方案.pptx" typeLabel="演示文稿" onPreview={onPreview} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '打开成果 培训方案.pptx' }));
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(path);
    expect(screen.getByText('预览')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '文档操作 培训方案.pptx' })).not.toBeInTheDocument();
  });

  it.each(['open', 'reveal'] as const)('%s 只执行对应操作，不触发预览', async action => {
    const state = setup();
    await state.user.click(screen.getByRole('button', { name: '文档操作 培训方案.pptx' }));
    await state.user.click(screen.getByRole('menuitem', { name: action === 'open' ? '使用默认应用打开' : '在 Finder 中显示' }));
    expect(state[action]).toHaveBeenCalledExactlyOnceWith(path);
    expect(state[action === 'open' ? 'reveal' : 'open']).not.toHaveBeenCalled();
    expect(state.onPreview).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('支持键盘选择、Escape 关闭和点击外部关闭', async () => {
    const { user, reveal } = setup();
    const trigger = screen.getByRole('button', { name: '文档操作 培训方案.pptx' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: '使用默认应用打开' })).toHaveFocus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(reveal).toHaveBeenCalledExactlyOnceWith(path);
    await user.click(trigger);
    await user.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('等待原生操作时阻止重复提交，失败后显示错误并允许重试', async () => {
    let reject!: (error: Error) => void;
    const open = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const { user } = setup({ open, reveal: vi.fn(), revealLabel: '在文件资源管理器中显示' });
    const trigger = screen.getByRole('button', { name: '文档操作 培训方案.pptx' });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: '使用默认应用打开' }));
    expect(trigger).toBeDisabled();
    reject(new Error('文件不存在或无法访问'));
    expect(await screen.findByRole('alert')).toHaveTextContent('文件不存在或无法访问');
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    expect(screen.getByRole('menuitem', { name: '在文件资源管理器中显示' })).toBeInTheDocument();
  });
});
