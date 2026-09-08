import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installModelCatalog } from '../../src/codex/remote-model-catalog.js';
import { createFakeAppServer } from '../helpers/fake-app-server.js';

let tempDir = '';

afterEach(() => {
  if (tempDir.length > 0) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('remote model catalog', () => {
  it('converts the real OpenAI list shape with conservative capabilities', async () => {
    const fixture = setup();
    const fetch = vi.fn(async () => jsonResponse({
      object: 'list',
      data: [
        { id: ' model-b ', display_name: 'Model B' },
        { id: 'model-a' },
        { id: 'model-b', display_name: 'Ignored duplicate' }
      ]
    }));

    const result = await install(fixture, fetch, 'model-a');
    const catalog = readCatalog(result.path);

    expect(result).toMatchObject({
      source: 'remote',
      remoteShape: 'openai_list',
      changed: true,
      modelCount: 2
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://gateway.example.test/v1/models?client_version=0.146.0',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer secret'
        }
      })
    );
    expect(catalog.models.map(model => model.slug)).toEqual(['model-a', 'model-b']);
    expect(catalog.models[1]).toMatchObject({
      slug: 'model-b',
      display_name: 'Model B',
      context_window: 64_000,
      max_context_window: 64_000,
      default_reasoning_level: null,
      supported_reasoning_levels: [],
      input_modalities: ['text'],
      supports_image_detail_original: false,
      supports_search_tool: false,
      supports_parallel_tool_calls: false,
      additional_speed_tiers: [],
      service_tiers: []
    });
    expect(catalog.models[1]).not.toHaveProperty('model_messages');
    if (process.platform !== 'win32') {
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
      expect(statSync(join(fixture.codexHome, 'model-catalogs')).mode & 0o777)
        .toBe(0o700);
    }
  });

  it('appends a missing default model and places it first', async () => {
    const fixture = setup();
    const result = await install(fixture, async () => jsonResponse({
      object: 'list',
      data: [{ id: 'model-b' }]
    }), 'model-a');

    expect(readCatalog(result.path).models.map(model => model.slug))
      .toEqual(['model-a', 'model-b']);
  });

  it('preserves a Codex manifest and appends the default model', async () => {
    const fixture = setup();
    const result = await install(fixture, async () => jsonResponse({
      revision: 'remote-v1',
      models: [{
        slug: 'model-b',
        display_name: 'Remote Model B',
        base_instructions: 'Remote instructions',
        future_capability: { enabled: true }
      }]
    }), 'model-a');
    const catalog = readCatalog(result.path);

    expect(result.remoteShape).toBe('codex_manifest');
    expect(catalog.revision).toBe('remote-v1');
    expect(catalog.models.map(model => model.slug)).toEqual(['model-a', 'model-b']);
    expect(catalog.models[1]?.future_capability).toEqual({ enabled: true });
  });

  it.each([
    ['empty list', () => jsonResponse({ object: 'list', data: [] })],
    ['empty manifest with list fields', () => jsonResponse({
      models: [],
      object: 'list',
      data: [{ id: 'model-b' }]
    })],
    ['missing id', () => jsonResponse({ object: 'list', data: [{}] })],
    ['blank id', () => jsonResponse({ object: 'list', data: [{ id: ' ' }] })],
    ['long id', () => jsonResponse({ object: 'list', data: [{ id: 'x'.repeat(257) }] })],
    ['unknown shape', () => jsonResponse({ data: [{ id: 'model-b' }] })],
    ['invalid JSON', () => new Response('{', { status: 200 })],
    ['too large', () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(16 * 1024 * 1024 + 1) }
    })],
    ['unauthorized', () => new Response('', { status: 401 })],
    ['forbidden', () => new Response('', { status: 403 })],
    ['not found', () => new Response('', { status: 404 })],
    ['rate limited', () => new Response('', { status: 429 })],
    ['internal server error', () => new Response('', { status: 500 })],
    ['server failure', () => new Response('', { status: 503 })]
  ])('falls back to only the default model for %s', async (_name, response) => {
    const fixture = setup();
    const result = await install(fixture, async () => response(), 'model-a');

    expect(result).toMatchObject({ source: 'fallback', modelCount: 1 });
    expect(readCatalog(result.path).models.map(model => model.slug))
      .toEqual(['model-a']);
  });

  it('falls back for request failures and timeouts', async () => {
    const fixture = setup();
    const failure = await install(fixture, async () => {
      throw new Error('connection failed');
    }, 'model-a');
    expect(failure.source).toBe('fallback');

    const timeout = await installModelCatalog({
      ...fixture,
      codexVersion: '0.146.0',
      baseUrl: 'https://gateway.example.test/v1',
      apiKey: 'secret',
      defaultModel: 'model-a',
      credentialVersion: 1,
      timeoutMs: 1,
      fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
    });
    expect(timeout.source).toBe('fallback');
  });

  it('uses a valid ETag cache for 304 and resets it after credential changes', async () => {
    const fixture = setup();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        object: 'list',
        data: [{ id: 'model-a' }, { id: 'model-b' }]
      }, { etag: '"catalog-v1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(jsonResponse({
        object: 'list',
        data: [{ id: 'model-a' }]
      }));

    await install(fixture, fetch, 'model-a', 1);
    const cached = await install(fixture, fetch, 'model-a', 1);
    const changedCredential = await install(fixture, fetch, 'model-a', 2);

    expect(cached).toMatchObject({ source: 'remote', changed: false, modelCount: 2 });
    expect(changedCredential).toMatchObject({ source: 'remote', modelCount: 1 });
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      'If-None-Match': '"catalog-v1"'
    });
    expect(fetch.mock.calls[2]?.[1]?.headers).not.toHaveProperty('If-None-Match');
  });

  it('does a full GET without ETag and detects unchanged content', async () => {
    const fixture = setup();
    const fetch = vi.fn(async (
      _url: string | URL | Request,
      _init?: RequestInit
    ) => jsonResponse({
      object: 'list',
      data: [{ id: 'model-a' }, { id: 'model-b' }]
    }));

    await install(fixture, fetch, 'model-a');
    const repeated = await install(fixture, fetch, 'model-a');

    expect(repeated).toMatchObject({ source: 'remote', changed: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]?.headers)
      .not.toHaveProperty('If-None-Match');
  });

  it('does not reuse an ETag for another request URL or default model', async () => {
    const fixture = setup();
    const fetch = vi.fn(async (
      _url: string | URL | Request,
      _init?: RequestInit
    ) => jsonResponse({
      object: 'list',
      data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }]
    }, { etag: '"catalog"' }));

    await install(
      fixture,
      fetch,
      'model-a',
      1,
      'https://gateway-a.example.test/v1/'
    );
    await install(
      fixture,
      fetch,
      'model-a',
      1,
      'https://gateway-b.example.test/v1/'
    );
    await install(
      fixture,
      fetch,
      'model-c',
      1,
      'https://gateway-b.example.test/v1/'
    );

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[1]?.[1]?.headers)
      .not.toHaveProperty('If-None-Match');
    expect(fetch.mock.calls[2]?.[1]?.headers)
      .not.toHaveProperty('If-None-Match');
  });

  it('falls back when a 304 cache file is missing', async () => {
    const fixture = setup();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        object: 'list',
        data: [{ id: 'model-a' }, { id: 'model-b' }]
      }, { etag: '"catalog-v1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));

    await install(fixture, fetch, 'model-a');
    rmSync(
      join(fixture.codexHome, 'model-catalogs', 'clawee-last-success.json'),
      { force: true }
    );
    const result = await install(fixture, fetch, 'model-a');

    expect(result).toMatchObject({ source: 'fallback', modelCount: 1 });
  });

  it('rejects a 304 cache whose content does not match metadata', async () => {
    const fixture = setup();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        object: 'list',
        data: [{ id: 'model-a' }, { id: 'model-b' }]
      }, { etag: '"catalog-v1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));

    await install(fixture, fetch, 'model-a');
    writeFileSync(
      join(fixture.codexHome, 'model-catalogs', 'clawee-last-success.json'),
      JSON.stringify({ models: [{ slug: 'model-a' }] })
    );
    const result = await install(fixture, fetch, 'model-a');

    expect(result).toMatchObject({ source: 'fallback', modelCount: 1 });
    expect(readCatalog(result.path).models.map(model => model.slug))
      .toEqual(['model-a']);
  });
});

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'clawee-remote-model-catalog-'));
  const fake = createFakeAppServer({ directory: join(tempDir, 'fake') });
  return {
    codexBin: fake.bin,
    codexHome: join(tempDir, 'codex-home')
  };
}

function install(
  fixture: ReturnType<typeof setup>,
  fetch: typeof globalThis.fetch,
  defaultModel: string,
  credentialVersion = 1,
  baseUrl = 'https://gateway.example.test/v1/'
) {
  return installModelCatalog({
    ...fixture,
    codexVersion: 'codex-cli 0.146.0',
    baseUrl,
    apiKey: 'secret',
    defaultModel,
    credentialVersion,
    fetch
  });
}

function jsonResponse(value: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function readCatalog(path: string): {
  revision?: unknown;
  models: Array<Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    revision?: unknown;
    models: Array<Record<string, unknown>>;
  };
}
