type BootstrapState = {
  phase:
    | 'idle'
    | 'migrating_data'
    | 'resolving_codex'
    | 'starting_daemon'
    | 'probing_codex'
    | 'starting_runtime'
    | 'ready'
    | 'workspace_failed'
    | 'failed';
  startedAt: string;
  runtimeId?: string;
  runtimeSource?: string;
  runtimeTarget?: string;
  runtimeContentSha256?: string;
  codexEntryPath?: string;
  codexHome?: string;
  error?: { code: string; message: string };
};

type BootstrapApi = {
  windowChrome?: {
    integratedTitleBar: boolean;
    titleBarHeight?: number;
    trafficLightInset?: number;
  };
  readBootstrapState(): Promise<BootstrapState>;
  subscribeBootstrapState(listener: (state: BootstrapState) => void): () => void;
  retryBootstrap(): Promise<unknown>;
  reloadWorkspace(): Promise<unknown>;
  restartRuntime(): Promise<unknown>;
  exportDiagnostics(): Promise<unknown>;
  exportEmergencyFeedback(description: string, screenshots?: import('@clawee/protocol').EmergencyFeedbackScreenshot[]): Promise<{ ok: boolean; message?: string }>;
  quit(): Promise<void>;
  readUpdateState?(): Promise<import('@clawee/protocol').DesktopUpdateState>;
  subscribeUpdateState?(listener: (state: import('@clawee/protocol').DesktopUpdateState) => void): () => void;
  openExternal(url: string): Promise<void>;
};

declare global {
  interface Window {
    claweeDesktop?: BootstrapApi;
  }
}

const api = window.claweeDesktop;
if (api === undefined) throw new Error('Clawee Desktop bridge is unavailable');
if (
  api.windowChrome?.integratedTitleBar === true
  && typeof api.windowChrome.titleBarHeight === 'number'
  && typeof api.windowChrome.trafficLightInset === 'number'
) {
  document.documentElement.dataset.integratedTitleBar = 'true';
  document.documentElement.style.setProperty(
    '--clawee-titlebar-height',
    `${api.windowChrome.titleBarHeight}px`
  );
  document.documentElement.style.setProperty(
    '--clawee-traffic-light-inset',
    `${api.windowChrome.trafficLightInset}px`
  );
}

const title = element('status-title');
const detail = element('status-detail');
const elapsed = element('elapsed');
const statusMark = element('status-mark');
const actions = element('failure-actions');
const workspaceActions = element('workspace-actions');
const technicalDetails = element('technical-details');
const runtimeIdentity = element('runtime-identity');
const codexPath = element('codex-path');
const codexHome = element('codex-home');
const errorCode = element('error-code');
const errorMessage = element('error-message');
let currentState: BootstrapState | undefined;

const labels: Record<BootstrapState['phase'], [string, string]> = {
  idle: ['正在准备 Clawee', '正在初始化桌面环境'],
  migrating_data: ['正在迁移本地数据', '正在校验并复制现有 Clawee Runtime 数据'],
  resolving_codex: ['正在验证 Codex Runtime', '正在校验内嵌运行时和独立数据目录'],
  starting_daemon: ['正在启动本地运行服务', '正在创建独立的 Clawee Runtime'],
  probing_codex: ['正在验证 Codex 是否可用', '正在检查受管理的 Codex 进程'],
  starting_runtime: ['正在打开 Clawee', '正在加载本地数据和 Codex 能力信息'],
  ready: ['正在打开 Clawee', '本地运行环境已就绪'],
  workspace_failed: ['工作台加载失败', '本地 Runtime 仍在运行，可以直接重载工作台或重启 Runtime'],
  failed: ['Codex Runtime 启动失败', '请查看诊断信息后重新检测']
};

void api.readBootstrapState().then(render);
api.subscribeBootstrapState(render);
const renderUpdate = (state: import('@clawee/protocol').DesktopUpdateState) => {
  element('update-recovery').hidden = state.status !== 'paused' && state.recovery !== 'failed';
  element('update-recovery-detail').textContent = `更新未完成，自动安装已暂停。${state.errorCode ?? ''} ${state.recoveryCode ?? ''}。可以导出诊断，重新检测或使用官方安装包修复。`;
};
void api.readUpdateState?.().then(renderUpdate);
api.subscribeUpdateState?.(renderUpdate);
element('update-installer').addEventListener('click', () => void api.openExternal('https://github.com/krillinai/Clawee/releases'));

element('retry').addEventListener('click', () => void api.retryBootstrap());
element('diagnostics').addEventListener('click', () => void api.exportDiagnostics());
let feedbackSubmitting = false;
element('emergency-feedback-form').addEventListener('submit', event => {
  event.preventDefault();
  if (feedbackSubmitting) return;
  void exportFeedback();
});

async function exportFeedback(): Promise<void> {
  const result = element('feedback-result');
  const button = element('emergency-feedback') as HTMLButtonElement;
  const descriptionInput = element('feedback-description') as HTMLTextAreaElement;
  const screenshotInput = element('feedback-screenshots') as HTMLInputElement;
  feedbackSubmitting = true;
  button.disabled = true;
  descriptionInput.readOnly = true;
  screenshotInput.disabled = true;
  button.textContent = '正在导出';
  result.textContent = '';
  result.dataset.failed = 'false';
  try {
    const description = descriptionInput.value.trim();
    if (!description) throw new Error('请填写问题描述。');
    const files = Array.from(screenshotInput.files ?? []);
    if (files.length > 5 || files.some(file => file.size > 10 * 1024 * 1024)) {
      throw new Error('最多添加 5 张截图，每张不超过 10 MiB。');
    }
    const screenshots = await Promise.all(files.map(async file => ({
      content_type: file.type,
      data: new Uint8Array(await file.arrayBuffer())
    })));
    const exported = await api!.exportEmergencyFeedback(description, screenshots);
    result.textContent = exported.ok ? '已导出部分资料，未发送到中心。' : exported.message ?? '导出未完成';
    result.dataset.failed = !exported.ok && exported.message !== '已取消导出' ? 'true' : 'false';
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : '导出失败，请重试。';
    result.dataset.failed = 'true';
  } finally {
    feedbackSubmitting = false;
    button.disabled = false;
    descriptionInput.readOnly = false;
    screenshotInput.disabled = false;
    button.textContent = '导出本地应急反馈';
  }
}
element('quit').addEventListener('click', () => void api.quit());
element('reload-workspace').addEventListener('click', () => void api.reloadWorkspace());
element('restart-runtime').addEventListener('click', () => void api.restartRuntime());
element('workspace-diagnostics').addEventListener('click', () => void api.exportDiagnostics());
element('workspace-quit').addEventListener('click', () => void api.quit());

window.setInterval(() => {
  if (
    currentState === undefined
    || currentState.phase === 'ready'
    || currentState.phase === 'failed'
    || currentState.phase === 'workspace_failed'
  ) {
    elapsed.hidden = true;
    return;
  }
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(currentState.startedAt)) / 1000));
  elapsed.hidden = seconds < 3;
  elapsed.textContent = `已等待 ${seconds} 秒`;
}, 500);

function render(state: BootstrapState): void {
  currentState = state;
  const [nextTitle, nextDetail] = state.phase === 'failed'
    ? failureLabel(state)
    : labels[state.phase];
  title.textContent = nextTitle;
  detail.textContent = nextDetail;
  const failed = state.phase === 'failed';
  const workspaceFailed = state.phase === 'workspace_failed';
  statusMark.dataset.failed = failed || workspaceFailed ? 'true' : 'false';
  actions.hidden = !failed;
  workspaceActions.hidden = !workspaceFailed;
  technicalDetails.hidden = !failed && !workspaceFailed;
  runtimeIdentity.textContent = [
    state.runtimeId,
    state.runtimeSource,
    state.runtimeTarget
  ].filter(Boolean).join(' / ') || '-';
  codexPath.textContent = state.codexEntryPath ?? '-';
  codexHome.textContent = state.codexHome ?? '-';
  errorCode.textContent = state.error?.code ?? '-';
  errorMessage.textContent = state.error?.message ?? '';
}

function failureLabel(state: BootstrapState): [string, string] {
  if (state.error?.code.startsWith('CODEX_RUNTIME_') === true) {
    return ['Codex Runtime 校验失败', state.error.message];
  }
  return labels.failed;
}

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing bootstrap element: ${id}`);
  return value;
}

export {};
