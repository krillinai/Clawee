import type {
  CodexModelInputModality,
  CodexModelListResponse,
  CodexModelReasoningEffortOption,
  CodexModelResponse,
  ReasoningEffort
} from '@clawee/protocol';
import type { CodexAppServerRequestClient } from './app-server-client.js';

export type CodexModelCatalog = {
  listModels(): Promise<CodexModelListResponse>;
  close(): Promise<void>;
};

export type CreateCodexModelCatalogInput = {
  client: CodexAppServerRequestClient;
  pageLimit?: number;
};

type CodexModelListPage = {
  data: ParsedCodexModel[];
  nextCursor?: string;
};

type ParsedCodexModel = CodexModelResponse & {
  hidden: boolean;
};

const DEFAULT_PAGE_LIMIT = 100;
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'default',
  'low',
  'medium',
  'high',
  'xhigh'
]);
const INPUT_MODALITIES = new Set<CodexModelInputModality>(['text', 'image']);

export function createCodexModelCatalog(
  input: CreateCodexModelCatalogInput
): CodexModelCatalog {
  const pageLimit = normalizePageLimit(input.pageLimit);

  return {
    async listModels(): Promise<CodexModelListResponse> {
      const models: ParsedCodexModel[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;

      do {
        const result = await input.client.request<unknown>('model/list', {
          limit: pageLimit,
          ...(cursor === undefined ? {} : { cursor })
        });
        const page = parseModelListPage(result);
        models.push(...page.data);
        cursor = page.nextCursor;
        if (cursor !== undefined && seenCursors.has(cursor)) {
          throw new Error('Codex app-server returned a repeated model cursor');
        }
        if (cursor !== undefined) seenCursors.add(cursor);
      } while (cursor !== undefined);

      return {
        models: models
          .filter(model => !model.hidden)
          .map(({ hidden: _hidden, ...model }) => model)
      };
    },

    close(): Promise<void> {
      return input.client.close();
    }
  };
}

export function selectConfiguredModel(
  catalog: CodexModelListResponse,
  configuredModel: string
): CodexModelListResponse {
  const normalized = configuredModel.trim();
  if (normalized.length === 0) return catalog;
  const existing = catalog.models.find(model => model.model === normalized);
  if (existing !== undefined) {
    return {
      models: catalog.models.map(model => ({
        ...model,
        isDefault: model.model === normalized
      }))
    };
  }
  return {
    models: [
      configuredModelResponse(normalized),
      ...catalog.models.map(model => ({ ...model, isDefault: false }))
    ]
  };
}

export async function assertConfiguredModelAvailable(
  client: CodexAppServerRequestClient,
  configuredModel: string
): Promise<void> {
  const catalog = await createCodexModelCatalog({ client }).listModels();
  if (!catalog.models.some(model => model.model === configuredModel)) {
    throw new Error(
      `Codex app-server model/list is missing configured model: ${configuredModel}`
    );
  }
}

function configuredModelResponse(model: string): CodexModelResponse {
  return {
    id: model,
    model,
    displayName: model,
    description: 'Configured by the Clawee model service.',
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ['text'],
    isDefault: true
  };
}

function parseModelListPage(value: unknown): CodexModelListPage {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Codex app-server returned an invalid model list');
  }
  const nextCursor = value.nextCursor;
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== 'string') {
    throw new Error('Codex app-server returned an invalid model cursor');
  }

  return {
    data: value.data.map(parseModel),
    ...(typeof nextCursor === 'string' && nextCursor.length > 0
      ? { nextCursor }
      : {})
  };
}

function parseModel(value: unknown): ParsedCodexModel {
  if (!isRecord(value)) {
    throw new Error('Codex app-server returned an invalid model');
  }

  const id = requireString(value.id, 'model.id');
  const model = requireString(value.model, 'model.model');
  const displayName = requireString(value.displayName, 'model.displayName');
  const description = value.description;
  if (typeof description !== 'string') {
    throw new Error('Codex app-server returned invalid model.description');
  }
  if (typeof value.hidden !== 'boolean') {
    throw new Error('Codex app-server returned invalid model.hidden');
  }
  if (!Array.isArray(value.supportedReasoningEfforts)) {
    throw new Error('Codex app-server returned invalid model.supportedReasoningEfforts');
  }
  if (!Array.isArray(value.inputModalities)) {
    throw new Error('Codex app-server returned invalid model.inputModalities');
  }
  if (typeof value.isDefault !== 'boolean') {
    throw new Error('Codex app-server returned invalid model.isDefault');
  }

  const supportedReasoningEfforts = value.supportedReasoningEfforts.flatMap(
    parseReasoningEffortOption
  );
  const defaultReasoningEffort = parseReasoningEffort(value.defaultReasoningEffort);
  const inputModalities = value.inputModalities.flatMap(parseInputModality);

  return {
    id,
    model,
    displayName,
    description,
    supportedReasoningEfforts,
    defaultReasoningEffort,
    inputModalities,
    isDefault: value.isDefault,
    hidden: value.hidden
  };
}

function parseReasoningEffortOption(
  value: unknown
): CodexModelReasoningEffortOption[] {
  if (!isRecord(value)) return [];
  const reasoningEffort = parseReasoningEffort(value.reasoningEffort);
  if (reasoningEffort === null || typeof value.description !== 'string') return [];
  return [{ reasoningEffort, description: value.description }];
}

function parseReasoningEffort(value: unknown): ReasoningEffort | null {
  return typeof value === 'string' && REASONING_EFFORTS.has(value as ReasoningEffort)
    ? value as ReasoningEffort
    : null;
}

function parseInputModality(value: unknown): CodexModelInputModality[] {
  return typeof value === 'string'
    && INPUT_MODALITIES.has(value as CodexModelInputModality)
    ? [value as CodexModelInputModality]
    : [];
}

function normalizePageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(value, 100));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Codex app-server returned invalid ${field}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
