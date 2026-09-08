import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveDevDaemonLaunch,
  WEB_E2E_ENTERPRISE_CONFIG_ENV,
  WEB_E2E_RUN_ID_ENV
} from './dev-daemon-launch.js';

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
