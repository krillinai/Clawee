import { describe, expect, it } from 'vitest';
import { canonicalFeedbackJSON } from './feedback.js';

describe('反馈规范化', () => {
  it('与 Go 测试向量一致', () => {
    expect(canonicalFeedbackJSON({ b: 1e-7, a: '测试', c: -0 })).toBe('{"a":"测试","b":1e-7,"c":0}');
  });
});
