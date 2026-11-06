import type { CodexModelResponse, ReasoningEffort } from '@clawee/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getModelReasoningOptions,
  readModelReasoningPreferences,
  resolveModelReasoning,
  writeModelReasoningPreferences
} from './model-reasoning-preferences.js';

function model(efforts: ReasoningEffort[]): CodexModelResponse {
  return {
    id: 'model-a', model: 'model-a', displayName: '模型 A', description: '',
    supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: '' })),
    defaultReasoningEffort: 'xhigh', inputModalities: ['text'], isDefault: true
  };
}

describe('模型推理强度偏好', () => {
  afterEach(() => window.localStorage.clear());

  it('优先选中档，不沿用模型的最高默认强度', () => {
    expect(resolveModelReasoning(model(['low', 'medium', 'high', 'xhigh']))).toBe('medium');
  });

  it.each([
    [['default', 'xhigh', 'low', 'high'], 'high'],
    [['max', 'xhigh', 'high', 'low'], 'high'],
    [['xhigh'], 'xhigh'],
    [['default'], null],
    [[], null]
  ] as Array<[ReasoningEffort[], ReasoningEffort | null]>)('从实际档位 %j 选择中间档 %s', (efforts, expected) => {
    expect(resolveModelReasoning(model(efforts))).toBe(expected);
  });

  it('按模型使用偏好，档位失效时回到中档', () => {
    const preferences = { 'model-a': 'xhigh', 'model-b': 'low' } as const;
    expect(resolveModelReasoning(model(['low', 'medium', 'xhigh']), preferences)).toBe('xhigh');
    expect(resolveModelReasoning({ ...model(['low', 'medium']), model: 'model-b' }, preferences)).toBe('low');
    expect(resolveModelReasoning(model(['low', 'medium']), preferences)).toBe('medium');
    expect(resolveModelReasoning(model([]), preferences)).toBeNull();
    expect(resolveModelReasoning(undefined, preferences)).toBeNull();
  });

  it('只展示模型支持的具体档位，并按强度排序', () => {
    expect(getModelReasoningOptions(model(['xhigh', 'default', 'medium', 'low', 'medium'])))
      .toEqual(['low', 'medium', 'xhigh']);
  });

  it('持久保存各模型的独立偏好', () => {
    writeModelReasoningPreferences({ 'model-a': 'high', 'model-b': 'low' });
    expect(readModelReasoningPreferences()).toEqual({ 'model-a': 'high', 'model-b': 'low' });
  });
});
