import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PluginsPage, { type PluginsPageProps } from './PluginsPage.js';

describe('PluginsPage', () => {
  it('describes enterprise upload as a ZIP package containing SKILL.md', async () => {
    const user = userEvent.setup();
    const onUploadSkill = vi.fn();
    render(<PluginsPage {...createProps({ enterprise: { ...createProps().enterprise, onUploadSkill } })} />);
    await user.click(screen.getByRole('button', { name: '添加技能' }));
    const upload = screen.getByRole('menuitem', { name: '上传技能 选择包含 SKILL.md 的 ZIP 压缩包' });
    expect(upload).not.toHaveTextContent('文件夹');
    await user.click(upload);
    expect(onUploadSkill).toHaveBeenCalledOnce();
  });
  it('defaults to enterprise skills and shows cloud skills beside it', async () => {
    const user = userEvent.setup();
    const onSourceChange = vi.fn();
    const view = render(<PluginsPage {...createProps({ onSourceChange })} />);

    expect(screen.getByRole('tab', { name: '企业Skills', selected: true }))
      .toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '企业Skills' }).nextElementSibling)
      .toBe(screen.getByRole('tab', { name: '云 Skills' }));

    await user.click(screen.getByRole('tab', { name: '云 Skills' }));
    expect(onSourceChange).toHaveBeenCalledWith('cloud');

    await user.click(screen.getByRole('tab', { name: 'Skill市场' }));
    expect(onSourceChange).toHaveBeenCalledWith('public');

    view.rerender(
      <PluginsPage
        {...createProps({
          source: 'enterprise',
          enterprise: {
            ...createProps().enterprise,
            session: {
              status: 'signed_out',
              transportSecurity: 'secure_https'
            }
          }
        })}
      />
    );

    expect(screen.getByRole('tab', { name: '企业Skills', selected: true }))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '登录企业账户' })).not.toBeInTheDocument();
    expect(screen.getByText('品牌合规审查')).toBeInTheDocument();
  });

  it('hides cloud skills when the server has no configured account', () => {
    render(<PluginsPage {...createProps({ cloud: undefined })} />);

    expect(screen.queryByRole('tab', { name: '云 Skills' })).not.toBeInTheDocument();
  });

  it('falls back from a direct cloud route when the server reports no account', async () => {
    const onSourceChange = vi.fn();
    render(<PluginsPage {...createProps({
      source: 'cloud',
      onSourceChange,
      cloud: { ...createProps().cloud!, data: undefined, loadError: '云 Skill 账户暂不可用' }
    })} />);

    expect(screen.getByRole('tab', { name: '企业Skills', selected: true })).toBeInTheDocument();
    await waitFor(() => expect(onSourceChange).toHaveBeenCalledWith('enterprise'));
  });
});

function createProps(overrides: Partial<PluginsPageProps> = {}): PluginsPageProps {
  return {
    connected: true,
    skills: {
      codexHome: '/tmp/codex',
      codexHomeMode: 'global',
      skillsPath: '/tmp/codex/skills',
      skillsWritable: true,
      requiresWriteConfirmation: false,
      skills: [],
      diagnostics: []
    },
    installRecords: [],
    loading: false,
    projects: [{ id: 'project-1', name: 'Project One', cwd: '/workspace/project-1' }],
    currentProjectId: 'project-1',
    onInstall: vi.fn(),
    onUpdate: vi.fn(),
    onUse: vi.fn(),
    onSourceChange: vi.fn(),
    enterprise: {
      connected: true,
      session: {
        status: 'signed_in',
        account: { subjectId: 'acct-member', email: 'member@example.com', name: 'Member' },
        transportSecurity: 'secure_https'
      },
      skills: [],
      loading: false,
      projects: [{ id: 'project-1', name: 'Project One', cwd: '/workspace/project-1' }],
      currentProjectId: 'project-1',
      onOpenAccount: vi.fn(),
      onRefresh: vi.fn(),
      onLoadDetail: vi.fn(),
      onInstall: vi.fn(),
      onUpdate: vi.fn(),
      onUse: vi.fn()
    },
    cloud: {
      data: {
        agentEmail: 'demo-agent@example.com',
        agentName: 'Demo',
        promptTemplate: '请让 {agent_name} 使用「{skill_name}」技能完成以下任务：',
        skills: [],
        refreshedAt: '2026-11-05T00:00:00.000Z'
      },
      loading: false,
      projects: [{ id: 'project-1', name: 'Project One', cwd: '/workspace/project-1' }],
      currentProjectId: 'project-1',
      onUse: vi.fn()
    },
    ...overrides
  };
}
