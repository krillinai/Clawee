import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_MANIFEST_PATH = resolve(PROJECT_ROOT, 'config/codex-runtime.json');
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_TAG_PATTERN = /^rust-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PLACEHOLDER_PATTERN = /(?:^|[-_ ])(?:todo|tbd|placeholder|changeme)(?:$|[-_ ])/i;
const WILDCARD_PATTERN = /(?:^|[^\\])\*|\.\*|^any$/i;

export class CodexRuntimeManifestError extends Error {
  constructor(issues) {
    super(formatIssues('Codex Runtime manifest is invalid', issues));
    this.name = 'CodexRuntimeManifestError';
    this.code = 'CODEX_RUNTIME_MANIFEST_INVALID';
    this.issues = issues;
  }
}

export function readCodexRuntimeManifest(
  manifestPath = DEFAULT_MANIFEST_PATH
) {
  let value;
  try {
    value = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    const issue = {
      code: 'MANIFEST_READ_FAILED',
      path: String(manifestPath),
      message: error instanceof Error ? error.message : String(error)
    };
    throw new CodexRuntimeManifestError([issue]);
  }

  const issues = validateManifest(value);
  if (issues.length > 0) throw new CodexRuntimeManifestError(issues);
  return value;
}

export function resolveCodexRuntimeTarget(manifest, input) {
  const matches = Object.values(manifest.targets).filter(
    target => target.platform === input.platform && target.arch === input.arch
  );
  if (matches.length !== 1) {
    const issue = {
      code: matches.length === 0
        ? 'MANIFEST_TARGET_NOT_FOUND'
        : 'MANIFEST_TARGET_AMBIGUOUS',
      path: `targets.${input.platform}.${input.arch}`,
      message: `Expected one Runtime target for ${input.platform}/${input.arch}, found ${matches.length}`
    };
    throw new CodexRuntimeManifestError([issue]);
  }
  return matches[0];
}

export function verifyCodexRuntimeSchemaFiles(
  manifest,
  projectRoot = PROJECT_ROOT
) {
  const issues = [];
  for (const channel of ['stable', 'experimental']) {
    const descriptor = manifest.schemas[channel];
    const schemaPath = resolveInsideProject(
      projectRoot,
      descriptor.path,
      `schemas.${channel}.path`,
      issues
    );
    if (schemaPath === undefined) continue;
    let bytes;
    try {
      bytes = readFileSync(schemaPath);
    } catch (error) {
      issues.push({
        code: 'MANIFEST_SCHEMA_READ_FAILED',
        path: `schemas.${channel}.path`,
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== descriptor.sha256) {
      issues.push({
        code: 'MANIFEST_SCHEMA_HASH_MISMATCH',
        path: `schemas.${channel}.sha256`,
        message: `Expected ${descriptor.sha256}, received ${actual}`
      });
    }
  }
  if (issues.length > 0) throw new CodexRuntimeManifestError(issues);
}

function validateManifest(value) {
  const issues = [];
  if (!isRecord(value)) {
    return [{
      code: 'MANIFEST_ROOT_INVALID',
      path: '$',
      message: 'Manifest root must be an object'
    }];
  }

  if (value.schemaVersion !== 1) {
    issues.push(issue(
      'MANIFEST_SCHEMA_VERSION_UNSUPPORTED',
      'schemaVersion',
      'schemaVersion must be 1'
    ));
  }
  requireString(value, 'runtimeId', issues);
  requirePattern(
    value,
    'codexVersion',
    VERSION_PATTERN,
    'MANIFEST_CODEX_VERSION_INVALID',
    issues
  );
  requirePattern(
    value,
    'releaseTag',
    RELEASE_TAG_PATTERN,
    'MANIFEST_RELEASE_TAG_INVALID',
    issues
  );
  requirePattern(
    value,
    'sourceCommit',
    SOURCE_COMMIT_PATTERN,
    'MANIFEST_SOURCE_COMMIT_INVALID',
    issues
  );
  if (value.variant !== 'codex') {
    issues.push(issue(
      'MANIFEST_VARIANT_INVALID',
      'variant',
      'variant must be codex'
    ));
  }
  if (!Number.isInteger(value.layoutVersion) || value.layoutVersion < 1) {
    issues.push(issue(
      'MANIFEST_LAYOUT_VERSION_INVALID',
      'layoutVersion',
      'layoutVersion must be a positive integer'
    ));
  }
  requirePattern(
    value,
    'minimumClaweeVersion',
    VERSION_PATTERN,
    'MANIFEST_MINIMUM_VERSION_INVALID',
    issues
  );
  requirePattern(
    value,
    'previousSupportedReleaseTag',
    RELEASE_TAG_PATTERN,
    'MANIFEST_PREVIOUS_RELEASE_TAG_INVALID',
    issues
  );

  validateSchemas(value.schemas, issues);
  validateTargets(value.targets, issues);
  return issues;
}

function validateSchemas(schemas, issues) {
  if (!isRecord(schemas)) {
    issues.push(issue(
      'MANIFEST_SCHEMAS_INVALID',
      'schemas',
      'schemas must be an object'
    ));
    return;
  }
  for (const channel of ['stable', 'experimental']) {
    const descriptor = schemas[channel];
    if (!isRecord(descriptor)) {
      issues.push(issue(
        'MANIFEST_SCHEMA_MISSING',
        `schemas.${channel}`,
        `${channel} schema descriptor is required`
      ));
      continue;
    }
    requireString(descriptor, 'path', issues, `schemas.${channel}.path`);
    if (!isValidSha256(descriptor.sha256)) {
      issues.push(issue(
        'MANIFEST_SCHEMA_HASH_INVALID',
        `schemas.${channel}.sha256`,
        'Schema SHA-256 must be a non-placeholder lowercase hex digest'
      ));
    }
  }
}

function validateTargets(targets, issues) {
  if (!isRecord(targets) || Object.keys(targets).length === 0) {
    issues.push(issue(
      'MANIFEST_TARGETS_INVALID',
      'targets',
      'targets must be a non-empty object'
    ));
    return;
  }

  const platformArchPairs = new Set();
  for (const [key, target] of Object.entries(targets)) {
    const path = `targets.${key}`;
    if (!isRecord(target)) {
      issues.push(issue(
        'MANIFEST_TARGET_INVALID',
        path,
        'Target descriptor must be an object'
      ));
      continue;
    }
    const platform = target.platform;
    const arch = target.arch;
    if (!['darwin', 'win32', 'linux'].includes(platform)) {
      issues.push(issue(
        'MANIFEST_TARGET_PLATFORM_INVALID',
        `${path}.platform`,
        'Unsupported target platform'
      ));
    }
    if (!['x64', 'arm64'].includes(arch)) {
      issues.push(issue(
        'MANIFEST_TARGET_ARCH_INVALID',
        `${path}.arch`,
        'Unsupported target architecture'
      ));
    }
    const pair = `${platform}/${arch}`;
    if (platformArchPairs.has(pair)) {
      issues.push(issue(
        'MANIFEST_TARGET_DUPLICATE',
        path,
        `Duplicate Runtime target for ${pair}`
      ));
    }
    platformArchPairs.add(pair);

    if (target.targetTriple !== key) {
      issues.push(issue(
        'MANIFEST_TARGET_TRIPLE_INVALID',
        `${path}.targetTriple`,
        'targetTriple must match its targets key'
      ));
    }
    const expectedAssetName = `codex-package-${key}.tar.gz`;
    if (target.assetName !== expectedAssetName) {
      issues.push(issue(
        'MANIFEST_TARGET_ASSET_INVALID',
        `${path}.assetName`,
        `assetName must be ${expectedAssetName}`
      ));
    }
    if (!isValidSha256(target.archiveSha256)) {
      issues.push(issue(
        'MANIFEST_TARGET_HASH_INVALID',
        `${path}.archiveSha256`,
        'Archive SHA-256 must be a non-placeholder lowercase hex digest'
      ));
    }
    validateExpectedFiles(target, path, issues);
    validateTrust(target, path, issues);
    if (typeof target.formalRelease !== 'boolean') {
      issues.push(issue(
        'MANIFEST_TARGET_FORMAL_RELEASE_INVALID',
        `${path}.formalRelease`,
        'formalRelease must be boolean'
      ));
    }
  }
}

function validateExpectedFiles(target, path, issues) {
  if (
    !Array.isArray(target.expectedFiles)
    || target.expectedFiles.length === 0
    || target.expectedFiles.some(file => !isNonPlaceholderString(file))
  ) {
    issues.push(issue(
      'MANIFEST_TARGET_FILES_INVALID',
      `${path}.expectedFiles`,
      'expectedFiles must be a non-empty string array'
    ));
    return;
  }
  const expected = target.platform === 'win32'
    ? [
        'bin/codex.exe',
        'bin/codex-code-mode-host.exe',
        'codex-resources/codex-command-runner.exe',
        'codex-resources/codex-windows-sandbox-setup.exe',
        'codex-path/rg.exe',
        'codex-package.json'
      ]
    : [
        'bin/codex',
        'bin/codex-code-mode-host',
        'codex-path/rg',
        'codex-package.json'
      ];
  if (target.platform === 'darwin' || target.platform === 'linux') {
    expected.push('codex-resources/zsh/bin/zsh');
  }
  if (target.platform === 'linux') {
    expected.push('codex-resources/bwrap');
  }
  for (const file of expected) {
    if (!target.expectedFiles.includes(file)) {
      issues.push(issue(
        'MANIFEST_TARGET_FILE_MISSING',
        `${path}.expectedFiles`,
        `Expected package file ${file}`
      ));
    }
  }
}

function validateTrust(target, path, issues) {
  if (!isRecord(target.trust)) {
    if (target.formalRelease === true) {
      issues.push(issue(
        'MANIFEST_TRUST_IDENTITY_MISSING',
        `${path}.trust`,
        'Formal targets require a trust policy'
      ));
    }
    return;
  }

  const trust = target.trust;
  const required = trust.kind === 'apple-code-signing'
    ? ['signingIdentity', 'teamIdentifier', 'certificateSha256']
    : trust.kind === 'authenticode'
      ? ['subject', 'certificateSha256']
      : trust.kind === 'sigstore'
        ? ['issuer', 'identity']
        : [];
  if (required.length === 0) {
    issues.push(issue(
      'MANIFEST_TRUST_KIND_INVALID',
      `${path}.trust.kind`,
      'Unsupported trust policy kind'
    ));
    return;
  }
  for (const field of required) {
    const fieldPath = `${path}.trust.${field}`;
    if (trust[field] === undefined || trust[field] === '') {
      issues.push(issue(
        'MANIFEST_TRUST_IDENTITY_MISSING',
        fieldPath,
        `${field} is required`
      ));
      continue;
    }
    const invalidHash = field === 'certificateSha256'
      && !isValidSha256(trust[field]);
    if (
      invalidHash
      || !isNonPlaceholderString(trust[field])
      || WILDCARD_PATTERN.test(trust[field])
    ) {
      issues.push(issue(
        'MANIFEST_TRUST_IDENTITY_INVALID',
        fieldPath,
        `${field} must be an exact, non-placeholder identity`
      ));
    }
  }
  validateSignedFiles(target, path, issues);
  validateUnsignedFiles(target, path, issues);
  validateEntitlements(target, path, issues);
  if (trust.kind === 'authenticode') {
    const rgHash = trust.unsignedFiles?.['codex-path/rg.exe'];
    if (!isValidSha256(rgHash)) {
      issues.push(issue(
        'MANIFEST_TRUST_IDENTITY_MISSING',
        `${path}.trust.unsignedFiles.codex-path/rg.exe`,
        'Unsigned Windows ripgrep requires an exact SHA-256 exception'
      ));
    }
  }
  if (trust.kind === 'sigstore') {
    const requiredSignedFiles = [
      target.platform === 'win32' ? 'bin/codex.exe' : 'bin/codex',
      target.platform === 'win32'
        ? 'bin/codex-code-mode-host.exe'
        : 'bin/codex-code-mode-host',
      'codex-resources/bwrap'
    ];
    if (!Array.isArray(trust.signedFiles)) {
      issues.push(issue(
        'MANIFEST_TRUST_SIGNED_FILES_INVALID',
        `${path}.trust.signedFiles`,
        'Sigstore trust requires an exact signedFiles array'
      ));
    } else {
      for (const file of requiredSignedFiles) {
        if (!trust.signedFiles.includes(file)) {
          issues.push(issue(
            'MANIFEST_TRUST_SIGNED_FILE_MISSING',
            `${path}.trust.signedFiles`,
            `Sigstore signedFiles is missing ${file}`
          ));
        }
      }
    }
    for (const file of ['codex-path/rg', 'codex-resources/zsh/bin/zsh']) {
      if (!isValidSha256(trust.unsignedFiles?.[file])) {
        issues.push(issue(
          'MANIFEST_TRUST_IDENTITY_MISSING',
          `${path}.trust.unsignedFiles.${file}`,
          `${file} requires an exact SHA-256 exception`
        ));
      }
    }
  }
}

function validateSignedFiles(target, path, issues) {
  const signedFiles = target.trust.signedFiles;
  if (
    !Array.isArray(signedFiles)
    || signedFiles.length === 0
    || signedFiles.some(file => !isNonPlaceholderString(file))
  ) {
    issues.push(issue(
      'MANIFEST_TRUST_SIGNED_FILES_INVALID',
      `${path}.trust.signedFiles`,
      'signedFiles must be a non-empty string array'
    ));
    return;
  }
  const unique = new Set(signedFiles);
  if (unique.size !== signedFiles.length) {
    issues.push(issue(
      'MANIFEST_TRUST_SIGNED_FILES_INVALID',
      `${path}.trust.signedFiles`,
      'signedFiles must not contain duplicates'
    ));
  }
  for (const file of signedFiles) {
    if (!target.expectedFiles.includes(file)) {
      issues.push(issue(
        'MANIFEST_TRUST_SIGNED_FILE_UNKNOWN',
        `${path}.trust.signedFiles`,
        `Signed file is not part of expectedFiles: ${file}`
      ));
    }
  }
}

function validateUnsignedFiles(target, path, issues) {
  const unsignedFiles = target.trust.unsignedFiles;
  if (unsignedFiles === undefined) return;
  if (!isRecord(unsignedFiles)) {
    issues.push(issue(
      'MANIFEST_TRUST_UNSIGNED_FILES_INVALID',
      `${path}.trust.unsignedFiles`,
      'unsignedFiles must be an object of package path to SHA-256'
    ));
    return;
  }
  for (const [file, sha256] of Object.entries(unsignedFiles)) {
    if (!target.expectedFiles.includes(file)) {
      issues.push(issue(
        'MANIFEST_TRUST_UNSIGNED_FILE_UNKNOWN',
        `${path}.trust.unsignedFiles.${file}`,
        'Unsigned exception must reference an expected package file'
      ));
    }
    if (!isValidSha256(sha256)) {
      issues.push(issue(
        'MANIFEST_TRUST_UNSIGNED_FILE_HASH_INVALID',
        `${path}.trust.unsignedFiles.${file}`,
        'Unsigned exception must use an exact SHA-256'
      ));
    }
  }
}

function validateEntitlements(target, path, issues) {
  const entitlements = target.trust.entitlements;
  if (entitlements === undefined) return;
  if (
    target.trust.kind !== 'apple-code-signing'
    || !isRecord(entitlements)
  ) {
    issues.push(issue(
      'MANIFEST_TRUST_ENTITLEMENTS_INVALID',
      `${path}.trust.entitlements`,
      'entitlements are only valid as an object for Apple code signing'
    ));
    return;
  }
  for (const [file, values] of Object.entries(entitlements)) {
    if (!target.trust.signedFiles.includes(file) || !isRecord(values)) {
      issues.push(issue(
        'MANIFEST_TRUST_ENTITLEMENTS_INVALID',
        `${path}.trust.entitlements.${file}`,
        'Entitlements must reference a signed file and contain an object'
      ));
      continue;
    }
    for (const [key, value] of Object.entries(values)) {
      if (
        !isNonPlaceholderString(key)
        || (typeof value !== 'boolean' && typeof value !== 'string')
      ) {
        issues.push(issue(
          'MANIFEST_TRUST_ENTITLEMENTS_INVALID',
          `${path}.trust.entitlements.${file}.${key}`,
          'Entitlement values must be booleans or strings'
        ));
      }
    }
  }
}

function resolveInsideProject(projectRoot, candidate, path, issues) {
  if (!isNonPlaceholderString(candidate) || isAbsolute(candidate)) {
    issues.push(issue(
      'MANIFEST_SCHEMA_PATH_INVALID',
      path,
      'Schema path must be a project-relative path'
    ));
    return undefined;
  }
  const resolved = resolve(projectRoot, candidate);
  const rel = relative(projectRoot, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    issues.push(issue(
      'MANIFEST_SCHEMA_PATH_INVALID',
      path,
      'Schema path escapes the project root'
    ));
    return undefined;
  }
  return resolved;
}

function requireString(object, field, issues, path = field) {
  if (!isNonPlaceholderString(object[field])) {
    issues.push(issue(
      'MANIFEST_STRING_INVALID',
      path,
      `${field} must be a non-placeholder string`
    ));
  }
}

function requirePattern(object, field, pattern, code, issues) {
  const value = object[field];
  if (!isNonPlaceholderString(value) || !pattern.test(value)) {
    issues.push(issue(code, field, `${field} has an invalid format`));
  }
}

function isValidSha256(value) {
  return typeof value === 'string'
    && SHA256_PATTERN.test(value)
    && value !== '0'.repeat(64)
    && !PLACEHOLDER_PATTERN.test(value);
}

function isNonPlaceholderString(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && !PLACEHOLDER_PATTERN.test(value);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(code, path, message) {
  return { code, path, message };
}

function formatIssues(prefix, issues) {
  return `${prefix}:\n${issues
    .map(item => `- [${item.code}] ${item.path}: ${item.message}`)
    .join('\n')}`;
}

if (process.argv[1] !== undefined) {
  const invokedUrl = pathToFileURL(resolve(process.argv[1])).href;
  if (import.meta.url === invokedUrl) {
    const manifest = readCodexRuntimeManifest();
    verifyCodexRuntimeSchemaFiles(manifest);
  }
}
