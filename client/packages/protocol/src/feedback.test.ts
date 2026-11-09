import { describe, expect, it } from 'vitest';
import { canonicalFeedbackJSON, resolveFeedbackOrigin } from './feedback.js';

describe('反馈规范化', () => {
  it('与 Go 测试向量一致', () => {
    expect(canonicalFeedbackJSON({ b: 1e-7, a: '测试', c: -0 })).toBe('{"a":"测试","b":1e-7,"c":0}');
  });
  it.each([undefined, '', 'not-a-url', 'ftp://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com?token=secret', 'https://enterprise.invalid'])('无效目标不回退到维护中心：%s', value => {
    expect(resolveFeedbackOrigin(value)).toBeUndefined();
  });
  it('使用当前部署的规范化origin', () => {
    expect(resolveFeedbackOrigin(' https://EXAMPLE.com:443/ ')).toBe('https://example.com');
    expect(resolveFeedbackOrigin('http://127.0.0.1:1904')).toBe('http://127.0.0.1:1904');
  });
});
