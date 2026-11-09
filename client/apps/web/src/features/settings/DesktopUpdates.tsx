import type { DesktopUpdateState } from '@clawee/protocol';
import { CircleCheck, Download, RefreshCw, RotateCw, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/dialogs/ConfirmDialog.js';
import type { HostBridge } from '../../host/bridge.js';
import { readJsonFromStorage, writeJsonToStorage } from '../../storage/browser-storage.js';

type UpdateAction = 'checkForUpdates' | 'downloadUpdate' | 'installUpdate' | 'testUpdate' | 'cancelUpdateTest';

export type DesktopUpdates = {
  state: DesktopUpdateState | null;
  busy: boolean;
  error?: string;
  canTest?: boolean;
  perform(action: UpdateAction, simulatedVersion?: string): Promise<void>;
};

export function useDesktopUpdates(host: HostBridge): DesktopUpdates {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const operationPending = useRef<HostBridge | null>(null);
  const activeHost = useRef<HostBridge | null>(host);

  useEffect(() => {
    activeHost.current = host;
    setState(null);
    setError(undefined);
    setPending(false);
    operationPending.current = null;
    if (host.kind !== 'desktop' || !host.readUpdateState || !host.subscribeUpdateState) return;
    let active = true;
    let receivedEvent = false;
    const unsubscribe = host.subscribeUpdateState(next => {
      if (!active) return;
      receivedEvent = true;
      setState(next);
    });
    void host.readUpdateState().then(next => {
      if (active && !receivedEvent) setState(next);
    }).catch(() => {
      if (active && !receivedEvent) setError('无法读取客户更新状态');
    });
    const online = () => { void host.checkForUpdates?.().catch(() => undefined); };
    window.addEventListener('online', online);
    return () => {
      active = false;
      activeHost.current = null;
      unsubscribe();
      window.removeEventListener('online', online);
    };
  }, [host]);

  const perform = useCallback(async (action: UpdateAction, simulatedVersion?: string) => {
    if (action === 'cancelUpdateTest') {
      try {
        const result = await host.cancelUpdateTest?.();
        if (activeHost.current === host && result && !result.ok) setError(result.message);
      } catch { if (activeHost.current === host) setError('无法取消升级测试，请等待当前操作完成'); }
      return;
    }
    const operation = host[action];
    if (!operation || operationPending.current === host || state?.supported !== true) return;
    operationPending.current = host;
    setPending(true);
    setError(undefined);
    try {
      const result = action === 'testUpdate' ? await host.testUpdate!(simulatedVersion ?? '') : await host[action]!();
      if (activeHost.current === host && !result.ok) setError(result.message);
    } catch (reason) {
      if (activeHost.current === host) setError(reason instanceof Error ? reason.message : '更新操作失败，请重试');
    } finally {
      if (operationPending.current === host) operationPending.current = null;
      if (activeHost.current === host) setPending(false);
    }
  }, [host, state?.supported]);

  const busy = pending || state?.status === 'checking' || state?.status === 'downloading' || state?.status === 'verifying' || state?.status === 'installing'
    || state?.nativePending === true || state?.test?.status === 'running' || state?.test?.status === 'waiting';
  return { state, busy, error: error ?? state?.error, perform, canTest: !!host.testUpdate && !!host.cancelUpdateTest };
}

function statusText(state: DesktopUpdateState): string {
  switch (state.status) {
    case 'checking': return '正在检查客户更新';
    case 'available': return `客户版本 ${state.version} 已发布`;
    case 'downloading': return `正在下载 ${Math.round(state.progress ?? 0)}%`;
    case 'verifying': return '正在校验更新包';
    case 'downloaded': return '更新包已下载并校验，可以安装';
    case 'waiting': return (state.deferredUntil ?? 0) > Date.now() ? '已推迟安装一小时' : '更新已就绪，等待任务完成和文件保存';
    case 'installing': return '正在准备安装并重启';
    case 'error': return '更新未完成，请重试';
    case 'paused': return state.nativePending ? '已请求原生安装，结果待确认，请退出后重新打开应用' : '此更新的自动安装已暂停';
    default: return '当前没有已发布的新版本';
  }
}

export function DesktopUpdateSettings({ updates }: { updates?: DesktopUpdates }) {
  const state = updates?.state;
  if (!updates || !state) return null;
  if (!state.supported) return updates.canTest ? <section className="settings-card desktop-update-settings">
    <UpdateTestSettings updates={updates} state={state} />
  </section> : null;
  return (
    <section className="settings-card desktop-update-settings" aria-label="客户端版本更新">
      <div className="desktop-update-header">
        <h2>客户端版本更新</h2>
        <button className="settings-secondary-button" type="button" disabled={updates.busy}
          onClick={() => void updates.perform('checkForUpdates')}><RefreshCw size={14} aria-hidden="true" />检查更新</button>
      </div>
      <dl className="desktop-update-metadata">
        <div><dt>当前版本</dt><dd>{state.currentVersion}</dd></div>
        {state.gateway ? <div><dt>更新服务器</dt><dd>{state.gateway}</dd></div> : null}
      </dl>
      {!state.gateway && state.automatic ? <p>等待连接 HTTPS 客户服务器</p> : null}
      <div className="desktop-update-status">
        <div className="desktop-update-status-text" role="status">
          <p>{state.status === 'downloading' ? '正在下载更新' : statusText(state)}</p>
          {state.status === 'downloading' ? <span>{Math.round(state.progress ?? 0)}%</span> : null}
        </div>
        {state.status === 'downloading' ? (
          <progress className="desktop-update-progress" aria-label="更新下载进度" max={100} value={state.progress ?? 0} />
        ) : null}
      </div>
      {state.notes ? <p className="desktop-update-notes">{state.notes}</p> : null}
      {updates.error ? <p className="settings-error" role="alert">{updates.error}</p> : null}
      <UpdateRecovery state={state} />
      {state.status === 'paused' && !state.nativePending ? <button className="settings-secondary-button" type="button" disabled={updates.busy}
        onClick={() => void updates.perform('downloadUpdate')}>重新校验并重试</button> : null}
      {!state.automatic && (state.status === 'available' || state.status === 'downloaded') ? (
        <div className="desktop-update-actions">
          {state.status === 'available' ? (
            <button className="settings-primary-button" type="button" disabled={updates.busy}
              onClick={() => void updates.perform('downloadUpdate')}><Download size={14} aria-hidden="true" />下载更新</button>
          ) : null}
          {state.status === 'downloaded' ? (
            <button className="settings-primary-button" type="button" disabled={updates.busy}
              onClick={() => void updates.perform('installUpdate')}><RotateCw size={14} aria-hidden="true" />安装并重启</button>
          ) : null}
        </div>
      ) : null}
      {updates.canTest ? <UpdateTestSettings updates={updates} state={state} /> : null}
    </section>
  );
}

function UpdateTestSettings({ updates, state }: { updates: DesktopUpdates; state: DesktopUpdateState }) {
  const [simulatedVersion, setSimulatedVersion] = useState('');
  const active = state.test?.status === 'running' || state.test?.status === 'waiting';
  const labels = { running: '正在执行', waiting: '等待安全空闲窗口', pending: '原生安装结果待确认',
    succeeded: '复测通过', failed: '复测未通过', unsupported: '当前安装器不支持此复测', cancelled: '已取消' };
  return <details className="settings-advanced-fields desktop-update-test">
    <summary>升级测试</summary>
    <p>仅本次检查模拟旧版本，实际运行版本仍为 {state.currentVersion}。将安装后台批准的包并重启，任务、文件保存和空闲保护继续生效。</p>
    <p>此复测验证当前客户端的更新流程，不能代替真实旧版本升级和数据迁移验证。</p>
    {state.testUnsupportedReason ? <p role="status">{state.testUnsupportedReason}</p> : null}
    <div className="settings-form-grid desktop-update-test-version">
      <label><span>模拟起始版本</span>
        <input value={simulatedVersion} placeholder="例如 1.0.19" maxLength={64} disabled={updates.busy || !state.supported}
          onChange={event => setSimulatedVersion(event.target.value)} />
      </label>
    </div>
    <p>后台批准版本：{state.version ?? '执行测试时从当前服务器读取'}</p>
    <div className="desktop-update-actions">
      <button className="settings-secondary-button" type="button" disabled={updates.busy || !state.supported || !simulatedVersion.trim()}
        onClick={() => void updates.perform('testUpdate', simulatedVersion.trim())}><RotateCw size={14} aria-hidden="true" />执行一次升级测试</button>
      {active ? <button className="settings-secondary-button" type="button" disabled={state.status === 'installing' || state.nativePending}
        onClick={() => void updates.perform('cancelUpdateTest')}>取消测试</button> : null}
    </div>
    {state.test ? <p role="status">{labels[state.test.status]}（模拟 {state.test.simulatedVersion}）。{state.test.message}</p> : null}
    {state.test?.status === 'failed' ? <a href="https://github.com/krillinai/Clawee/releases" target="_blank" rel="noreferrer">下载官方安装包修复</a> : null}
    {updates.error && !state.supported ? <p className="settings-error" role="alert">{updates.error}</p> : null}
  </details>;
}

const dismissedUpdateKey = 'clawee.desktop.dismissed-update.v1';
const dismissedAutomaticUpdateKey = 'clawee.desktop.dismissed-automatic-update.v1';

export function DesktopUpdateNotice({ updates }: { updates: DesktopUpdates }) {
  const [dismissedVersion, setDismissedVersion] = useState(() => readJsonFromStorage<string>(dismissedUpdateKey));
  const [dismissedAutomaticVersion, setDismissedAutomaticVersion] = useState(() => {
    try { return window.sessionStorage.getItem(dismissedAutomaticUpdateKey); } catch { return null; }
  });
  const state = updates.state;
  const open = state?.supported === true && state.version !== undefined
    && state.version !== dismissedVersion
    && (state.status === 'available' || state.status === 'downloaded' || state.status === 'error');
  const action: UpdateAction = state?.status === 'downloaded' ? 'installUpdate'
    : state?.status === 'error' ? 'checkForUpdates' : 'downloadUpdate';
  function dismiss() {
    if (!state?.version) return;
    if (state.automatic) {
      setDismissedAutomaticVersion(state.version);
      try { window.sessionStorage.setItem(dismissedAutomaticUpdateKey, state.version); } catch {}
    } else {
      setDismissedVersion(state.version);
      try { writeJsonToStorage(dismissedUpdateKey, state.version); } catch {}
    }
  }
  if (state?.automatic) {
    if (!state.version || state.version === dismissedAutomaticVersion
      || !['available', 'downloading', 'verifying', 'downloaded', 'waiting', 'installing', 'paused', 'error'].includes(state.status)) return null;
    const Icon = state.status === 'error' || state.status === 'paused' ? TriangleAlert
      : state.status === 'downloaded' || state.status === 'waiting' ? CircleCheck : Download;
    return (
      <aside className="desktop-update-notice" role="status" aria-label="客户端自动更新">
        <Icon className="desktop-update-notice-icon" size={18} aria-hidden="true" />
        <div className="desktop-update-notice-content">
          <span className="desktop-update-notice-title">客户端更新 · {state.version}</span>
          <span className="desktop-update-notice-text">{statusText(state)}</span>
          {updates.error ? <span className="desktop-update-notice-text" role="alert">{updates.error}</span> : null}
          <UpdateRecovery state={state} />
        </div>
        <button className="icon-button desktop-update-notice-dismiss" type="button" aria-label="关闭更新提示" title="关闭更新提示"
          onClick={dismiss}><X size={16} aria-hidden="true" /></button>
        {state.status === 'paused' && !state.nativePending ? <button className="desktop-update-notice-action" type="button" disabled={updates.busy}
          onClick={() => void updates.perform('downloadUpdate')}>重试</button> : null}
      </aside>
    );
  }
  return (
    <ConfirmDialog open={open} title={`客户版本 ${state?.version ?? ''} 更新`}
      description={<>
        <span>{state ? statusText(state) : ''}。{state?.notes}</span>
        {updates.error ? <span role="alert"> {updates.error}</span> : null}
        {state?.status === 'downloaded' ? <span> 安装将重启应用，有未结束的本地任务时不会安装。</span> : null}
      </>}
      confirmLabel={action === 'installUpdate' ? '安装并重启' : action === 'checkForUpdates' ? '重试检查' : '下载更新'}
      cancelLabel="稍后" busy={updates.busy} onCancel={dismiss}
      onConfirm={() => void updates.perform(action)} />
  );
}

function UpdateRecovery({ state }: { state: DesktopUpdateState }) {
  return <>
    {state.recovery === 'restored' ? <span>工作台已恢复，可以继续工作。</span> : null}
    {state.recovery === 'failed' ? <span role="alert">工作台恢复失败（{state.recoveryCode}），请重新打开应用或使用安装包修复。</span> : null}
    {state.status === 'paused' ? <a href="https://github.com/krillinai/Clawee/releases" target="_blank" rel="noreferrer">官方安装包</a> : null}
  </>;
}
