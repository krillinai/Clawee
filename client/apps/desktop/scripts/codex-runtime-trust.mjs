import {
  existsSync,
  mkdtempSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

import {
  failCodexRuntimeAsset as fail
} from './codex-runtime-errors.mjs';
import {
  windowsPowerShellEnvironment
} from './release-platform.mjs';

export async function verifyCodexRuntimeTrust(input) {
  const trust = input.target.trust;
  const binaryFiles = input.target.expectedFiles
    .filter(path => path !== 'codex-package.json')
    .sort();
  const signedFiles = [...trust.signedFiles].sort();
  const unsignedFiles = Object.keys(trust.unsignedFiles ?? {}).sort();
  if (
    !isDeepStrictEqual(
      [...signedFiles, ...unsignedFiles].sort(),
      binaryFiles
    )
  ) {
    fail(
      'CODEX_RUNTIME_TRUST_COVERAGE_INVALID',
      'Runtime trust policy does not cover every executable exactly once'
    );
  }
  if (signedFiles.some(path => unsignedFiles.includes(path))) {
    fail(
      'CODEX_RUNTIME_TRUST_COVERAGE_INVALID',
      'Runtime trust policy marks a file as both signed and unsigned'
    );
  }

  if (trust.kind === 'apple-code-signing') {
    await verifyAppleTrust(input.root, trust, input.commandRunner, input.hashFile);
    return;
  }
  if (trust.kind === 'authenticode') {
    await verifyWindowsTrust(
      input.root,
      trust,
      input.commandRunner,
      input.hashFile
    );
    return;
  }
  if (trust.kind === 'sigstore') {
    if (typeof input.sigstoreVerifier !== 'function') {
      fail(
        'CODEX_RUNTIME_SIGSTORE_VERIFIER_REQUIRED',
        'Sigstore Runtime targets require an explicit proof verifier'
      );
    }
    await input.sigstoreVerifier({
      root: input.root,
      trust
    });
    await verifyUnsignedFiles(
      input.root,
      trust.unsignedFiles ?? {},
      input.hashFile
    );
    return;
  }
  fail(
    'CODEX_RUNTIME_TRUST_KIND_UNSUPPORTED',
    `Unsupported Runtime trust policy: ${String(trust.kind)}`
  );
}

export async function runCodexRuntimeCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...(command.toLowerCase().endsWith('powershell.exe')
      ? { env: windowsPowerShellEnvironment() }
      : {}),
    shell: false,
    timeout: 2 * 60_000,
    windowsHide: true
  });
  if (result.error !== undefined) {
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.error.message
    };
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

async function verifyAppleTrust(root, trust, commandRunner, hashFile) {
  for (const relativePath of trust.signedFiles) {
    const path = join(root, relativePath);
    const verification = await commandRunner('codesign', [
      '--verify',
      '--strict',
      '--verbose=4',
      path
    ]);
    assertCommandSucceeded(
      `codesign verification for ${relativePath}`,
      verification
    );

    const details = await commandRunner('codesign', [
      '--display',
      '--verbose=4',
      '--entitlements',
      ':-',
      path
    ]);
    assertCommandSucceeded(`codesign inspection for ${relativePath}`, details);
    const output = `${details.stdout ?? ''}\n${details.stderr ?? ''}`;
    const authorities = [...output.matchAll(/^Authority=(.+)$/gm)]
      .map(match => match[1].trim());
    const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1].trim();
    const entitlements = parseAppleEntitlements(output);
    const expectedEntitlements = trust.entitlements?.[relativePath] ?? {};
    if (
      authorities[0] !== trust.signingIdentity
      || teamIdentifier !== trust.teamIdentifier
      || !isDeepStrictEqual(entitlements, expectedEntitlements)
    ) {
      fail(
        'CODEX_RUNTIME_TRUST_MISMATCH',
        `Apple signing identity or entitlements do not match: ${relativePath}`,
        {
          actual: {
            signingIdentity: authorities[0],
            teamIdentifier,
            entitlements
          },
          expected: {
            signingIdentity: trust.signingIdentity,
            teamIdentifier: trust.teamIdentifier,
            entitlements: expectedEntitlements
          }
        }
      );
    }

    const certificateRoot = mkdtempSync(join(
      tmpdir(),
      'clawee-codex-certificate-'
    ));
    try {
      const certificatePrefix = join(certificateRoot, 'certificate');
      const certificateResult = await commandRunner('codesign', [
        '--display',
        `--extract-certificates=${certificatePrefix}`,
        path
      ]);
      assertCommandSucceeded(
        `codesign certificate extraction for ${relativePath}`,
        certificateResult
      );
      const certificatePath = `${certificatePrefix}0`;
      if (
        !existsSync(certificatePath)
        || await hashFile(certificatePath) !== trust.certificateSha256
      ) {
        fail(
          'CODEX_RUNTIME_TRUST_MISMATCH',
          `Apple signing certificate does not match: ${relativePath}`
        );
      }
    } finally {
      rmSync(certificateRoot, { force: true, recursive: true });
    }
  }
}

function parseAppleEntitlements(output) {
  const plistStart = output.indexOf('<plist');
  const plistEnd = output.indexOf('</plist>');
  if (plistStart === -1 || plistEnd === -1) return {};
  const plist = output.slice(plistStart, plistEnd + '</plist>'.length);
  const values = {};
  const pattern = /<key>([^<]+)<\/key>\s*(?:<true\s*\/>|<false\s*\/>|<string>([^<]*)<\/string>)/g;
  for (const match of plist.matchAll(pattern)) {
    const token = match[0].slice(match[0].indexOf('</key>') + 6).trim();
    values[decodeXml(match[1])] = token.startsWith('<true')
      ? true
      : token.startsWith('<false')
        ? false
        : decodeXml(match[2] ?? '');
  }
  return sortObject(values);
}

async function verifyWindowsTrust(root, trust, commandRunner, hashFile) {
  for (const relativePath of trust.signedFiles) {
    const path = join(root, relativePath);
    const script = windowsCertificateInspectionScript(path);
    const result = await commandRunner('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script
    ]);
    assertCommandSucceeded(
      `Authenticode inspection for ${relativePath}`,
      result
    );
    let actual;
    try {
      actual = JSON.parse(result.stdout.trim());
    } catch (error) {
      fail(
        'CODEX_RUNTIME_TRUST_INSPECTION_INVALID',
        `Invalid Authenticode inspection output: ${errorMessage(error)}`
      );
    }
    if (
      actual.status !== 'Valid'
      || !distinguishedNamesEqual(actual.subject, trust.subject)
      || actual.certificateSha256 !== trust.certificateSha256
    ) {
      fail(
        'CODEX_RUNTIME_TRUST_MISMATCH',
        `Authenticode identity does not match: ${relativePath}`,
        {
          actual,
          expected: {
            status: 'Valid',
            subject: trust.subject,
            certificateSha256: trust.certificateSha256
          }
        }
      );
    }
  }
  await verifyUnsignedFiles(root, trust.unsignedFiles ?? {}, hashFile);
}

function distinguishedNamesEqual(left, right) {
  const leftAttributes = parseDistinguishedName(left);
  const rightAttributes = parseDistinguishedName(right);
  return leftAttributes !== undefined
    && rightAttributes !== undefined
    && isDeepStrictEqual(leftAttributes, rightAttributes);
}

function parseDistinguishedName(value) {
  if (typeof value !== 'string') return undefined;
  const pattern = /(?:^|,\s*)(C|ST|S|L|O|OU|CN)=/gi;
  const matches = [...value.matchAll(pattern)];
  if (matches.length === 0) return undefined;
  const attributes = {};
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const key = match[1].toUpperCase() === 'S'
      ? 'ST'
      : match[1].toUpperCase();
    const valueStart = match.index + match[0].lastIndexOf('=') + 1;
    const valueEnd = matches[index + 1]?.index ?? value.length;
    const attributeValue = unquoteDistinguishedNameValue(
      value.slice(valueStart, valueEnd).trim()
    );
    if (attributes[key] !== undefined || attributeValue.length === 0) {
      return undefined;
    }
    attributes[key] = attributeValue;
  }
  return sortObject(attributes);
}

function unquoteDistinguishedNameValue(value) {
  const unquoted = value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
  return unquoted.replaceAll('\\,', ',').replaceAll('\\"', '"').trim();
}

function windowsCertificateInspectionScript(path) {
  const escapedPath = path.replaceAll("'", "''");
  return [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'`,
    '$certificate = $signature.SignerCertificate',
    'if ($null -eq $certificate) {',
    "  Write-Error 'Authenticode signer certificate is missing'",
    '  exit 1',
    '}',
    '$sha256 = [Security.Cryptography.SHA256]::Create()',
    'try {',
    '  $hash = [BitConverter]::ToString(',
    '    $sha256.ComputeHash($certificate.RawData)',
    "  ).Replace('-', '').ToLowerInvariant()",
    '} finally {',
    '  $sha256.Dispose()',
    '}',
    '[pscustomobject]@{',
    '  status = [string]$signature.Status',
    '  subject = $certificate.Subject',
    '  certificateSha256 = $hash',
    '} | ConvertTo-Json -Compress'
  ].join('\n');
}

async function verifyUnsignedFiles(root, unsignedFiles, hashFile) {
  for (const [relativePath, expectedHash] of Object.entries(unsignedFiles)) {
    const actualHash = await hashFile(join(root, relativePath));
    if (actualHash !== expectedHash) {
      fail(
        'CODEX_RUNTIME_UNSIGNED_FILE_HASH_MISMATCH',
        `Unsigned Runtime helper hash does not match: ${relativePath}`,
        { actual: actualHash, expected: expectedHash }
      );
    }
  }
}

function assertCommandSucceeded(label, result) {
  if (result?.status !== 0) {
    fail(
      'CODEX_RUNTIME_COMMAND_FAILED',
      `${label} failed: ${result?.stderr || result?.stdout || 'unknown error'}`
    );
  }
}

function sortObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  );
}

function decodeXml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
