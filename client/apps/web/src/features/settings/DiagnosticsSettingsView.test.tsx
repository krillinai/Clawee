import type { CodexStatusResponse } from '@clawee/protocol';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DiagnosticsSettingsView } from './DiagnosticsSettingsView.js';

const codexStatus: CodexStatusResponse = {
  codexBin: '/opt/homebrew/bin/codex',
  codexVersion: 'codex-cli 2.4.0',
  codexHome: '/Users/test/.codex',
  codexHomeMode: 'global',
  codexHomeSource: 'default',
  codexHomeWritable: true,
  capabilities: {
    mcpAdd: true,
    profiles: true
  },
  availabilityProbe: {
    status: 'succeeded',
    checkedAt: '2026-07-17T00:00:00.000Z',
    durationMs: 900
  },
  runtime: {
    runtimeId: 'codex-rust-v0.146.0-layout-1',
    source: 'embedded-package',
    version: '0.146.0',
    releaseTag: 'rust-v0.146.0',
    target: 'aarch64-apple-darwin',
    layoutVersion: 1,
    entryPath: '/Applications/Clawee.app/Contents/Resources/codex-runtime/bin/codex',
    homePath: '/Users/test/Library/Application Support/Clawee/codex/homes/codex-rust-v0.146.0-layout-1',
    contentSha256: 'a'.repeat(64),
    activationState: 'committed',
    minimumClaweeVersion: '1.0.0',
    committedAt: '2026-08-21T08:00:00.000Z'
  },
  diagnostics: ['MCP github 登录已过期']
};

describe('DiagnosticsSettingsView', () => {
  it('shows runtime, path, capability, and warning details', () => {
    render(
      <DiagnosticsSettingsView
        connected
        runtimeVersion="0.1.0"
        codexStatus={codexStatus}
      />
    );

    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('codex-cli 2.4.0')).toBeInTheDocument();
    expect(screen.getByText('/opt/homebrew/bin/codex')).toBeInTheDocument();
    expect(screen.getByText('/Users/test/.codex')).toBeInTheDocument();
    expect(screen.getByText('MCP github 登录已过期')).toBeInTheDocument();
    expect(screen.getByText(/"mcpAdd": true/)).toBeInTheDocument();
    expect(screen.getByText('可写')).toBeInTheDocument();
    expect(screen.getByText('可正常调用')).toBeInTheDocument();
    expect(screen.getByText('codex-rust-v0.146.0-layout-1')).toBeInTheDocument();
    expect(screen.getByText('embedded-package')).toBeInTheDocument();
    expect(screen.getByText('rust-v0.146.0')).toBeInTheDocument();
    expect(screen.getByText('aarch64-apple-darwin')).toBeInTheDocument();
    expect(screen.getByText('committed（已提交）')).toBeInTheDocument();
    expect(screen.getByText('2026-08-21T08:00:00.000Z')).toBeInTheDocument();
    expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
  });

  it('shows explicit empty and disconnected states', () => {
    const { rerender } = render(
      <DiagnosticsSettingsView
        connected
        runtimeVersion="0.1.0"
        codexStatus={{ ...codexStatus, diagnostics: [] }}
      />
    );

    expect(screen.getByText('当前没有诊断告警')).toBeInTheDocument();

    rerender(
      <DiagnosticsSettingsView
        connected={false}
        runtimeVersion="0.1.0"
      />
    );

    expect(screen.getByText('本地服务未连接，诊断状态可能已过期。')).toBeInTheDocument();
    expect(screen.getAllByText('等待连接')).toHaveLength(2);
  });

  it('adds a recovery action to Runtime integrity diagnostics', () => {
    render(
      <DiagnosticsSettingsView
        connected
        runtimeVersion="0.1.0"
        codexStatus={{
          ...codexStatus,
          diagnostics: [
            'CODEX_RUNTIME_CACHE_INTEGRITY_MISMATCH: cached Runtime changed'
          ]
        }}
      />
    );

    expect(screen.getByText(/请重新安装 Clawee/)).toHaveTextContent(
      'CODEX_RUNTIME_CACHE_INTEGRITY_MISMATCH'
    );
  });
});
