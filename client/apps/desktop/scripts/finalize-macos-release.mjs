import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  notarizeArtifact, stapleArtifact, validateArtifactTicket, waitForNotarization
} from './macos-notarization.mjs';
import { saveNotaryRecovery } from './notary-recovery.mjs';

export function verifyMacReleaseCommand(label, command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 2 * 60_000 });
  if (result.status !== 0) {
    throw new Error(`${label}验证失败：${[result.stderr, result.stdout, result.error?.message].filter(Boolean).join('\n')}`);
  }
  return result;
}

export async function finalizeReleaseDmgArtifacts(artifacts, credentialArgs, recovery) {
  assert.equal(artifacts.length, 1, '公证检查点只能对应一个 DMG');
  assert(['not-submitted', 'submitted'].includes(recovery.checkpoint.submission.state),
    '公证上传结果不明确，拒绝重新上传');
  for (const artifact of artifacts) {
    verifyMacReleaseCommand('DMG 文件完整性', 'hdiutil', ['verify', artifact]);
    verifyMacReleaseCommand('DMG 签名', 'codesign', ['--verify', '--verbose=4', artifact]);
    if (recovery.checkpoint.submission.state === 'submitted') {
      await waitForNotarization(recovery.checkpoint.submission.id, credentialArgs);
    } else {
      await saveNotaryRecovery(recovery, { stage: 'submit', submission: { state: 'submitting', id: null } });
      await notarizeArtifact(artifact, credentialArgs, {
        onSubmitted: id => saveNotaryRecovery(recovery, { submission: { state: 'submitted', id } })
      });
    }
    await saveNotaryRecovery(recovery, { stage: 'accepted' });
    await stapleArtifact(artifact);
    await saveNotaryRecovery(recovery, { stage: 'staple' });
    await validateArtifactTicket(artifact);
    await saveNotaryRecovery(recovery, { stage: 'validate' });
    verifyMacReleaseCommand('DMG Gatekeeper', 'spctl', [
      '--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', artifact
    ]);
    await saveNotaryRecovery(recovery, { stage: 'gatekeeper' });
  }
}
