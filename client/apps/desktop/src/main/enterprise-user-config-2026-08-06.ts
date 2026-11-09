import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import TOML from '@iarna/toml';
import type { DesktopUpdateConnection } from '@clawee/protocol';

export const ENTERPRISE_CONFIG_FILENAME = 'config.toml';

export type PreparedEnterpriseUserConfig = {
  path: string;
};

export function readConfiguredUpdateConnection(path: string): DesktopUpdateConnection | null {
  try {
    const config = TOML.parse(readFileSync(path, 'utf8'));
    if (typeof config.gateway !== 'string') return null;
    const gateway = new URL(config.gateway.trim());
    if (gateway.protocol !== 'https:' || gateway.username || gateway.password
      || gateway.pathname !== '/' || gateway.search || gateway.hash || gateway.hostname === 'enterprise.invalid') return null;
    return { gateway: gateway.origin };
  } catch { return null; }
}

export function prepareEnterpriseUserConfig(input: {
  bundledPath: string;
  userPath: string;
}): PreparedEnterpriseUserConfig {
  if (!existsSync(input.userPath)) {
    writeUserConfig(
      input.userPath,
      readFileSync(input.bundledPath, 'utf8')
    );
  }
  return { path: input.userPath };
}

function writeUserConfig(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, contents, { mode: 0o600 });
  renameSync(temporaryPath, path);
}
