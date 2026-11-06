import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureDesktopE2EEvidence,
  parseWindowsProcessList,
  selectProcessTree
} from '../e2e/desktop-e2e-evidence.js';

describe('Desktop E2E evidence', () => {
  it('includes descendants even after their root process exits', () => {
    const processes = [
      { pid: 4, parentPid: 3, name: 'command' },
      { pid: 3, parentPid: 2, name: 'codex' },
      { pid: 8, parentPid: 7, name: 'unrelated' }
    ];
    expect(selectProcessTree(processes, [2])).toEqual(processes.slice(0, 2));
    expect(selectProcessTree(processes, [])).toEqual([]);
  });

  it('parses both single and multiple Windows process records', () => {
    const record = { ProcessId: 42, ParentProcessId: 41, Name: 'codex.exe' };
    const expected = [{ pid: 42, parentPid: 41, name: 'codex.exe' }];
    expect(parseWindowsProcessList(JSON.stringify(record))).toEqual(expected);
    expect(parseWindowsProcessList(JSON.stringify([record]))).toEqual(expected);
    expect(parseWindowsProcessList('null')).toEqual([]);
  });

  it('persists sanitized logs and process evidence before fixture removal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-e2e-evidence-'));
    const userData = join(root, 'user-data');
    const outputDir = join(root, 'evidence');
    try {
      mkdirSync(join(userData, 'logs'), { recursive: true });
      writeFileSync(join(userData, 'logs', 'desktop-main.log'), JSON.stringify({
        message: 'Daemon Utility Process ready',
        details: { pid: process.pid, token: 'fixture-secret' }
      }) + '\n');
      await captureDesktopE2EEvidence({
        userData, rootPids: [], outputDir,
        details: { mode: 'running', password: 'another-secret', durationMs: 5_500 }
      });
      rmSync(userData, { recursive: true });
      const log = readFileSync(join(outputDir, 'desktop-main.log'), 'utf8');
      const snapshot = readFileSync(join(outputDir, 'process-tree.json'), 'utf8');
      expect(log).not.toContain('fixture-secret');
      expect(snapshot).not.toContain('another-secret');
      expect(JSON.parse(snapshot)).toMatchObject({
        rootPids: [process.pid], details: { mode: 'running', durationMs: 5_500 }
      });
      expect(JSON.parse(snapshot).processes).toEqual(expect.arrayContaining([
        expect.objectContaining({ pid: process.pid })
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
