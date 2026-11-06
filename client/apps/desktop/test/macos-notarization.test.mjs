import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  notarizeArtifact,
  notarytoolCredentialArgs,
  stapleArtifact,
  validateArtifactTicket
} from '../scripts/macos-notarization.mjs';
import afterSign from '../scripts/notarize-after-sign.mjs';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('node:timers/promises', () => ({
  setTimeout: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
}));

const submissionId = '73255800-fbcd-4950-a509-fde40d5e39a9';
const credentials = ['--apple-id', 'release@example.com', '--password', 'secret', '--team-id', 'TEAM'];
const success = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
const failure = stderr => ({ status: 1, stdout: '', stderr });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.mocked(spawnSync).mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('macOS notarization', () => {
  it('submits once without waiting, then polls the same submission', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(success({ id: submissionId }))
      .mockReturnValueOnce(success({ id: submissionId, status: 'In Progress' }))
      .mockReturnValueOnce(success({ id: submissionId, status: 'Accepted' }));

    const result = expect(notarizeArtifact('/release/Clawee.zip', credentials))
      .resolves.toBe(submissionId);
    await vi.runAllTimersAsync();
    await result;

    expect(spawnSync).toHaveBeenNthCalledWith(1, 'xcrun', [
      'notarytool', 'submit', '/release/Clawee.zip', ...credentials,
      '--output-format', 'json'
    ], expect.objectContaining({ timeout: 10 * 60_000 }));
    for (const [, args] of vi.mocked(spawnSync).mock.calls.slice(1)) {
      expect(args).toEqual([
        'notarytool', 'info', submissionId, ...credentials, '--output-format', 'json'
      ]);
    }
  });

  it.each([
    'NSURLErrorDomain Code=-1001 "The request timed out."',
    'NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline."',
    'NSURLErrorDomain Code=-1005 "The network connection was lost."'
  ])('recovers from %s without uploading again', async error => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(success({ id: submissionId }))
      .mockReturnValueOnce(failure(error))
      .mockReturnValueOnce(success({ id: submissionId, status: 'Accepted' }));

    const result = expect(notarizeArtifact('/release/Clawee.dmg', credentials))
      .resolves.toBe(submissionId);
    await vi.runAllTimersAsync();
    await result;
    expect(spawnSync).toHaveBeenCalledTimes(3);
    expect(Date.now()).toBe(10_000);
  });

  it('retries a locally timed-out status query', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(success({ id: submissionId }))
      .mockReturnValueOnce({ status: null, error: { code: 'ETIMEDOUT' } })
      .mockReturnValueOnce(success({ id: submissionId, status: 'Accepted' }));

    const result = expect(notarizeArtifact('/release/Clawee.zip', credentials))
      .resolves.toBe(submissionId);
    await vi.runAllTimersAsync();
    await result;
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it('stops after three network retries and retains the submission ID in the error', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(success({ id: submissionId }))
      .mockReturnValue(failure('NSURLErrorDomain Code=-1009'));

    const result = expect(notarizeArtifact('/release/Clawee.zip', credentials))
      .rejects.toThrow(`公证查询重试耗尽：${submissionId}`);
    await vi.runAllTimersAsync();
    await result;
    expect(spawnSync).toHaveBeenCalledTimes(5);
    expect(Date.now()).toBe(70_000);
  });

  it('does not retry a rejected notarization', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(success({ id: submissionId }))
      .mockReturnValueOnce(success({ id: submissionId, status: 'Invalid' }));

    await expect(notarizeArtifact('/release/Clawee.zip', credentials))
      .rejects.toThrow(`公证未通过：${submissionId} status=Invalid`);
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry authentication errors and redacts credentials', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(success({ id: submissionId }))
      .mockReturnValueOnce(failure('HTTP 401 release@example.com password=secret'));

    await expect(notarizeArtifact('/release/Clawee.zip', credentials))
      .rejects.toThrow('HTTP 401 *** password=***');
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it('never retries a failed upload without a submission ID', async () => {
    vi.mocked(spawnSync).mockReturnValue(failure('NSURLErrorDomain Code=-1001'));
    await expect(notarizeArtifact('/release/Clawee.zip', credentials))
      .rejects.toThrow('公证提交失败');
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the upload response has no submission ID', async () => {
    vi.mocked(spawnSync).mockReturnValue(success({ status: 'Uploaded' }));
    await expect(notarizeArtifact('/release/Clawee.zip', credentials))
      .rejects.toThrow('公证提交未返回有效 ID');
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed query results instead of retrying them', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(success({ id: submissionId }))
      .mockReturnValueOnce({ status: 0, stdout: 'not json', stderr: '' });
    await expect(notarizeArtifact('/release/Clawee.zip', credentials))
      .rejects.toThrow('公证查询返回无效 JSON');
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it('rejects query results for a different submission', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(success({ id: submissionId }))
      .mockReturnValueOnce(success({ id: 'other-submission', status: 'Accepted' }));
    await expect(notarizeArtifact('/release/Clawee.zip', credentials))
      .rejects.toThrow(`公证查询返回的 ID 不匹配：${submissionId}`);
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it('bounds the polling duration and retains the submission ID on timeout', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(success({ id: submissionId }))
      .mockReturnValue(success({ id: submissionId, status: 'In Progress' }));

    const result = expect(notarizeArtifact('/release/Clawee.zip', credentials))
      .rejects.toThrow(`公证查询超时：${submissionId}`);
    await vi.runAllTimersAsync();
    await result;
    expect(Date.now()).toBe(20 * 60_000);
    expect(spawnSync).toHaveBeenCalledTimes(81);
  });

  it('preserves three retries for ticket stapling', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(failure('ticket unavailable'))
      .mockReturnValueOnce(failure('ticket unavailable'))
      .mockReturnValueOnce(failure('ticket unavailable'))
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    const result = expect(stapleArtifact('/release/Clawee.app')).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await result;
    expect(spawnSync).toHaveBeenCalledTimes(4);
    expect(spawnSync).toHaveBeenLastCalledWith('xcrun', [
      'stapler', 'staple', '/release/Clawee.app'
    ], expect.objectContaining({ timeout: 60_000 }));
  });

  it('fails when ticket stapling retries are exhausted', async () => {
    vi.mocked(spawnSync).mockReturnValue(failure('ticket unavailable'));
    const result = expect(stapleArtifact('/release/Clawee.app'))
      .rejects.toThrow('公证票据装订失败');
    await vi.runAllTimersAsync();
    await result;
    expect(spawnSync).toHaveBeenCalledTimes(4);
  });
});

describe('macOS notarization ticket validation', () => {
  it('validates the existing ticket without submitting or stapling again', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' });

    await expect(validateArtifactTicket('/release/Clawee.dmg')).resolves.toBeUndefined();

    expect(spawnSync).toHaveBeenCalledExactlyOnceWith('xcrun', [
      'stapler', 'validate', '/release/Clawee.dmg'
    ], expect.objectContaining({ encoding: 'utf8', timeout: 2 * 60_000 }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    'NSURLErrorDomain Code=-1001 "The request timed out."',
    'NSURLErrorDomain Code=-1005 "The network connection was lost."',
    'NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline."',
    'kCFErrorDomainCFNetwork Code=-1005 "(null)"'
  ])('retries validation after %s', async error => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 68, stdout: error, stderr: 'The validate action failed! Error 68.' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

    const result = expect(validateArtifactTicket('/release/Clawee.dmg')).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await result;

    expect(spawnSync).toHaveBeenCalledTimes(2);
    for (const [command, args] of vi.mocked(spawnSync).mock.calls) {
      expect(command).toBe('xcrun');
      expect(args).toEqual(['stapler', 'validate', '/release/Clawee.dmg']);
    }
    expect(Date.now()).toBe(10_000);
  });

  it('retries a locally timed-out validation', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: null, error: { code: 'ETIMEDOUT', message: 'spawnSync xcrun ETIMEDOUT' } })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

    const result = expect(validateArtifactTicket('/release/Clawee.dmg')).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await result;

    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(Date.now()).toBe(10_000);
  });

  it.each([
    'The validate action failed! Error 68.',
    'The stapled ticket is invalid.',
    'HTTP 401 Unauthorized',
    'NSURLErrorDomain Code=-1200 "An SSL error has occurred."'
  ])('does not retry non-transient failures: %s', async error => {
    vi.mocked(spawnSync).mockReturnValue(failure(error));

    await expect(validateArtifactTicket('/release/Clawee.dmg'))
      .rejects.toThrow(error);

    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops after four retries and includes the artifact and complete diagnostics', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 68,
      stdout: 'NSURLErrorDomain Code=-1005',
      stderr: 'The validate action failed! Error 68.'
    });

    const result = expect(validateArtifactTicket('/release/Clawee.dmg'))
      .rejects.toThrow(/公证票据验证重试耗尽：\/release\/Clawee\.dmg[\s\S]*Error 68[\s\S]*Code=-1005/);
    await vi.runAllTimersAsync();
    await result;

    expect(spawnSync).toHaveBeenCalledTimes(5);
    expect(Date.now()).toBe(150_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops immediately if a network retry encounters an invalid ticket', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(failure('NSURLErrorDomain Code=-1005'))
      .mockReturnValueOnce(failure('The stapled ticket is invalid.'));

    const result = expect(validateArtifactTicket('/release/Clawee.dmg'))
      .rejects.toThrow('The stapled ticket is invalid.');
    await vi.runAllTimersAsync();
    await result;

    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(Date.now()).toBe(10_000);
  });
});

describe('macOS notarization credentials', () => {
  it('uses password credentials and validates the team', () => {
    const env = {
      APPLE_ID: ' release@example.com ',
      APPLE_APP_SPECIFIC_PASSWORD: ' secret ',
      APPLE_TEAM_ID: ' TEAM '
    };
    expect(notarytoolCredentialArgs(env, 'TEAM')).toEqual(credentials);
    expect(() => notarytoolCredentialArgs(env, 'OTHER')).toThrow('release Team ID');
    expect(() => notarytoolCredentialArgs({ APPLE_ID: env.APPLE_ID }, 'TEAM'))
      .toThrow('must be configured together');
  });

  it('supports API keys and keychain profiles', () => {
    expect(notarytoolCredentialArgs({
      APPLE_API_KEY: '/key.p8', APPLE_API_KEY_ID: 'KEY', APPLE_API_ISSUER: 'ISSUER'
    }, 'TEAM')).toEqual(['--key', '/key.p8', '--key-id', 'KEY', '--issuer', 'ISSUER']);
    expect(() => notarytoolCredentialArgs({ APPLE_API_KEY: '/key.p8' }, 'TEAM'))
      .toThrow('must be configured together');
    expect(notarytoolCredentialArgs({}, 'TEAM'))
      .toEqual(['--keychain-profile', 'clawee-notary']);
    expect(notarytoolCredentialArgs({
      APPLE_KEYCHAIN_PROFILE: 'release', APPLE_KEYCHAIN: '/release.keychain'
    }, 'TEAM')).toEqual(['--keychain-profile', 'release', '--keychain', '/release.keychain']);
  });
});

describe('macOS afterSign hook', () => {
  const context = {
    electronPlatformName: 'darwin',
    appOutDir: '/release/mac',
    packager: { appInfo: { productFilename: 'Clawee' } }
  };

  it('notarizes and staples the signed App before archives are built, then removes the temporary ZIP', async () => {
    vi.stubEnv('APPLE_ID', 'release@example.com');
    vi.stubEnv('APPLE_APP_SPECIFIC_PASSWORD', 'secret');
    vi.stubEnv('APPLE_TEAM_ID', 'TEAM');
    vi.stubEnv('CLAWEE_APPLE_TEAM_ID', 'TEAM');
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce(success({ id: submissionId }))
      .mockReturnValueOnce(success({ id: submissionId, status: 'Accepted' }))
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

    await afterSign(context);
    const [command, args] = vi.mocked(spawnSync).mock.calls[0];
    expect(command).toBe('ditto');
    expect(args.slice(0, -1)).toEqual([
      '-c', '-k', '--sequesterRsrc', '--keepParent', join(context.appOutDir, 'Clawee.app')
    ]);
    expect(existsSync(args.at(-1))).toBe(false);
    expect(spawnSync).toHaveBeenLastCalledWith('xcrun', [
      'stapler', 'staple', join(context.appOutDir, 'Clawee.app')
    ], expect.anything());
  });

  it('does not run for other platforms', async () => {
    await afterSign({ ...context, electronPlatformName: 'win32' });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('removes the temporary directory and does not staple when notarization fails', async () => {
    vi.stubEnv('APPLE_ID', 'release@example.com');
    vi.stubEnv('APPLE_APP_SPECIFIC_PASSWORD', 'secret');
    vi.stubEnv('APPLE_TEAM_ID', 'TEAM');
    vi.stubEnv('CLAWEE_APPLE_TEAM_ID', 'TEAM');
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce(success({ id: submissionId }))
      .mockReturnValueOnce(success({ id: submissionId, status: 'Invalid' }));

    await expect(afterSign(context)).rejects.toThrow('公证未通过');
    expect(spawnSync).toHaveBeenCalledTimes(3);
    const archive = vi.mocked(spawnSync).mock.calls[0][1].at(-1);
    expect(existsSync(archive)).toBe(false);
  });
});
