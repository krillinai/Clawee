import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_RUNTIME_DIRECTORY = resolve(
  PROJECT_ROOT,
  'apps/desktop/.pack/codex-runtime'
);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_HTTP_BODY_BYTES = 10 * 1024 * 1024;
const FORBIDDEN_MULTI_AGENT_TOOL_NAMES = new Set([
  'close_agent',
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'resume_agent',
  'send_input',
  'send_message',
  'spawn_agent',
  'wait_agent'
]);

export async function verifyCodexAppServerReleaseContract(input = {}) {
  const runtimeDirectory = resolve(
    input.runtimeDirectory ?? DEFAULT_RUNTIME_DIRECTORY
  );
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const packageMetadata = readRuntimePackageMetadata(runtimeDirectory);
  const codexBin = resolve(
    runtimeDirectory,
    packageMetadata.entrypoint
  );
  assertExecutable(codexBin);

  const root = mkdtempSync(join(tmpdir(), 'clawee-codex-release-contract-'));
  const codexHome = join(root, 'codex-home');
  const workspace = join(root, 'workspace');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const modelServer = await startModelServer(timeoutMs);
  let writer;
  let writerSentMethods = [];
  let business;
  try {
    writeContractConfig(
      join(codexHome, 'config.toml'),
      modelServer.origin
    );
    writer = await AppServerConnection.start({
      codexBin,
      codexHome,
      cwd: workspace,
      timeoutMs
    });
    const write = await writer.request('config/batchWrite', {
      edits: [
        {
          keyPath: 'agents.enabled',
          value: false,
          mergeStrategy: 'upsert'
        },
        {
          keyPath: 'features.multi_agent',
          value: false,
          mergeStrategy: 'upsert'
        },
        {
          keyPath: 'features.multi_agent_v2',
          value: false,
          mergeStrategy: 'upsert'
        }
      ],
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: false
    });
    assertConfigurationWrite(write);
    writerSentMethods = [...writer.sentMethods];
    await writer.close();
    writer = undefined;

    business = await AppServerConnection.start({
      codexBin,
      codexHome,
      cwd: workspace,
      timeoutMs
    });
    const config = await business.request('config/read', {
      includeLayers: false,
      cwd: null
    });
    assertConfigurationRead(config, write);

    const threadResponse = await business.request('thread/start', {
      cwd: workspace,
      model: 'mock-model',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      serviceName: 'clawee-release-contract'
    });
    const threadId = requireNestedString(
      threadResponse,
      ['thread', 'id'],
      'thread/start response'
    );
    const turnCompleted = business.waitForNotification(
      'turn/completed',
      message => (
        isRecord(message.params)
        && message.params.threadId === threadId
      )
    );
    await business.request('turn/start', {
      threadId,
      input: [{
        type: 'text',
        text: 'Reply with done.',
        text_elements: []
      }],
      cwd: workspace,
      model: 'mock-model',
      effort: null,
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    });

    const [modelRequest] = await Promise.all([
      modelServer.request,
      turnCompleted
    ]);
    const toolNames = collectModelToolNames(modelRequest.body.tools);
    assertNoMultiAgentTools(toolNames);
    assertNoUsageRequest([
      ...writerSentMethods,
      ...business.sentMethods
    ]);
    assertNoSubThreads(business.messages, threadId);

    return {
      runtimeDirectory,
      codexBin,
      target: packageMetadata.target,
      requestPath: modelRequest.path,
      toolCount: toolNames.length,
      toolNames,
      threadId,
      sentMethods: [
        ...writerSentMethods,
        ...business.sentMethods
      ]
    };
  } finally {
    await writer?.close().catch(() => undefined);
    await business?.close().catch(() => undefined);
    await modelServer.close();
    rmSync(root, { force: true, recursive: true });
  }
}

export function collectModelToolNames(value) {
  if (!Array.isArray(value)) return [];
  const names = new Set();
  for (const tool of value) collectToolNames(tool, names);
  return [...names].sort();
}

export function assertNoMultiAgentTools(toolNames) {
  const forbidden = toolNames.filter(name => {
    const normalized = name.toLowerCase();
    const segments = normalized.split(/[.:/]/);
    return normalized.includes('multi_agent_v1')
      || normalized.includes('collaboration')
      || segments.some(segment =>
        FORBIDDEN_MULTI_AGENT_TOOL_NAMES.has(segment)
      );
  });
  if (forbidden.length > 0) {
    throw new Error(
      `CODEX_RUNTIME_MULTI_AGENT_TOOLS_PRESENT: ${forbidden.join(', ')}`
    );
  }
}

export function assertNoUsageRequest(methods) {
  if (methods.includes('account/usage/read')) {
    throw new Error('CODEX_RUNTIME_THREAD_USAGE_REQUESTED');
  }
}

function collectToolNames(value, names, prefix = '') {
  if (!isRecord(value)) return;
  const name = typeof value.name === 'string' ? value.name : undefined;
  const namespace = typeof value.namespace === 'string'
    ? value.namespace
    : value.type === 'namespace' && name !== undefined
      ? name
      : undefined;
  if (name !== undefined) {
    names.add(prefix.length > 0 ? `${prefix}.${name}` : name);
  }
  if (isRecord(value.function) && typeof value.function.name === 'string') {
    names.add(
      prefix.length > 0
        ? `${prefix}.${value.function.name}`
        : value.function.name
    );
  }
  if (Array.isArray(value.tools)) {
    const nextPrefix = namespace ?? prefix;
    for (const nested of value.tools) {
      collectToolNames(nested, names, nextPrefix);
    }
  }
}

function assertConfigurationWrite(value) {
  if (
    !isRecord(value)
    || value.status !== 'ok'
    || typeof value.version !== 'string'
    || value.version.length === 0
    || typeof value.filePath !== 'string'
    || !isAbsolute(value.filePath)
    || value.overriddenMetadata !== null
  ) {
    throw new Error('CODEX_RUNTIME_CONFIGURATION_WRITE_INVALID');
  }
}

function assertConfigurationRead(value, write) {
  if (
    !isRecord(value)
    || !isRecord(value.config)
    || !isRecord(value.config.agents)
    || !isRecord(value.config.features)
    || !isRecord(value.origins)
  ) {
    throw new Error('CODEX_RUNTIME_CONFIGURATION_READ_INVALID');
  }
  for (const [keyPath, effectiveValue, originKeyPaths] of [
    ['agents.enabled', value.config.agents.enabled, ['agents.enabled']],
    [
      'features.multi_agent',
      value.config.features.multi_agent,
      ['features.multi_agent']
    ],
    [
      'features.multi_agent_v2',
      value.config.features.multi_agent_v2,
      ['features.multi_agent_v2', 'features.multi_agent_v2.enabled']
    ]
  ]) {
    if (effectiveValue !== false) {
      throw new Error(
        `CODEX_RUNTIME_CONFIGURATION_FEATURE_ENABLED: ${keyPath}`
      );
    }
    const origin = originKeyPaths
      .map(originKeyPath => value.origins[originKeyPath])
      .find(isRecord);
    if (
      !isRecord(origin)
      || origin.version !== write.version
      || !isRecord(origin.name)
      || origin.name.type !== 'user'
      || origin.name.file !== write.filePath
      || origin.name.profile !== null
    ) {
      throw new Error(
        `CODEX_RUNTIME_CONFIGURATION_ORIGIN_CONFLICT: ${keyPath}`
      );
    }
  }
}

function assertNoSubThreads(messages, rootThreadId) {
  const threadIds = new Set([rootThreadId]);
  for (const message of messages) {
    if (message.method !== 'thread/started' || !isRecord(message.params)) {
      continue;
    }
    const thread = isRecord(message.params.thread)
      ? message.params.thread
      : undefined;
    if (typeof thread?.id === 'string') threadIds.add(thread.id);
  }
  if (threadIds.size !== 1) {
    throw new Error(
      `CODEX_RUNTIME_SUBTHREAD_CREATED: ${[...threadIds].join(', ')}`
    );
  }
}

function readRuntimePackageMetadata(runtimeDirectory) {
  let value;
  try {
    value = JSON.parse(
      readFileSync(join(runtimeDirectory, 'codex-package.json'), 'utf8')
    );
  } catch (error) {
    throw new Error(
      `CODEX_RUNTIME_PACKAGE_METADATA_INVALID: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (
    !isRecord(value)
    || typeof value.entrypoint !== 'string'
    || value.entrypoint.length === 0
    || typeof value.target !== 'string'
  ) {
    throw new Error('CODEX_RUNTIME_PACKAGE_METADATA_INVALID');
  }
  return value;
}

function assertExecutable(path) {
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error(`CODEX_RUNTIME_ENTRYPOINT_INVALID: ${path}`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
    throw new Error(`CODEX_RUNTIME_ENTRYPOINT_NOT_EXECUTABLE: ${path}`);
  }
}

function writeContractConfig(path, modelOrigin) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `model = "mock-model"
model_provider = "mock_provider"
approval_policy = "never"
sandbox_mode = "danger-full-access"
check_for_update_on_startup = false

[agents]
enabled = true

[features]
multi_agent = true
multi_agent_v2 = true

[model_providers.mock_provider]
name = "Clawee release contract"
base_url = "${modelOrigin}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600 });
}

async function startModelServer(timeoutMs) {
  let resolveRequest;
  let rejectRequest;
  const request = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const server = createServer(async (incoming, response) => {
    try {
      if (
        incoming.method !== 'POST'
        || incoming.url === undefined
        || !incoming.url.endsWith('/responses')
      ) {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await readHttpBody(incoming));
      resolveRequest({
        path: incoming.url,
        headers: incoming.headers,
        body
      });
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      });
      response.end(modelResponseBody());
    } catch (error) {
      rejectRequest(error);
      response.writeHead(500).end();
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise(resolveClose => server.close(resolveClose));
    throw new Error('CODEX_RUNTIME_MODEL_SERVER_ADDRESS_INVALID');
  }
  const timer = setTimeout(() => {
    rejectRequest(new Error('CODEX_RUNTIME_MODEL_REQUEST_TIMEOUT'));
  }, timeoutMs);
  timer.unref();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    request: request.finally(() => clearTimeout(timer)),
    close: () => new Promise(resolveClose => server.close(resolveClose))
  };
}

function readHttpBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        rejectBody(new Error('CODEX_RUNTIME_MODEL_REQUEST_TOO_LARGE'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', rejectBody);
  });
}

function modelResponseBody() {
  const events = [
    {
      type: 'response.created',
      response: { id: 'resp-clawee-release-contract' }
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        id: 'msg-clawee-release-contract',
        content: [{ type: 'output_text', text: 'done' }]
      }
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp-clawee-release-contract',
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0
        }
      }
    }
  ];
  return events.map(event => (
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  )).join('');
}

class AppServerConnection {
  static async start(input) {
    const connection = new AppServerConnection(input);
    await connection.initialize();
    return connection;
  }

  constructor(input) {
    this.timeoutMs = input.timeoutMs;
    this.sentMethods = [];
    this.messages = [];
    this.pending = new Map();
    this.waiters = new Set();
    this.nextId = 0;
    this.stdout = '';
    this.stderr = '';
    this.settled = false;
    this.child = spawn(input.codexBin, ['app-server', '--stdio'], {
      cwd: input.cwd,
      env: {
        ...process.env,
        CODEX_HOME: input.codexHome,
        OPENAI_API_KEY: 'clawee-release-contract',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        NO_PROXY: '127.0.0.1,localhost'
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.closed = new Promise(resolveClosed => {
      this.resolveClosed = resolveClosed;
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.handleStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${chunk}`.slice(-64 * 1024);
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('close', (code, signal) => {
      const reason = code === null
        ? `signal ${signal ?? 'unknown'}`
        : `exit code ${code}`;
      this.fail(
        new Error(
          `Codex app-server closed with ${reason}: ${this.stderr.trim()}`
        ),
        false
      );
      this.resolveClosed();
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: {
        name: 'clawee-release-contract',
        title: 'Clawee Release Contract',
        version: '1.0.0'
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
    this.notify('initialized');
  }

  request(method, params) {
    if (this.settled) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }
    this.sentMethods.push(method);
    const id = `clawee_contract_${++this.nextId}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(
          `Codex app-server request timed out: ${method}`
        ));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, {
        method,
        resolve: resolveRequest,
        reject: rejectRequest,
        timer
      });
      this.write({ id, method, params }).catch(error => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  notify(method) {
    this.write({ method }).catch(error => this.fail(error));
  }

  waitForNotification(method, predicate = () => true) {
    const existing = this.messages.find(message => (
      message.method === method && predicate(message)
    ));
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolveWaiter, rejectWaiter) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        rejectWaiter(new Error(
          `Codex app-server notification timed out: ${method}`
        ));
      }, this.timeoutMs);
      timer.unref();
      const waiter = {
        method,
        predicate,
        resolve: resolveWaiter,
        reject: rejectWaiter,
        timer
      };
      this.waiters.add(waiter);
    });
  }

  async close() {
    if (this.settled) {
      await this.closed;
      return;
    }
    this.child.kill('SIGTERM');
    const forceKill = setTimeout(() => {
      if (!this.settled) this.child.kill('SIGKILL');
    }, 2_000);
    forceKill.unref();
    await this.closed;
    clearTimeout(forceKill);
  }

  async write(value) {
    if (this.settled || this.child.stdin.destroyed) {
      throw new Error('Codex app-server stdin is closed');
    }
    await new Promise((resolveWrite, rejectWrite) => {
      this.child.stdin.write(`${JSON.stringify(value)}\n`, error => {
        if (error === null || error === undefined) resolveWrite();
        else rejectWrite(error);
      });
    });
  }

  handleStdout(chunk) {
    this.stdout += chunk;
    while (true) {
      const newline = this.stdout.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      if (line.trim().length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new Error('Codex app-server emitted invalid JSON'));
        return;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (!isRecord(message)) return;
    this.messages.push(message);
    const id = message.id;
    if (
      (typeof id === 'string' || typeof id === 'number')
      && ('result' in message || 'error' in message)
    ) {
      const pending = this.pending.get(String(id));
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(id));
      if (isRecord(message.error)) {
        pending.reject(new Error(
          typeof message.error.message === 'string'
            ? message.error.message
            : `${pending.method} failed`
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (
      (typeof id === 'string' || typeof id === 'number')
      && typeof message.method === 'string'
    ) {
      this.write({
        id,
        error: {
          code: -32601,
          message: `Unsupported server request: ${message.method}`
        }
      }).catch(error => this.fail(error));
      return;
    }
    if (typeof message.method !== 'string') return;
    for (const waiter of [...this.waiters]) {
      if (
        waiter.method !== message.method
        || !waiter.predicate(message)
      ) {
        continue;
      }
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  fail(error, kill = true) {
    if (this.settled) return;
    this.settled = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
    if (kill && !this.child.killed) this.child.kill('SIGTERM');
  }
}

function requireNestedString(value, path, label) {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      throw new Error(`CODEX_RUNTIME_CONTRACT_INVALID: ${label}`);
    }
    current = current[segment];
  }
  if (typeof current !== 'string' || current.length === 0) {
    throw new Error(`CODEX_RUNTIME_CONTRACT_INVALID: ${label}`);
  }
  return current;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArguments(argv) {
  const runtimeArgument = argv.find(argument =>
    argument.startsWith('--runtime-dir=')
  );
  const timeoutArgument = argv.find(argument =>
    argument.startsWith('--timeout-ms=')
  );
  return {
    runtimeDirectory: runtimeArgument === undefined
      ? DEFAULT_RUNTIME_DIRECTORY
      : runtimeArgument.slice('--runtime-dir='.length),
    timeoutMs: timeoutArgument === undefined
      ? DEFAULT_TIMEOUT_MS
      : Number.parseInt(timeoutArgument.slice('--timeout-ms='.length), 10)
  };
}

if (
  process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const input = parseArguments(process.argv.slice(2));
  verifyCodexAppServerReleaseContract(input)
    .then(result => {
      console.log(JSON.stringify({
        ok: true,
        runtime: basename(result.runtimeDirectory),
        target: result.target,
        requestPath: result.requestPath,
        toolCount: result.toolCount,
        toolNames: result.toolNames,
        sentMethods: result.sentMethods
      }));
    })
    .catch(error => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
}
