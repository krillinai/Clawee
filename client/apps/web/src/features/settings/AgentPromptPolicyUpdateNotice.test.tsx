import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentPromptPolicyUpdateNotice } from './AgentPromptPolicyUpdateNotice.js';

describe('AgentPromptPolicyUpdateNotice', () => {
  it('保留提示图标和关闭操作，避免正文落入图标列', () => {
    const onClose = vi.fn();
    const { container } = render(
      <AgentPromptPolicyUpdateNotice version={3} onClose={onClose} />
    );

    expect(screen.getByRole('status', { name: 'Agent 提示词已更新' })).toBeInTheDocument();
    expect(container.querySelector('.desktop-update-notice-icon')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭 Agent 提示词更新提示' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
