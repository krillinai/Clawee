import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../client/node_modules/@playwright/test/index.mjs';
import { createEmbeddedRuntimeFixture } from '../client/apps/desktop/e2e/embedded-runtime-fixture.js';
import { closePackagedApp, type PackagedApp } from '../client/apps/desktop/e2e/packaged-app.js';
import { readCustomer } from './customer-config.mjs';

test('实际客户 App 首启复制包内地址，覆盖安装保留已有地址和身份', async () => {
  const customer = readCustomer(process.env.CUSTOMER_ID);
  const fixture = await createEmbeddedRuntimeFixture();
  let app: PackagedApp | undefined;
  try {
    const bundled = join(fixture.resourcesRoot, 'deployment/config.toml');
    const bundledContents = readFileSync(bundled, 'utf8');
    expect(bundledContents).toBe(customer.contents);
    expect(createHash('sha256').update(bundledContents).digest('hex')).toBe(customer.configSha256);
    expect(existsSync(join(fixture.resourcesRoot, 'deployment/official-release.json'))).toBe(false);
    // 只保留现有隔离启动入口；删除 fake Gateway 文件，令正式初始化从包内复制。
    const userConfig = join(fixture.root, 'enterprise/config.toml');
    rmSync(userConfig);
    app = await fixture.launch();
    await expect.poll(() => existsSync(userConfig)).toBe(true);
    expect(readFileSync(userConfig, 'utf8')).toBe(bundledContents);
    await expect(app.page).toHaveURL(/^clawee-app:/);
    await closePackagedApp(app);
    app = undefined;
    const existing = 'gateway = "https://existing.example.com"\nagent_id = "clawee_550e8400-e29b-41d4-a716-446655440000"\n';
    writeFileSync(userConfig, existing);
    app = await fixture.launch();
    await expect(app.page).toHaveURL(/^clawee-app:/);
    expect(readFileSync(userConfig, 'utf8')).toBe(existing);
  } finally {
    if (app) await closePackagedApp(app);
    await fixture.dispose();
  }
});
