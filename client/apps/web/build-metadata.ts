import { readFileSync } from 'node:fs';

type PackageManifest = {
  version?: unknown;
};

export const claweeAppVersion = readClaweeAppVersion();

function readClaweeAppVersion(): string {
  const configuredVersion = process.env.CLAWEE_VERSION?.trim();
  if (configuredVersion) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(configuredVersion.replace(/^v/, ''))) {
      throw new Error('CLAWEE_VERSION is invalid');
    }
    return configuredVersion.replace(/^v/, '');
  }
  const manifest = JSON.parse(
    readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8')
  ) as PackageManifest;
  if (
    typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
  ) {
    throw new Error('Desktop package version is missing or invalid');
  }
  return manifest.version;
}
