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
  it('renders four actionable common scenarios', () => {
    render(<ConversationStarterTags onOpenDashboard={vi.fn()} onLoadSkill={vi.fn()} />);

    expect(screen.getByLabelText('常用场景')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '数据分析' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '脚本选题生成' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '广告素材审核' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '视频发布' })).toBeEnabled();
    expect(screen.queryByText('获客转化')).not.toBeInTheDocument();
    expect(screen.queryByText('内容创意生成')).not.toBeInTheDocument();
    expect(screen.queryByText('广告投放')).not.toBeInTheDocument();
  });

  it('opens the dashboard and maps each Skill shortcut to its runtime name', async () => {
    const user = userEvent.setup();
    const onOpenDashboard = vi.fn();
    const onLoadSkill = vi.fn();
    render(
      <ConversationStarterTags
        onOpenDashboard={onOpenDashboard}
        onLoadSkill={onLoadSkill}
      />
    );

    await user.click(screen.getByRole('button', { name: '数据分析' }));
    await user.click(screen.getByRole('button', { name: '脚本选题生成' }));
    await user.click(screen.getByRole('button', { name: '广告素材审核' }));
    await user.click(screen.getByRole('button', { name: '视频发布' }));

    expect(onOpenDashboard).toHaveBeenCalledOnce();
    expect(onLoadSkill.mock.calls).toEqual([
      ['content-strategy'],
      ['ad-creative'],
      ['marketing-video']
    ]);
  });

  it('disables all shortcuts while loading and exposes contextual feedback', () => {
    const { rerender } = render(
      <ConversationStarterTags
        busySkillName="ad-creative"
        onOpenDashboard={vi.fn()}
        onLoadSkill={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: '广告素材审核' }))
      .toHaveAttribute('aria-busy', 'true');
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByRole('status')).toHaveTextContent('正在加载广告素材审核 Skill');

    rerender(
      <ConversationStarterTags
        error="Skill 安装失败"
        onOpenDashboard={vi.fn()}
        onLoadSkill={vi.fn()}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Skill 安装失败');
  });
});
