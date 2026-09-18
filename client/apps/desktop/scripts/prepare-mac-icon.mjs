import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import sharp from 'sharp';

if (process.platform !== 'darwin') {
  throw new Error('生成 macOS 图标需要在 macOS 上运行');
}

const resourcesDir = resolve(import.meta.dirname, '../resources');
const source = join(resourcesDir, 'icon.png');
const output = join(resourcesDir, 'icon.icns');
const temporaryDir = mkdtempSync(join(tmpdir(), 'clawee-mac-icon-'));
const iconset = join(temporaryDir, 'icon.iconset');

try {
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      await sharp(source).resize(pixels, pixels).png().toFile(join(iconset, name));
    }
  }
  // 原生编码避免自动转换器的小尺寸 PNG 图层在 Finder 中解码异常。
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', output], {
    stdio: 'pipe', timeout: 30_000
  });
  console.log(`已生成 macOS 图标：${output}`);
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
