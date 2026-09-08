import { spawnSync } from 'node:child_process';

const teamId = process.env.CLAWEE_APPLE_TEAM_ID?.trim() || process.env.APPLE_TEAM_ID?.trim();
if (!teamId) throw new Error('请设置 CLAWEE_APPLE_TEAM_ID 或 APPLE_TEAM_ID');
const profile =
  process.env.APPLE_KEYCHAIN_PROFILE?.trim() || 'clawee-notary';

if (process.platform !== 'darwin') {
  throw new Error('macOS release credentials can only be checked on macOS');
}

const identities = run('security', [
  'find-identity',
  '-v',
  '-p',
  'codesigning'
]);
if (
  !identities.stdout.includes('Developer ID Application:')
  || !identities.stdout.includes(`(${teamId})`)
) {
  throw new Error(
    `Missing Developer ID Application identity for Team ${teamId}`
  );
}
console.log(`[desktop-release] Developer ID 签名身份有效：team=${teamId}`);

run('xcrun', [
  'notarytool',
  'history',
  '--keychain-profile',
  profile,
  '--output-format',
  'json'
]);
console.log(`[desktop-release] Apple 公证凭据有效：profile=${profile}`);

console.log(
  `[desktop-release] 发布凭据有效：team=${teamId} profile=${profile}`
);

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 60_000
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0]} failed: ${result.stderr || result.stdout}`
    );
  }
  return result;
}
