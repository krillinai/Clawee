import { spawnSync } from 'node:child_process';

const appleId = process.argv
  .slice(2)
  .find(argument => argument !== '--')
  ?.trim() || process.env.APPLE_ID?.trim();
const teamId = process.env.APPLE_TEAM_ID?.trim() || process.env.CLAWEE_APPLE_TEAM_ID?.trim();
const profile =
  process.env.APPLE_KEYCHAIN_PROFILE?.trim() || 'clawee-notary';
const keychain = process.env.APPLE_KEYCHAIN?.trim();

if (process.platform !== 'darwin') {
  throw new Error('Apple notarization credentials must be configured on macOS');
}
if (!appleId) {
  throw new Error(
    'Missing Apple ID. Usage: pnpm desktop:notary:setup -- <APPLE_ID>'
  );
}

if (!teamId) {
  throw new Error('缺少 APPLE_TEAM_ID，请由发布维护者配置。');
}

if (profileIsValid()) {
  console.log(
    `[desktop-release] 公证凭据已经可用：profile=${profile} team=${teamId}`
  );
  process.exit(0);
}

console.log(
  `[desktop-release] 正在配置公证凭据：profile=${profile} team=${teamId}`
);
console.log(
  '[desktop-release] 接下来请输入 Apple App 专用密码，不是 Apple ID 登录密码。'
);
const args = [
  'notarytool',
  'store-credentials',
  profile,
  '--apple-id',
  appleId,
  '--team-id',
  teamId,
  '--validate'
];
if (keychain) args.push('--keychain', keychain);
const result = spawnSync('xcrun', args, {
  stdio: 'inherit'
});
if (result.status !== 0) {
  throw new Error('Apple notarization credential setup failed');
}
if (!profileIsValid()) {
  throw new Error(
    `Apple notarization profile "${profile}" was saved but cannot be used`
  );
}
console.log(`[desktop-release] 公证凭据已保存到钥匙串 profile：${profile}`);

function profileIsValid() {
  const args = [
    'notarytool',
    'history',
    '--keychain-profile',
    profile,
    '--output-format',
    'json'
  ];
  if (keychain) args.push('--keychain', keychain);
  return spawnSync('xcrun', args, {
    encoding: 'utf8',
    timeout: 60_000
  }).status === 0;
}
