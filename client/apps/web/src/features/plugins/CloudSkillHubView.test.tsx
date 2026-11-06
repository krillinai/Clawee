import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CloudSkillHubView } from './CloudSkillHubView.js';

describe('CloudSkillHubView', () => {
  it('点击卡片展示技能信息，并支持选择项目使用', async () => {
    const user = userEvent.setup();
    const onUse = vi.fn();
    render(<CloudSkillHubView
      data={{
        agentEmail: 'demo-agent@example.com',
        agentName: '演示助手',
        promptTemplate: '请让 {agent_name} 使用「{skill_name}」技能完成以下任务：',
        refreshedAt: '2026-11-05T00:00:00.000Z',
        skills: [{ skillId: 'skill-1', name: '数据分析', description: '分析数据', version: '1.0.0' }]
      }}
      loading={false}
      projects={[{ id: 'project-1', name: '项目一', cwd: '/workspace/project-1' }]}
      currentProjectId="project-1"
      onUse={onUse}
    />);

    const card = screen.getByTestId('cloud-skill-skill-1');
    expect(card).toHaveClass('skill-market-card');
    expect(within(card).getByText('云 Skill')).toHaveClass('skill-market-card__author');
    expect(card.querySelector('.skill-market-card__action-row')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /下载|更新|上传/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /信息展示/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看 数据分析 详情' }));
    expect(screen.getByRole('dialog', { name: '数据分析' })).toHaveTextContent('演示助手');
    await user.click(screen.getByRole('button', { name: '关闭 Skill 信息' }));
    await user.click(screen.getByRole('button', { name: /^使用$/ }));
    await user.click(screen.getByRole('button', { name: '使用所选项目' }));
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ skillId: 'skill-1', name: '数据分析' }), 'project-1');
  });
});
