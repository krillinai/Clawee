import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConversationEmptyState, ConversationStarterTags } from './ConversationEmptyState.js';

describe('ConversationEmptyState', () => {
  it('greets the user by nickname without decorative controls or a brand character', () => {
    const { container } = render(
      <ConversationEmptyState nickname="Joshua" now={new Date(2026, 6, 29, 9)} />
    );

    const heading = screen.getByRole('heading', { name: '上午好，Joshua' });
    const brandMark = container.querySelector<HTMLImageElement>('.conversation-empty-logo-bg');

    expect(heading).toBeInTheDocument();
    expect(screen.getByText('需要帮你做点什么')).toBeInTheDocument();
    expect(brandMark).toBeNull();
    expect(screen.queryByText('日常办公')).not.toBeInTheDocument();
    expect(screen.queryByText('代码开发')).not.toBeInTheDocument();
  });

  it.each([
    [8, '上午好'],
    [14, '下午好'],
    [20, '晚上好']
  ])('uses the local time period without a fallback nickname at %i:00', (hour, expected) => {
    render(<ConversationEmptyState now={new Date(2026, 6, 29, hour)} />);

    expect(screen.getByRole('heading', { name: expected })).toBeInTheDocument();
  });

  it('treats a blank login name as unavailable', () => {
    render(
      <ConversationEmptyState nickname="   " now={new Date(2026, 6, 29, 9)} />
    );

    expect(screen.getByRole('heading', { name: '上午好' })).toBeInTheDocument();
  });
});

describe('ConversationStarterTags', () => {
  it('opens existing modules without offering unavailable Skill shortcuts', async () => {
    const user = userEvent.setup();
    const onOpenView = vi.fn();
    render(<ConversationStarterTags onOpenView={onOpenView} />);

    expect(screen.getByLabelText('常用场景')).toBeInTheDocument();
    for (const name of ['工作台', '工作流', '企业Skills', '企业知识库']) {
      await user.click(screen.getByRole('button', { name }));
    }
    expect(onOpenView.mock.calls).toEqual([
      ['dashboard'], ['workflow'], ['plugins'], ['knowledge']
    ]);
    expect(screen.queryByRole('button', { name: '视频发布' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
