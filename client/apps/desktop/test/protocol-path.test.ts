import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deepLinkToRoute } from '../src/main/deep-link-manager.js';

describe('Desktop deep links', () => {
  it('maps supported links to existing hash routes', () => {
    expect(deepLinkToRoute('clawee://new')).toBe('#/');
    expect(deepLinkToRoute('clawee://tasks')).toBe('#/tasks');
    expect(deepLinkToRoute(
      'clawee://thread/thread%2F%E4%B8%AD%E6%96%87?runId=run%2F1&approvalId=approval%201'
    )).toBe(
      '#/thread/thread%2F%E4%B8%AD%E6%96%87?runId=run%2F1&approvalId=approval+1'
    );
  });

  it('rejects unknown routes and protocols', () => {
    expect(deepLinkToRoute('https://example.com')).toBeUndefined();
    expect(deepLinkToRoute('clawee://unknown')).toBeUndefined();
  });

  it('forces Chinese application localization before Electron becomes ready', () => {
    const mainSource = readFileSync('src/main/main.ts', 'utf8');
    const builderConfig = readFileSync('electron-builder.yml', 'utf8');

    expect(mainSource).toMatch(
      /app\.setName\('Clawee'\);\s*app\.commandLine\.appendSwitch\('lang', 'zh-CN'\);/
    );
    expect(mainSource).not.toContain('disable-lcd-text');
    expect(builderConfig).toContain('CFBundleDevelopmentRegion: zh_CN');
    expect(builderConfig).toContain('CFBundleLocalizations:');
    expect(builderConfig).toContain('- zh-Hans');
  });

  it('uses an Electron-rebuilt daemon runtime during development', () => {
    const packageJson = JSON.parse(
      readFileSync('package.json', 'utf8')
    ) as { scripts: Record<string, string> };
    const mainSource = readFileSync('src/main/main.ts', 'utf8');
    const developmentScript = readFileSync('scripts/dev.mjs', 'utf8');

    expect(packageJson.scripts['build:main']).toContain(
      'scripts/clean-main-dist.mjs'
    );
    expect(mainSource).toContain(
      "resolve(appRoot, '.pack/daemon/dist/main.js')"
    );
    expect(mainSource).toContain(
      'const DEVELOPMENT = !app.isPackaged;'
    );
    expect(mainSource).not.toContain(
      'process.env.CLAWEE_DESKTOP_DEV'
    );
    expect(developmentScript).toContain(
      "['--filter', '@clawee/desktop', 'prepare:daemon']"
    );
    expect(developmentScript).toContain(
      "['--filter', '@clawee/desktop', 'prepare:codex-runtime']"
    );
    expect(developmentScript).toContain('CLAWEE_CODEX_DEV_BIN');
    expect(developmentScript).toContain('CLAWEE_CODEX_DEV_HOME');
    expect(developmentScript).not.toContain(
      'process.env.CLAWEE_CODEX_DEV_BIN'
    );
    expect(developmentScript).not.toContain(
      'process.env.CLAWEE_CODEX_DEV_HOME'
    );
    expect(developmentScript).toContain('syncDevelopmentDaemonDist();');
  });

  it('does not start the Browser development Daemon for Desktop-hosted Web', () => {
    const developmentScript = readFileSync('scripts/dev.mjs', 'utf8');
    const webViteConfig = readFileSync('../web/vite.config.ts', 'utf8');

    expect(developmentScript).toContain(
      "CLAWEE_WEB_DESKTOP_HOSTED: '1'"
    );
    expect(webViteConfig).toContain(
      "const DESKTOP_HOSTED = process.env.CLAWEE_WEB_DESKTOP_HOSTED === '1';"
    );
    expect(webViteConfig).toContain(
      '...(DESKTOP_HOSTED ? [] : [claweeRuntimeDevPlugin()])'
    );
    expect(webViteConfig).not.toContain(
      'if (sourceEnv.CLAWEE_CODEX_RUNTIME_DESCRIPTOR'
    );
    expect(webViteConfig).toContain(
      "'CLAWEE_CODEX_RUNTIME_DESCRIPTOR'"
    );
  });
});
