import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CLAWEE_APP_VERSION } from '../../app-version.js';
import { createTestCodexRuntimeStatus } from '../../test/codex-runtime-status.js';
import { ClaweeSettingsView } from './ClaweeSettingsView.js';
import type { CodexAvailabilityProbe, CodexModelResponse } from '@clawee/protocol';
import { ApiClientError } from '../../runtime/errors.js';

const runtimeStatus = {
  connected: true,
  runtimeVersion: '0.9.1',
  codexVersion: 'codex-cli 1.2.3',
  codexPath: '/opt/homebrew/bin/codex',
  codexHome: '/Users/example/.codex',
  lastCheckedAt: '2026-07-07 10:00'
};

describe('ClaweeSettingsView', () => {
  it('推理强度入口默认折叠，展开后按模型设置，不修改模型服务配置', () => {
    const models: CodexModelResponse[] = [{
      id: 'model-a', model: 'model-a', displayName: '模型 A', description: '',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '' },
        { reasoningEffort: 'medium', description: '' },
        { reasoningEffort: 'xhigh', description: '' }
      ],
      defaultReasoningEffort: 'xhigh', inputModalities: ['text'], isDefault: true
    }];
    models.push({ ...models[0]!, id: 'model-b', model: 'model-b', displayName: '模型 B', supportedReasoningEfforts: [] });
    const onModelReasoningChange = vi.fn();
    const onModelServiceConfigure = vi.fn();
    const { rerender } = render(<ClaweeSettingsView runtimeStatus={runtimeStatus} initialTab="model"
      modelServiceMode="platform_managed" models={models} onModelReasoningChange={onModelReasoningChange}
      onModelServiceConfigure={onModelServiceConfigure} onBack={vi.fn()} />);

    const entry = screen.getByText('推理强度设置');
    expect(entry.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByLabelText('模型 A 推理强度')).not.toBeVisible();
    fireEvent.click(entry);
    const select = screen.getByRole('combobox', { name: '模型 A 推理强度' });
    expect(select).toBeVisible();
    expect(select).toHaveValue('medium');
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['低', '中（推荐）', '超高']);
    expect(screen.queryByLabelText('模型 B 推理强度')).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'xhigh' } });
    expect(onModelReasoningChange).toHaveBeenCalledWith('model-a', 'xhigh');
    expect(onModelServiceConfigure).not.toHaveBeenCalled();

    rerender(<ClaweeSettingsView runtimeStatus={runtimeStatus} initialTab="model" models={models}
      modelReasoningPreferences={{ 'model-a': 'xhigh' }} onModelReasoningChange={onModelReasoningChange} onBack={vi.fn()} />);
    expect(select).toHaveValue('xhigh');
    fireEvent.click(entry);
    expect(select).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '常规' }));
    fireEvent.click(screen.getByRole('button', { name: 'AI模型配置' }));
    expect(screen.getByText('推理强度设置').closest('details')).not.toHaveAttribute('open');
  });

  it('客户更新显示原生版本和下载入口，不显示旧占位文案', () => {
    const perform = vi.fn(async () => undefined);
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} onBack={vi.fn()}
      desktopUpdates={{ state: { supported: true, status: 'available', currentVersion: '0.1.7', version: '0.1.9' }, busy: false, perform }} />);
    fireEvent.click(screen.getByRole('button', { name: '关于 Clawee' }));
    expect(within(screen.getByText('Clawee 版本').parentElement!).getByText('0.1.7')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '客户端版本更新' })).getByText('0.1.7')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载更新' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '下载更新' }));
    expect(perform).toHaveBeenCalledWith('downloadUpdate');
    expect(screen.queryByText('手动检查稍后支持')).not.toBeInTheDocument();
  });

  it('在关于页面显示桌面客户端安装目录', () => {
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} onBack={vi.fn()}
      installationDirectory="/Applications/Clawee.app" />);
    fireEvent.click(screen.getByRole('button', { name: '关于 Clawee' }));
    expect(within(screen.getByText('安装目录').parentElement!).getByText('/Applications/Clawee.app'))
      .toBeInTheDocument();
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
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByText('搜索暂不可用')).not.toBeInTheDocument();
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
    expect(await screen.findByText('配置已保存')).toBeInTheDocument();
    expect(screen.queryByText('接口检测通过')).not.toBeInTheDocument();
    expect(apiKey).toHaveAttribute('type', 'password');
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://new.example.com/v1' } });
    expect(screen.queryByText('配置已保存')).not.toBeInTheDocument();
  });

  it('blocks model actions while the model service is unavailable', () => {
    const check = vi.fn();
    const configure = vi.fn();
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} initialTab="model"
      modelServiceStatus="unavailable"
      modelServiceConfiguration={{ baseUrl: 'https://model.example.com/v1', model: 'gpt-5' }}
      onModelServiceCheck={check} onModelServiceConfigure={configure} onBack={vi.fn()} />);

    expect(screen.getByText('模型服务暂时不可用，当前无法保存配置。请先点击“重新检测”，确认服务恢复后再试。'))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: '检测模型' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存配置' })).toBeDisabled();
    expect(check).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
  });

  it('hides internal configuration errors behind an actionable message', async () => {
    const configure = vi.fn().mockRejectedValue(new ApiClientError({
      status: 409,
      code: 'MODEL_SERVICE_CONFIGURATION_BUSY',
      message: 'MODEL_SERVICE_CONFIGURATION_BUSY: model access mode is not ready for manual configuration'
    }));
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} initialTab="model"
      modelServiceStatus="configuration_required"
      onModelServiceConfigure={configure} onBack={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://model.example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'secret-key' } });
    fireEvent.change(screen.getByLabelText('模型名字'), { target: { value: 'gpt-5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    expect(await screen.findByText('模型服务尚未准备好，当前无法保存配置。请先点击“重新检测”，确认服务恢复后再试。'))
      .toBeInTheDocument();
    expect(screen.queryByText(/MODEL_SERVICE_CONFIGURATION_BUSY/)).not.toBeInTheDocument();
  });

  it('loads the local key, checks the draft without saving, and invalidates results after edits', async () => {
    const configure = vi.fn();
    const check = vi.fn().mockResolvedValue({ status: 'succeeded', checkedAt: '2026-10-09T10:00:00Z', durationMs: 1250, headersReceived: true, responseReceived: true, stage: 'model_text' });
    const checkRuntime = vi.fn().mockResolvedValue({ status: 'succeeded', checkedAt: '2026-10-09T10:00:01Z', durationMs: 80, responseReceived: true });
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} initialTab="model"
      modelServiceConfiguration={{ baseUrl: 'https://api.example.test/v1', model: 'model-1' }}
      onModelServiceReadApiKey={vi.fn().mockResolvedValue({ apiKey: 'stored-secret' })}
      onModelServiceCheck={check} onModelServiceCheckRuntime={checkRuntime} onModelServiceConfigure={configure} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('API Key')).toHaveValue('stored-secret'));
    await waitFor(() => expect(screen.getByRole('button', { name: '检测模型' })).toBeEnabled());
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: '检测模型' }));
    expect(await screen.findByText(/接口检测通过/)).toBeInTheDocument();
    expect(screen.getByText(/首段文本耗时：1.3 秒/)).toBeInTheDocument();
    expect(screen.getByText(/检测时间：/)).toBeInTheDocument();
    expect(screen.getByText('响应头：已收到')).toBeInTheDocument();
    expect(screen.getByText('模型文本：已收到')).toBeInTheDocument();
    expect(screen.getByText('Runtime 链路检测：通过')).toBeInTheDocument();
    expect(check).toHaveBeenCalledWith({ baseUrl: 'https://api.example.test/v1', model: 'model-1', apiKey: 'stored-secret' });
    expect(checkRuntime).toHaveBeenCalledOnce();
    expect(configure).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '模型名字' }), { target: { value: 'model-2' } });
    expect(screen.queryByText(/接口检测通过/)).not.toBeInTheDocument();
  });

  it('shows check failures and keeps platform credentials inaccessible', async () => {
    const readApiKey = vi.fn();
    const check = vi.fn().mockResolvedValue({ status: 'failed', message: '模型检测超时', errorCode: 'MODEL_SERVICE_CHECK_TIMEOUT', httpStatus: 200, diagnostic: '等待模型文本超时', checkedAt: '2026-10-09T10:00:00Z' });
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} initialTab="model" modelServiceMode="platform_managed"
      modelServiceConfiguration={{ baseUrl: 'https://platform.example.test/v1', model: 'model-1' }}
      onModelServiceReadApiKey={readApiKey} onModelServiceCheck={check} onBack={vi.fn()} />);
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
    expect(readApiKey).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '保存配置' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '检测模型' }));
    expect(await screen.findByText(/模型检测超时/)).toBeInTheDocument();
    const details = screen.getByText('检测详情').closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(within(details!).getByText('MODEL_SERVICE_CHECK_TIMEOUT')).toBeInTheDocument();
    expect(within(details!).getByText('HTTP 状态：200')).toBeInTheDocument();
    expect(within(details!).getByText('等待模型文本超时')).toBeInTheDocument();
    expect(check).toHaveBeenCalledWith(undefined);
  });

  it.each([
    [false, 'response_headers', '等待接口响应', '响应头：未收到'],
    [true, 'model_text', '等待模型文本', '响应头：已收到']
  ] as const)('shows observed progress and advice without expanding technical details (%s)', async (headersReceived, stage, stageLabel, headersLabel) => {
    const check = vi.fn().mockResolvedValue({
      status: 'failed', headersReceived, responseReceived: false, stage,
      errorCode: 'MODEL_SERVICE_CONNECTION_RESET', transportCode: 'ECONNRESET',
      message: '模型接口连接中断', suggestion: '请检查上游与代理转发。'
    });
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} initialTab="model" modelServiceMode="platform_managed"
      modelServiceConfiguration={{ baseUrl: 'https://platform.example.test/v1', model: 'model-1' }}
      onModelServiceCheck={check} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '检测模型' }));
    expect(await screen.findByText('模型接口连接中断')).toBeInTheDocument();
    expect(screen.getByText(headersLabel)).toBeInTheDocument();
    expect(screen.getByText('模型文本：未收到')).toBeInTheDocument();
    expect(screen.getByText('建议：请检查上游与代理转发。')).toBeInTheDocument();
    const details = screen.getByText('检测详情').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText(`检测阶段：${stageLabel}`)).toBeInTheDocument();
    expect(within(details).getByText('ECONNRESET')).toBeInTheDocument();
    expect(check).toHaveBeenCalledOnce();
  });

  it('shows actionable proxy details without asking the user to change the API key', async () => {
    const check = vi.fn().mockResolvedValue({
      status: 'failed',
      message: 'HTTP 代理无法连接模型服务',
      suggestion: '请检查代理地址、端口和访问白名单。',
      errorCode: 'MODEL_SERVICE_PROXY_CONNECT_FAILED',
      proxyErrorCode: 'PROXY_CONNECT_FAILED',
      networkPath: 'http_proxy',
      proxyEnvKeys: ['HTTPS_PROXY'],
      proxyApplies: true,
      proxyStage: 'connect',
      requestId: 'request-123'
    });
    render(<ClaweeSettingsView runtimeStatus={runtimeStatus} initialTab="model" modelServiceMode="platform_managed"
      modelServiceConfiguration={{ baseUrl: 'https://platform.example.test/v1', model: 'model-1' }}
      onModelServiceCheck={check} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '检测模型' }));
    expect(await screen.findByText('HTTP 代理无法连接模型服务')).toBeInTheDocument();
    expect(screen.getByText('建议：请检查代理地址、端口和访问白名单。')).toBeInTheDocument();
    const details = screen.getByText('检测详情').closest('details')!;
    expect(within(details).getByText('网络路径：HTTP Proxy')).toBeInTheDocument();
    expect(within(details).getByText('代理变量：HTTPS_PROXY')).toBeInTheDocument();
    expect(within(details).getByText('代理阶段：连接代理')).toBeInTheDocument();
    expect(within(details).getByText('PROXY_CONNECT_FAILED')).toBeInTheDocument();
    expect(within(details).getByText('request-123')).toBeInTheDocument();
    expect(screen.queryByText(/API Key 无效/)).not.toBeInTheDocument();
  });

  it('groups model actions and shows elapsed time until the check completes', async () => {
    vi.useFakeTimers();
    let finishCheck!: (result: CodexAvailabilityProbe) => void;
    const check = vi.fn(() => new Promise<CodexAvailabilityProbe>(resolve => { finishCheck = resolve; }));
    const configure = vi.fn();
    const view = render(<ClaweeSettingsView runtimeStatus={runtimeStatus} initialTab="model"
      modelServiceConfiguration={{ baseUrl: 'https://api.example.test/v1', model: 'model-1' }}
      onModelServiceCheck={check} onModelServiceConfigure={configure} onBack={vi.fn()} />);
    try {
      fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'secret-key' } });
      const checkButton = screen.getByRole('button', { name: '检测模型' });
      const saveButton = screen.getByRole('button', { name: '保存配置' });
      expect(checkButton.parentElement).toBe(saveButton.parentElement);
      expect(checkButton).toHaveClass('settings-secondary-button');
      fireEvent.click(checkButton);
      expect(screen.getByRole('status')).toHaveTextContent('正在检测模型接口');
      expect(screen.getByText(/已用时 0 秒/)).toHaveTextContent('模型：model-1');
      expect(checkButton).toBeDisabled();
      expect(saveButton).toBeDisabled();
      expect(screen.getByLabelText('模型名字')).toBeDisabled();
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(screen.getByText(/已用时 10 秒/)).toBeInTheDocument();
      expect(screen.getByText('检测仍在进行，尚未收到结果')).toBeInTheDocument();
      await act(async () => { finishCheck({ status: 'succeeded', durationMs: 10_200 }); });
      expect(screen.getByRole('status')).toHaveTextContent('接口检测通过');
      expect(screen.getByText(/首段文本耗时：10.2 秒/)).toBeInTheDocument();
      expect(screen.queryByText(/已用时/)).not.toBeInTheDocument();
      expect(checkButton).toBeEnabled();
      expect(saveButton).toBeEnabled();
      expect(configure).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('shows rejected checks inline and clears the timer on unmount', async () => {
    const check = vi.fn().mockRejectedValue(new Error('本地模型检测服务不可用'));
    const view = render(<ClaweeSettingsView runtimeStatus={runtimeStatus} initialTab="model"
      modelServiceMode="platform_managed" onModelServiceCheck={check} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '检测模型' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('本地模型检测服务不可用'));
    expect(screen.getByRole('button', { name: '检测模型' })).toBeEnabled();
    view.unmount();
    vi.useFakeTimers();
    const pendingView = render(<ClaweeSettingsView runtimeStatus={runtimeStatus} initialTab="model"
      modelServiceMode="platform_managed" onModelServiceCheck={() => new Promise(() => undefined)} onBack={vi.fn()} />);
    try {
      fireEvent.click(screen.getByRole('button', { name: '检测模型' }));
      expect(vi.getTimerCount()).toBe(1);
      pendingView.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pendingView.unmount();
      vi.useRealTimers();
    }
  });

  it('notifies when the global default permission changes after confirmation', async () => {
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
    const dialog = await screen.findByRole('alertdialog', { name: '开启完全访问权限' });
    fireEvent.click(within(dialog).getByRole('button', { name: '开启' }));

    await waitFor(() => expect(onDefaultPermissionChange).toHaveBeenCalledWith('danger-full-access'));
  });

  it('keeps the existing permission when full access confirmation is canceled', async () => {
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
    const dialog = await screen.findByRole('alertdialog', { name: '开启完全访问权限' });
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
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
    const defaultAccent = within(accentControl).getByRole('radio', { name: '默认黄' });
    expect(defaultAccent).toHaveAttribute('aria-checked', 'true');
    expect(defaultAccent).toHaveStyle({ '--settings-accent-swatch': '#fade1f' });
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
    expect(screen.queryByText('客户端版本更新')).not.toBeInTheDocument();

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
