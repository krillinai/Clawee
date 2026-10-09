import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopUpdateState } from '@clawee/protocol';
import type { DesktopHostResult } from '../shared/types.js';

export type CustomerUpdatePackage = {
  platform: 'macos' | 'windows';
  arch: 'arm64' | 'x64';
  url: string;
  sha512: string;
  size: number;
};

export type CustomerUpdateRelease = {
  kind: 'customer-desktop-update';
  gateway_url: string;
  version: string;
  notes: string;
  packages: CustomerUpdatePackage[];
  revision: number;
  published_at: string;
};

export type NativeUpdateAdapter = {
  check(feed: string): Promise<unknown>;
  download(release: CustomerUpdateRelease, artifact: CustomerUpdatePackage): Promise<void>;
  verify(artifact: CustomerUpdatePackage): Promise<void>;
  install(authorizeQuit: () => void): Promise<void>;
  onProgress(listener: (percent: number) => void): void;
};

type UpdateInput = {
  gateway?: string;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  native?: NativeUpdateAdapter;
  readRelease(gateway: string): Promise<unknown>;
  prepare(): Promise<void>;
  stop(): Promise<void>;
  recover(): Promise<void>;
};

export class CustomerUpdateController extends EventEmitter<{
  state: [DesktopUpdateState];
}> {
  private state: DesktopUpdateState;
  private approved?: CustomerUpdateRelease;
  private downloaded?: CustomerUpdateRelease;
  private work?: Promise<DesktopHostResult>;
  private operation?: 'check' | 'download' | 'install';
  private timer?: NodeJS.Timeout;
  private quitAuthorized = false;

  constructor(private readonly input: UpdateInput) {
    super();
    this.state = {
      supported: input.gateway !== undefined && input.native !== undefined
        && supportedTarget(input.platform, input.arch),
      status: 'idle',
      currentVersion: input.currentVersion
    };
    input.native?.onProgress(percent => {
      if (this.state.status === 'downloading' && Number.isFinite(percent)) {
        this.update({ ...this.state, progress: Math.max(0, Math.min(100, percent)) });
      }
    });
  }

  get currentState(): DesktopUpdateState {
    return structuredClone(this.state);
  }

  get installationPending(): boolean {
    return this.operation === 'install';
  }

  get canQuitForInstall(): boolean {
    return this.quitAuthorized;
  }

  start(): void {
    if (!this.state.supported || this.timer !== undefined) return;
    void this.checkForUpdates();
    this.timer = setInterval(() => { void this.checkForUpdates(); }, 5 * 60_000);
    this.timer.unref();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  checkForUpdates(): Promise<DesktopHostResult> {
    return this.run('check', async () => {
      this.update({ ...this.state, status: 'checking', error: undefined });
      const release = await this.readRelease();
      if (release === undefined) {
        this.approved = undefined;
        this.downloaded = undefined;
        this.update({ supported: true, currentVersion: this.input.currentVersion, status: 'idle' });
        return;
      }
      assertNativeMetadata(await this.input.native!.check(this.feed(release)), release, this.artifact(release));
      const alreadyDownloaded = this.downloaded !== undefined && sameRelease(this.downloaded, release);
      if (alreadyDownloaded) await this.verifyDownloaded(release);
      this.approved = release;
      if (!alreadyDownloaded) this.downloaded = undefined;
      this.update({
        supported: true,
        currentVersion: this.input.currentVersion,
        status: alreadyDownloaded ? 'downloaded' : 'available',
        version: release.version,
        notes: release.notes,
        ...(alreadyDownloaded ? { progress: 100 } : {})
      });
    });
  }

  downloadUpdate(): Promise<DesktopHostResult> {
    return this.run('download', async () => {
      const release = this.approved;
      if (release === undefined) throw new Error('请先检查客户更新');
      await this.assertCurrent(release);
      if (this.downloaded !== undefined && sameRelease(this.downloaded, release)) {
        try {
          await this.verifyDownloaded(release);
          this.update({ ...this.state, status: 'downloaded', progress: 100, error: undefined });
          return;
        } catch {
          this.downloaded = undefined;
        }
      }
      assertNativeMetadata(await this.input.native!.check(this.feed(release)), release, this.artifact(release));
      this.downloaded = undefined;
      this.update({ ...this.state, status: 'downloading', progress: 0, error: undefined });
      await this.input.native!.download(release, this.artifact(release));
      await this.assertCurrent(release);
      this.downloaded = release;
      this.update({ ...this.state, status: 'downloaded', progress: 100 });
    });
  }

  installUpdate(): Promise<DesktopHostResult> {
    return this.run('install', async () => {
      const release = this.downloaded;
      if (release === undefined) throw new Error('请先下载并校验客户更新');
      await this.assertCurrent(release);
      await this.verifyDownloaded(release);
      let preparationAttempted = false;
      try {
        preparationAttempted = true;
        await this.input.prepare();
        await this.assertCurrent(release);
        this.update({ ...this.state, status: 'installing', error: undefined });
        await this.input.stop();
        await this.assertCurrent(release);
        await this.verifyDownloaded(release);
        await this.input.native!.install(() => { this.quitAuthorized = true; });
        this.dispose();
      } catch (error) {
        this.quitAuthorized = false;
        if (preparationAttempted) await this.input.recover();
        throw error;
      }
    });
  }

  private run(operation: 'check' | 'download' | 'install', action: () => Promise<void>): Promise<DesktopHostResult> {
    if (!this.state.supported) {
      return Promise.resolve({ ok: false, code: 'UNSUPPORTED', message: '此安装包不支持客户更新' });
    }
    if (this.work !== undefined) {
      if (operation === this.operation || operation === 'check') return this.work;
      return Promise.resolve({ ok: false, code: 'FAILED', message: '另一更新操作正在进行，请稍后重试' });
    }
    this.operation = operation;
    this.work = Promise.resolve().then(action).then((): DesktopHostResult => ({ ok: true }))
      .catch((error: unknown): DesktopHostResult => {
        const message = error instanceof Error ? error.message : '客户更新失败，请重试';
        this.update({ ...this.state, status: 'error', error: message });
        return { ok: false, code: 'FAILED', message };
      }).finally(() => {
        this.operation = undefined;
        this.work = undefined;
      });
    return this.work;
  }

  private update(state: DesktopUpdateState): void {
    this.state = state;
    this.emit('state', this.currentState);
  }

  private async verifyDownloaded(release: CustomerUpdateRelease): Promise<void> {
    try {
      await this.input.native!.verify(this.artifact(release));
    } catch (error) {
      this.downloaded = undefined;
      throw error;
    }
  }

  private async readRelease(): Promise<CustomerUpdateRelease | undefined> {
    const body = await this.input.readRelease(this.input.gateway!);
    if (!isRecord(body) || !('update' in body)) throw new Error('客户更新响应无效');
    if (body.update === null) return undefined;
    const release = validateRelease(body.update, this.input.gateway!);
    if (!newerVersion(release.version, this.input.currentVersion)) return undefined;
    if (!release.packages.some(artifact => this.matchesTarget(artifact))) return undefined;
    return release;
  }

  private async assertCurrent(release: CustomerUpdateRelease): Promise<void> {
    const current = await this.readRelease();
    if (current === undefined || !sameRelease(current, release)) {
      throw new Error('客户更新发布快照已变化，请重新检查并下载');
    }
  }

  private matchesTarget(artifact: CustomerUpdatePackage): boolean {
    return artifact.platform === (this.input.platform === 'darwin' ? 'macos' : 'windows')
      && artifact.arch === this.input.arch;
  }

  private artifact(release: CustomerUpdateRelease): CustomerUpdatePackage {
    const artifact = release.packages.find(value => this.matchesTarget(value));
    if (artifact === undefined) throw new Error('客户更新不包含当前平台');
    return artifact;
  }

  private feed(release: CustomerUpdateRelease): string {
    const artifact = this.artifact(release);
    return `${this.input.gateway}/api/v1/public/client-updates/${release.revision}/${artifact.platform}/${artifact.arch}/`;
  }
}

export function readCustomerUpdateGateway(resourcesPath: string, packaged: boolean): string | undefined {
  if (!packaged) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(join(resourcesPath, 'deployment/customer-update.json'), 'utf8'));
    if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.gateway_url !== 'string') return undefined;
    const url = httpsUrl(value.gateway_url);
    return value.gateway_url === url.origin ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export async function readPublicCustomerRelease(gateway: string): Promise<unknown> {
  const response = await fetch(`${gateway}/api/v1/public/client-updates`, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`客户更新检查失败（${response.status}）`);
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error('客户更新响应过大');
  return JSON.parse(text) as unknown;
}

export function assertNativeMetadata(info: unknown, release: CustomerUpdateRelease, artifact: CustomerUpdatePackage): void {
  if (!isRecord(info) || info.version !== release.version || info.releaseNotes !== release.notes
    || !Array.isArray(info.files) || info.files.length !== 1
    || Object.keys(info).some(key => !['version', 'releaseNotes', 'files', 'path', 'sha512', 'releaseDate'].includes(key))) {
    throw new Error('更新 feed 与批准的发布快照不一致');
  }
  const file: unknown = info.files[0];
  if (!isRecord(file) || file.url !== artifact.url || file.sha512 !== artifact.sha512 || file.size !== artifact.size
    || Object.keys(file).some(key => !['url', 'sha512', 'size'].includes(key))
    || (info.path !== undefined && info.path !== artifact.url)
    || (info.sha512 !== undefined && info.sha512 !== artifact.sha512)) {
    throw new Error('更新包 metadata 与批准的发布快照不一致');
  }
}

function validateRelease(value: unknown, gateway: string): CustomerUpdateRelease {
  if (!isRecord(value) || value.kind !== 'customer-desktop-update' || value.gateway_url !== gateway
    || typeof value.version !== 'string' || !stableVersion(value.version)
    || typeof value.notes !== 'string' || value.notes.length > 20_000
    || !Number.isSafeInteger(value.revision) || Number(value.revision) <= 0
    || typeof value.published_at !== 'string' || !Number.isFinite(Date.parse(value.published_at))
    || !Array.isArray(value.packages) || value.packages.length === 0 || value.packages.length > 3
    || Object.keys(value).some(key => !['kind', 'gateway_url', 'version', 'notes', 'packages', 'revision', 'published_at'].includes(key))) {
    throw new Error('客户更新发布快照无效或不属于此 Gateway');
  }
  const targets = new Set<string>();
  const packages = value.packages.map((artifact: unknown): CustomerUpdatePackage => {
    if (!isRecord(artifact) || (artifact.platform !== 'macos' && artifact.platform !== 'windows')
      || (artifact.arch !== 'arm64' && artifact.arch !== 'x64')
      || (artifact.platform === 'windows' && artifact.arch !== 'x64')
      || typeof artifact.url !== 'string' || artifact.url.length > 4096
      || typeof artifact.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(artifact.sha512)
      || Buffer.from(artifact.sha512, 'base64').toString('base64') !== artifact.sha512
      || !Number.isSafeInteger(artifact.size) || Number(artifact.size) <= 0
      || Object.keys(artifact).some(key => !['platform', 'arch', 'url', 'sha512', 'size'].includes(key))) {
      throw new Error('客户更新包信息无效');
    }
    const url = httpsUrl(artifact.url);
    if (!url.pathname.toLowerCase().endsWith(artifact.platform === 'macos' ? '.zip' : '.exe')) {
      throw new Error('客户更新包格式无效');
    }
    const target = `${artifact.platform}/${artifact.arch}`;
    if (targets.has(target)) throw new Error('客户更新平台重复');
    targets.add(target);
    return { platform: artifact.platform, arch: artifact.arch, url: artifact.url, sha512: artifact.sha512, size: Number(artifact.size) };
  });
  return {
    kind: 'customer-desktop-update', gateway_url: gateway, version: value.version,
    notes: value.notes, revision: Number(value.revision), published_at: value.published_at,
    packages: packages.sort((left, right) => `${left.platform}/${left.arch}`.localeCompare(`${right.platform}/${right.arch}`))
  };
}

function sameRelease(left: CustomerUpdateRelease, right: CustomerUpdateRelease): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('客户更新仅允许 HTTPS 地址');
  return url;
}

function stableVersion(version: string): boolean {
  return version.length <= 64 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    && version.split('.').every(component => Number.isSafeInteger(Number(component)));
}

function newerVersion(version: string, current: string): boolean {
  if (!stableVersion(current)) throw new Error('当前安装包版本不是稳定版本');
  const left = version.split('.').map(BigInt);
  const right = current.split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
}

function supportedTarget(platform: NodeJS.Platform, arch: string): boolean {
  return (platform === 'darwin' && (arch === 'arm64' || arch === 'x64'))
    || (platform === 'win32' && arch === 'x64');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
