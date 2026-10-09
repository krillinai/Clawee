import type { DesktopUpdateState } from '@clawee/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/dialogs/ConfirmDialog.js';
import type { HostBridge } from '../../host/bridge.js';
import { readJsonFromStorage, writeJsonToStorage } from '../../storage/browser-storage.js';

type UpdateAction = 'checkForUpdates' | 'downloadUpdate' | 'installUpdate';

export type DesktopUpdates = {
  state: DesktopUpdateState | null;
  busy: boolean;
  error?: string;
  perform(action: UpdateAction): Promise<void>;
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
    return () => {
      active = false;
      activeHost.current = null;
      unsubscribe();
    };
  }, [host]);

  const perform = useCallback(async (action: UpdateAction) => {
    const operation = host[action];
    if (!operation || operationPending.current === host || state?.supported !== true) return;
    operationPending.current = host;
    setPending(true);
    setError(undefined);
    try {
      const result = await operation();
      if (activeHost.current === host && !result.ok) setError(result.message);
    } catch (reason) {
      if (activeHost.current === host) setError(reason instanceof Error ? reason.message : '更新操作失败，请重试');
    } finally {
      if (operationPending.current === host) operationPending.current = null;
      if (activeHost.current === host) setPending(false);
    }
  }, [host, state?.supported]);

  const busy = pending || state?.status === 'checking' || state?.status === 'downloading' || state?.status === 'installing';
  return { state, busy, error: error ?? state?.error, perform };
}

function statusText(state: DesktopUpdateState): string {
  switch (state.status) {
    case 'checking': return '正在检查客户更新';
    case 'available': return `客户版本 ${state.version} 已发布`;
    case 'downloading': return `正在下载 ${Math.round(state.progress ?? 0)}%`;
    case 'downloaded': return '更新包已下载并校验，可以安装';
    case 'installing': return '正在准备安装并重启';
    case 'error': return '更新未完成，请重试';
    default: return '当前没有已发布的新版本';
  }
}

export function DesktopUpdateSettings({ updates }: { updates?: DesktopUpdates }) {
  const state = updates?.state;
  if (!updates || !state?.supported) return null;
  return (
    <section className="settings-card desktop-update-settings" aria-label="客户版本更新">
      <h2>客户版本更新</h2>
      <p>当前版本：{state.currentVersion}。只接收客户管理员发布的更新。</p>
      <p role="status">{statusText(state)}</p>
      {state.notes ? <p className="desktop-update-notes">{state.notes}</p> : null}
      {state.status === 'downloading' ? (
        <progress aria-label="更新下载进度" max={100} value={state.progress ?? 0} />
      ) : null}
      {updates.error ? <p className="settings-error" role="alert">{updates.error}</p> : null}
      <div className="desktop-update-actions">
        <button className="settings-secondary-button" type="button" disabled={updates.busy}
          onClick={() => void updates.perform('checkForUpdates')}>检查更新</button>
        {state.status === 'available' ? (
          <button className="settings-primary-button" type="button" disabled={updates.busy}
            onClick={() => void updates.perform('downloadUpdate')}>下载更新</button>
        ) : null}
        {state.status === 'downloaded' ? (
          <button className="settings-primary-button" type="button" disabled={updates.busy}
            onClick={() => void updates.perform('installUpdate')}>安装并重启</button>
        ) : null}
      </div>
    </section>
  );
}

const dismissedUpdateKey = 'clawee.desktop.dismissed-update.v1';

export function DesktopUpdateNotice({ updates }: { updates: DesktopUpdates }) {
  const [dismissedVersion, setDismissedVersion] = useState(() => readJsonFromStorage<string>(dismissedUpdateKey));
  const state = updates.state;
  const open = state?.supported === true && state.version !== undefined
    && state.version !== dismissedVersion
    && (state.status === 'available' || state.status === 'downloaded' || state.status === 'error');
  const action: UpdateAction = state?.status === 'downloaded' ? 'installUpdate'
    : state?.status === 'error' ? 'checkForUpdates' : 'downloadUpdate';
  function dismiss() {
    if (!state?.version) return;
    setDismissedVersion(state.version);
    try { writeJsonToStorage(dismissedUpdateKey, state.version); } catch {}
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
