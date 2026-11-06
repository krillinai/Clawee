import type { CodexModelResponse, ReasoningEffort } from '@clawee/protocol';
import { readJsonFromStorage, writeJsonToStorage } from '../storage/browser-storage.js';

export type ModelReasoningEffort = Exclude<ReasoningEffort, 'default'>;
export type ModelReasoningPreferences = Record<string, ModelReasoningEffort>;

const STORAGE_KEY = 'clawee.models.reasoning-preferences.v1';
const EFFORTS: ModelReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const LABELS: Record<ModelReasoningEffort, string> = {
  low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高'
};

export function getModelReasoningOptions(model: CodexModelResponse): ModelReasoningEffort[] {
  return EFFORTS.filter(effort => model.supportedReasoningEfforts.some(option => option.reasoningEffort === effort));
}

export function reasoningEffortLabel(effort: ModelReasoningEffort): string {
  return LABELS[effort];
}

export function resolveModelReasoning(
  model: CodexModelResponse | undefined,
  preferences: ModelReasoningPreferences = {}
): ModelReasoningEffort | null {
  if (model === undefined) return null;
  const options = getModelReasoningOptions(model);
  const preferred = preferences[model.model];
  if (preferred !== undefined && options.includes(preferred)) return preferred;
  return options.includes('medium') ? 'medium' : options[Math.floor((options.length - 1) / 2)] ?? null;
}

export function readModelReasoningPreferences(): ModelReasoningPreferences {
  const stored = readJsonFromStorage<unknown>(STORAGE_KEY);
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).filter(
    (entry): entry is [string, ModelReasoningEffort] => EFFORTS.includes(entry[1] as ModelReasoningEffort)
  ));
}

export function writeModelReasoningPreferences(preferences: ModelReasoningPreferences): void {
  writeJsonToStorage(STORAGE_KEY, preferences);
}
