import { parse, stringify } from '@iarna/toml';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_TOOL_ISOLATION_FEATURES, type BuiltInToolPolicy } from '../codex/argv.js';
import { readBundledModelCatalog } from '../codex/current-model-catalog.js';
import { createCodexProbeHome } from '../codex/probe-home.js';

export const SKILL_AI_REVIEW_TOOLS: BuiltInToolPolicy = {
  shell: false,
  fileRead: false,
  fileWrite: false,
  applyPatch: false,
  webSearch: false
};

export function prepareSkillAIReviewRuntime(input: {
  codexBin: string;
  codexHome: string;
  cwd: string;
  env?: Record<string, string>;
}) {
  let home: ReturnType<typeof createCodexProbeHome> | undefined;
  try {
    home = createCodexProbeHome(input.codexHome);
    const configuration = parse(readFileSync(join(home.path, 'config.toml'), 'utf8'));
    const cwd = input.cwd;
    const userHome = join(home.path, 'user-home');
    mkdirSync(userHome, { mode: 0o700 });
    const env: Record<string, string> = {
      HOME: userHome,
      USERPROFILE: userHome,
      XDG_CONFIG_HOME: userHome,
      XDG_DATA_HOME: userHome,
      APPDATA: userHome,
      LOCALAPPDATA: userHome
    };
    const sourceEnv = { ...process.env, ...input.env };
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
      if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name]!;
    }
    const providers = configuration.model_providers;
    if (providers !== null && typeof providers === 'object' && !Array.isArray(providers)) {
      for (const provider of Object.values(providers)) {
        if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) continue;
        const values = provider as Record<string, unknown>;
        if (values.env_key !== undefined && (typeof values.env_key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values.env_key))) {
          throw new Error('审核模型凭据变量无效');
        }
        if (typeof values.env_key === 'string' && sourceEnv[values.env_key] !== undefined) {
          env[values.env_key] = sourceEnv[values.env_key]!;
        }
        const headers = values.http_headers;
        const envHeaders = { ...(values.env_http_headers as Record<string, string> | undefined) };
        if (headers !== null && typeof headers === 'object' && !Array.isArray(headers)) {
          for (const [header, value] of Object.entries(headers)) {
            if (typeof value !== 'string') throw new Error('审核模型配置无效');
            const name = `CLAWEE_REVIEW_HEADER_${Object.keys(env).length}`;
            env[name] = value;
            envHeaders[header] = name;
          }
        }
        for (const name of Object.values(envHeaders)) {
          if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('审核模型凭据变量无效');
          if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name]!;
        }
        delete values.http_headers;
        if (Object.keys(envHeaders).length > 0) values.env_http_headers = envHeaders;
        if (values.experimental_bearer_token !== undefined) throw new Error('审核模型配置含不支持的凭据');
      }
    }
    const catalog = typeof configuration.model_catalog_json === 'string'
      ? JSON.parse(readFileSync(configuration.model_catalog_json, 'utf8')) as { models: Record<string, unknown>[] }
      : readBundledModelCatalog(input.codexBin);
    if (!Array.isArray(catalog.models) || catalog.models.length === 0) throw new Error('审核模型目录无效');
    if (catalog.models.some(model => model === null || typeof model !== 'object' || typeof model.slug !== 'string')
      || typeof configuration.model === 'string' && !catalog.models.some(model => model.slug === configuration.model)) {
      throw new Error('审核模型未包含在受控目录');
    }
    const models = catalog.models.map(model => ({
      ...model,
      shell_type: 'disabled',
      apply_patch_tool_type: null,
      experimental_supported_tools: [],
      include_skills_usage_instructions: false,
      supports_search_tool: false,
      tool_mode: null,
      multi_agent_version: null
    }));
    const catalogPath = join(home.path, 'review-models.json');
    writeFileSync(catalogPath, JSON.stringify({ ...catalog, models }), { mode: 0o600 });
    configuration.model_catalog_json = catalogPath;
    configuration.project_doc_max_bytes = 0;
    configuration.project_root_markers = [];
    configuration.skills = { include_instructions: false, bundled: { enabled: false } };
    configuration.tools = { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } };
    configuration.agents = { enabled: false };
    configuration.approval_policy = 'never';
    configuration.sandbox_mode = 'read-only';
    configuration.features = Object.fromEntries([
      ...CODEX_TOOL_ISOLATION_FEATURES,
      'multi_agent_v2', 'view_image', 'skill_search', 'goals', 'token_budget',
      'current_time_reminder', 'request_permissions_tool', 'deferred_executor',
      'code_mode', 'code_mode_host', 'code_mode_prewarm', 'standalone_web_search',
      'memories', 'external_agent_memory_import'
    ].map(feature => [feature, false]));
    writeFileSync(join(home.path, 'config.toml'), stringify(configuration), { mode: 0o600 });
    chmodSync(cwd, 0o500);
    const configArgs: string[] = [];
    function tomlValue(value: unknown): string {
      if (Array.isArray(value)) return `[${value.map(tomlValue).join(',')}]`;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return `{${Object.entries(value).map(([key, field]) => `${JSON.stringify(key)}=${tomlValue(field)}`).join(',')}}`;
      }
      return JSON.stringify(value);
    }
    for (const [key, value] of Object.entries(configuration)) configArgs.push('-c', `${key}=${tomlValue(value)}`);
    return { ...home, cwd, env, configArgs };
  } catch {
    home?.cleanup();
    throw new Error('Skill AI 审核隔离准备失败');
  }
}
