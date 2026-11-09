import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTROLLED_EXEC_COMMAND_CALL_ID,
  CONTROLLED_EXEC_COMMAND_OUTPUT,
  ControlledModelServer,
  findControlledCommandOutput,
  resolveControlledCommandToolCall
} from '../e2e/controlled-model-server.js';

describe('Controlled model command tools', () => {
  it('uses the unified exec_command contract on Unix', () => {
    const call = resolveControlledCommandToolCall(
      ['exec_command', 'shell_command'],
      'darwin'
    );

    expect(call).toEqual({
      name: 'exec_command',
      argumentsValue: {
        cmd: `sleep 2; printf '%s' '${CONTROLLED_EXEC_COMMAND_OUTPUT}' `
          + `> clawee-tool-loop.txt && printf '%s\\n' `
          + `'${CONTROLLED_EXEC_COMMAND_OUTPUT}'`,
        yield_time_ms: 1_000
      }
    });
  });

  it('uses the Windows shell_command contract with PowerShell syntax', () => {
    const call = resolveControlledCommandToolCall(
      ['shell_command'],
      'win32'
    );

    expect(call).toEqual({
      name: 'shell_command',
      argumentsValue: {
        command: `[System.IO.File]::WriteAllText(`
          + `'clawee-tool-loop.txt', '${CONTROLLED_EXEC_COMMAND_OUTPUT}'); `
          + `Write-Output '${CONTROLLED_EXEC_COMMAND_OUTPUT}'`,
        timeout_ms: 10_000
      }
    });
  });

  it('does not invent a command tool when the Runtime exposes none', () => {
    expect(resolveControlledCommandToolCall(
      ['view_image'],
      'win32'
    )).toBeUndefined();
  });
});

describe('Controlled model asynchronous tool loop', () => {
  let server: ControlledModelServer;

  beforeEach(async () => {
    server = new ControlledModelServer('success', 'win32');
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it('polls a running session until the final output arrives', async () => {
    const input = [{
      type: 'function_call_output',
      call_id: CONTROLLED_EXEC_COMMAND_CALL_ID,
      output: 'Process running with session ID 54596\nOutput:\n'
    }];
    const first = await modelOutput(server, input);
    expect(first).toMatchObject({ type: 'function_call', name: 'write_stdin' });
    expect(JSON.parse(first.arguments as string)).toEqual({
      session_id: 54596, chars: '', yield_time_ms: 1_000
    });

    input.push({
      type: 'function_call_output',
      call_id: first.call_id as string,
      output: `Process running with session ID 54596\n${CONTROLLED_EXEC_COMMAND_OUTPUT}`
    });
    const second = await modelOutput(server, input);
    expect(second).toMatchObject({ type: 'function_call', name: 'write_stdin' });
    expect(second.call_id).not.toBe(first.call_id);

    input.push({
      type: 'function_call_output',
      call_id: second.call_id as string,
      output: `Process exited with code 0\nOutput:\n${CONTROLLED_EXEC_COMMAND_OUTPUT}`
    });
    const final = await modelOutput(server, input);
    expect(final).toMatchObject({
      type: 'message',
      content: [{ type: 'output_text', text: 'Clawee tool loop completed.' }]
    });
    expect(findControlledCommandOutput(server.requests)).toContain(input.at(-1)!.output);
  });

  it('completes a synchronous command without polling', async () => {
    expect(await modelOutput(server, [{
      type: 'function_call_output',
      call_id: CONTROLLED_EXEC_COMMAND_CALL_ID,
      output: CONTROLLED_EXEC_COMMAND_OUTPUT
    }])).toMatchObject({ type: 'message' });
  });

  it('preserves earlier stdout when the final poll has no new output', async () => {
    const running = {
      type: 'function_call_output', call_id: CONTROLLED_EXEC_COMMAND_CALL_ID,
      output: `Process running with session ID 42\nOutput:\n${CONTROLLED_EXEC_COMMAND_OUTPUT}`
    };
    const poll = await modelOutput(server, [running]);
    expect(await modelOutput(server, [{
      type: 'function_call_output', call_id: poll.call_id,
      output: 'Process exited with code 0\nOutput:\n'
    }])).toMatchObject({ type: 'message' });
    expect(findControlledCommandOutput(server.requests)).toContain(CONTROLLED_EXEC_COMMAND_OUTPUT);
  });

  it('does not declare an empty or failed command output successful', async () => {
    const response = await fetch(`${server.origin}/responses`, {
      method: 'POST',
      body: JSON.stringify({ input: [{
        type: 'function_call_output',
        call_id: CONTROLLED_EXEC_COMMAND_CALL_ID,
        output: 'Process exited with code 1\nOutput:\n'
      }] })
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('Clawee tool loop completed.');
  });

  it('does not ignore a nonzero exit code even if stdout contains the marker', async () => {
    const response = await fetch(`${server.origin}/responses`, {
      method: 'POST',
      body: JSON.stringify({ input: [{
        type: 'function_call_output', call_id: CONTROLLED_EXEC_COMMAND_CALL_ID,
        output: `Process exited with code 1\n${CONTROLLED_EXEC_COMMAND_OUTPUT}`
      }] })
    });
    expect(response.status).toBe(500);
  });
});

it('挂起 Probe 时先放行模型服务验证，再挂起带标记的请求', async () => {
  const server = new ControlledModelServer('probe-hang');
  await server.start();
  try {
    expect(await modelOutput(server, [{ type: 'input_text', text: '模型服务验证' }]))
      .toMatchObject({ type: 'message' });
    await expect(fetch(`${server.origin}/responses`, {
      method: 'POST',
      body: JSON.stringify({ input: 'CLAWEE_READY_abcd' }),
      signal: AbortSignal.timeout(200)
    })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(server.requests.map(request => request.marker))
      .toEqual([null, 'CLAWEE_READY_abcd']);
  } finally {
    await server.close();
  }
});

async function modelOutput(
  server: ControlledModelServer,
  input: Array<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${server.origin}/responses`, {
    method: 'POST',
    body: JSON.stringify({
      tools: [
        { type: 'function', name: 'exec_command' },
        { type: 'function', name: 'write_stdin' }
      ],
      input
    })
  });
  expect(response.status).toBe(200);
  const events = (await response.text()).split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
  return events.find(event => event.type === 'response.output_item.done')!
    .item as Record<string, unknown>;
}
