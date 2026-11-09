import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { redactText, redactValue } from '../src/main/redaction.js';

const executeFile = promisify(execFile);

export type ProcessRecord = { pid: number; parentPid: number; name: string };

export function selectProcessTree(
  processes: ProcessRecord[],
  rootPids: number[]
): ProcessRecord[] {
  const selected = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const processRecord of processes) {
      if (selected.has(processRecord.parentPid) && !selected.has(processRecord.pid)) {
        selected.add(processRecord.pid);
        changed = true;
      }
    }
  }
  return processes.filter(processRecord => selected.has(processRecord.pid));
}

export function parseWindowsProcessList(output: string): ProcessRecord[] {
  const parsed: unknown = JSON.parse(output);
  const records = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
  return records.map(record => ({
    pid: Number(record.ProcessId),
    parentPid: Number(record.ParentProcessId),
    name: String(record.Name)
  }));
}

export async function readProcessTree(rootPids: number[]): Promise<ProcessRecord[]> {
  return selectProcessTree(await readProcessList(), rootPids);
}

export async function captureDesktopE2EEvidence(input: {
  userData: string;
  rootPids: number[];
  outputDir: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  mkdirSync(input.outputDir, { recursive: true });
  const rootPids = new Set(input.rootPids);
  for (const filename of ['desktop-main.log.1', 'desktop-main.log']) {
    const path = join(input.userData, 'logs', filename);
    if (!existsSync(path)) continue;
    const contents = readFileSync(path, 'utf8');
    writeFileSync(join(input.outputDir, filename), redactText(contents));
    for (const line of contents.trim().split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (entry.message === 'Daemon Utility Process ready'
          && Number.isInteger(entry.details?.pid)) rootPids.add(entry.details.pid);
      } catch {
        continue;
      }
    }
  }

  let processes: ProcessRecord[] = [];
  let snapshotError: string | undefined;
  try {
    processes = await readProcessTree([...rootPids]);
  } catch (error) {
    snapshotError = error instanceof Error ? error.message : String(error);
  }
  writeFileSync(join(input.outputDir, 'process-tree.json'), JSON.stringify(redactValue({
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    rootPids: [...rootPids],
    processes,
    snapshotError,
    details: input.details
  }), null, 2));
}

async function readProcessList(): Promise<ProcessRecord[]> {
  const options = { encoding: 'utf8' as const, timeout: 5_000, windowsHide: true };
  if (process.platform === 'win32') {
    const executable = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
    );
    const { stdout } = await executeFile(executable, [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'
    ], options);
    return parseWindowsProcessList(stdout);
  }
  const { stdout } = await executeFile('ps', ['-axo', 'pid=,ppid=,comm='], options);
  return stdout.trim().split('\n').map(line => {
    const [, pid, parentPid, name] = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)!;
    return { pid: Number(pid), parentPid: Number(parentPid), name: name! };
  });
}
