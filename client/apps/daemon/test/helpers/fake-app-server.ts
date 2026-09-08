import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';

export type FakeAppServerMessage = {
  pid: number;
  id?: string | number;
  method?: string;
  params?: unknown;
};

export type FakeAppServerSpawn = {
  pid: number;
  args: string[];
  codexHome: string | null;
};

export function createFakeAppServer(input: {
  directory: string;
  readFeatureOverrides?: {
    multi_agent?: boolean;
    multi_agent_v2?: boolean;
  };
  readAgentsEnabledOverride?: boolean;
  origin?: {
    type: string;
    file?: string;
    profile?: string | null;
  };
  includeThreadUsage?: boolean;
  readableThreadIds?: string[];
}): {
  bin: string;
  readMessages(): FakeAppServerMessage[];
  readSpawns(): FakeAppServerSpawn[];
} {
  mkdirSync(input.directory, { recursive: true });
  const bin = join(input.directory, 'fake-app-server.js');
  const messagesPath = join(input.directory, 'messages.jsonl');
  const spawnsPath = join(input.directory, 'spawns.jsonl');
  const statePath = join(input.directory, 'state.json');
  const readFeatureOverrides = input.readFeatureOverrides ?? {};
  const origin = input.origin ?? { type: 'user', profile: null };

  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const messagesPath = ${JSON.stringify(messagesPath)};
const spawnsPath = ${JSON.stringify(spawnsPath)};
const statePath = ${JSON.stringify(statePath)};
const readFeatureOverrides = ${JSON.stringify(readFeatureOverrides)};
const configuredOrigin = ${JSON.stringify(origin)};
const includeThreadUsage = ${JSON.stringify(input.includeThreadUsage === true)};
const readableThreadIds = new Set(${JSON.stringify(input.readableThreadIds ?? [])});
const readAgentsEnabledOverride = ${JSON.stringify(input.readAgentsEnabledOverride)};
const codexHome = process.env.CODEX_HOME || '';
const configPath = path.join(codexHome, 'config.toml');
const version = 'sha256:fake-runtime-configuration';
const bundledModelCatalog = {
  models: [{
    slug: 'gpt-test-bundled',
    display_name: 'GPT Test Bundled',
    description: 'Fake bundled model',
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: 'Fake Codex base instructions',
    include_skills_usage_instructions: false,
    default_reasoning_summary: 'auto',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 10000 },
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    context_window: 272000,
    max_context_window: 272000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    supports_search_tool: false,
    use_responses_lite: false
  }]
};
const append = (file, value) => {
  fs.appendFileSync(file, JSON.stringify(value) + '\\n');
};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const readState = () => fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : {
      agents_enabled: true,
      multi_agent: true,
      multi_agent_v2: true,
      values: {},
      written_keys: []
    };
const setPath = (target, keyPath, value) => {
  const segments = keyPath.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    current[segment] ||= {};
    current = current[segment];
  }
  current[segments.at(-1)] = value;
};

const args = process.argv.slice(2);
if (
  args.includes('debug')
  && args.includes('models')
  && args.includes('--bundled')
) {
  process.stdout.write(JSON.stringify(bundledModelCatalog));
  process.exit(0);
}

if (
  codexHome.length === 0
  || !fs.existsSync(codexHome)
  || !fs.statSync(codexHome).isDirectory()
) {
  process.stderr.write('CODEX_HOME must exist before app-server starts\\n');
  process.exit(61);
}

append(spawnsPath, {
  pid: process.pid,
  args: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME || null
});

process.on('SIGTERM', () => process.exit(0));
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const message = JSON.parse(line);
  append(messagesPath, { pid: process.pid, ...message });
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-app-server' } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'config/batchWrite') {
    const state = readState();
    for (const edit of message.params.edits) {
      setPath(state.values, edit.keyPath, edit.value);
      if (!state.written_keys.includes(edit.keyPath)) {
        state.written_keys.push(edit.keyPath);
      }
      if (edit.keyPath === 'agents.enabled') {
        state.agents_enabled = edit.value;
      } else if (edit.keyPath === 'features.multi_agent') {
        state.multi_agent = edit.value;
      }
      if (edit.keyPath === 'features.multi_agent_v2') {
        state.multi_agent_v2 = edit.value;
      }
    }
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state));
    fs.writeFileSync(
      configPath,
      '[agents]\\nenabled = false\\n\\n'
      + '[features]\\nmulti_agent = false\\nmulti_agent_v2 = false\\n'
    );
    send({
      id: message.id,
      result: {
        status: 'ok',
        version,
        filePath: configPath,
        overriddenMetadata: null
      }
    });
    return;
  }
  if (message.method === 'config/read') {
    const state = readState();
    const originName = {
      ...configuredOrigin,
      file: configuredOrigin.file || configPath
    };
    const config = structuredClone(state.values);
    config.agents ||= {};
    config.features ||= {};
    config.agents.enabled =
      readAgentsEnabledOverride ?? state.agents_enabled;
    config.features.multi_agent =
      readFeatureOverrides.multi_agent ?? state.multi_agent;
    config.features.multi_agent_v2 =
      readFeatureOverrides.multi_agent_v2 ?? state.multi_agent_v2;
    const origins = Object.fromEntries(
      state.written_keys.map(keyPath => [
        keyPath === 'features.multi_agent_v2'
          ? 'features.multi_agent_v2.enabled'
          : keyPath,
        { name: originName, version }
      ])
    );
    send({
      id: message.id,
      result: {
        config,
        origins,
        layers: null,
        ...(includeThreadUsage ? { threadUsage: { totalTokens: 123 } } : {})
      }
    });
    return;
  }
  if (message.method === 'model/list') {
    send({ id: message.id, result: { data: [], nextCursor: null } });
    return;
  }
  if (message.method === 'thread/read') {
    const threadId = message.params && message.params.threadId;
    if (typeof threadId !== 'string' || !readableThreadIds.has(threadId)) {
      send({
        id: message.id,
        error: { code: -32602, message: 'thread not loaded: ' + threadId }
      });
      return;
    }
    send({
      id: message.id,
      result: {
        thread: {
          id: threadId,
          turns: []
        }
      }
    });
    return;
  }
  send({
    id: message.id,
    error: { code: -32601, message: 'Unsupported fake method: ' + message.method }
  });
});
`, 'utf8');
  chmodSync(bin, 0o755);

  return {
    bin,
    readMessages: () => readJsonLines<FakeAppServerMessage>(messagesPath),
    readSpawns: () => readJsonLines<FakeAppServerSpawn>(spawnsPath)
  };
}

function readJsonLines<Value>(path: string): Value[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Value);
}
