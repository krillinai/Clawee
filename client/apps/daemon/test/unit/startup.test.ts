import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createProductionServerInput,
  prepareSchedulerStartup,
  resolveEnterpriseStartupArguments,
  resolveProductionServerEnvironment,
  resolveServerModeArguments
} from '../../src/startup.js';

describe('daemon production startup', () => {
  it('keeps Server Mode disabled unless --server is provided', () => {
    expect(resolveServerModeArguments(['node', 'main.js'], '/srv/clawee'))
      .toBeUndefined();
    expect(() => resolveServerModeArguments(
      ['node', 'main.js', '--port=19860'],
      '/srv/clawee'
    )).toThrow('SERVER_MODE_REQUIRED');
  });

  it('parses Server Mode defaults and path overrides', () => {
    expect(resolveServerModeArguments(
      ['node', 'main.js', '--server'],
      '/srv/clawee'
    )).toEqual({
      host: '127.0.0.1',
      port: 19860,
      dataDir: '/srv/clawee/.runtime',
      defaultProjectRoot: '/srv/clawee/.runtime/projects',
      tokenSource: 'file',
      tokenFile: '/srv/clawee/.runtime/server-token',
      webDistDir: '/srv/clawee/apps/web/dist'
    });
    expect(resolveServerModeArguments([
      'node',
      'main.js',
      '--server',
      '--host=0.0.0.0',
      '--port=21000',
      '--data-dir=/var/lib/clawee',
      '--default-project-root=/srv/projects',
      '--token-file=/run/secrets/clawee-token',
      '--web-dist-dir=/opt/clawee/web'
    ], '/srv/clawee')).toEqual({
      host: '0.0.0.0',
      port: 21000,
      dataDir: '/var/lib/clawee',
      defaultProjectRoot: '/srv/projects',
      tokenSource: 'file',
      tokenFile: '/run/secrets/clawee-token',
      webDistDir: '/opt/clawee/web'
    });
  });

  it('rejects invalid Server Mode arguments', () => {
    for (const argv of [
      ['node', 'main.js', '--server', '--port=0'],
      ['node', 'main.js', '--server', '--port=abc'],
      ['node', 'main.js', '--server', '--host'],
      ['node', 'main.js', '--server', '--server']
    ]) {
      expect(() => resolveServerModeArguments(argv, '/srv/clawee'))
        .toThrow('SERVER_MODE_ARGUMENT_INVALID');
    }
  });

  it('enables scheduler autostart and built-in agent tools for the production server', () => {
    const input = createProductionServerInput({
      token: 'runtime-token',
      codexBin: '/opt/clawee/codex-runtime/bin/codex',
      codexHome: '/var/lib/clawee/codex-home'
    });

    expect(input).toMatchObject({
      token: 'runtime-token',
      schedulerAutostart: true,
      agentToolsEnabled: true,
      persistentAppServerEnabled: true
    });
  });

  it('repairs schedule bindings before classifying sessions', () => {
    const steps: string[] = [];

    const result = prepareSchedulerStartup({
      coordinator: {
        ensureBindings() {
          steps.push('repair');
          return { scanned: 2, repaired: 1, failed: 0, unchanged: 1 };
        }
      },
      classifySessions() {
        steps.push('classify');
      }
    });

    expect(steps).toEqual(['repair', 'classify']);
    expect(result).toEqual({ scanned: 2, repaired: 1, failed: 0, unchanged: 1 });
  });

  it('maps isolated runtime paths from non-empty environment variables', () => {
    const runtime = {
      candidate: {
        runtimeId: 'codex-rust-v0.146.0-layout-1',
        source: 'embedded-package',
        codexVersion: '0.146.0',
        releaseTag: 'rust-v0.146.0',
        target: 'aarch64-apple-darwin',
        layoutVersion: 1,
        entryPath: '/tmp/fake-codex',
        homePath: '/tmp/clawee-codex-home',
        contentSha256: 'a'.repeat(64),
        minimumClaweeVersion: '1.0.0',
        migrationSourceHome: null
      },
      previous: null,
      claweeVersion: '1.0.0'
    };
    expect(resolveProductionServerEnvironment({
      CLAWEE_DATA_DIR: ' /tmp/clawee-data ',
      CLAWEE_CODEX_RUNTIME_DESCRIPTOR: JSON.stringify(runtime),
      CLAWEE_DEFAULT_CWD: ' /tmp/default-workspace ',
      CLAWEE_DEFAULT_PROJECT_ROOT: ' /tmp/Documents '
    })).toEqual({
      dataDir: '/tmp/clawee-data',
      codexBin: '/tmp/fake-codex',
      codexHome: '/tmp/clawee-codex-home',
      runtime,
      defaultCwd: '/tmp/default-workspace',
      defaultProjectRoot: '/tmp/Documents'
    });

    expect(() => resolveProductionServerEnvironment({
      CLAWEE_DATA_DIR: ' ',
      CLAWEE_CODEX_RUNTIME_DESCRIPTOR: '',
      CLAWEE_DEFAULT_CWD: '\n',
      CLAWEE_DEFAULT_PROJECT_ROOT: ' '
    })).toThrow('CODEX_RUNTIME_DESCRIPTOR_REQUIRED');
  });

  it('rejects malformed descriptors and legacy Runtime environment variables', () => {
    expect(() => resolveProductionServerEnvironment({
      CLAWEE_CODEX_RUNTIME_DESCRIPTOR: '{broken'
    })).toThrow(/CODEX_RUNTIME_DESCRIPTOR_INVALID/);
    expect(() => resolveProductionServerEnvironment({
      CLAWEE_CODEX_RUNTIME_DESCRIPTOR: JSON.stringify({
        candidate: {
          runtimeId: 'runtime',
          source: 'embedded-package',
          codexVersion: '0.146.0',
          releaseTag: 'rust-v0.146.0',
          target: 'aarch64-apple-darwin',
          layoutVersion: 1,
          entryPath: 'relative/codex',
          homePath: '/tmp/home',
          contentSha256: 'a'.repeat(64),
          minimumClaweeVersion: '1.0.0',
          migrationSourceHome: null
        },
        previous: null,
        claweeVersion: '1.0.0'
      })
    })).toThrow(/CODEX_RUNTIME_DESCRIPTOR_INVALID/);
    expect(() => resolveProductionServerEnvironment({
      CLAWEE_CODEX_RUNTIME_DESCRIPTOR: JSON.stringify({
        candidate: {
          runtimeId: 'runtime',
          source: 'embedded-package',
          codexVersion: '0.146.0',
          releaseTag: 'rust-v0.146.0',
          target: 'aarch64-apple-darwin',
          layoutVersion: 1,
          entryPath: '/tmp/codex',
          homePath: '/tmp/home',
          contentSha256: 'a'.repeat(64),
          minimumClaweeVersion: '1.0.0',
          migrationSourceHome: null
        },
        previous: null,
        claweeVersion: '1.0.0'
      }),
      CODEX_HOME: '/tmp/legacy-home'
    })).toThrow('CODEX_RUNTIME_LEGACY_ENV_FORBIDDEN');
  });

  it('forces development server launchers to replace external Runtime descriptors', () => {
    const startServer = readFileSync(
      resolve(process.cwd(), 'scripts/start-server.mjs'),
      'utf8'
    );
    const prepareRuntime = readFileSync(
      resolve(process.cwd(), 'scripts/prepare-server-runtime.mjs'),
      'utf8'
    );

    expect(startServer).toContain(
      'process.env.CLAWEE_CODEX_RUNTIME_DESCRIPTOR = JSON.stringify'
    );
    expect(startServer).not.toContain(
      'if (!process.env.CLAWEE_CODEX_RUNTIME_DESCRIPTOR'
    );
    expect(prepareRuntime).not.toContain(
      'process.env.CLAWEE_CODEX_RUNTIME_DESCRIPTOR'
    );
    expect(startServer).not.toContain(
      'SERVER_MODE_CODEX_VERSION_MISMATCH'
    );
    expect(startServer).toContain(
      'SERVER_MODE_CODEX_VERSION_UNVALIDATED'
    );
    expect(startServer).toContain('codexVersion: runtime.version');
  });

  it('reads the enterprise gateway and optional E2E identity from arguments', () => {
    const configArgument =
      '--clawee-enterprise-config=/tmp/enterprise-gateway.json';
    expect(resolveEnterpriseStartupArguments(
      ['node', 'main.js', configArgument],
      () => 'https://enterprise.example'
    )).toEqual({
      enterpriseConfigPath: '/tmp/enterprise-gateway.json',
      enterpriseOrigin: 'https://enterprise.example'
    });
    expect(resolveEnterpriseStartupArguments(
      [
        'node',
        'main.js',
        configArgument,
        '--clawee-enterprise-e2e-run-id=123e4567-e89b-42d3-a456-426614174000',
        '--clawee-enterprise-e2e-authorized=packaged-app'
      ],
      () => 'http://127.0.0.1:1904'
    )).toEqual({
      enterpriseConfigPath: '/tmp/enterprise-gateway.json',
      enterpriseOrigin: 'http://127.0.0.1:1904',
      enterpriseE2ERunId: '123e4567-e89b-42d3-a456-426614174000'
    });

    for (const argv of [
      ['node', 'main.js'],
      [
        'node',
        'main.js',
        configArgument,
        '--clawee-enterprise-e2e-run-id=123e4567-e89b-42d3-a456-426614174000'
      ],
      [
        'node',
        'main.js',
        configArgument,
        '--clawee-enterprise-e2e-run-id=not-a-uuid',
        '--clawee-enterprise-e2e-authorized=packaged-app'
      ]
    ]) {
      expect(() => resolveEnterpriseStartupArguments(
        argv,
        () => 'http://127.0.0.1:1904'
      )).toThrow();
    }
  });

  it('rejects enterprise configuration through environment variables', () => {
    for (const env of [
      { CLAWEE_ENTERPRISE_ORIGIN: 'https://enterprise.example' },
      {
        CLAWEE_ENTERPRISE_E2E_RUN_ID:
          '123e4567-e89b-42d3-a456-426614174000'
      },
      { CLAWEE_ENTERPRISE_KEYRING_SERVICE: 'arbitrary-service' },
      { CLAWEE_ENTERPRISE_CREDENTIAL_PERSISTENCE: 'system' }
    ]) {
      expect(() => resolveProductionServerEnvironment(env)).toThrow(
        'ENTERPRISE_ENV_CONFIG_FORBIDDEN'
      );
    }
  });
});
