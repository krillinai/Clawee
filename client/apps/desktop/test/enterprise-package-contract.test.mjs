import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertEnterpriseReleaseTransport,
  readEnterpriseGatewayPackageConfig
} from '../scripts/enterprise-package-contract.mjs';

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Desktop enterprise package contract', () => {
  it('uses an explicit absolute config without changing the default or falling back', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-gateway-source-'));
    tempRoots.push(root);
    const original = join(root, 'default.toml');
    const customer = join(root, 'customer.toml');
    writeFileSync(original, 'gateway = "http://127.0.0.1:1904"\n');
    writeFileSync(customer, 'gateway = "https://gateway.demo.example.com"\n');
    expect(readEnterpriseGatewayPackageConfig(original, 'release').gateway)
      .toBe('http://127.0.0.1:1904');
    expect(readEnterpriseGatewayPackageConfig(original, 'release', customer).gateway)
      .toBe('https://gateway.demo.example.com');
    expect(() => readEnterpriseGatewayPackageConfig(original, 'release', join(root, 'missing.toml')))
      .toThrow('ENTERPRISE_CONFIG_INVALID');
    for (const path of ['', 'relative.toml']) {
      expect(() => readEnterpriseGatewayPackageConfig(original, 'release', path))
        .toThrow('ENTERPRISE_CONFIG_PATH_MUST_BE_ABSOLUTE');
    }
    writeFileSync(customer, 'invalid toml');
    expect(() => readEnterpriseGatewayPackageConfig(original, 'release', customer))
      .toThrow('ENTERPRISE_CONFIG_INVALID');
    expect(readEnterpriseGatewayPackageConfig(original, 'release').gateway)
      .toBe('http://127.0.0.1:1904');
  });

  it('allows local HTTP builds while requiring HTTPS for remote gateways', () => {
    expect(assertEnterpriseReleaseTransport({
      mode: 'dir',
      origin: 'http://127.0.0.1:1904'
    })).toEqual({
      origin: 'http://127.0.0.1:1904',
      transportSecurity: 'insecure_http'
    });
    expect(assertEnterpriseReleaseTransport({
      mode: 'dist',
      origin: 'http://127.0.0.1:1904'
    }).transportSecurity).toBe('insecure_http');
    expect(() => assertEnterpriseReleaseTransport({
      mode: 'release',
      origin: 'http://enterprise.example'
    })).toThrow('ENTERPRISE_RELEASE_REQUIRES_HTTPS');
    expect(assertEnterpriseReleaseTransport({
      mode: 'release',
      origin: 'https://enterprise.example/'
    })).toEqual({
      origin: 'https://enterprise.example',
      transportSecurity: 'secure_https'
    });
  });

  it('reads gateway configuration without packaging the local agent id', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawee-gateway-contract-'));
    tempRoots.push(root);
    const path = join(root, 'gateway.json');
    writeFileSync(path, 'gateway = "https://enterprise.example/"\n');

    expect(readEnterpriseGatewayPackageConfig(path, 'release')).toEqual({
      gateway: 'https://enterprise.example',
      transportSecurity: 'secure_https'
    });

    writeFileSync(
      path,
      'gateway = "https://enterprise.example"\n'
      + 'agent_id = "clawee_550e8400-e29b-41d4-a716-446655440000"\n'
    );
    expect(readEnterpriseGatewayPackageConfig(path, 'release')).toEqual({
      gateway: 'https://enterprise.example',
      transportSecurity: 'secure_https'
    });

    writeFileSync(
      path,
      'gateway = "https://enterprise.example"\nextra = true\n'
    );
    expect(() => readEnterpriseGatewayPackageConfig(path, 'release')).toThrow(
      'ENTERPRISE_CONFIG_INVALID'
    );

    writeFileSync(
      path,
      'gateway = "https://enterprise.example"\nagent_id = "invalid"\n'
    );
    expect(() => readEnterpriseGatewayPackageConfig(path, 'release')).toThrow(
      'ENTERPRISE_CONFIG_INVALID'
    );
  });
});
