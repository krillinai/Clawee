import type { CodexModelListResponse } from '@clawee/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeClient } from '../runtime/client.js';
import {
  createModelService,
  MODEL_CATALOG_STORAGE_KEY,
  readCachedModelCatalog,
  readRecentModelConfig,
  RECENT_MODEL_CONFIG_STORAGE_KEY,
  writeCachedModelCatalog,
  writeRecentModelConfig
} from './model-service-2026-08-05.js';

const hiddenModels = [
  'codex-auto-review',
  'gpt-4o-audio-preview',
  'gpt-4o-realtime-preview',
  'gpt-5.2',
  'gpt-5.2-2025-12-11',
  'gpt-5.2-chat-latest',
  'gpt-5.2-pro',
  'gpt-5.2-pro-2025-12-11',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-5.4-2026-03-05',
  'gpt-5.4-mini',
  'gpt-image-1',
  'gpt-image-1.5',
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
  'gpt-reserve',
  'deepseek-v4-flash-vision-exp'
];

describe('ModelService', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('loads the Runtime Codex model catalog', async () => {
    const catalog = createModelCatalog();
    const get = vi.fn(async (_path: string) => catalog);
    const service = createModelService({
      get<T>(path: string): Promise<T> {
        return get(path) as Promise<T>;
      },
      rawGet: vi.fn()
    } satisfies Pick<RuntimeClient, 'get' | 'rawGet'>);

    await expect(service.listModels()).resolves.toEqual(catalog);
    expect(get).toHaveBeenCalledWith('/codex/models');
  });

  it.each(hiddenModels)('从接口列表中隐藏 %s，包括默认模型', async model => {
    const visibleModel = { ...createModelCatalog().models[0]!, isDefault: false };
    const service = createModelService({
      get: vi.fn().mockResolvedValue({
        models: [
          { ...visibleModel, id: `entry-${model}`, model, isDefault: true },
          visibleModel
        ],
        updatesAvailable: true
      }),
      rawGet: vi.fn()
    });

    await expect(service.listModels()).resolves.toEqual({
      models: [visibleModel],
      updatesAvailable: true
    });
  });

  it('读取旧缓存时同样过滤黑名单，并保持剩余模型的顺序', () => {
    const visibleModel = createModelCatalog().models[0]!;
    const anotherVisibleModel = { ...visibleModel, id: 'deepseek-v4-flash', model: 'deepseek-v4-flash', isDefault: false };
    writeCachedModelCatalog({
      models: [
        visibleModel,
        ...hiddenModels.map(model => ({ ...visibleModel, id: model, model, isDefault: false })),
        anotherVisibleModel
      ]
    });

    expect(readCachedModelCatalog()).toEqual({ models: [visibleModel, anotherVisibleModel] });
  });

  it('仅精确匹配调用标识，不按目录 ID、显示名或前缀隐藏', async () => {
    const template = createModelCatalog().models[0]!;
    const catalog = {
      models: [
        { ...template, id: 'gpt-5.4', displayName: 'gpt-5.2' },
        { ...template, id: 'custom', model: 'gpt-5.4-custom', isDefault: false },
        { ...template, id: 'gpt-image-2.5', model: 'gpt-image-2.5', isDefault: false }
      ]
    };
    const service = createModelService({ get: vi.fn().mockResolvedValue(catalog), rawGet: vi.fn() });

    await expect(service.listModels()).resolves.toEqual(catalog);
  });

  it('全部模型被隐藏时，接口和缓存都返回空列表', async () => {
    const template = createModelCatalog().models[0]!;
    const catalog = { models: hiddenModels.map(model => ({ ...template, id: model, model })) };
    const service = createModelService({ get: vi.fn().mockResolvedValue(catalog), rawGet: vi.fn() });
    writeCachedModelCatalog(catalog);

    await expect(service.listModels()).resolves.toEqual({ models: [] });
    expect(readCachedModelCatalog()).toEqual({ models: [] });
  });

  it('drops an invalid cached catalog instead of exposing corrupt data', () => {
    window.localStorage.setItem(MODEL_CATALOG_STORAGE_KEY, JSON.stringify({
      version: 1,
      updatedAt: '2026-08-05T08:00:00.000Z',
      catalog: {
        models: [{ id: 'gpt-5.6-sol' }]
      }
    }));

    expect(readCachedModelCatalog()).toBeUndefined();
    expect(window.localStorage.getItem(MODEL_CATALOG_STORAGE_KEY)).toBeNull();
  });

  it('persists and validates the most recently selected model config', () => {
    writeRecentModelConfig({
      model: 'gpt-5.5',
      reasoning: 'xhigh'
    });

    expect(readRecentModelConfig()).toEqual({
      model: 'gpt-5.5',
      reasoning: 'xhigh'
    });

    window.localStorage.setItem(RECENT_MODEL_CONFIG_STORAGE_KEY, JSON.stringify({
      version: 1,
      model: 'gpt-5.5',
      reasoning: 'future'
    }));
    expect(readRecentModelConfig()).toBeNull();
    expect(window.localStorage.getItem(RECENT_MODEL_CONFIG_STORAGE_KEY)).toBeNull();
  });
});

function createModelCatalog(): CodexModelListResponse {
  return {
    models: [
      {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        description: 'Latest model',
        supportedReasoningEfforts: [
          { reasoningEffort: 'medium', description: 'Balanced' },
          { reasoningEffort: 'xhigh', description: 'Deepest' }
        ],
        defaultReasoningEffort: 'medium',
        inputModalities: ['text', 'image'],
        isDefault: true
      }
    ]
  };
}
