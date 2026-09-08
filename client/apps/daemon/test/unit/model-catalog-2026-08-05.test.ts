import type { CodexModelResponse } from '@clawee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { CodexAppServerRequestClient } from '../../src/codex/app-server-client.js';
import {
  assertConfiguredModelAvailable,
  createCodexModelCatalog,
  selectConfiguredModel
} from '../../src/codex/model-catalog-2026-08-05.js';

describe('Codex model catalog', () => {
  it('loads every page and returns every visible model family', async () => {
    const request = vi.fn(async (_method: string, params: unknown) => {
      const cursor = (params as { cursor?: string }).cursor;
      if (cursor === undefined) {
        return {
          data: [rawModel('gpt-5.5')],
          nextCursor: 'page-2'
        };
      }
      return {
        data: [
          rawModel('gpt-5.6-sol', { isDefault: true }),
          rawModel('gpt-5.4'),
          rawModel('deepseek-v4-flash'),
          rawModel('minimax-hidden', { hidden: true })
        ],
        nextCursor: null
      };
    });
    const close = vi.fn(async () => undefined);
    const catalog = createCodexModelCatalog({
      client: { request, close } as CodexAppServerRequestClient,
      pageLimit: 50
    });

    await expect(catalog.listModels()).resolves.toEqual({
      models: [
        model('gpt-5.5'),
        model('gpt-5.6-sol', { isDefault: true }),
        model('gpt-5.4'),
        model('deepseek-v4-flash')
      ]
    });
    expect(request).toHaveBeenNthCalledWith(1, 'model/list', { limit: 50 });
    expect(request).toHaveBeenNthCalledWith(2, 'model/list', {
      limit: 50,
      cursor: 'page-2'
    });
    await catalog.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('adds a missing configured model without removing catalog models', () => {
    expect(selectConfiguredModel({
      models: [model('gpt-5.6-sol', { isDefault: true })]
    }, 'deepseek-v4-flash')).toEqual({
      models: [
        {
          id: 'deepseek-v4-flash',
          model: 'deepseek-v4-flash',
          displayName: 'deepseek-v4-flash',
          description: 'Configured by the Clawee model service.',
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          isDefault: true
        },
        model('gpt-5.6-sol', { isDefault: false })
      ]
    });
  });

  it('preserves all metadata and marks only the configured model as default', () => {
    expect(selectConfiguredModel({
      models: [
        model('gpt-5.6-sol', { isDefault: true }),
        model('deepseek-v4-flash')
      ]
    }, 'deepseek-v4-flash')).toEqual({
      models: [
        model('gpt-5.6-sol', { isDefault: false }),
        model('deepseek-v4-flash', { isDefault: true })
      ]
    });
  });

  it('confirms the configured model from the complete app-server list', async () => {
    const request = vi.fn(async () => ({
      data: [rawModel('deepseek-v4-flash', { description: '' })],
      nextCursor: null
    }));
    const client = {
      request,
      close: async () => undefined
    } as CodexAppServerRequestClient;

    await expect(assertConfiguredModelAvailable(
      client,
      'deepseek-v4-flash'
    )).resolves.toBeUndefined();
    await expect(assertConfiguredModelAvailable(
      client,
      'missing-model'
    )).rejects.toThrow('model/list is missing configured model: missing-model');
  });

  it('preserves known metadata for a configured Codex model', () => {
    expect(selectConfiguredModel({
      models: [model('gpt-5.6-sol')]
    }, 'gpt-5.6-sol')).toEqual({
      models: [model('gpt-5.6-sol', { isDefault: true })]
    });
  });

  it('rejects repeated cursors instead of looping forever', async () => {
    const request = vi.fn(async () => ({
      data: [rawModel('gpt-5.6-sol')],
      nextCursor: 'same'
    }));
    const catalog = createCodexModelCatalog({
      client: {
        request,
        close: async () => undefined
      } as CodexAppServerRequestClient
    });

    await expect(catalog.listModels()).rejects.toThrow(
      'Codex app-server returned a repeated model cursor'
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});

function rawModel(
  name: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id: name,
    model: name,
    displayName: displayName(name),
    description: `${name} description`,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'future', description: 'Unknown future value' }
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image', 'audio'],
    isDefault: false,
    ...overrides
  };
}

function model(
  name: string,
  overrides: Partial<CodexModelResponse> & { hidden?: boolean } = {}
): CodexModelResponse {
  return {
    id: name,
    model: name,
    displayName: displayName(name),
    description: `${name} description`,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'medium', description: 'Balanced' }
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    isDefault: false,
    ...overrides
  } as CodexModelResponse;
}

function displayName(name: string): string {
  return name.replace(/^gpt-/, 'GPT-');
}
