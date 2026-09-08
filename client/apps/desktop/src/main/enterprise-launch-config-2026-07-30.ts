import { isAbsolute } from 'node:path';

const ENTERPRISE_E2E_ARGUMENT = '--clawee-enterprise-e2e';
const ENTERPRISE_E2E_CONFIG_ARGUMENT = '--clawee-enterprise-e2e-config';
const ENTERPRISE_E2E_HOME_ARGUMENT = '--clawee-enterprise-e2e-home';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DesktopEnterpriseLaunchConfig = {
  enterpriseE2ERunId?: string;
  enterpriseE2EConfigPath?: string;
  enterpriseE2EHomeDir?: string;
};

export function resolveDesktopEnterpriseLaunchConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): DesktopEnterpriseLaunchConfig {
  const argumentValues = argumentValuesFor(argv, ENTERPRISE_E2E_ARGUMENT);
  const configPathValues = argumentValuesFor(
    argv,
    ENTERPRISE_E2E_CONFIG_ARGUMENT
  );
  const homeDirValues = argumentValuesFor(
    argv,
    ENTERPRISE_E2E_HOME_ARGUMENT
  );
  const environmentRunId = normalizedValue(
    env.CLAWEE_ENTERPRISE_E2E_RUN_ID
  );
  const environmentHomeDir = normalizedValue(
    env.CLAWEE_ENTERPRISE_E2E_HOME
  );
  const hasE2ESignal =
    argumentValues.length > 0
    || configPathValues.length > 0
    || homeDirValues.length > 0
    || environmentRunId !== undefined
    || environmentHomeDir !== undefined;

  if (!hasE2ESignal) return {};

  const argumentRunId = argumentValues[0];
  const configPath = configPathValues[0];
  const homeDir = homeDirValues[0];
  if (
    argumentValues.length !== 1
    || configPathValues.length !== 1
    || homeDirValues.length > 1
    || argumentRunId === undefined
    || configPath === undefined
    || environmentRunId === undefined
    || argumentRunId !== environmentRunId
    || !UUID_PATTERN.test(argumentRunId)
    || !isAbsolute(configPath)
  ) {
    throw new Error('ENTERPRISE_E2E_CONFIG_FORBIDDEN');
  }
  if (
    (homeDir === undefined) !== (environmentHomeDir === undefined)
    || (
      homeDir !== undefined
      && (
        environmentHomeDir !== homeDir
        || !isAbsolute(homeDir)
      )
    )
  ) {
    throw new Error('ENTERPRISE_E2E_CONFIG_FORBIDDEN');
  }

  return {
    enterpriseE2ERunId: argumentRunId,
    enterpriseE2EConfigPath: configPath,
    ...(homeDir === undefined
      ? {}
      : { enterpriseE2EHomeDir: homeDir })
  };
}

function argumentValuesFor(
  argv: readonly string[],
  name: string
): Array<string | undefined> {
  return argv
    .filter(argument => (
      argument === name || argument.startsWith(`${name}=`)
    ))
    .map(argument => (
      argument === name
        ? undefined
        : normalizedValue(argument.slice(name.length + 1))
    ));
}

function normalizedValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}
