import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerEnterprisePlatformBrandingRoutes } from '../../src/api/routes.enterprise-platform-branding.js';
import {
  createEnterpriseHttpClient,
  type EnterpriseHttpClient
} from '../../src/enterprise/http-client-2026-07-30.js';
import type { EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';

const ORIGIN = 'https://enterprise.example';

describe('enterprise platform branding', () => {
  it('validates configuration and proxies image content', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/platform-branding')) {
        return new Response(JSON.stringify({
          data: {
            sidebar_logo_configured: true,
            sidebar_compact_logo_configured: false
          }
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png', 'content-length': '4' }
      });
    });
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    await expect(client.getPlatformBranding!('token')).resolves.toEqual({
      sidebarLogoConfigured: true,
      sidebarCompactLogoConfigured: false
    });
    await expect(client.getPlatformBrandingImage!('token', 'sidebar-logo')).resolves.toEqual({
      content: new Uint8Array([137, 80, 78, 71]),
      contentType: 'image/png'
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL('/api/v1/app/platform-branding', ORIGIN),
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('rejects invalid upstream responses', async () => {
    const invalidConfiguration = createEnterpriseHttpClient({
      fetch: vi.fn(async () => new Response(JSON.stringify({ data: { sidebar_logo_configured: 'yes' } }), {
        headers: { 'content-type': 'application/json' }
      })),
      origin: ORIGIN
    });
    await expect(invalidConfiguration.getPlatformBranding!('token')).rejects.toMatchObject({
      code: 'ENTERPRISE_PROTOCOL_ERROR'
    });

    const invalidImage = createEnterpriseHttpClient({
      fetch: vi.fn(async () => new Response('html', { headers: { 'content-type': 'text/html' } })),
      origin: ORIGIN
    });
    await expect(invalidImage.getPlatformBrandingImage!('token', 'sidebar-logo')).rejects.toMatchObject({
      code: 'ENTERPRISE_PROTOCOL_ERROR'
    });
  });

  it('serves local configuration and binary routes without caching', async () => {
    const server = Fastify();
    const sessionManager = {
      requireAccessToken: vi.fn(async () => 'token'),
      invalidateUnauthorized: vi.fn(async () => undefined)
    } as unknown as EnterpriseSessionManager;
    const httpClient = {
      getPlatformBranding: vi.fn(async () => ({
        sidebarLogoConfigured: true,
        sidebarCompactLogoConfigured: false
      })),
      getPlatformBrandingImage: vi.fn(async () => ({
        content: new Uint8Array([1, 2, 3]),
        contentType: 'image/jpeg' as const
      }))
    } as unknown as EnterpriseHttpClient;
    await registerEnterprisePlatformBrandingRoutes(server, { sessionManager, httpClient });

    const configuration = await server.inject('/enterprise/platform-branding');
    expect(configuration.statusCode).toBe(200);
    expect(configuration.headers['cache-control']).toBe('no-store');
    expect(configuration.json()).toEqual({
      sidebarLogoConfigured: true,
      sidebarCompactLogoConfigured: false
    });

    const image = await server.inject('/enterprise/platform-branding/sidebar-logo');
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/jpeg');
    expect(image.headers['cache-control']).toBe('no-store');
    expect(image.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    await server.close();
  });
});
