import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createGeneratedModel,
  readBundledModelCatalog,
  selectModelTemplate,
  type BundledModelCatalog,
  type JsonRecord
} from './current-model-catalog.js';

export type RemoteCatalogShape = 'openai_list' | 'codex_manifest';
export type InstalledCatalogSource = 'remote' | 'fallback';

export type InstallModelCatalogResult = {
  path: string;
  source: InstalledCatalogSource;
  remoteShape?: RemoteCatalogShape;
  contentHash: string;
  changed: boolean;
  modelCount: number;
};

type CatalogMeta = {
  schemaVersion: 2;
  credentialVersion: number;
  requestUrl: string;
  defaultModel: string;
  etag?: string;
  contentHash: string;
  remoteShape: RemoteCatalogShape;
  updatedAt: string;
};

type NormalizedRemoteCatalog = {
  catalog: JsonRecord & { models: JsonRecord[] };
  shape: RemoteCatalogShape;
};

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_MODEL_ID_LENGTH = 256;

export function installFallbackModelCatalog(input: {
  codexHome: string;
  codexBin: string;
  defaultModel: string;
}): InstallModelCatalogResult {
  const bundled = readBundledModelCatalog(input.codexBin);
  return writeCurrentCatalog(
    input.codexHome,
    createFallbackCatalog(bundled, input.defaultModel),
    'fallback'
  );
}

export async function installModelCatalog(input: {
  codexHome: string;
  codexBin: string;
  codexVersion: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  credentialVersion: number;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<InstallModelCatalogResult> {
  const bundled = readBundledModelCatalog(input.codexBin);
  const fallback = () => writeCurrentCatalog(
    input.codexHome,
    createFallbackCatalog(bundled, input.defaultModel),
    'fallback'
  );
  try {
    const paths = catalogPaths(input.codexHome);
    const previousMeta = readMeta(paths.meta);
    const requestUrl = modelListUrl(input.baseUrl, input.codexVersion);
    const canUseConditionalRequest =
      previousMeta?.credentialVersion === input.credentialVersion
      && previousMeta.requestUrl === requestUrl
      && previousMeta.defaultModel === input.defaultModel
      && previousMeta.etag !== undefined;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      input.timeoutMs ?? REQUEST_TIMEOUT_MS
    );
    timeout.unref();
    let response: Response;
    try {
      response = await (input.fetch ?? globalThis.fetch)(requestUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${input.apiKey}`,
          ...(canUseConditionalRequest
            ? { 'If-None-Match': previousMeta.etag! }
            : {})
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 304) {
      if (!canUseConditionalRequest) return fallback();
      const cached = readAndValidateCachedCatalog(
        paths.lastSuccess,
        input.defaultModel,
        previousMeta.contentHash
      );
      if (cached === undefined) return fallback();
      return writeCurrentCatalog(
        input.codexHome,
        cached,
        'remote',
        previousMeta.remoteShape
      );
    }
    if (response.status !== 200) return fallback();

    const parsed = JSON.parse(await readBoundedResponse(response)) as unknown;
    const normalized = normalizeRemoteCatalog(
      parsed,
      bundled,
      input.defaultModel
    );
    const result = writeCurrentCatalog(
      input.codexHome,
      normalized.catalog,
      'remote',
      normalized.shape
    );
    writePrivateJson(paths.lastSuccess, normalized.catalog);
    writePrivateJson(paths.meta, {
      schemaVersion: 2,
      credentialVersion: input.credentialVersion,
      requestUrl,
      defaultModel: input.defaultModel,
      ...(response.headers.get('etag') === null
        ? {}
        : { etag: response.headers.get('etag')! }),
      contentHash: result.contentHash,
      remoteShape: normalized.shape,
      updatedAt: new Date().toISOString()
    } satisfies CatalogMeta);
    return result;
  } catch {
    return fallback();
  }
}

function normalizeRemoteCatalog(
  value: unknown,
  bundled: BundledModelCatalog,
  defaultModel: string
): NormalizedRemoteCatalog {
  if (!isRecord(value)) throw new Error('remote model catalog is not an object');
  if ('models' in value) {
    if (!Array.isArray(value.models) || value.models.length === 0) {
      throw new Error('remote manifest is empty');
    }
    const models = normalizeManifestModels(value.models, bundled, defaultModel);
    return {
      catalog: { ...value, models: defaultFirst(models, defaultModel) },
      shape: 'codex_manifest'
    };
  }
  if (value.object === 'list' && Array.isArray(value.data)) {
    const models = normalizeOpenAiModels(value.data, bundled, defaultModel);
    return {
      catalog: { ...bundled, models: defaultFirst(models, defaultModel) },
      shape: 'openai_list'
    };
  }
  throw new Error('remote model catalog has an unsupported shape');
}

function normalizeOpenAiModels(
  values: unknown[],
  bundled: BundledModelCatalog,
  defaultModel: string
): JsonRecord[] {
  const template = selectModelTemplate(bundled.models);
  const models: JsonRecord[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isRecord(value)) throw new Error('remote model entry is invalid');
    const id = modelId(value.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const displayName = typeof value.display_name === 'string'
      && value.display_name.trim().length > 0
      ? value.display_name.trim()
      : id;
    models.push(createGeneratedModel(id, displayName, template));
  }
  if (models.length === 0) throw new Error('remote model list is empty');
  if (!seen.has(defaultModel)) {
    models.push(createGeneratedModel(defaultModel, defaultModel, template));
  }
  return models;
}

function normalizeManifestModels(
  values: unknown[],
  bundled: BundledModelCatalog,
  defaultModel: string
): JsonRecord[] {
  const models: JsonRecord[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isRecord(value)) throw new Error('remote manifest entry is invalid');
    const slug = modelId(value.slug);
    if (seen.has(slug)) throw new Error('remote manifest contains duplicate slugs');
    seen.add(slug);
    models.push({ ...value, slug });
  }
  if (models.length === 0) throw new Error('remote manifest is empty');
  if (!seen.has(defaultModel)) {
    models.push(createGeneratedModel(
      defaultModel,
      defaultModel,
      selectModelTemplate(bundled.models)
    ));
  }
  return models;
}

function createFallbackCatalog(
  bundled: BundledModelCatalog,
  defaultModel: string
): JsonRecord & { models: JsonRecord[] } {
  return {
    ...bundled,
    models: [createGeneratedModel(
      defaultModel,
      defaultModel,
      selectModelTemplate(bundled.models)
    )]
  };
}

function defaultFirst(models: JsonRecord[], defaultModel: string): JsonRecord[] {
  const index = models.findIndex(model => model.slug === defaultModel);
  if (index <= 0) return models;
  return [models[index]!, ...models.slice(0, index), ...models.slice(index + 1)];
}

function modelId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('remote model id is invalid');
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_MODEL_ID_LENGTH) {
    throw new Error('remote model id is invalid');
  }
  return normalized;
}

function modelListUrl(baseUrl: string, codexVersion: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/models`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('client_version', normalizeCodexVersion(codexVersion));
  return url.toString();
}

function normalizeCodexVersion(value: string): string {
  return /\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/u.exec(value)?.[0]
    ?? value.trim();
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('remote model catalog response is too large');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('remote model catalog response is too large');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function writeCurrentCatalog(
  codexHome: string,
  catalog: JsonRecord & { models: JsonRecord[] },
  source: InstalledCatalogSource,
  remoteShape?: RemoteCatalogShape
): InstallModelCatalogResult {
  const path = catalogPaths(codexHome).current;
  const content = serialize(catalog);
  const contentHash = sha256(content);
  const changed = readContentHash(path) !== contentHash;
  writePrivateContent(path, content);
  return {
    path,
    source,
    ...(remoteShape === undefined ? {} : { remoteShape }),
    contentHash,
    changed,
    modelCount: catalog.models.length
  };
}

function readAndValidateCachedCatalog(
  path: string,
  defaultModel: string,
  expectedContentHash: string
): (JsonRecord & { models: JsonRecord[] }) | undefined {
  try {
    const content = readFileSync(path, 'utf8');
    if (sha256(content) !== expectedContentHash) return undefined;
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.models) || parsed.models.length === 0) {
      return undefined;
    }
    const seen = new Set<string>();
    for (const model of parsed.models) {
      if (!isRecord(model)) return undefined;
      const slug = modelId(model.slug);
      if (seen.has(slug)) return undefined;
      seen.add(slug);
    }
    if (!seen.has(defaultModel)) return undefined;
    return { ...parsed, models: parsed.models as JsonRecord[] };
  } catch {
    return undefined;
  }
}

function readMeta(path: string): CatalogMeta | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (
      !isRecord(value)
      || value.schemaVersion !== 2
      || !Number.isSafeInteger(value.credentialVersion)
      || typeof value.requestUrl !== 'string'
      || typeof value.defaultModel !== 'string'
      || typeof value.contentHash !== 'string'
      || (value.remoteShape !== 'openai_list' && value.remoteShape !== 'codex_manifest')
      || typeof value.updatedAt !== 'string'
      || !(value.etag === undefined || typeof value.etag === 'string')
    ) {
      return undefined;
    }
    return value as CatalogMeta;
  } catch {
    return undefined;
  }
}

function catalogPaths(codexHome: string) {
  const directory = join(codexHome, 'model-catalogs');
  return {
    current: join(directory, 'clawee-current.json'),
    lastSuccess: join(directory, 'clawee-last-success.json'),
    meta: join(directory, 'clawee-catalog-meta.json')
  };
}

function writePrivateJson(path: string, value: unknown): void {
  writePrivateContent(path, serialize(value));
}

function writePrivateContent(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  try {
    if (readFileSync(path, 'utf8') === content) {
      chmodSync(path, 0o600);
      return;
    }
  } catch {
    // Missing or unreadable files are replaced atomically below.
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readContentHash(path: string): string | undefined {
  try {
    return sha256(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
