import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readCodexRuntimeManifest
} from '../../../scripts/codex-runtime/manifest.mjs';
import {
  prepareCodexRuntime
} from './codex-runtime-assets.mjs';
import {
  normalizeDesktopPlatform
} from './release-platform.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const projectRoot = resolve(desktopDirectory, '../..');
const manifest = readCodexRuntimeManifest(resolve(
  projectRoot,
  'config/codex-runtime.json'
));
const platform = normalizeDesktopPlatform(
  process.env.CLAWEE_DESKTOP_TARGET_PLATFORM ?? process.platform
);
const arch = process.env.CLAWEE_DESKTOP_TARGET_ARCH ?? process.arch;
const testMode = process.env.CLAWEE_CODEX_RUNTIME_TEST_MODE === '1';
const archivePath = process.env.CLAWEE_CODEX_RUNTIME_TEST_ARCHIVE;
const cacheRoot = resolve(
  process.env.CLAWEE_DESKTOP_CACHE_DIR
    ?? resolve(desktopDirectory, '.cache')
);

const result = await prepareCodexRuntime({
  manifest,
  platform,
  arch,
  stagingDirectory: resolve(desktopDirectory, '.pack/codex-runtime'),
  cacheDirectory: resolve(cacheRoot, 'codex-runtime'),
  ...(archivePath === undefined ? {} : { archivePath: resolve(archivePath) }),
  testMode
});

console.log(JSON.stringify(result, null, 2));
