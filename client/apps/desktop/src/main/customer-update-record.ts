import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CustomerUpdateError } from './customer-update-error.js';

export type UpdateIdentity = { gateway: string; targetVersion: string; platform: string; arch: string; sha512: string };
export type UpdateInstallReceipt = { targetVersion: string; fingerprint: string };
export type UpdateRecord = UpdateIdentity & {
  id: string;
  key: string;
  fromVersion: string;
  phase: 'ready' | 'preparing' | 'native_requested' | 'awaiting_start' | 'succeeded' | 'paused';
  updatedAt: number;
  attempts: number;
  networkFailures: number;
  corruptDownloads: number;
  nextRetryAt: number;
  errorCode?: string;
  recoveryCode?: string;
  test?: { simulatedVersion: string; installReceiptBefore?: string };
};

// revision、下载地址和会话均不参与包身份；本地记录永远不能用作授权来源。
export function updateIdentityKey(identity: UpdateIdentity): string {
  return createHash('sha256').update(JSON.stringify([
    identity.gateway, identity.targetVersion, identity.platform, identity.arch, identity.sha512
  ])).digest('hex');
}

export class CustomerUpdateJournal {
  private records: UpdateRecord[] = [];
  unavailable = false;
  constructor(private readonly path?: string, private readonly observe?: (record: UpdateRecord) => void) {
    if (!path) return;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.unavailable = true;
      return;
    }
    try {
      if (text.length > 1024 * 1024) throw new Error();
      const value = JSON.parse(text) as { schemaVersion?: unknown; records?: unknown };
      if (value.schemaVersion !== 1 || !Array.isArray(value.records) || !value.records.every(validRecord)) throw new Error();
      this.records = value.records;
    } catch {
      try {
        renameSync(path, `${path}.corrupt-${randomUUID()}`);
        this.persist([]);
      } catch { this.unavailable = true; }
    }
  }

  get(identity: UpdateIdentity): UpdateRecord | undefined {
    const record = this.records.find(value => value.key === updateIdentityKey(identity));
    return record && structuredClone(record);
  }

  ensure(identity: UpdateIdentity, fromVersion: string): UpdateRecord {
    if (this.unavailable) throw new Error('UPDATE_RECORD_INVALID');
    const existing = this.get(identity);
    if (existing) return existing;
    const record: UpdateRecord = { ...identity, key: updateIdentityKey(identity), id: randomUUID(), fromVersion,
      phase: 'ready', updatedAt: Date.now(), attempts: 0, networkFailures: 0, corruptDownloads: 0, nextRetryAt: 0 };
    this.save(record);
    return record;
  }

  save(record: UpdateRecord): void {
    if (this.unavailable) throw new CustomerUpdateError('UPDATE_RECORD_WRITE_FAILED', '本地更新记录不可写，自动更新已暂停');
    const next = structuredClone({ ...record, updatedAt: Date.now() });
    const records = [...this.records.filter(value => value.key !== next.key), next];
    try {
      this.persist(records);
    } catch {
      this.unavailable = true;
      throw new CustomerUpdateError('UPDATE_RECORD_WRITE_FAILED', '无法保存本地更新记录，自动更新已暂停');
    }
    this.records = records;
    this.observe?.(structuredClone(next));
  }

  private persist(records: UpdateRecord[]): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify({ schemaVersion: 1, records })); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, this.path);
  }

  latestTest(): UpdateRecord | undefined {
    const record = [...this.records].reverse().find(value => value.test);
    return record && structuredClone(record);
  }

  reconcileStartup(version: string, receipt?: UpdateInstallReceipt): UpdateRecord[] {
    const pending: UpdateRecord[] = [];
    for (const record of [...this.records]) {
      if (record.test && record.platform === 'macos' && record.errorCode
        && ['native_requested', 'awaiting_start'].includes(record.phase)) {
        try { this.save({ ...record, phase: 'paused' }); }
        catch { break; }
        continue;
      }
      // macOS 复测按目标版本和本地初始化确认；Windows 仍检查本次 NSIS 完成记录。
      if (record.test && record.platform === 'windows' && record.fromVersion === record.targetVersion
        && (['native_requested', 'awaiting_start'].includes(record.phase) || record.errorCode === 'LOCAL_INITIALIZATION_FAILED')
        && (!receipt || receipt.targetVersion !== record.targetVersion || receipt.fingerprint === record.test.installReceiptBefore)) {
        try { this.save({ ...record, phase: 'paused', errorCode: 'UPDATE_TEST_INSTALL_UNCONFIRMED' }); }
        catch { break; }
        continue;
      }
      if (record.phase === 'paused' && record.errorCode === 'LOCAL_INITIALIZATION_FAILED' && record.targetVersion === version) {
        pending.push(record); continue;
      }
      if (record.test && record.phase === 'ready') {
        try { this.save({ ...record, phase: 'paused', errorCode: 'INSTALL_INTERRUPTED' }); }
        catch { break; }
        continue;
      }
      if (!['preparing', 'native_requested', 'awaiting_start'].includes(record.phase)) continue;
      if (record.targetVersion === version && record.phase !== 'preparing') {
        pending.push(record);
      } else {
        try { this.save({ ...record, phase: 'paused', errorCode: record.phase === 'preparing' ? 'INSTALL_INTERRUPTED' : 'TARGET_NOT_STARTED' }); }
        catch { break; }
      }
    }
    return pending;
  }
}

function validRecord(value: unknown): value is UpdateRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as UpdateRecord;
  return typeof record.gateway === 'string' && /^https:\/\//.test(record.gateway)
    && typeof record.targetVersion === 'string' && /^\d+\.\d+\.\d+$/.test(record.targetVersion)
    && ['macos', 'windows'].includes(record.platform) && ['arm64', 'x64'].includes(record.arch)
    && typeof record.sha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(record.sha512)
    && typeof record.id === 'string' && /^[a-f0-9-]{36}$/.test(record.id)
    && typeof record.fromVersion === 'string' && record.key === updateIdentityKey(record)
    && (record.test === undefined || (record.test !== null && typeof record.test === 'object'
      && typeof record.test.simulatedVersion === 'string' && /^\d+\.\d+\.\d+$/.test(record.test.simulatedVersion)
      && (record.test.installReceiptBefore === undefined || (typeof record.test.installReceiptBefore === 'string' && record.test.installReceiptBefore.length <= 256))))
    && ['ready', 'preparing', 'native_requested', 'awaiting_start', 'succeeded', 'paused'].includes(record.phase)
    && [record.updatedAt, record.attempts, record.networkFailures, record.corruptDownloads, record.nextRetryAt].every(n => Number.isSafeInteger(n) && n >= 0)
    && [record.errorCode, record.recoveryCode].every(code => code === undefined || /^[A-Z][A-Z0-9_]{0,79}$/.test(code));
}
