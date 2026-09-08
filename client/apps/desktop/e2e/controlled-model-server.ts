import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';

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

export const CONTROLLED_EXEC_COMMAND_CALL_ID =
  'clawee-e2e-exec-command';
export const CONTROLLED_EXEC_COMMAND_PROMPT =
  'CLAWEE_E2E_EXEC_COMMAND';
export const CONTROLLED_EXEC_COMMAND_OUTPUT =
  'CLAWEE_TOOL_LOOP_OK';
export const CONTROLLED_HANG_PROMPT =
  'CLAWEE_E2E_HANG_UNTIL_CANCELED';
export const CONTROLLED_MODEL_API_KEY = 'clawee-controlled-e2e';

export type ControlledModelRequest = {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
  responseText: string;
  marker: string | null;
};

export type ControlledModelResponseMode = 'success' | 'failure' | 'hang';

export type ControlledCommandToolCall = {
  name: 'exec_command' | 'shell_command';
  argumentsValue: Record<string, unknown>;
};

export class ControlledModelServer {
  private server: Server | undefined;
  private originValue = '';
  private readonly capturedRequests: ControlledModelRequest[] = [];
  private responseSequence = 0;

  constructor(
    private readonly responseMode: ControlledModelResponseMode = 'success',
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  get origin(): string {
    if (this.originValue.length === 0) {
      throw new Error('受控模型服务尚未启动');
    }
    return this.originValue;
  }

  get requests(): readonly ControlledModelRequest[] {
    return this.capturedRequests;
  }

  async start(): Promise<string> {
    if (this.server !== undefined) {
      throw new Error('受控模型服务不能重复启动');
    }
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(error => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          error: error instanceof Error ? error.message : String(error)
        }));
      });
    });
    await new Promise<void>((resolveStart, rejectStart) => {
      this.server!.once('error', rejectStart);
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.off('error', rejectStart);
        resolveStart();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      await this.close();
      throw new Error('受控模型服务未获得有效监听地址');
    }
    this.originValue = `http://127.0.0.1:${address.port}`;
    return this.originValue;
  }

  async close(): Promise<void> {
    const current = this.server;
    this.server = undefined;
    this.originValue = '';
    if (current === undefined) return;
    current.closeIdleConnections();
    current.closeAllConnections();
    await new Promise<void>((resolveClose, rejectClose) => {
      current.close(error => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
  }

  async waitForRequestCount(
    count: number,
    timeoutMs = 60_000
  ): Promise<readonly ControlledModelRequest[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.capturedRequests.length >= count) return this.requests;
      await delay(50);
    }
    throw new Error(
      `等待受控模型请求超时：期望至少 ${count}，实际 `
      + `${this.capturedRequests.length}`
    );
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (
      request.method !== 'POST'
      || request.url === undefined
      || !request.url.endsWith('/responses')
    ) {
      response.writeHead(404).end();
      return;
    }
    const parsed = JSON.parse(await readHttpBody(request)) as unknown;
    if (!isRecord(parsed)) {
      response.writeHead(400).end();
      return;
    }
    const marker = JSON.stringify(parsed).match(
      /CLAWEE_READY_[0-9a-f]+/i
    )?.[0] ?? null;
    const responseText = marker ?? 'Clawee controlled response.';
    this.capturedRequests.push({
      path: request.url,
      headers: request.headers,
      body: parsed,
      responseText,
      marker
    });
    const toolNames = collectControlledModelToolNames([
      this.capturedRequests.at(-1)!
    ]);
    const commandToolCall = resolveControlledCommandToolCall(
      toolNames,
      this.platform
    );
    if (this.responseMode === 'failure') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          message: 'Controlled model failure'
        }
      }));
      return;
    }
    if (this.responseMode === 'hang') return;
    if (
      findControlledFunctionCallOutput(
        this.capturedRequests.slice(-1),
        CONTROLLED_EXEC_COMMAND_CALL_ID
      ) !== undefined
    ) {
      this.sendModelResponse(
        response,
        assistantMessageResponseBody(
          ++this.responseSequence,
          'Clawee tool loop completed.'
        )
      );
      return;
    }
    if (
      commandToolCall !== undefined
      && controlledModelRequestContainsText(
        this.capturedRequests.at(-1)!,
        CONTROLLED_EXEC_COMMAND_PROMPT
      )
    ) {
      this.sendModelResponse(
        response,
        functionCallResponseBody(
          ++this.responseSequence,
          CONTROLLED_EXEC_COMMAND_CALL_ID,
          commandToolCall.name,
          commandToolCall.argumentsValue
        )
      );
      return;
    }
    if (
      commandToolCall !== undefined
      && controlledModelRequestContainsText(
        this.capturedRequests.at(-1)!,
        CONTROLLED_HANG_PROMPT
      )
    ) {
      return;
    }
    this.sendModelResponse(
      response,
      assistantMessageResponseBody(
        ++this.responseSequence,
        responseText
      )
    );
  }

  private sendModelResponse(
    response: ServerResponse,
    body: string
  ): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close'
    });
    response.end(body);
  }
}

export function collectControlledModelToolNames(
  requests: readonly ControlledModelRequest[]
): string[] {
  const names = new Set<string>();
  for (const request of requests) {
    const tools = request.body.tools;
    if (!Array.isArray(tools)) continue;
    for (const tool of tools) collectToolNames(tool, names);
  }
  return [...names].sort();
}

export function forbiddenMultiAgentToolNames(
  toolNames: readonly string[]
): string[] {
  return toolNames.filter(name => {
    const normalized = name.toLowerCase();
    const segments = normalized.split(/[.:/]/);
    return normalized.includes('multi_agent_v1')
      || normalized.includes('multi_agent_v2')
      || normalized.includes('collaboration')
      || segments.some(segment =>
        FORBIDDEN_MULTI_AGENT_TOOL_NAMES.has(segment)
      );
  });
}

export function controlledModelRequestContainsText(
  request: ControlledModelRequest,
  expected: string
): boolean {
  return valueContainsText(request.body, expected);
}

export function findControlledFunctionCallOutput(
  requests: readonly ControlledModelRequest[],
  callId: string
): unknown {
  for (const request of requests) {
    const output = findFunctionCallOutput(request.body, callId);
    if (output !== undefined) return output;
  }
  return undefined;
}

export function resolveControlledCommandToolCall(
  toolNames: readonly string[],
  platform: NodeJS.Platform = process.platform
): ControlledCommandToolCall | undefined {
  const name = toolNames.includes('exec_command')
    ? 'exec_command'
    : toolNames.includes('shell_command')
      ? 'shell_command'
      : undefined;
  if (name === undefined) return undefined;
  const command = controlledWriteFileCommand(platform);
  return name === 'exec_command'
    ? {
        name,
        argumentsValue: {
          cmd: command,
          yield_time_ms: 1_000
        }
      }
    : {
        name,
        argumentsValue: {
          command,
          timeout_ms: 10_000
        }
      };
}

function collectToolNames(
  value: unknown,
  names: Set<string>,
  prefix = ''
): void {
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
  if (!Array.isArray(value.tools)) return;
  const nextPrefix = namespace ?? prefix;
  for (const nested of value.tools) {
    collectToolNames(nested, names, nextPrefix);
  }
}

function assistantMessageResponseBody(
  sequence: number,
  text: string
): string {
  const responseId = `resp-clawee-e2e-${sequence}`;
  const messageId = `msg-clawee-e2e-${sequence}`;
  const events = [
    {
      type: 'response.created',
      response: { id: responseId }
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        id: messageId,
        content: [{ type: 'output_text', text }]
      }
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
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

function functionCallResponseBody(
  sequence: number,
  callId: string,
  name: string,
  argumentsValue: Record<string, unknown>
): string {
  const responseId = `resp-clawee-e2e-${sequence}`;
  const events = [
    {
      type: 'response.created',
      response: { id: responseId }
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: callId,
        name,
        arguments: JSON.stringify(argumentsValue)
      }
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
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

function controlledWriteFileCommand(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? `[System.IO.File]::WriteAllText(`
      + `'clawee-tool-loop.txt', '${CONTROLLED_EXEC_COMMAND_OUTPUT}'); `
      + `Write-Output '${CONTROLLED_EXEC_COMMAND_OUTPUT}'`
    : `printf '%s' '${CONTROLLED_EXEC_COMMAND_OUTPUT}' `
      + `> clawee-tool-loop.txt && printf '%s\\n' `
      + `'${CONTROLLED_EXEC_COMMAND_OUTPUT}'`;
}

function valueContainsText(value: unknown, expected: string): boolean {
  if (typeof value === 'string') return value.includes(expected);
  if (Array.isArray(value)) {
    return value.some(item => valueContainsText(item, expected));
  }
  if (!isRecord(value)) return false;
  return Object.values(value).some(item => valueContainsText(item, expected));
}

function findFunctionCallOutput(
  value: unknown,
  callId: string
): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const output = findFunctionCallOutput(item, callId);
      if (output !== undefined) return output;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (
    value.type === 'function_call_output'
    && value.call_id === callId
  ) {
    return value.output;
  }
  for (const item of Object.values(value)) {
    const output = findFunctionCallOutput(item, callId);
    if (output !== undefined) return output;
  }
  return undefined;
}

async function readHttpBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_HTTP_BODY_BYTES) {
      throw new Error('受控模型请求超过大小限制');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
