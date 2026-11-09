// 按实际调用的模型标识精确匹配；名单随客户端版本更新。
const MODEL_BLACKLIST = new Set([
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
]);

export function isModelHidden(model: string): boolean {
  return MODEL_BLACKLIST.has(model);
}
