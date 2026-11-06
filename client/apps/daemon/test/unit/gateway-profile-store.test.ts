import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGatewayProfileStore } from '../../src/enterprise/gateway-profile-store.js';
import { createPrivateCredentialFileStore } from '../../src/security/private-credential-file.js';

describe('服务器登录与模型配置', () => {
  it('重启后按服务器恢复信息，退出会话不影响已记住的信息', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clawee-gateway-profiles-'));
    try {
      const path = join(directory, 'private', 'credentials.json');
      const file = createPrivateCredentialFileStore({ path });
      const profiles = createGatewayProfileStore({ file });
      const login = { email: 'member@example.com', password: 'password123' };
      const model = { baseUrl: 'https://models.example/v1', model: 'model-a', apiKey: 'manual-secret' };
      await Promise.all([
        profiles.writeLogin('https://a.example', login),
        profiles.writeModel('https://a.example', model),
        profiles.writeLogin('https://b.example', { phone: '13800000000', password: 'other-password' })
      ]);
      await file.write('enterprise', { accessToken: 'session' });
      await file.delete('enterprise');
      const restored = createGatewayProfileStore({ file: createPrivateCredentialFileStore({ path }) });
      expect(await restored.readLogin('https://a.example')).toEqual(login);
      expect(await restored.readModel('https://a.example')).toEqual(model);
      expect(await restored.readModel('https://b.example')).toBeUndefined();
      expect(await restored.readLogin('https://unknown.example')).toBeUndefined();
      expect(await restored.readLogin('https://b.example')).toEqual({ phone: '13800000000', password: 'other-password' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
