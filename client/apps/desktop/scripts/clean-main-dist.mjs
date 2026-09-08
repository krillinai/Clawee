import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

rmSync(resolve(scriptDirectory, '../dist/main'), {
  force: true,
  recursive: true
});
