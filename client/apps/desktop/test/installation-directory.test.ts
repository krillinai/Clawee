import { describe, expect, it } from 'vitest';
import { resolveInstallationDirectory } from '../src/shared/installation-directory.js';

describe('客户端安装目录解析', () => {
  it('解析 macOS 应用包目录', () => {
    expect(resolveInstallationDirectory(
      'darwin',
      '/Applications/Clawee.app/Contents/Resources',
      true
    )).toBe('/Applications/Clawee.app');
  });

  it('解析 Windows 安装目录', () => {
    expect(resolveInstallationDirectory(
      'win32',
      String.raw`C:\Program Files\Clawee\resources`,
      true
    )).toBe(String.raw`C:\Program Files\Clawee`);
  });

  it('解析 Linux resources 上级目录', () => {
    expect(resolveInstallationDirectory(
      'linux',
      '/opt/Clawee/resources',
      true
    )).toBe('/opt/Clawee');
  });

  it('开发环境不返回伪安装目录', () => {
    expect(resolveInstallationDirectory(
      'darwin',
      '/Users/test/Clawee/client/apps/desktop/resources',
      false
    )).toBeUndefined();
  });

  it('缺少 Electron resources 路径时安全返回未设置', () => {
    expect(resolveInstallationDirectory('darwin', undefined, true)).toBeUndefined();
  });
});
