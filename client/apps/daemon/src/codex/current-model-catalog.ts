import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnCodexProcessSync } from './process.js';

const MODEL_CATALOG_RELATIVE_PATH = join(
  'model-catalogs',
  'clawee-current.json'
);
const MODEL_CATALOG_COMMAND_TIMEOUT_MS = 10_000;
const MODEL_CATALOG_MAX_BYTES = 16 * 1024 * 1024;
export const GENERATED_MODEL_CONTEXT_WINDOW = 64_000;

export type JsonRecord = Record<string, unknown>;

export type BundledModelCatalog = JsonRecord & {
  models: JsonRecord[];
};

export function ensureCurrentModelCatalog(input: {
  codexBin: string;
  codexHome: string;
  model: string;
}): string {
  const bundled = readBundledModelCatalog(input.codexBin);
  const bundledModel = bundled.models.find(model => model.slug === input.model);
  const models = [bundledModel ?? createGeneratedModel(
    input.model,
    input.model,
    selectModelTemplate(bundled.models)
  )];
  const path = join(input.codexHome, MODEL_CATALOG_RELATIVE_PATH);
  writePrivateJson(path, { ...bundled, models });
  return path;
}

export function readBundledModelCatalog(codexBin: string): BundledModelCatalog {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'clawee-model-catalog-'));
  try {
    const result = spawnCodexProcessSync(
      codexBin,
      ['debug', 'models', '--bundled'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CODEX_HOME: isolatedHome
        },
        maxBuffer: MODEL_CATALOG_MAX_BYTES,
        timeout: MODEL_CATALOG_COMMAND_TIMEOUT_MS,
        windowsHide: true
      }
    );
    if (result.error != null || result.status !== 0) {
      const stderr = normalizeOutput(result.stderr).trim();
      const cause = result.error?.message
        ?? (stderr.length > 0 ? stderr : undefined)
        ?? `exit code ${String(result.status)}, signal ${String(result.signal)}`;
      throw new Error(`Codex bundled model catalog command failed: ${cause}`);
    }
    return parseBundledModelCatalog(normalizeOutput(result.stdout));
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

function parseBundledModelCatalog(value: string): BundledModelCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Codex bundled model catalog is not valid JSON: ${errorMessage(error)}`
    );
  }
  if (
    !isRecord(parsed)
    || !Array.isArray(parsed.models)
    || parsed.models.length === 0
    || !parsed.models.every(model => isRecord(model))
  ) {
    throw new Error('Codex bundled model catalog has no usable models');
  }
  return {
    ...parsed,
    models: parsed.models
  };
}

export function selectModelTemplate(models: readonly JsonRecord[]): JsonRecord {
  const preferred = models.find(model => model.slug === 'gpt-5.4');
  const template = preferred ?? models.find(hasBaseInstructions);
  if (template === undefined || !hasBaseInstructions(template)) {
    throw new Error(
      'Codex bundled model catalog has no model with base instructions'
    );
  }
  return template;
}

export function createGeneratedModel(
  model: string,
  displayName: string,
  template: JsonRecord
): JsonRecord {
  const templateWithoutModelMessages = Object.fromEntries(
    Object.entries(template).filter(([key]) => key !== 'model_messages')
  );
  return {
    ...templateWithoutModelMessages,
    slug: model,
    display_name: displayName,
    description: null,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 99,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    include_skills_usage_instructions: false,
    default_reasoning_summary: 'auto',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: 'text',
    truncation_policy: {
      mode: 'bytes',
      limit: 10_000
    },
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    context_window: GENERATED_MODEL_CONTEXT_WINDOW,
    max_context_window: GENERATED_MODEL_CONTEXT_WINDOW,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_search_tool: false,
    use_responses_lite: false,
    tool_mode: null,
    multi_agent_version: null
  };
}

function writePrivateJson(path: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  try {
    if (readFileSync(path, 'utf8') === content) {
      chmodSync(path, 0o600);
      return;
    }
  } catch {
    // Missing or unreadable catalogs are replaced atomically below.
  }

  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function hasBaseInstructions(value: JsonRecord): boolean {
  return typeof value.base_instructions === 'string'
    && value.base_instructions.length > 0;
}

function normalizeOutput(value: string | Buffer | null): string {
  if (typeof value === 'string') return value;
  return value?.toString('utf8') ?? '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
