import { useState } from 'react';
import type { HostBridge } from '../../host/bridge.js';
import { ConfirmDialog } from '../../components/dialogs/ConfirmDialog.js';
import { ExportDiagnosticsButton } from './ExportDiagnosticsButton.js';

export function RuntimeConnectionNotice(props: {
  hostBridge: Pick<HostBridge, 'restartRuntime'>;
  checkingSession?: boolean;
  onRetry(): Promise<void>;
}) {
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run(restart: boolean) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (restart && props.hostBridge.restartRuntime !== undefined) {
        const result = await props.hostBridge.restartRuntime();
        if (!result.ok) throw new Error(result.message);
      }
      await props.onRetry();
    } catch {
      setError('本地服务恢复失败，请稍后重试或导出诊断。');
    } finally { setBusy(false); }
  }
  return (
    <section className="model-runtime-notice" aria-label="本地服务连接状态">
      <span role="status">{props.checkingSession ? '正在检查登录状态，请稍候。' : '正在恢复本地服务连接，项目和会话暂时无法更新。'}</span>
      <button type="button" disabled={busy} onClick={() => void run(false)}>重试连接</button>
      {props.hostBridge.restartRuntime !== undefined ? (
        <button type="button" disabled={busy} onClick={() => setConfirmRestart(true)}>重启本地服务</button>
      ) : null}
      <ExportDiagnosticsButton />
      {error ? <span role="alert">{error}</span> : null}
      <ConfirmDialog
        open={confirmRestart}
        title="重启本地服务？"
        description="这会中断正在执行的任务，已保存的项目和会话会保留。"
        confirmLabel="确认重启"
        onCancel={() => setConfirmRestart(false)}
        onConfirm={() => { setConfirmRestart(false); void run(true); }}
      />
    </section>
  );
}
