import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_EXEC_COMMAND_OUTPUT,
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
        cmd: `printf '%s' '${CONTROLLED_EXEC_COMMAND_OUTPUT}' `
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
