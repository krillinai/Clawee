import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { EnterpriseSessionResponse } from '@clawee/protocol';
import { registerEnterpriseRoutes } from '../../src/api/routes.enterprise-2026-07-30.js';
import type { EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';
import type { EnterpriseMcpManager } from '../../src/enterprise/mcp-manager-2026-08-07.js';
import type { EnterpriseSkillManager } from '../../src/enterprise/skill-manager-2026-07-30.js';
import { createGatewayProfileStore } from '../../src/enterprise/gateway-profile-store.js';

describe('已保存的服务器登录信息', () => {
  it('只保存成功登录的信息，读取当前服务器信息时禁止缓存', async () => {
    const sections = new Map<string, unknown>();
    const gatewayProfiles = createGatewayProfileStore({ file: {
      async read(section) { return structuredClone(sections.get(section)); },
      async write(section, value) { sections.set(section, structuredClone(value)); },
      async delete(section) { sections.delete(section); }
    } });
    let gateway = 'https://a.example';
    const session: EnterpriseSessionResponse = { status: 'signed_in', transportSecurity: 'secure_https' };
    const login = vi.fn(async () => session);
    const server = Fastify();
    await registerEnterpriseRoutes(server, {
      sessionManager: { login, register: login } as unknown as EnterpriseSessionManager,
      skillManager: {} as EnterpriseSkillManager,
      mcpManager: { async handleSessionAuthenticated() {} } as EnterpriseMcpManager,
      gatewayProfiles,
      getOrigin: () => gateway
    });
    try {
      const credentials = { email: 'member@example.com', password: 'password123' };
      expect((await server.inject({ method: 'POST', url: '/enterprise/login', payload: credentials })).statusCode).toBe(200);
      const saved = await server.inject('/enterprise/login-preferences');
      expect(saved.headers['cache-control']).toBe('no-store');
      expect(saved.json()).toEqual({ gateway, login: credentials });
      login.mockRejectedValueOnce(new Error('认证失败'));
      expect((await server.inject({ method: 'POST', url: '/enterprise/login', payload: { ...credentials, password: 'wrong-password' } })).statusCode).toBe(500);
      expect((await server.inject('/enterprise/login-preferences')).json().login).toEqual(credentials);
      gateway = 'https://b.example';
      expect((await server.inject('/enterprise/login-preferences')).json()).toEqual({ gateway, login: null });
      const phoneLogin = { phone: '13800000000', password: 'another-password' };
      expect((await server.inject({ method: 'POST', url: '/enterprise/register', payload: { ...phoneLogin, name: '员工' } })).statusCode).toBe(200);
      expect((await server.inject('/enterprise/login-preferences')).json().login).toEqual(phoneLogin);
      gateway = 'https://a.example';
      expect((await server.inject('/enterprise/login-preferences')).json().login).toEqual(credentials);
    } finally {
      await server.close();
    }
  });
});
