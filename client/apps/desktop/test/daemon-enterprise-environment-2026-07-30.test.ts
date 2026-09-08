import { describe, expect, it } from 'vitest';
import {
  buildDaemonArguments,
  buildDaemonEnvironment,
  type DaemonStartInput
} from '../src/main/daemon-manager.js';

const runId = '123e4567-e89b-42d3-a456-426614174000';

describe('Daemon enterprise environment', () => {
  it('removes inherited enterprise configuration from the child environment', () => {
    const environment = buildDaemonEnvironment(createInput({
      env: {
        PATH: '/usr/bin',
        CLAWEE_ENTERPRISE_ORIGIN: 'https://untrusted.example',
        CLAWEE_ENTERPRISE_E2E_RUN_ID:
          '223e4567-e89b-42d3-a456-426614174000',
        CLAWEE_ENTERPRISE_E2E_AUTHORIZED: 'untrusted',
        CLAWEE_ENTERPRISE_KEYRING_SERVICE: 'attacker-service',
        CLAWEE_ENTERPRISE_KEYRING_ACCOUNT: 'attacker-account',
        CLAWEE_ENTERPRISE_CREDENTIAL_PERSISTENCE: 'desktop',
        clawee_enterprise_keyring_account: 'lowercase-attacker-account',
        CLAWEE_MODEL_API_KEY: 'attacker-model-key',
        clawee_model_api_key: 'lowercase-attacker-model-key'
      }
    }));

    expect(environment).toMatchObject({
      PATH: '/usr/bin'
    });
    expect(environment.CLAWEE_ENTERPRISE_ORIGIN).toBeUndefined();
    expect(environment.CLAWEE_ENTERPRISE_E2E_RUN_ID).toBeUndefined();
    expect(environment.CLAWEE_ENTERPRISE_E2E_AUTHORIZED).toBeUndefined();
    expect(environment.CLAWEE_ENTERPRISE_KEYRING_SERVICE).toBeUndefined();
    expect(environment.CLAWEE_ENTERPRISE_KEYRING_ACCOUNT).toBeUndefined();
    expect(environment.clawee_enterprise_keyring_account).toBeUndefined();
    expect(environment.CLAWEE_MODEL_API_KEY).toBeUndefined();
    expect(environment.clawee_model_api_key).toBeUndefined();
    expect(
      environment.CLAWEE_ENTERPRISE_CREDENTIAL_PERSISTENCE
    ).toBeUndefined();
  });

  it('passes the gateway config path and E2E identity as typed arguments', () => {
    expect(buildDaemonArguments(createInput({
      enterpriseE2ERunId: runId
    }))).toEqual([
      '--clawee-enterprise-config=/tmp/enterprise-gateway.json',
      `--clawee-enterprise-e2e-run-id=${runId}`,
      '--clawee-enterprise-e2e-authorized=packaged-app'
    ]);
    expect(buildDaemonArguments(createInput())).toEqual([
      '--clawee-enterprise-config=/tmp/enterprise-gateway.json'
    ]);
  });

  it('does not pass enterprise overrides during an ordinary launch', () => {
    const environment = buildDaemonEnvironment(createInput({
      env: {
        CLAWEE_ENTERPRISE_ORIGIN: 'http://127.0.0.1:1904',
        CLAWEE_ENTERPRISE_E2E_RUN_ID: runId,
        CLAWEE_ENTERPRISE_E2E_AUTHORIZED: 'packaged-app',
        CLAWEE_ENTERPRISE_KEYRING_SERVICE: 'service',
        CLAWEE_ENTERPRISE_KEYRING_ACCOUNT: 'account'
      }
    }));

    expect(environment.CLAWEE_ENTERPRISE_ORIGIN).toBeUndefined();
    expect(environment.CLAWEE_ENTERPRISE_E2E_RUN_ID).toBeUndefined();
    expect(environment.CLAWEE_ENTERPRISE_E2E_AUTHORIZED).toBeUndefined();
    expect(environment.CLAWEE_ENTERPRISE_KEYRING_SERVICE).toBeUndefined();
    expect(environment.CLAWEE_ENTERPRISE_KEYRING_ACCOUNT).toBeUndefined();
  });

  it('passes one structured Runtime descriptor and removes legacy overrides', () => {
    const environment = buildDaemonEnvironment(createInput({
      env: {
        CODEX_BIN: '/tmp/hostile-codex',
        CLAWEE_CODEX_BIN: '/tmp/hostile-clawee-codex',
        CODEX_HOME: '/tmp/hostile-home',
        CLAWEE_CODEX_HOME: '/tmp/hostile-legacy-home'
      }
    }));

    expect(environment.CLAWEE_CODEX_RUNTIME_DESCRIPTOR).toBe(
      JSON.stringify(createInput().runtime)
    );
    expect(environment.CODEX_BIN).toBeUndefined();
    expect(environment.CLAWEE_CODEX_BIN).toBeUndefined();
    expect(environment.CODEX_HOME).toBeUndefined();
    expect(environment.CLAWEE_CODEX_HOME).toBeUndefined();
  });
});

function createInput(
  overrides: Partial<DaemonStartInput> = {}
): DaemonStartInput {
  return {
    entryPath: '/daemon/main.js',
    cwd: '/tmp',
    env: {},
    runtime: {
      candidate: {
        runtimeId: 'codex-rust-v0.146.0-layout-1',
        source: 'embedded-package',
        codexVersion: '0.146.0',
        releaseTag: 'rust-v0.146.0',
        target: 'aarch64-apple-darwin',
        layoutVersion: 1,
        entryPath: '/usr/bin/codex',
        homePath: '/tmp/codex-home',
        contentSha256: 'a'.repeat(64),
        minimumClaweeVersion: '1.0.0',
        migrationSourceHome: null
      },
      previous: null,
      claweeVersion: '1.0.0'
    },
    dataDir: '/tmp/data',
    defaultCwd: '/tmp',
    defaultProjectRoot: '/tmp/project',
    requireProbe: false,
    probeVerified: true,
    enterpriseConfigPath: '/tmp/enterprise-gateway.json',
    ...overrides
  };
}
