import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveDevDaemonLaunch,
  WEB_E2E_ENTERPRISE_CONFIG_ENV,
  WEB_E2E_RUN_ID_ENV
} from './dev-daemon-launch.js';
import {
  withDevelopmentRuntime
} from './development-runtime-env.js';

describe('Vite Runtime daemon launch', () => {
  it('uses the normal development daemon outside Web E2E', () => {
    expect(resolveDevDaemonLaunch({
      CLAWEE_DATA_DIR: '/tmp/clawee-data'
    })).toEqual({
      script: 'dev',
      runtimeArgs: [],
      env: {
        CLAWEE_DATA_DIR: '/tmp/clawee-data'
      }
    });
  });

  it('uses an authorized isolated credential file during Web E2E', () => {
    const configPath = resolve('/tmp/clawee-web-e2e/config.toml');
    const launch = resolveDevDaemonLaunch({
      [WEB_E2E_RUN_ID_ENV]: '123e4567-e89b-42d3-a456-426614174000',
      [WEB_E2E_ENTERPRISE_CONFIG_ENV]: configPath,
      CLAWEE_DATA_DIR: '/tmp/clawee-data'
    });

    expect(launch).toEqual({
      script: 'dev:e2e',
      runtimeArgs: [
        `--clawee-enterprise-config=${configPath}`,
        '--clawee-enterprise-e2e-run-id=123e4567-e89b-42d3-a456-426614174000',
        '--clawee-enterprise-e2e-authorized=packaged-app'
      ],
      env: {
        CLAWEE_DATA_DIR: '/tmp/clawee-data'
      }
    });
  });

  it('keeps the isolated Runtime descriptor during Web E2E', () => {
    const descriptor = JSON.stringify({
      candidate: {
        runtimeId: 'codex-web-e2e-layout-1',
        entryPath: '/tmp/clawee-web-e2e/fake-codex'
      }
    });
    const env = withDevelopmentRuntime({
      CLAWEE_DATA_DIR: '/tmp/clawee-data',
      CLAWEE_CODEX_RUNTIME_DESCRIPTOR: ` ${descriptor} `,
      CODEX_BIN: '/tmp/untrusted-codex',
      CODEX_HOME: '/tmp/untrusted-home'
    }, {
      repoRoot: '/tmp/clawee-repo',
      useProvidedDescriptor: true
    });

    expect(env.CLAWEE_CODEX_RUNTIME_DESCRIPTOR).toBe(descriptor);
    expect(env.CLAWEE_DATA_DIR).toBe('/tmp/clawee-data');
    expect(env.CLAWEE_DEFAULT_CWD).toBe('/tmp/clawee-repo');
    expect(env.CLAWEE_DEFAULT_PROJECT_ROOT).toBe('/tmp/clawee-repo');
    expect(env.CODEX_BIN).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it('requires an isolated Runtime descriptor during Web E2E', () => {
    expect(() => withDevelopmentRuntime({}, {
      repoRoot: '/tmp/clawee-repo',
      useProvidedDescriptor: true
    })).toThrow('WEB_E2E_RUNTIME_DESCRIPTOR_REQUIRED');
  });

  it('rejects partial, malformed, or relative Web E2E configuration', () => {
    for (const env of [
      {
        [WEB_E2E_RUN_ID_ENV]:
          '123e4567-e89b-42d3-a456-426614174000'
      },
      {
        [WEB_E2E_ENTERPRISE_CONFIG_ENV]:
          resolve('/tmp/clawee-web-e2e/config.toml')
      },
      {
        [WEB_E2E_RUN_ID_ENV]: 'not-a-uuid',
        [WEB_E2E_ENTERPRISE_CONFIG_ENV]:
          resolve('/tmp/clawee-web-e2e/config.toml')
      },
      {
        [WEB_E2E_RUN_ID_ENV]:
          '123e4567-e89b-42d3-a456-426614174000',
        [WEB_E2E_ENTERPRISE_CONFIG_ENV]: 'relative/config.toml'
      }
    ]) {
      expect(() => resolveDevDaemonLaunch(env)).toThrow(
        'WEB_E2E_ENTERPRISE_CONFIG_INVALID'
      );
    }
  });
});
