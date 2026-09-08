import { describe, expect, it } from 'vitest';
import { createRendererConnection } from '../src/main/bootstrap-controller.js';

describe('createRendererConnection', () => {
  const connection = {
    address: 'http://127.0.0.1:56196',
    token: 'runtime-token'
  };

  it('connects the development renderer to the Electron-owned Runtime', () => {
    expect(createRendererConnection(connection, true)).toEqual({
      baseUrl: connection.address,
      token: connection.token
    });
  });

  it('keeps the packaged renderer behind the clawee-app protocol proxy', () => {
    expect(createRendererConnection(connection, false)).toEqual({
      baseUrl: '/.clawee/runtime'
    });
  });
});
