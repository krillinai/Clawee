import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const queryTimeoutMs = 20 * 60_000;
const retryDelays = [10_000, 20_000, 40_000];
const ticketValidationRetryDelays = [...retryDelays, 80_000];

export function notarytoolCredentialArgs(env, teamId) {
  const passwordCredentials = [
    env.APPLE_ID, env.APPLE_APP_SPECIFIC_PASSWORD, env.APPLE_TEAM_ID
  ];
  if (passwordCredentials.some(hasValue)) {
    if (!passwordCredentials.every(hasValue)) {
      throw new Error(
        'APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID '
        + 'must be configured together'
      );
    }
    if (env.APPLE_TEAM_ID.trim() !== teamId) {
      throw new Error(
        `APPLE_TEAM_ID ${env.APPLE_TEAM_ID.trim()} does not match `
        + `the Clawee release Team ID ${teamId}`
      );
    }
    return [
      '--apple-id', env.APPLE_ID.trim(),
      '--password', env.APPLE_APP_SPECIFIC_PASSWORD.trim(),
      '--team-id', env.APPLE_TEAM_ID.trim()
    ];
  }
  const apiKeyCredentials = [
    env.APPLE_API_KEY, env.APPLE_API_KEY_ID, env.APPLE_API_ISSUER
  ];
  if (apiKeyCredentials.some(hasValue)) {
    if (!apiKeyCredentials.every(hasValue)) {
      throw new Error(
        'APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER '
        + 'must be configured together'
      );
    }
    return [
      '--key', env.APPLE_API_KEY.trim(),
      '--key-id', env.APPLE_API_KEY_ID.trim(),
      '--issuer', env.APPLE_API_ISSUER.trim()
    ];
  }
  return [
    '--keychain-profile', env.APPLE_KEYCHAIN_PROFILE?.trim() || 'clawee-notary',
    ...(hasValue(env.APPLE_KEYCHAIN) ? ['--keychain', env.APPLE_KEYCHAIN.trim()] : [])
  ];
}

export async function notarizeArtifact(artifact, credentialArgs, { onSubmitted } = {}) {
  const submitted = spawnSync('xcrun', [
    'notarytool', 'submit', artifact, ...credentialArgs, '--output-format', 'json'
  ], { encoding: 'utf8', timeout: 10 * 60_000 });
  if (submitted.status !== 0) {
    throw new Error(`公证提交失败：${commandOutput(submitted, credentialArgs)}`);
  }
  const submissionId = parseResponse(submitted.stdout, '公证提交').id;
  if (typeof submissionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(submissionId)) {
    throw new Error('公证提交未返回有效 ID，停止执行以避免重复上传');
  }
  console.log(`[desktop-notary] 已提交：${basename(artifact)} id=${submissionId}`);
  await onSubmitted?.(submissionId);
  return waitForNotarization(submissionId, credentialArgs);
}

export async function waitForNotarization(submissionId, credentialArgs) {
  if (typeof submissionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(submissionId)) {
    throw new Error('公证恢复需要有效的已有提交 ID');
  }
  const deadline = Date.now() + queryTimeoutMs;
  let retries = 0;
  while (Date.now() < deadline) {
    const result = spawnSync('xcrun', [
      'notarytool', 'info', submissionId, ...credentialArgs, '--output-format', 'json'
    ], { encoding: 'utf8', timeout: Math.min(60_000, deadline - Date.now()) });
    if (result.status !== 0) {
      const output = commandOutput(result, credentialArgs);
      const transient = result.error?.code === 'ETIMEDOUT'
        || /(?:NSURLErrorDomain\s+Code=|CFNetwork\s+Code=)-(?:1001|1005|1009)\b/.test(output);
      if (!transient) {
        throw new Error(`公证查询失败：${submissionId}\n${output}`);
      }
      if (retries === retryDelays.length) {
        throw new Error(`公证查询重试耗尽：${submissionId}\n${output}`);
      }
      const waitMs = retryDelays[retries++];
      console.log(
        `[desktop-notary] 查询网络失败：id=${submissionId} `
        + `retry=${retries}/${retryDelays.length} wait=${waitMs}ms`
      );
      await delay(Math.max(0, Math.min(waitMs, deadline - Date.now())));
      continue;
    }
    const response = parseResponse(result.stdout, '公证查询');
    if (response.id !== submissionId) {
      throw new Error(`公证查询返回的 ID 不匹配：${submissionId}`);
    }
    if (response.status === 'Accepted') {
      console.log(`[desktop-notary] 公证通过：id=${submissionId}`);
      return submissionId;
    }
    if (response.status !== 'In Progress') {
      throw new Error(`公证未通过：${submissionId} status=${response.status}`);
    }
    await delay(Math.max(0, Math.min(15_000, deadline - Date.now())));
  }
  throw new Error(`公证查询超时：${submissionId}，可用 notarytool info 查询已有提交`);
}

export async function stapleArtifact(artifact) {
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    const result = spawnSync('xcrun', ['stapler', 'staple', artifact], {
      encoding: 'utf8', timeout: 60_000
    });
    if (result.status === 0) return;
    if (attempt === retryDelays.length) {
      throw new Error(`公证票据装订失败：${commandOutput(result, [])}`);
    }
    console.log(`[desktop-notary] 票据装订重试：${basename(artifact)} retry=${attempt + 1}/3`);
    await delay(retryDelays[attempt]);
  }
}

export async function validateArtifactTicket(artifact) {
  for (let attempt = 0; attempt <= ticketValidationRetryDelays.length; attempt++) {
    const result = spawnSync('xcrun', ['stapler', 'validate', artifact], {
      encoding: 'utf8', timeout: 2 * 60_000
    });
    if (result.status === 0) return;
    const output = commandOutput(result, []);
    const transient = result.error?.code === 'ETIMEDOUT'
      || /(?:NSURLErrorDomain\s+Code=|CFNetwork\s+Code=)-(?:1001|1005|1009)\b/.test(output);
    if (!transient) {
      throw new Error(`公证票据验证失败：${artifact}\n${output}`);
    }
    if (attempt === ticketValidationRetryDelays.length) {
      throw new Error(`公证票据验证重试耗尽：${artifact}\n${output}`);
    }
    const waitMs = ticketValidationRetryDelays[attempt];
    console.log(
      `[desktop-notary] 票据验证网络失败：${basename(artifact)} `
      + `retry=${attempt + 1}/${ticketValidationRetryDelays.length} wait=${waitMs}ms\n${output}`
    );
    await delay(waitMs);
  }
}

function parseResponse(output, label) {
  try {
    const response = JSON.parse(output);
    if (response === null || typeof response !== 'object') throw new Error();
    return response;
  } catch {
    throw new Error(`${label}返回无效 JSON`);
  }
}

function commandOutput(result, credentialArgs) {
  let output = [result.stderr, result.stdout, result.error?.message]
    .filter(Boolean).join('\n');
  for (let index = 1; index < credentialArgs.length; index += 2) {
    output = output.split(credentialArgs[index]).join('***');
  }
  return output;
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
