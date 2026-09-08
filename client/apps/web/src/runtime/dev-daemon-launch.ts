import { isAbsolute } from 'node:path';

export const WEB_E2E_ENTERPRISE_CONFIG_ENV =
  'CLAWEE_WEB_E2E_ENTERPRISE_CONFIG';
export const WEB_E2E_RUN_ID_ENV = 'CLAWEE_WEB_E2E_RUN_ID';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DevDaemonLaunch = {
  script: 'dev' | 'dev:e2e';
  runtimeArgs: string[];
  env: NodeJS.ProcessEnv;
};

export function resolveDevDaemonLaunch(
  sourceEnv: NodeJS.ProcessEnv
): DevDaemonLaunch {
  const runId = normalizedValue(sourceEnv[WEB_E2E_RUN_ID_ENV]);
  const configPath = normalizedValue(
    sourceEnv[WEB_E2E_ENTERPRISE_CONFIG_ENV]
  );
  const env = { ...sourceEnv };
  delete env[WEB_E2E_RUN_ID_ENV];
  delete env[WEB_E2E_ENTERPRISE_CONFIG_ENV];

  if (runId === undefined && configPath === undefined) {
    return {
      script: 'dev',
      runtimeArgs: [],
      env
    };
  }
  if (
    runId === undefined
    || configPath === undefined
    || !UUID_PATTERN.test(runId)
    || !isAbsolute(configPath)
  ) {
    throw new Error('WEB_E2E_ENTERPRISE_CONFIG_INVALID');
  }
  return {
    script: 'dev:e2e',
    runtimeArgs: [
      `--clawee-enterprise-config=${configPath}`,
      `--clawee-enterprise-e2e-run-id=${runId}`,
      '--clawee-enterprise-e2e-authorized=packaged-app'
    ],
    env
  };
}

function normalizedValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}
