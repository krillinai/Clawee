import { Download } from 'lucide-react';
import { useState } from 'react';
import { readDesktopHostBridge } from '../../host/desktop-bridge.js';
import './export-diagnostics.css';

export function ExportDiagnosticsButton() {
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [failed, setFailed] = useState(false);
  const exportDiagnostics = readDesktopHostBridge()?.exportDiagnostics;
  if (exportDiagnostics === undefined) return null;

  async function handleExport() {
    if (exporting || exportDiagnostics === undefined) return;
    setExporting(true);
    setNotice(undefined);
    setFailed(false);
    try {
      const result = await exportDiagnostics();
      setFailed(!result.ok && result.message !== '已取消导出');
      setNotice(result.ok ? '诊断文件已导出' : result.message);
    } catch {
      setFailed(true);
      setNotice('诊断导出失败，请重试。');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="diagnostics-export">
      <button type="button" disabled={exporting} onClick={() => void handleExport()}>
        <Download size={14} aria-hidden="true" />
        {exporting ? '正在导出…' : '导出诊断'}
      </button>
      {notice ? <p role={failed ? 'alert' : 'status'}>{notice}</p> : null}
    </div>
  );
}
