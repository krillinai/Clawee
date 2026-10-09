import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CLAWEE_APP_VERSION } from '../../app-version.js';
import { createTestCodexRuntimeStatus } from '../../test/codex-runtime-status.js';
import { ClaweeSettingsView } from './ClaweeSettingsView.js';

const runtimeStatus = {
  connected: true,
  runtimeVersion: '0.9.1',
  codexVersion: 'codex-cli 1.2.3',
  codexPath: '/opt/homebrew/bin/codex',
  codexHome: '/Users/wulien/.codex',
  lastCheckedAt: '2026-07-07 10:00'
};

describe('ClaweeSettingsView', () => {
  it('客户更新显示原生版本和下载入口，不显示旧占位文案', () => {
    const perform = vi.fn(async () => undefined);
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} onBack={vi.fn()}
      desktopUpdates={{ state: { supported: true, status: 'available', currentVersion: '0.1.7', version: '0.1.9' }, busy: false, perform }} />);
    fireEvent.click(screen.getByRole('button', { name: '关于 Clawee' }));
    expect(screen.getByText('0.1.7')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载更新' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '下载更新' }));
    expect(perform).toHaveBeenCalledWith('downloadUpdate');
    expect(screen.queryByText('手动检查稍后支持')).not.toBeInTheDocument();
  });
  it('登录后提供服务器配置设置入口', async () => {
    const onSaveGateway = vi.fn(async () => undefined);
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} onBack={vi.fn()}
      onReadGateway={async () => ({ gateway: 'https://current.example', gateways: ['https://current.example'], configurable: true })}
      onSaveGateway={onSaveGateway} />);
    fireEvent.click(screen.getByRole('button', { name: '服务器配置' }));
    expect(await screen.findByLabelText('当前服务器')).toHaveValue('https://current.example');
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }));
    fireEvent.change(screen.getByLabelText('服务器地址 2'), { target: { value: 'https://new.example' } });
    fireEvent.click(screen.getByRole('button', { name: '保存服务器配置' }));
    await screen.findByText('服务器配置已保存');
    expect(onSaveGateway).toHaveBeenCalledWith('https://current.example', ['https://current.example', 'https://new.example']);
  });

  it('renders default navigation and general settings without old work mode copy', () => {
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} onBack={vi.fn()} />);

    expect(screen.getByRole('button', { name: '返回应用' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('搜索暂不可用')).toBeDisabled();
    expect(screen.getByText('搜索暂不可用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '常规' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'AI模型配置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '插件' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'MCP 服务' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Profiles' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '清理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '诊断' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关于 Clawee' })).toBeInTheDocument();

    expect(screen.getByText('默认权限')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '默认权限' }))
      .toHaveValue('danger-full-access');
    expect(screen.getByText('默认文件打开方式')).toBeInTheDocument();
    expect(screen.getByText('语言')).toBeInTheDocument();
    expect(screen.getByText('中文')).toBeInTheDocument();
    expect(screen.getByText('菜单栏显示')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: '动态背景' })).not.toBeInTheDocument();
    expect(screen.queryByText('工作模式')).not.toBeInTheDocument();
    expect(screen.queryByText('适用于编程')).not.toBeInTheDocument();
  });

  it('configures the AI model service and keeps the key masked after saving', async () => {
    const onModelServiceConfigure = vi.fn().mockResolvedValue(undefined);
    render(
      <ClaweeSettingsView
        runtimeStatus={runtimeStatus}
        modelServiceConfiguration={{
          baseUrl: 'https://model.example.com/v1',
          model: 'gpt-5'
        }}
        onModelServiceConfigure={onModelServiceConfigure}
        onBack={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'AI模型配置' }));
    expect(screen.getByRole('heading', { name: 'AI模型配置' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Base URL' }))
      .toHaveValue('https://model.example.com/v1');
    expect(screen.getByRole('textbox', { name: '模型名字' })).toHaveValue('gpt-5');

    const apiKey = screen.getByLabelText('API Key');
    expect(apiKey).toHaveAttribute('type', 'password');
    expect(apiKey).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: '显示 API Key' }));
    expect(apiKey).toHaveAttribute('type', 'text');
    fireEvent.change(apiKey, { target: { value: 'secret-key' } });
    fireEvent.click(screen.getByRole('button', { name: '隐藏 API Key' }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      expect(onModelServiceConfigure).toHaveBeenCalledWith({
        baseUrl: 'https://model.example.com/v1',
        model: 'gpt-5',
        apiKey: 'secret-key'
      });
      expect(apiKey).toHaveValue('secret-key');
    });
    expect(await screen.findByText(/模型检测通过/)).toBeInTheDocument();
    expect(apiKey).toHaveAttribute('type', 'password');
  });

  it('loads the local key, checks the draft without saving, and invalidates results after edits', async () => {
    const configure = vi.fn();
    const check = vi.fn().mockResolvedValue({ status: 'succeeded', checkedAt: '2026-10-09T10:00:00Z' });
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} initialTab="model"
      modelServiceConfiguration={{ baseUrl: 'https://api.example.test/v1', model: 'model-1' }}
      onModelServiceReadApiKey={vi.fn().mockResolvedValue({ apiKey: 'stored-secret' })}
      onModelServiceCheck={check} onModelServiceConfigure={configure} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('API Key')).toHaveValue('stored-secret'));
    await waitFor(() => expect(screen.getByRole('button', { name: '检测模型' })).toBeEnabled());
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: '检测模型' }));
    expect(await screen.findByText(/模型检测通过/)).toBeInTheDocument();
    expect(check).toHaveBeenCalledWith({ baseUrl: 'https://api.example.test/v1', model: 'model-1', apiKey: 'stored-secret' });
    expect(configure).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '模型名字' }), { target: { value: 'model-2' } });
    expect(screen.queryByText(/模型检测通过/)).not.toBeInTheDocument();
  });

  it('shows check failures and keeps platform credentials inaccessible', async () => {
    const readApiKey = vi.fn();
    const check = vi.fn().mockResolvedValue({ status: 'failed', message: '模型检测超时', checkedAt: '2026-10-09T10:00:00Z' });
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} initialTab="model" modelServiceMode="platform_managed"
      modelServiceConfiguration={{ baseUrl: 'https://platform.example.test/v1', model: 'model-1' }}
      onModelServiceReadApiKey={readApiKey} onModelServiceCheck={check} onBack={vi.fn()} />);
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
    expect(readApiKey).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '保存配置' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '检测模型' }));
    expect(await screen.findByText(/模型检测超时/)).toBeInTheDocument();
    expect(check).toHaveBeenCalledWith(undefined);
  });

  it('notifies when the global default permission changes', () => {
    const onDefaultPermissionChange = vi.fn();
    render(
      <ClaweeSettingsView
        runtimeStatus={runtimeStatus}
        defaultPermission="workspace-write"
        onDefaultPermissionChange={onDefaultPermissionChange}
        onBack={vi.fn()}
      />
    );

    const permission = screen.getByRole('combobox', { name: '默认权限' });
    expect(permission).toHaveValue('workspace-write');

    fireEvent.change(permission, { target: { value: 'danger-full-access' } });

    expect(onDefaultPermissionChange).toHaveBeenCalledWith('danger-full-access');
  });

  it('keeps the existing permission when full access confirmation is canceled', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onDefaultPermissionChange = vi.fn();
    render(
      <ClaweeSettingsView
        runtimeStatus={runtimeStatus}
        defaultPermission="workspace-write"
        onDefaultPermissionChange={onDefaultPermissionChange}
        onBack={vi.fn()}
      />
    );

    const permission = screen.getByRole('combobox', { name: '默认权限' });
    expect(within(permission).getAllByRole('option').map(option => option.textContent))
      .toEqual(['跟随项目设置', '请求批准', '完全访问权限']);

    fireEvent.change(permission, { target: { value: 'danger-full-access' } });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onDefaultPermissionChange).not.toHaveBeenCalled();
  });

  it('renders a two-option color mode control and notifies when it changes', () => {
    const onColorModeChange = vi.fn();
    render(
      <ClaweeSettingsView
        runtimeStatus={runtimeStatus}
        colorMode="dark"
        onColorModeChange={onColorModeChange}
        onBack={vi.fn()}
      />
    );

    const modeControl = screen.getByRole('group', { name: '颜色模式' });
    expect(within(modeControl).getByRole('button', { name: '浅色' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(within(modeControl).getByRole('button', { name: '深色' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.click(within(modeControl).getByRole('button', { name: '浅色' }));
    expect(onColorModeChange).toHaveBeenCalledWith('light');
  });

  it('renders brand following and seven accent color swatches and notifies when the selection changes', () => {
    const onAccentColorChange = vi.fn();
    render(
      <ClaweeSettingsView
        runtimeStatus={runtimeStatus}
        accentColor="neutral"
        onAccentColorChange={onAccentColorChange}
        onBack={vi.fn()}
      />
    );

    const accentControl = screen.getByRole('radiogroup', { name: '重点色' });
    expect(within(accentControl).getAllByRole('radio')).toHaveLength(8);
    expect(within(accentControl).getByRole('radio', { name: '默认灰' }))
      .toHaveAttribute('aria-checked', 'true');
    const customAccent = within(accentControl).getByRole('radio', { name: '自定义' });
    expect(customAccent).toHaveTextContent('自定义');
    expect(customAccent.querySelector('.settings-accent-swatch')).toBeInTheDocument();
    expect(customAccent.firstElementChild).toHaveClass('settings-accent-swatch');
    expect(customAccent.lastElementChild).toHaveClass('settings-custom-accent-text');
    expect(customAccent.querySelector('svg')).not.toBeInTheDocument();
    expect(customAccent).toHaveStyle({ '--settings-accent-swatch': '#3b82f6' });
    expect(screen.getByText('｜')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '自定义重点色色值' })).toHaveValue('#3b82f6');

    fireEvent.click(within(accentControl).getByRole('radio', { name: '橙色' }));
    expect(onAccentColorChange).toHaveBeenCalledWith('orange');
  });

  it('validates and applies a custom accent color without blocking draft input', () => {
    const onCustomAccentColorChange = vi.fn();
    render(
      <ClaweeSettingsView
        runtimeStatus={runtimeStatus}
        accentColor="custom"
        customAccentColor="#3b82f6"
        onCustomAccentColorChange={onCustomAccentColorChange}
        onBack={vi.fn()}
      />
    );

    const input = screen.getByRole('textbox', { name: '自定义重点色色值' });
    expect(input).toHaveValue('#3b82f6');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '#0af' } });
    expect(onCustomAccentColorChange).toHaveBeenLastCalledWith('#00aaff');
    expect(input).toHaveValue('#0af');

    fireEvent.change(input, { target: { value: '#12' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('请输入 3 位或 6 位十六进制色值');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('#3b82f6');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('updates the desktop close behavior when Desktop preferences are available', () => {
    const onDesktopCloseBehaviorChange = vi.fn();
    render(
      <ClaweeSettingsView
        runtimeStatus={runtimeStatus}
        desktopCloseBehavior="hide"
        onDesktopCloseBehaviorChange={onDesktopCloseBehaviorChange}
        onBack={vi.fn()}
      />
    );

    const behavior = screen.getByRole('combobox', { name: '关闭窗口时' });
    expect(behavior).toHaveValue('hide');
    fireEvent.change(behavior, { target: { value: 'quit' } });
    expect(onDesktopCloseBehaviorChange).toHaveBeenCalledWith('quit');
  });

  it('does not show Codex CLI version on the initial general tab', () => {
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} onBack={vi.fn()} />);

    expect(screen.queryByText('Codex CLI 版本')).not.toBeInTheDocument();
    expect(screen.queryByText(runtimeStatus.codexVersion)).not.toBeInTheDocument();
  });

  it('shows local skills and MCP status on the plugins tab', () => {
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '插件' }));

    expect(screen.getByRole('button', { name: '插件' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Skills 状态')).toBeInTheDocument();
    expect(screen.getByText('MCP 服务状态')).toBeInTheDocument();
    expect(screen.getByText('最近检测时间')).toBeInTheDocument();
    expect(screen.getByText(runtimeStatus.lastCheckedAt)).toBeInTheDocument();
    expect(screen.getByText('本地能力已就绪')).toBeInTheDocument();
  });

  it('shows Codex CLI details only in the about advanced information section', () => {
    render(
      <ClaweeSettingsView
        runtimeStatus={runtimeStatus}
        agentId="clawee_550e8400-e29b-41d4-a716-446655440000"
        onBack={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '关于 Clawee' }));

    expect(screen.getByText('Clawee 版本')).toBeInTheDocument();
    expect(screen.getByText(CLAWEE_APP_VERSION)).toBeInTheDocument();
    expect(screen.getByText('Runtime 版本')).toBeInTheDocument();
    expect(screen.getByText('数据目录')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '检查更新' })).not.toBeInTheDocument();
    expect(screen.queryByText('手动检查稍后支持')).not.toBeInTheDocument();
    expect(screen.queryByText('客户版本更新')).not.toBeInTheDocument();

    const advanced = screen.getByRole('region', { name: '高级信息' });
    expect(within(advanced).getByText('当前 Agent ID')).toBeInTheDocument();
    expect(within(advanced).getByText(
      'clawee_550e8400-e29b-41d4-a716-446655440000'
    )).toBeInTheDocument();
    expect(within(advanced).getByText('Codex CLI 版本')).toBeInTheDocument();
    expect(within(advanced).getByText(runtimeStatus.codexVersion)).toBeInTheDocument();
    expect(within(advanced).getByText('Codex CLI 路径')).toBeInTheDocument();
    expect(within(advanced).getByText(runtimeStatus.codexPath)).toBeInTheDocument();
    expect(within(advanced).getByText('CODEX_HOME')).toBeInTheDocument();
    expect(within(advanced).getByText(runtimeStatus.codexHome)).toBeInTheDocument();
    expect(within(advanced).getByText('本地运行内核状态')).toBeInTheDocument();
    expect(within(advanced).getByText('正常')).toBeInTheDocument();
    expect(within(advanced).getByText('最近一次检测时间')).toBeInTheDocument();
    expect(within(advanced).getByText(runtimeStatus.lastCheckedAt)).toBeInTheDocument();
  });

  it('keeps MCP management out of settings and opens Profiles', () => {
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} onBack={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'MCP 服务' }))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
    expect(screen.getByRole('heading', { name: 'Profiles' })).toBeInTheDocument();
    expect(screen.getByText('本地服务连接后可以管理 Profile。')).toBeInTheDocument();
  });

  it('opens Cleanup and Diagnostics pages from settings navigation', () => {
    render(
      <ClaweeSettingsView
        runtimeStatus={runtimeStatus}
        codexStatus={{
          codexBin: runtimeStatus.codexPath,
          codexVersion: runtimeStatus.codexVersion,
          codexHome: runtimeStatus.codexHome,
          codexHomeMode: 'global',
          codexHomeSource: 'default',
          codexHomeWritable: true,
          capabilities: { cleanup: true },
          diagnostics: [],
          runtime: createTestCodexRuntimeStatus({
            entryPath: runtimeStatus.codexPath,
            homePath: runtimeStatus.codexHome
          })
        }}
        onBack={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '清理' }));
    expect(screen.getByRole('heading', { name: '运行数据清理' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '诊断' }));
    expect(screen.getByRole('heading', { name: '诊断' })).toBeInTheDocument();
    expect(screen.getAllByText(runtimeStatus.codexPath)).toHaveLength(2);
  });

  it('shows disconnected local runtime status in about advanced information', () => {
    render(<ClaweeSettingsView runtimeStatus={{ ...runtimeStatus, connected: false }} onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '关于 Clawee' }));

    const advanced = screen.getByRole('region', { name: '高级信息' });
    expect(within(advanced).getByText('本地运行内核状态')).toBeInTheDocument();
    expect(within(advanced).getByText('未连接')).toBeInTheDocument();
  });

  it('calls onBack when returning to the app', () => {
    const onBack = vi.fn();
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} onBack={onBack} />);

    fireEvent.click(screen.getByRole('button', { name: '返回应用' }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
