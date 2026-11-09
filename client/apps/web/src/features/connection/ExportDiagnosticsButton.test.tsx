import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostBridgeResult } from '../../host/bridge.js';
import { EnterpriseAccountPage } from '../account/EnterpriseAccountPage-2026-07-30.js';
import { DiagnosticsSettingsView } from '../settings/DiagnosticsSettingsView.js';
import { ExportDiagnosticsButton } from './ExportDiagnosticsButton.js';

const originalApi = window.claweeDesktop;
afterEach(() => { window.claweeDesktop = originalApi; });

function installExporter(exportDiagnostics: () => Promise<HostBridgeResult>) {
  window.claweeDesktop = {
    kind: 'desktop', platform: 'darwin', exportDiagnostics
  } as NonNullable<typeof window.claweeDesktop>;
}

describe('ExportDiagnosticsButton', () => {
  it('浏览器或不支持导出的桌面版本不展示入口', () => {
    delete window.claweeDesktop;
    const { rerender } = render(<ExportDiagnosticsButton />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    window.claweeDesktop = { kind: 'desktop', platform: 'darwin' } as NonNullable<typeof window.claweeDesktop>;
    rerender(<ExportDiagnosticsButton />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('导出期间禁止重复操作，成功后提示结果', async () => {
    let finish!: (result: HostBridgeResult) => void;
    const exportDiagnostics = vi.fn(() => new Promise<HostBridgeResult>(resolve => { finish = resolve; }));
    installExporter(exportDiagnostics);
    render(<ExportDiagnosticsButton />);
    await userEvent.click(screen.getByRole('button', { name: '导出诊断' }));
    expect(screen.getByRole('button', { name: '正在导出…' })).toBeDisabled();
    finish({ ok: true });
    expect(await screen.findByRole('status')).toHaveTextContent('诊断文件已导出');
    expect(exportDiagnostics).toHaveBeenCalledOnce();
  });

  it('取消后可再次导出，原生导出异常提供重试提示', async () => {
    const exportDiagnostics = vi.fn<() => Promise<HostBridgeResult>>()
      .mockResolvedValueOnce({ ok: false, code: 'FAILED', message: '已取消导出' })
      .mockRejectedValueOnce(new Error('native failure'));
    installExporter(exportDiagnostics);
    render(<ExportDiagnosticsButton />);
    await userEvent.click(screen.getByRole('button', { name: '导出诊断' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已取消导出');
    await userEvent.click(screen.getByRole('button', { name: '导出诊断' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('诊断导出失败，请重试。');
    expect(screen.getByRole('button', { name: '导出诊断' })).toBeEnabled();
  });

  it('登录页等待 Runtime 时可直接导出，登录仍禁用', async () => {
    const exportDiagnostics = vi.fn(async (): Promise<HostBridgeResult> => ({ ok: true }));
    installExporter(exportDiagnostics);
    const session = { status: 'signed_out', transportSecurity: 'secure_https' } as const;
    render(<EnterpriseAccountPage connected={false} required session={session}
      onLogin={async () => session} onRegister={async () => session}
      onLogout={async () => session} onRefresh={async () => session} />);
    expect(screen.getByText('正在等待本地 Runtime')).toBeInTheDocument();
    expect(document.querySelector('.enterprise-email-submit')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '导出诊断' }));
    expect(exportDiagnostics).toHaveBeenCalledOnce();
  });

  it('设置诊断页在本地服务断连时也能导出', async () => {
    const exportDiagnostics = vi.fn(async (): Promise<HostBridgeResult> => ({ ok: true }));
    installExporter(exportDiagnostics);
    render(<DiagnosticsSettingsView connected={false} />);
    await userEvent.click(screen.getByRole('button', { name: '导出诊断' }));
    expect(exportDiagnostics).toHaveBeenCalledOnce();
  });
});
