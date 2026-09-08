import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createRendererConnectionConfig
} from '../src/main/bootstrap-controller.js';

describe('Desktop renderer Runtime connection', () => {
  const connection = {
    address: 'http://127.0.0.1:60764',
    token: 'runtime-token'
  };

  it('uses the active Utility Process directly for the Vite development page', () => {
    expect(createRendererConnectionConfig(connection, true)).toEqual({
      baseUrl: 'http://127.0.0.1:60764',
      token: 'runtime-token'
    });
  });

  it('keeps the authenticated protocol proxy for packaged applications', () => {
    expect(createRendererConnectionConfig(connection, false)).toEqual({
      baseUrl: '/.clawee/runtime'
    });
  });

  it('bootstrap_has_no_select_codex_capability_in_packaged_mode', () => {
    const sources = [
      readFileSync('src/shared/ipc.ts', 'utf8'),
      readFileSync('src/shared/types.ts', 'utf8'),
      readFileSync('src/preload/index.ts', 'utf8'),
      readFileSync('src/bootstrap/main.ts', 'utf8'),
      readFileSync('src/bootstrap/index.html', 'utf8'),
      readFileSync('src/main/main.ts', 'utf8')
    ].join('\n');

    expect(sources).not.toMatch(/selectCodex|select-codex|选择 Codex|选择 ChatGPT/);
  });
});
