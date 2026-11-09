import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { INCIDENT_LOG_MAX_BYTES, type AutomaticIncident } from '@clawee/protocol';
import { captureIncidentLogs } from '../src/main/incident-logs.js';

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, lstatSync: vi.fn(original.lstatSync) };
});

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
it('原始文件缺失时仍附带首次故障原因和请求上下文，诊断凭据保持脱敏', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-incident-logs-')); directories.push(directory);
  const first = { cause_code: 'UND_ERR_CONNECT_TIMEOUT', request_method: 'POST', request_path: '/enterprise/dingtalk/login/prepare', request_id: 'req_gateway',
    error_message: '连接超时 Bearer private-value', additional_details: 'GET https://gateway.test/api/v1/auth/methods；耗时 10516 ms；超时设置 15000 ms；尝试 1/1' };
  const incident = { incident_id: 'incident_1', source: 'web', layer: 'web_daemon', stage: 'request', error_code: 'WEB_HTTP_FAILED', http_status: 503, duration_ms: 10516,
    first_diagnostics: first, diagnostics: { error_message: 'later failure must not replace first cause' } } as AutomaticIncident;
  const text = captureIncidentLogs({ logDir: directory, dataDir: directory, incident });
  const header = JSON.parse(text.split('\n')[0]!);
  expect(header.incident).toMatchObject({ source: 'web', layer: 'web_daemon', stage: 'request', error_code: 'WEB_HTTP_FAILED', http_status: 503, duration_ms: 10516,
    diagnostics: { ...first, error_message: '连接超时 Bearer [REDACTED]' } });
  expect(text).not.toContain('private-value');
  expect(text).not.toContain('later failure');
});
it('采集实际日志内容、标记缺失和截断，不读取会话正文，凭据仍过滤', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-incident-logs-')); directories.push(directory);
  const logDir = join(directory, 'logs'); const dataDir = join(directory, 'daemon');
  mkdirSync(logDir); mkdirSync(join(dataDir, 'runs', 'run_1'), { recursive: true });
  writeFileSync(join(logDir, 'desktop-main.log'), 'old\n'.repeat(30000) + 'timeout at /Users/zhang/work.ts:42 Bearer very-private-value\n');
  writeFileSync(join(dataDir, 'runs', 'run_1', 'stderr.redacted.log'), 'TLS handshake failed ECONNRESET\n');
  writeFileSync(join(dataDir, 'runs', 'run_1', 'events.ndjson'), 'business-prompt-must-not-upload');
  const incident = { incident_id: 'incident_1', run_id: 'run_1' } as AutomaticIncident;
  const text = captureIncidentLogs({ logDir, dataDir, incident });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(INCIDENT_LOG_MAX_BYTES);
  expect(text).toContain('TLS handshake failed ECONNRESET'); expect(text).toContain('/Users/zhang/work.ts:42');
  expect(text).not.toContain('very-private-value'); expect(text).not.toContain('business-prompt-must-not-upload');
  const records = text.trim().split('\n').map(line => JSON.parse(line));
  expect(records.find(record => record.source === 'desktop-main.log.1')).toMatchObject({ missing: true });
  expect(records.find(record => record.source === 'desktop-main.log')).toMatchObject({ truncated: true });
});
it('拒绝日志符号链接并忽略路径穿越的 Run 标识', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-incident-logs-')); directories.push(directory);
  writeFileSync(join(directory, 'private.txt'), 'should-not-read');
  symlinkSync(
    process.platform === 'win32' ? directory : join(directory, 'private.txt'),
    join(directory, 'desktop-main.log'),
    process.platform === 'win32' ? 'junction' : 'file'
  );
  const text = captureIncidentLogs({ logDir: directory, dataDir: directory, incident: { incident_id: 'incident_1', run_id: '../private' } as AutomaticIncident });
  expect(text).not.toContain('should-not-read'); expect(text).not.toContain('runtime-stderr.log');
});
it('rejects a file marked as a symbolic link before opening it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-incident-logs-')); directories.push(directory);
  const logPath = join(directory, 'desktop-main.log.1');
  writeFileSync(logPath, 'should-not-read');
  const stat = fs.lstatSync(logPath, { bigint: true });
  vi.spyOn(stat, 'isSymbolicLink').mockReturnValue(true);
  vi.mocked(fs.lstatSync).mockReturnValueOnce(stat);
  const text = captureIncidentLogs({ logDir: directory, dataDir: directory, incident: { incident_id: 'incident_1' } as AutomaticIncident });
  expect(text).not.toContain('should-not-read');
  expect(text.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ source: 'desktop-main.log.1', missing: true }));
});
it('rejects a log replaced between the path check and opening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-incident-logs-')); directories.push(directory);
  const logPath = join(directory, 'desktop-main.log.1');
  writeFileSync(logPath, 'should-not-read');
  const stat = fs.lstatSync(logPath, { bigint: true });
  vi.mocked(fs.lstatSync).mockReturnValueOnce(Object.assign(stat, { ino: stat.ino + 1n }));
  const text = captureIncidentLogs({ logDir: directory, dataDir: directory, incident: { incident_id: 'incident_1' } as AutomaticIncident });
  expect(text).not.toContain('should-not-read');
  expect(text.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ source: 'desktop-main.log.1', missing: true }));
});
