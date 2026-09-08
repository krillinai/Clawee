import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mergeCodexEnvironment,
  prepareCodexRuntimeConfiguration
} from '../../src/codex/runtime-configuration.js';
import { createFakeAppServer } from '../helpers/fake-app-server.js';

let tempDir = '';

afterEach(() => {
  if (tempDir.length > 0) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('Codex Runtime configuration', () => {
  it('keeps the validated model credential authoritative over injected environments', () => {
    expect(mergeCodexEnvironment(
      {
        CLAWEE_MODEL_API_KEY: 'validated-key',
        SHARED_VALUE: 'base'
      },
      {
        CLAWEE_MODEL_API_KEY: 'injected-key',
        SHARED_VALUE: 'injected',
        INJECTED_ONLY: 'available'
      }
    )).toEqual({
      CLAWEE_MODEL_API_KEY: 'validated-key',
      SHARED_VALUE: 'injected',
      INJECTED_ONLY: 'available'
    });
  });

  it('disables agents and both multi-agent flags before reusing a verified business process', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-configuration-'));
    const fake = createFakeAppServer({
      directory: join(tempDir, 'fake'),
      includeThreadUsage: true
    });
    const codexHome = join(tempDir, 'codex-home');
    expect(existsSync(codexHome)).toBe(false);

    const prepared = await prepareCodexRuntimeConfiguration({
      codexBin: fake.bin,
      codexHome,
      requestTimeoutMs: 10_000
    });
    try {
      expect(statSync(codexHome).isDirectory()).toBe(true);
      expect(prepared.verification).toEqual({
        configFilePath: join(codexHome, 'config.toml'),
        version: 'sha256:fake-runtime-configuration',
        agents: {
          enabled: false
        },
        features: {
          multi_agent: false,
          multi_agent_v2: false
        }
      });

      const spawns = fake.readSpawns();
      expect(spawns).toHaveLength(2);
      expect(spawns).toEqual([
        {
          pid: spawns[0]!.pid,
          args: ['app-server', '--stdio'],
          codexHome
        },
        {
          pid: spawns[1]!.pid,
          args: ['app-server', '--stdio'],
          codexHome
        }
      ]);
      expect(spawns[0]!.pid).not.toBe(spawns[1]!.pid);

      const methodsBeforeBusinessRequest = fake.readMessages().map(
        message => [message.pid, message.method]
      );
      expect(methodsBeforeBusinessRequest).toEqual([
        [spawns[0]!.pid, 'initialize'],
        [spawns[0]!.pid, 'initialized'],
        [spawns[0]!.pid, 'config/batchWrite'],
        [spawns[1]!.pid, 'initialize'],
        [spawns[1]!.pid, 'initialized'],
        [spawns[1]!.pid, 'config/read']
      ]);

      const write = fake.readMessages().find(
        message => message.method === 'config/batchWrite'
      );
      expect(write?.params).toEqual({
        edits: [
          {
            keyPath: 'agents.enabled',
            value: false,
            mergeStrategy: 'upsert'
          },
          {
            keyPath: 'features.multi_agent',
            value: false,
            mergeStrategy: 'upsert'
          },
          {
            keyPath: 'features.multi_agent_v2',
            value: false,
            mergeStrategy: 'upsert'
          }
        ],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: false
      });

      await expect(
        prepared.client.request('model/list', { limit: 1 })
      ).resolves.toEqual({ data: [], nextCursor: null });
      const messages = fake.readMessages();
      expect(messages.at(-1)).toMatchObject({
        pid: spawns[1]!.pid,
        method: 'model/list'
      });
      expect(messages.map(message => message.method)).not.toContain(
        'account/usage/read'
      );
      expect(messages.some(message =>
        message.method?.startsWith('thread/') === true
        || message.method?.startsWith('turn/') === true
      )).toBe(false);
    } finally {
      await prepared.client.close();
    }

    const repeated = await prepareCodexRuntimeConfiguration({
      codexBin: fake.bin,
      codexHome,
      requestTimeoutMs: 10_000
    });
    try {
      expect(repeated.verification).toEqual(prepared.verification);
      const repeatedSpawns = fake.readSpawns();
      expect(repeatedSpawns).toHaveLength(3);
      expect(fake.readMessages().filter(
        message => message.method === 'config/batchWrite'
      )).toHaveLength(1);
      expect(fake.readMessages().slice(-3).map(message => message.method))
        .toEqual(['initialize', 'initialized', 'config/read']);
    } finally {
      await repeated.client.close();
    }
  });

  it('falls back to a full rewrite when cached effective configuration drifts', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-configuration-'));
    const fakeDirectory = join(tempDir, 'fake');
    const fake = createFakeAppServer({ directory: fakeDirectory });
    const codexHome = join(tempDir, 'codex-home');

    const initial = await prepareCodexRuntimeConfiguration({
      codexBin: fake.bin,
      codexHome,
      requestTimeoutMs: 10_000
    });
    await initial.client.close();

    const statePath = join(fakeDirectory, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, JSON.stringify({
      ...state,
      agents_enabled: true
    }));

    const recovered = await prepareCodexRuntimeConfiguration({
      codexBin: fake.bin,
      codexHome,
      requestTimeoutMs: 10_000
    });
    try {
      expect(recovered.verification.agents.enabled).toBe(false);
      expect(fake.readSpawns()).toHaveLength(5);
      expect(fake.readMessages().filter(
        message => message.method === 'config/batchWrite'
      )).toHaveLength(2);
    } finally {
      await recovered.client.close();
    }
  }, 20_000);

  it('aliases migrated thread model providers to the configured Clawee service', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-configuration-'));
    const fake = createFakeAppServer({
      directory: join(tempDir, 'fake')
    });
    const codexHome = join(tempDir, 'codex-home');
    const sessions = join(codexHome, 'sessions', '2026', '08', '24');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, 'rollout-legacy.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: '019f0000-0000-7000-8000-000000000001',
          model_provider: 'custom'
        }
      })}\n`,
      'utf8'
    );

    const prepared = await prepareCodexRuntimeConfiguration({
      codexBin: fake.bin,
      codexHome,
      requestTimeoutMs: 10_000,
      modelService: {
        baseUrl: 'https://gateway.example.test/v1',
        model: 'gpt-enterprise'
      }
    });
    try {
      expect(prepared.verification.modelProviderAliases).toEqual(['custom']);
      const write = fake.readMessages().find(
        message => message.method === 'config/batchWrite'
      );
      expect(write?.params).toMatchObject({
        edits: expect.arrayContaining([
          {
            keyPath: 'model_providers.custom.base_url',
            value: 'https://gateway.example.test/v1',
            mergeStrategy: 'upsert'
          },
          {
            keyPath: 'model_providers.custom.env_key',
            value: 'CLAWEE_MODEL_API_KEY',
            mergeStrategy: 'upsert'
          }
        ])
      });
    } finally {
      await prepared.client.close();
    }
  });

  it('registers the configured model in a private Codex model catalog', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-configuration-'));
    const fake = createFakeAppServer({
      directory: join(tempDir, 'fake')
    });
    const codexHome = join(tempDir, 'codex-home');
    const catalogPath = join(
      codexHome,
      'model-catalogs',
      'clawee-current.json'
    );

    const prepared = await prepareCodexRuntimeConfiguration({
      codexBin: fake.bin,
      codexHome,
      requestTimeoutMs: 10_000,
      modelService: {
        baseUrl: 'https://gateway.example.test/v1',
        model: 'deepseek-v4-flash'
      }
    });
    try {
      if (process.platform !== 'win32') {
        expect(statSync(catalogPath).mode & 0o777).toBe(0o600);
      }
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
        models: Array<Record<string, unknown>>;
      };
      expect(catalog.models.map(model => model.slug)).toEqual([
        'deepseek-v4-flash'
      ]);
      expect(catalog.models.at(-1)).toMatchObject({
        slug: 'deepseek-v4-flash',
        display_name: 'deepseek-v4-flash',
        supported_reasoning_levels: [],
        shell_type: 'unified_exec',
        context_window: 64_000,
        max_context_window: 64_000,
        input_modalities: ['text'],
        supports_image_detail_original: false,
        support_verbosity: false,
        base_instructions: 'Fake Codex base instructions'
      });
      expect(catalog.models.at(-1)).not.toHaveProperty('model_messages');

      const write = fake.readMessages().find(
        message => message.method === 'config/batchWrite'
      );
      expect(write?.params).toMatchObject({
        edits: expect.arrayContaining([{
          keyPath: 'model_catalog_json',
          value: catalogPath,
          mergeStrategy: 'upsert'
        }])
      });
    } finally {
      await prepared.client.close();
    }
  });

  it('preserves bundled capabilities for a known enterprise model', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-configuration-'));
    const fake = createFakeAppServer({ directory: join(tempDir, 'fake') });
    const codexHome = join(tempDir, 'codex-home');
    const prepared = await prepareCodexRuntimeConfiguration({
      codexBin: fake.bin,
      codexHome,
      requestTimeoutMs: 10_000,
      modelService: {
        baseUrl: 'https://gateway.example.test/v1',
        model: 'gpt-test-bundled'
      }
    });
    try {
      const catalog = JSON.parse(readFileSync(join(
        codexHome,
        'model-catalogs',
        'clawee-current.json'
      ), 'utf8')) as { models: Array<Record<string, unknown>> };
      expect(catalog.models).toHaveLength(1);
      expect(catalog.models[0]).toMatchObject({
        slug: 'gpt-test-bundled',
        display_name: 'GPT Test Bundled',
        context_window: 272_000,
        max_context_window: 272_000,
        input_modalities: ['text', 'image']
      });
    } finally {
      await prepared.client.close();
    }
  });

  it('rejects ready when the agents override remains enabled', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-configuration-'));
    const fake = createFakeAppServer({
      directory: join(tempDir, 'fake'),
      readAgentsEnabledOverride: true
    });

    await expect(prepareCodexRuntimeConfiguration({
      codexBin: fake.bin,
      codexHome: join(tempDir, 'codex-home'),
      requestTimeoutMs: 10_000
    })).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_CONFIGURATION_FEATURE_ENABLED'
    });

    expect(fake.readMessages().some(message =>
      message.method?.startsWith('thread/') === true
      || message.method?.startsWith('turn/') === true
      || message.method === 'account/usage/read'
    )).toBe(false);
  });

  it('rejects ready when an effective multi-agent value remains enabled', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-configuration-'));
    const fake = createFakeAppServer({
      directory: join(tempDir, 'fake'),
      readFeatureOverrides: { multi_agent_v2: true }
    });

    await expect(prepareCodexRuntimeConfiguration({
      codexBin: fake.bin,
      codexHome: join(tempDir, 'codex-home'),
      requestTimeoutMs: 10_000
    })).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_CONFIGURATION_FEATURE_ENABLED'
    });

    const spawns = fake.readSpawns();
    expect(spawns).toHaveLength(2);
    expect(fake.readMessages().map(message => message.method)).toEqual([
      'initialize',
      'initialized',
      'config/batchWrite',
      'initialize',
      'initialized',
      'config/read'
    ]);
  });

  it('rejects ready when the effective origin is not the written user config', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-runtime-configuration-'));
    const fake = createFakeAppServer({
      directory: join(tempDir, 'fake'),
      origin: {
        type: 'system',
        file: '/etc/codex/config.toml'
      }
    });

    await expect(prepareCodexRuntimeConfiguration({
      codexBin: fake.bin,
      codexHome: join(tempDir, 'codex-home'),
      requestTimeoutMs: 10_000
    })).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_CONFIGURATION_ORIGIN_CONFLICT'
    });

    expect(fake.readMessages().some(message =>
      message.method?.startsWith('thread/') === true
      || message.method?.startsWith('turn/') === true
      || message.method === 'account/usage/read'
    )).toBe(false);
  });
});
