import { describe, expect, it } from 'vitest';
import {
  readEnterpriseClientConfig,
  serializeEnterpriseClientConfig
} from '../../src/enterprise/client-config-2026-08-06.js';

const agentId = 'clawee_550e8400-e29b-41d4-a716-446655440000';

describe('enterprise client config', () => {
  it('保存多个服务器地址并保留 Agent 身份', () => {
    const config = {
      gateway: 'https://enterprise.example',
      gateways: ['https://enterprise.example', 'http://other.example:1904'],
      agentId
    };
    expect(readEnterpriseClientConfig('/tmp/config.toml', () => serializeEnterpriseClientConfig(config))).toEqual(config);
  });

  it('accepts a gateway and optional agent id', () => {
    expect(readEnterpriseClientConfig(
      '/tmp/config.toml',
      () => [
        'gateway = "https://enterprise.example/"',
        `agent_id = "${agentId}"`
      ].join('\n')
    )).toEqual({
      gateway: 'https://enterprise.example',
      agentId
    });
    expect(serializeEnterpriseClientConfig({
      gateway: 'https://enterprise.example',
      agentId
    })).toBe([
      'gateway = "https://enterprise.example"',
      `agent_id = "${agentId}"`,
      ''
    ].join('\n'));
  });

  it.each([
    'gateway = "https://enterprise.example"\nextra = true\n',
    'gateway = "https://enterprise.example/path"\n',
    'gateway = "ftp://enterprise.example"\n',
    'gateway = "https://enterprise.example"\ngateways = ["file:///tmp"]\n',
    'gateway = "https://enterprise.example"\ngateways = "invalid"\n',
    'gateway = "https://enterprise.example"\nagent_id = "invalid"\n',
    'not-toml = '
  ])('rejects invalid gateway configuration', contents => {
    expect(() => readEnterpriseClientConfig(
      '/tmp/config.toml',
      () => contents
    )).toThrow('ENTERPRISE_CONFIG_INVALID');
  });
});
