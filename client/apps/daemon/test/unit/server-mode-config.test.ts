import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readPackagedServerConfiguration
} from '../../src/server-mode/config.js';

let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('packaged Server configuration', () => {
  it('resolves relative paths from the configuration directory', () => {
    const configPath = createConfig([
      '[server]',
      'host = "0.0.0.0"',
      'port = 21000',
      'data_dir = "../state"',
      'default_project_root = "../projects"',
      'token_file = "../secrets/token"',
      '',
      '[enterprise]',
      'config_file = "./enterprise.toml"'
    ]);

    expect(readPackagedServerConfiguration(configPath)).toEqual({
      configPath,
      host: '0.0.0.0',
      port: 21000,
      dataDir: join(tempDir, 'state'),
      defaultProjectRoot: join(tempDir, 'projects'),
      autoInstallUpdateSkills: false,
      tokenSource: 'file',
      tokenFile: join(tempDir, 'secrets/token'),
      enterpriseConfigFile: join(tempDir, 'config/enterprise.toml')
    });
  });

  it.each([
    { enabled: true, token: 'token = "secret"' },
    { enabled: false, token: 'token = "secret"' },
    { enabled: true, token: 'token_file = "../secrets/token"' },
    { enabled: false, token: 'token_file = "../secrets/token"' }
  ])('reads auto_install_update_skills=$enabled with $token without rewriting it', ({ enabled, token }) => {
    const configPath = createConfig([
      '[server]',
      `auto_install_update_skills = ${enabled}`,
      token,
      '',
      '[enterprise]',
      'config_file = "./enterprise.toml"'
    ]);
    const original = readFileSync(configPath, 'utf8');

    expect(readPackagedServerConfiguration(configPath).autoInstallUpdateSkills)
      .toBe(enabled);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });

  it.each(['"true"', '"false"', '0', '1', '1.5', '[]', '{}', '2026-10-09'])
    ('rejects non-boolean auto_install_update_skills=%s', value => {
      const configPath = createConfig([
        '[server]',
        `auto_install_update_skills = ${value}`,
        '',
        '[enterprise]',
        'config_file = "./enterprise.toml"'
      ]);
      const original = readFileSync(configPath, 'utf8');

      expect(() => readPackagedServerConfiguration(configPath))
        .toThrow('SERVER_CONFIG_INVALID');
      expect(readFileSync(configPath, 'utf8')).toBe(original);
    });

  it('keeps auto_install_update_skills out of the default configuration generator', () => {
    const source = readFileSync(
      new URL('../../../../scripts/server-package.mjs', import.meta.url),
      'utf8'
    );
    const generator = source.match(
      /function writeExampleConfiguration\(packageRoot\) \{[\s\S]*?\n\}/
    )?.[0];

    expect(generator).toContain('server.example.toml');
    expect(generator).toContain("'[server]'");
    expect(generator).not.toContain('auto_install_update_skills');
    expect(generator).not.toContain('autoInstallUpdateSkills');
  });

  it('uses a direct token without touching token_file', () => {
    const configPath = createConfig([
      '[server]',
      'token = " direct-token "',
      'token_file = "/missing/and/unreadable/token"',
      '',
      '[enterprise]',
      'config_file = "./enterprise.toml"'
    ]);

    const config = readPackagedServerConfiguration(configPath);

    expect(config.autoInstallUpdateSkills).toBe(false);
    expect(config.tokenSource).toBe('config');
    expect(config.token).toBe('direct-token');
    expect(config.tokenFile).toBeUndefined();
    if (process.platform !== 'win32') {
      expect((readFileSync(configPath), statMode(configPath))).toBe(0o600);
    }
  });

  it('rejects blank direct tokens instead of falling back to a file', () => {
    const configPath = createConfig([
      '[server]',
      'token = "   "',
      'token_file = "../token"',
      '',
      '[enterprise]',
      'config_file = "./enterprise.toml"'
    ]);

    expect(() => readPackagedServerConfiguration(configPath))
      .toThrow('SERVER_CONFIG_TOKEN_INVALID');
  });

  it('applies token file and project defaults beneath data_dir', () => {
    const configPath = createConfig([
      '[server]',
      'data_dir = "../runtime data"',
      '',
      '[enterprise]',
      'config_file = "./enterprise.toml"'
    ]);
    const original = readFileSync(configPath, 'utf8');

    expect(readPackagedServerConfiguration(configPath)).toMatchObject({
      dataDir: join(tempDir, 'runtime data'),
      defaultProjectRoot: join(tempDir, 'runtime data/projects'),
      autoInstallUpdateSkills: false,
      tokenSource: 'file',
      tokenFile: join(tempDir, 'runtime data/server-token')
    });
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });

  it('rejects unknown fields, invalid ports, and symbolic links', () => {
    const unknown = createConfig([
      '[server]',
      'unknown = true',
      '',
      '[enterprise]',
      'config_file = "./enterprise.toml"'
    ]);
    expect(() => readPackagedServerConfiguration(unknown))
      .toThrow('SERVER_CONFIG_INVALID');

    writeFileSync(unknown, [
      '[server]',
      'port = 70000',
      '',
      '[enterprise]',
      'config_file = "./enterprise.toml"'
    ].join('\n'));
    expect(() => readPackagedServerConfiguration(unknown))
      .toThrow('SERVER_LISTEN_CONFIG_INVALID');

    writeFileSync(unknown, [
      '[server]',
      'host = ":"',
      '',
      '[enterprise]',
      'config_file = "./enterprise.toml"'
    ].join('\n'));
    expect(() => readPackagedServerConfiguration(unknown))
      .toThrow('SERVER_LISTEN_CONFIG_INVALID');

    for (const invalidHost of ['a.-b', 'a-.b', '127.0.0.999']) {
      writeFileSync(unknown, [
        '[server]',
        `host = "${invalidHost}"`,
        '',
        '[enterprise]',
        'config_file = "./enterprise.toml"'
      ].join('\n'));
      expect(() => readPackagedServerConfiguration(unknown))
        .toThrow('SERVER_LISTEN_CONFIG_INVALID');
    }

    const link = join(tempDir, 'server-link.toml');
    symlinkSync(unknown, link);
    expect(() => readPackagedServerConfiguration(link))
      .toThrow('SERVER_CONFIG_INVALID');
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a non-writable direct-token configuration',
    () => {
      const configPath = createConfig([
        '[server]',
        'token = "secret"',
        '',
        '[enterprise]',
        'config_file = "./enterprise.toml"'
      ]);
      chmodSync(configPath, 0o400);
      expect(() => readPackagedServerConfiguration(configPath))
        .toThrow('SERVER_CONFIG_TOKEN_INVALID');
    }
  );
});

function createConfig(lines: string[]): string {
  if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), 'clawee-server-config-'));
  const configDir = join(tempDir, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'enterprise.toml'),
    'gateway = "https://gateway.clawee.work"\n'
  );
  const configPath = join(configDir, 'server.toml');
  writeFileSync(configPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  return configPath;
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}
