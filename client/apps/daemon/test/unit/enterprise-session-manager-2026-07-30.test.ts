import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type {
  EnterpriseCredential,
  EnterpriseCredentialStore
} from '../../src/enterprise/credential-store-2026-07-30.js';
import { EnterpriseCredentialStoreError } from '../../src/enterprise/credential-store-2026-07-30.js';
import {
  createEnterpriseSessionManager,
  EnterpriseSessionError
} from '../../src/enterprise/session-manager-2026-07-30.js';
import type {
  EnterpriseAgentIdentityStore
} from '../../src/enterprise/agent-identity-2026-08-02.js';
import type {
  EnterpriseHttpClient,
  EnterpriseMeResult
} from '../../src/enterprise/http-client-2026-07-30.js';
import { EnterpriseHttpError } from '../../src/enterprise/http-client-2026-07-30.js';

const credential: EnterpriseCredential = {
  accessToken: 'enterprise-session-token',
  expiresAt: '2026-07-31T10:00:00Z'
};
const agentId = 'clawee_550e8400-e29b-41d4-a716-446655440000';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('enterprise session manager', () => {
  it('requires a fully signed-in session before exposing its access token', async () => {
    const me = deferred<EnterpriseMeResult>();
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(credential),
      httpClient: createClient({
        getMe: vi.fn(async () => me.promise)
      }),
      transportSecurity: 'secure_https'
    });

    await expect(manager.requireAccessToken()).rejects.toMatchObject({
      code: 'ENTERPRISE_UNAUTHORIZED'
    });
    manager.startRestore();
    me.resolve(activeMe());
    await vi.waitFor(() => expect(manager.getSnapshot().status).toBe('signed_in'));
    await expect(manager.requireAccessToken()).resolves.toBe(credential.accessToken);
  });

  it('starts restore asynchronously and publishes a valid session later', async () => {
    const me = deferred<EnterpriseMeResult>();
    const store = createStore(credential);
    const client = createClient({
      getMe: vi.fn(async () => me.promise)
    });
    const onSignedIn = vi.fn();
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: store,
      httpClient: client,
      onSignedIn,
      transportSecurity: 'secure_https'
    });

    manager.startRestore();
    expect(manager.getSnapshot()).toEqual({
      status: 'checking',
      transportSecurity: 'secure_https'
    });

    me.resolve(activeMe());
    await vi.waitFor(() => {
      expect(manager.getSnapshot()).toEqual({
        status: 'signed_in',
        agentId,
        account: {
          subjectId: 'acct_01JZ8W6A2M4S',
          email: 'user@example.com',
          name: 'User'
        },
        expiresAt: credential.expiresAt,
        transportSecurity: 'secure_https'
      });
    });
    expect(store.write).not.toHaveBeenCalled();
    expect(onSignedIn).toHaveBeenCalledWith({
      subjectId: 'acct_01JZ8W6A2M4S',
      agentId,
      accessToken: credential.accessToken,
      activityReportingEnabled: false
    });
  });

  it('publishes the local agent id without a saved enterprise session', async () => {
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      initialAgentId: agentId,
      credentialStore: createStore(),
      httpClient: createClient(),
      transportSecurity: 'secure_https'
    });

    manager.startRestore();

    await vi.waitFor(() => {
      expect(manager.getSnapshot()).toEqual({
        status: 'signed_out',
        agentId,
        transportSecurity: 'secure_https'
      });
    });
  });

  it('publishes the same signed-in callback for password authentication', async () => {
    const onSignedIn = vi.fn();
    const onSignedOut = vi.fn();
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(),
      httpClient: createClient(),
      onSignedIn,
      onSignedOut,
      transportSecurity: 'secure_https'
    });

    await manager.login({
      email: 'user@example.com',
      password: 'password-123'
    });

    expect(onSignedIn).toHaveBeenCalledOnce();
    expect(onSignedIn).toHaveBeenCalledWith({
      subjectId: 'acct_01JZ8W6A2M4S',
      agentId,
      accessToken: credential.accessToken,
      activityReportingEnabled: false
    });
    onSignedIn.mockClear();
    await manager.requireIdentity();
    expect(onSignedIn).not.toHaveBeenCalled();
    await manager.logout();
    expect(onSignedOut).toHaveBeenCalled();
  });

  it('publishes the same signed-in callback for registration and QR login', async () => {
    const onSignedIn = vi.fn();
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(),
      httpClient: createClient({
        startQrLogin: vi.fn(async ({ provider }) => ({
          requestId: `qr-${provider}`,
          provider,
          qrCodeUrl: `https://enterprise.example/${provider}.png`,
          expiresAt: '2026-08-28T00:00:00Z',
          pollAfterMs: 1000
        })),
        pollQrLogin: vi.fn(async () => ({
          requestId: 'qr-feishu',
          provider: 'feishu' as const,
          status: 'signed_in' as const,
          login: {
            account: activeMe().account,
            agentId,
            accessToken: 'qr-session-token',
            tokenType: 'Bearer' as const,
            expiresAt: credential.expiresAt
          }
        }))
      }),
      onSignedIn,
      transportSecurity: 'secure_https'
    });

    await manager.register({
      email: 'user@example.com',
      password: 'password-123',
      name: 'User'
    });
    await manager.startQrLogin!({ provider: 'feishu' });
    await manager.pollQrLogin!('qr-feishu');

    expect(onSignedIn).toHaveBeenCalledTimes(2);
    expect(onSignedIn).toHaveBeenLastCalledWith(expect.objectContaining({
      accessToken: 'qr-session-token'
    }));
  });

  it.each([
    {
      name: 'inactive account',
      me: { ...activeMe(), status: 'disabled' },
      reason: 'account_inactive',
      code: 'ENTERPRISE_ACCOUNT_INACTIVE'
    },
    {
      name: 'frontend forbidden',
      me: { ...activeMe(), frontendAllowed: false },
      reason: 'frontend_forbidden',
      code: 'ENTERPRISE_FRONTEND_FORBIDDEN'
    }
  ])('uses the same validation rule for $name', async ({ me, reason, code }) => {
    const store = createStore();
    const client = createClient({
      getMe: vi.fn(async () => me)
    });
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: store,
      httpClient: client,
      transportSecurity: 'secure_https'
    });

    await expect(manager.login({
      email: 'user@example.com',
      password: 'password-123'
    })).rejects.toMatchObject({ code });
    expect(store.write).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toEqual({
      status: 'signed_out',
      agentId,
      reason,
      transportSecurity: 'secure_https'
    });
  });

  it('deletes expired saved credentials but preserves them on service failure', async () => {
    const expiredStore = createStore(credential);
    const expired = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: expiredStore,
      httpClient: createClient({
        getMe: vi.fn(async () => {
          throw new EnterpriseHttpError(
            'ENTERPRISE_UNAUTHORIZED',
            'response',
            401
          );
        })
      }),
      transportSecurity: 'secure_https'
    });

    await expect(expired.refresh()).rejects.toMatchObject({
      code: 'ENTERPRISE_SESSION_EXPIRED'
    });
    expect(expiredStore.delete).toHaveBeenCalledOnce();
    expect(expired.getSnapshot()).toEqual({
      status: 'signed_out',
      agentId,
      reason: 'session_expired',
      transportSecurity: 'secure_https'
    });

    const offlineStore = createStore(credential);
    const offline = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: offlineStore,
      httpClient: createClient({
        getMe: vi.fn(async () => {
          throw new EnterpriseHttpError(
            'ENTERPRISE_SERVICE_UNAVAILABLE',
            'request'
          );
        })
      }),
      transportSecurity: 'secure_https'
    });

    await expect(offline.refresh()).rejects.toMatchObject({
      code: 'ENTERPRISE_SERVICE_UNAVAILABLE'
    });
    expect(offlineStore.delete).not.toHaveBeenCalled();
    expect(offline.getSnapshot()).toEqual({
      status: 'service_unavailable',
      agentId,
      reason: 'service_unavailable',
      expiresAt: credential.expiresAt,
      transportSecurity: 'secure_https'
    });
  });

  it('preserves the token when logout cannot reach the enterprise service', async () => {
    const store = createStore(credential);
    const client = createClient({
      getMe: vi.fn(async () => activeMe()),
      logout: vi.fn(async () => {
        throw new EnterpriseHttpError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          'request'
        );
      })
    });
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: store,
      httpClient: client,
      transportSecurity: 'secure_https'
    });
    await manager.refresh();

    await expect(manager.logout()).rejects.toMatchObject({
      code: 'ENTERPRISE_SERVICE_UNAVAILABLE'
    });
    expect(store.delete).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toMatchObject({
      status: 'service_unavailable',
      account: { email: 'user@example.com' }
    });
  });

  it('returns registered-login-required without exposing the password', async () => {
    const password = 'password-that-must-not-escape';
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(),
      httpClient: createClient({
        login: vi.fn(async () => {
          throw new EnterpriseHttpError(
            'ENTERPRISE_UNAUTHORIZED',
            'response',
            401
          );
        })
      }),
      transportSecurity: 'secure_https'
    });

    let error: unknown;
    try {
      await manager.register({
        email: ' User@Example.com ',
        name: 'User',
        password
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EnterpriseSessionError);
    expect(error).toMatchObject({
      code: 'ENTERPRISE_REGISTERED_LOGIN_REQUIRED',
      details: { email: 'user@example.com' },
      statusCode: 409
    });
    expect(String(error)).not.toContain(password);
  });

  it('settles asynchronous restore after a protocol failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = createStore(credential);
    const protocolClient = createClient({
      getMe: vi.fn(async () => {
        throw new EnterpriseHttpError(
          'ENTERPRISE_PROTOCOL_ERROR',
          'decode',
          200
        );
      })
    });
    const restoring = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: store,
      httpClient: protocolClient,
      transportSecurity: 'secure_https'
    });

    restoring.startRestore();
    await vi.waitFor(() => {
      expect(restoring.getSnapshot()).toEqual({
        status: 'signed_out',
        agentId,
        transportSecurity: 'secure_https'
      });
    });
    expect(store.delete).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'Enterprise session restore failed [ENTERPRISE_PROTOCOL_ERROR]'
    );
    warn.mockRestore();
  });

  it('settles asynchronous restore when secure storage does not respond', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = createStore();
    store.read.mockImplementationOnce(() => new Promise(() => undefined));
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: store,
      credentialReadTimeoutMs: 25,
      httpClient: createClient(),
      transportSecurity: 'secure_https'
    });

    manager.startRestore();
    expect(manager.getSnapshot()).toEqual({
      status: 'checking',
      transportSecurity: 'secure_https'
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(manager.getSnapshot()).toEqual({
      status: 'signed_out',
      reason: 'secure_storage_unavailable',
      transportSecurity: 'secure_https'
    });
    expect(warn).toHaveBeenCalledWith(
      'Enterprise session restore failed [ENTERPRISE_SECURE_STORAGE_UNAVAILABLE]'
    );
  });

  it('shares one secure storage read between restore and refresh', async () => {
    const stored = deferred<EnterpriseCredential | undefined>();
    const store = createStore();
    store.read.mockImplementationOnce(() => stored.promise);
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: store,
      httpClient: createClient(),
      transportSecurity: 'secure_https'
    });

    manager.startRestore();
    const refresh = manager.refresh();

    expect(store.read).toHaveBeenCalledOnce();
    stored.resolve(credential);
    await expect(refresh).resolves.toMatchObject({ status: 'signed_in' });
    expect(store.read).toHaveBeenCalledOnce();
  });

  it('does not start another secure storage read while a timed-out read is pending', async () => {
    vi.useFakeTimers();
    const stored = deferred<EnterpriseCredential | undefined>();
    const store = createStore();
    store.read.mockImplementationOnce(() => stored.promise);
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: store,
      credentialReadTimeoutMs: 25,
      httpClient: createClient(),
      transportSecurity: 'secure_https'
    });

    const firstRefresh = expect(manager.refresh()).rejects.toMatchObject({
      code: 'ENTERPRISE_SECURE_STORAGE_UNAVAILABLE'
    });
    await vi.advanceTimersByTimeAsync(25);
    await firstRefresh;

    const retry = expect(manager.refresh()).rejects.toMatchObject({
      code: 'ENTERPRISE_SECURE_STORAGE_UNAVAILABLE'
    });
    expect(store.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(25);
    await retry;
    expect(store.read).toHaveBeenCalledOnce();

    stored.resolve(undefined);
    await vi.runAllTimersAsync();
  });

  it('sends one stable agent id through login and validation', async () => {
    const login = vi.fn(async () => ({
      account: {
        subjectId: 'acct_01JZ8W6A2M4S',
        email: 'user@example.com',
        name: 'User'
      },
      agentId,
      accessToken: credential.accessToken,
      tokenType: 'Bearer' as const,
      expiresAt: credential.expiresAt
    }));
    const getMe = vi.fn(async () => activeMe());
    const loggingIn = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(),
      httpClient: createClient({ getMe, login }),
      transportSecurity: 'secure_https'
    });
    const request = {
      email: 'user@example.com',
      password: 'password-123'
    };

    await expect(loggingIn.login(request)).resolves.toMatchObject({
      status: 'signed_in'
    });
    expect(login).toHaveBeenCalledWith(request, agentId);
    expect(getMe).toHaveBeenCalledWith(credential.accessToken);
  });

  it('fails a stale identity check after a concurrent logout', async () => {
    const me = deferred<EnterpriseMeResult>();
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(credential),
      httpClient: createClient({ getMe: vi.fn(async () => me.promise) }),
      transportSecurity: 'secure_https'
    });

    const identity = manager.requireIdentity();
    await vi.waitFor(() => expect(manager.getSnapshot().status).toBe('checking'));
    await manager.logout();
    me.resolve(activeMe());

    await expect(identity).rejects.toMatchObject({
      code: 'ENTERPRISE_UNAUTHORIZED',
      statusCode: 401
    });
    expect(manager.getSnapshot().status).toBe('signed_out');
  });

  it('rejects mismatched agent identities without persisting a session', async () => {
    const store = createStore();
    const logout = vi.fn(async () => undefined);
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: store,
      httpClient: createClient({
        login: vi.fn(async () => ({
          account: {
            subjectId: 'acct_01JZ8W6A2M4S',
            email: 'user@example.com',
            name: 'User'
          },
          agentId: 'clawee_123e4567-e89b-42d3-a456-426614174000',
          accessToken: credential.accessToken,
          tokenType: 'Bearer' as const,
          expiresAt: credential.expiresAt
        })),
        logout
      }),
      transportSecurity: 'secure_https'
    });

    await expect(manager.login({
      email: 'user@example.com',
      password: 'password-123'
    })).rejects.toMatchObject({
      code: 'ENTERPRISE_PROTOCOL_ERROR',
      statusCode: 502
    });
    expect(logout).toHaveBeenCalledWith(credential.accessToken);
    expect(store.write).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toEqual({
      status: 'signed_out',
      agentId,
      transportSecurity: 'secure_https'
    });
  });

  it('settles registration when the remote request fails', async () => {
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(),
      httpClient: createClient({
        register: vi.fn(async () => {
          throw new EnterpriseHttpError(
            'ENTERPRISE_AGENT_ID_CONFLICT',
            'response',
            409,
            'agent_id_conflict'
          );
        })
      }),
      transportSecurity: 'secure_https'
    });

    await expect(manager.register({
      email: 'user@example.com',
      name: 'User',
      password: 'password-123'
    })).rejects.toMatchObject({
      code: 'ENTERPRISE_AGENT_ID_CONFLICT',
      statusCode: 409
    });
    expect(manager.getSnapshot()).toEqual({
      status: 'signed_out',
      agentId,
      transportSecurity: 'secure_https'
    });
  });

  it('prepares one in-memory DingTalk PKCE flow without exposing the verifier', async () => {
    const prepare = vi.fn(async (input: {
      agentId: string;
      redirectUri: string;
      state: string;
      codeChallenge: string;
    }) => `https://enterprise.example/dingtalk/start?state=${input.state}`);
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(),
      httpClient: createClient({ prepareDingTalkAuthorization: prepare }),
      transportSecurity: 'secure_https'
    });
    const before = Date.now();

    const response = await manager.prepareDingTalkLogin!(
      'http://127.0.0.1:49152/enterprise/dingtalk/callback'
    );

    const request = prepare.mock.calls[0]![0];
    expect(request).toMatchObject({
      agentId,
      redirectUri: 'http://127.0.0.1:49152/enterprise/dingtalk/callback'
    });
    expect(request.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(response.expiresAt)).toBeGreaterThanOrEqual(before + 599_000);
    expect(JSON.stringify(response)).not.toContain('verifier');
    expect(JSON.stringify(response)).not.toContain(request.codeChallenge);
  });

  it('exchanges a matching DingTalk callback once and persists only the bearer credential', async () => {
    let prepared: Parameters<NonNullable<EnterpriseHttpClient['prepareDingTalkAuthorization']>>[0]
      | undefined;
    const exchange = vi.fn(async (input) => {
      expect(input.agentId).toBe(agentId);
      expect(input.redirectUri).toBe(
        'http://127.0.0.1:49152/enterprise/dingtalk/callback'
      );
      expect(input.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(createHash('sha256').update(input.codeVerifier, 'ascii').digest('base64url'))
        .toBe(prepared?.codeChallenge);
      return dingTalkLogin();
    });
    const store = createStore();
    const onSignedIn = vi.fn();
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: store,
      httpClient: createClient({
        prepareDingTalkAuthorization: vi.fn(async input => {
          prepared = input;
          return `https://enterprise.example/dingtalk/start?state=${input.state}`;
        }),
        exchangeDingTalkAuthorizationCode: exchange
      }),
      onSignedIn,
      transportSecurity: 'secure_https'
    });
    await manager.prepareDingTalkLogin!(
      'http://127.0.0.1:49152/enterprise/dingtalk/callback'
    );

    await expect(manager.handleDingTalkCallback!({
      state: prepared!.state,
      code: 'c'.repeat(43)
    })).resolves.toEqual({ signedIn: true });

    expect(exchange).toHaveBeenCalledOnce();
    expect(onSignedIn).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'dingtalk-session-token'
    }));
    expect(store.write).toHaveBeenCalledWith({
      accessToken: 'dingtalk-session-token',
      expiresAt: credential.expiresAt
    });
    expect(manager.getSnapshot()).toMatchObject({
      status: 'signed_in',
      account: { email: 'user@example.com' }
    });
    await expect(manager.handleDingTalkCallback!({
      state: prepared!.state,
      code: 'c'.repeat(43)
    })).resolves.toEqual({ signedIn: false, reason: 'request_missing' });
    expect(exchange).toHaveBeenCalledOnce();
  });

  it('rejects wrong state, malformed code, and callbacks replaced by a newer prepare', async () => {
    const states: string[] = [];
    const exchange = vi.fn(async () => dingTalkLogin());
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(),
      httpClient: createClient({
        prepareDingTalkAuthorization: vi.fn(async input => {
          states.push(input.state);
          return `https://enterprise.example/dingtalk/start?state=${input.state}`;
        }),
        exchangeDingTalkAuthorizationCode: exchange
      }),
      transportSecurity: 'secure_https'
    });
    const redirectUri = 'http://127.0.0.1:49152/enterprise/dingtalk/callback';
    await manager.prepareDingTalkLogin!(redirectUri);
    await expect(manager.handleDingTalkCallback!({
      state: 'x'.repeat(43),
      code: 'c'.repeat(43)
    })).resolves.toEqual({ signedIn: false, reason: 'state_mismatch' });
    await expect(manager.handleDingTalkCallback!({
      state: states[0],
      code: 'not-a-code'
    })).resolves.toEqual({ signedIn: false, reason: 'invalid_callback' });
    await manager.prepareDingTalkLogin!(redirectUri);
    await expect(manager.handleDingTalkCallback!({
      state: states[0],
      code: 'c'.repeat(43)
    })).resolves.toEqual({ signedIn: false, reason: 'state_mismatch' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('expires a pending DingTalk flow after ten minutes without exchanging a callback', async () => {
    vi.useFakeTimers();
    let state = '';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exchange = vi.fn(async () => dingTalkLogin());
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(),
      httpClient: createClient({
        prepareDingTalkAuthorization: vi.fn(async input => {
          state = input.state;
          return 'https://enterprise.example/dingtalk/start';
        }),
        exchangeDingTalkAuthorizationCode: exchange
      }),
      transportSecurity: 'secure_https'
    });
    await manager.prepareDingTalkLogin!(
      'http://127.0.0.1:49152/enterprise/dingtalk/callback'
    );

    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);

    expect(manager.getSnapshot()).toMatchObject({
      status: 'signed_out',
      reason: 'dingtalk_expired'
    });
    expect(warn.mock.calls
      .map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
      .find(event => event.stage === 'authorization_wait'))
      .toMatchObject({
        type: 'enterprise_dingtalk_auth',
        stage: 'authorization_wait',
        outcome: 'failed',
        reason: 'dingtalk_expired'
      });
    await expect(manager.handleDingTalkCallback!({
      state,
      code: 'c'.repeat(43)
    })).resolves.toEqual({ signedIn: false, reason: 'dingtalk_expired' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('rejects an old DingTalk callback after another authentication operation starts', async () => {
    let state = '';
    const passwordResult = deferred<ReturnType<typeof dingTalkLogin>>();
    const login = vi.fn(() => passwordResult.promise);
    const exchange = vi.fn(async () => dingTalkLogin());
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(),
      httpClient: createClient({
        login,
        prepareDingTalkAuthorization: vi.fn(async input => {
          state = input.state;
          return 'https://enterprise.example/dingtalk/start';
        }),
        exchangeDingTalkAuthorizationCode: exchange
      }),
      transportSecurity: 'secure_https'
    });
    await manager.prepareDingTalkLogin!(
      'http://127.0.0.1:49152/enterprise/dingtalk/callback'
    );

    const passwordLogin = manager.login({
      email: 'user@example.com',
      password: 'password-123'
    });
    await vi.waitFor(() => expect(login).toHaveBeenCalledOnce());
    await expect(manager.handleDingTalkCallback!({
      state,
      code: 'c'.repeat(43)
    })).resolves.toEqual({ signedIn: false, reason: 'request_missing' });
    expect(exchange).not.toHaveBeenCalled();

    passwordResult.resolve(dingTalkLogin());
    await expect(passwordLogin).resolves.toMatchObject({ status: 'signed_in' });
  });

  it.each([
    ['oauth_provider_denied', 'dingtalk_denied'],
    ['not_enterprise_member', 'dingtalk_account_unavailable'],
    ['dingtalk_upstream_unavailable', 'service_unavailable']
  ] as const)('maps DingTalk callback error %s to %s', async (gatewayError, reason) => {
    let state = '';
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(),
      httpClient: createClient({
        prepareDingTalkAuthorization: vi.fn(async input => {
          state = input.state;
          return 'https://enterprise.example/dingtalk/start';
        })
      }),
      transportSecurity: 'secure_https'
    });
    await manager.prepareDingTalkLogin!(
      'http://127.0.0.1:49152/enterprise/dingtalk/callback'
    );

    await expect(manager.handleDingTalkCallback!({
      state,
      error: gatewayError
    })).resolves.toEqual({
      signedIn: false,
      reason,
      providerError: gatewayError
    });
    expect(manager.getSnapshot()).toMatchObject({ status: 'signed_out', reason });
  });

  it('maps invalid grants to an expired DingTalk request', async () => {
    let state = '';
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(),
      httpClient: createClient({
        prepareDingTalkAuthorization: vi.fn(async input => {
          state = input.state;
          return 'https://enterprise.example/dingtalk/start';
        }),
        exchangeDingTalkAuthorizationCode: vi.fn(async () => {
          throw new EnterpriseHttpError(
            'ENTERPRISE_INVALID_REQUEST',
            'response',
            400,
            'invalid_grant'
          );
        })
      }),
      transportSecurity: 'secure_https'
    });
    await manager.prepareDingTalkLogin!(
      'http://127.0.0.1:49152/enterprise/dingtalk/callback'
    );

    await expect(manager.handleDingTalkCallback!({
      state,
      code: 'c'.repeat(43)
    })).resolves.toEqual({ signedIn: false, reason: 'dingtalk_expired' });
    expect(manager.getSnapshot()).toMatchObject({
      status: 'signed_out',
      reason: 'dingtalk_expired'
    });
  });

  it('logs Gateway token exchange diagnostics without OAuth secrets', async () => {
    let state = '';
    let codeVerifier = '';
    const authorizationCode = 'c'.repeat(43);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(),
      httpClient: createClient({
        prepareDingTalkAuthorization: vi.fn(async input => {
          state = input.state;
          return 'https://enterprise.example/dingtalk/start';
        }),
        exchangeDingTalkAuthorizationCode: vi.fn(async input => {
          codeVerifier = input.codeVerifier;
          throw new EnterpriseHttpError(
            'ENTERPRISE_FORBIDDEN',
            'response',
            403,
            'not_enterprise_member',
            undefined,
            'req_dingtalk_test'
          );
        })
      }),
      transportSecurity: 'secure_https'
    });
    await manager.prepareDingTalkLogin!(
      'http://127.0.0.1:49152/enterprise/dingtalk/callback'
    );

    await expect(manager.handleDingTalkCallback!({
      state,
      code: authorizationCode
    })).resolves.toEqual({
      signedIn: false,
      reason: 'dingtalk_account_unavailable',
      providerError: 'not_enterprise_member'
    });

    const messages = warn.mock.calls.map(([message]) => String(message));
    const diagnostic = messages
      .map(message => JSON.parse(message) as Record<string, unknown>)
      .find(event =>
        event.stage === 'token_exchange'
        && event.outcome === 'failed'
      );
    expect(diagnostic).toMatchObject({
      type: 'enterprise_dingtalk_auth',
      stage: 'token_exchange',
      outcome: 'failed',
      reason: 'dingtalk_account_unavailable',
      errorCode: 'ENTERPRISE_FORBIDDEN',
      upstreamCode: 'not_enterprise_member',
      statusCode: 403,
      requestId: 'req_dingtalk_test'
    });
    expect(messages.join('\n')).not.toContain(state);
    expect(messages.join('\n')).not.toContain(authorizationCode);
    expect(messages.join('\n')).not.toContain(codeVerifier);
    expect(messages.join('\n')).not.toContain('dingtalk-session-token');
  });

  it('keeps Gateway request diagnostics through DingTalk session validation', async () => {
    let state = '';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = createEnterpriseSessionManager({
      agentIdentityStore: createAgentIdentityStore(),
      credentialStore: createStore(),
      httpClient: createClient({
        prepareDingTalkAuthorization: vi.fn(async input => {
          state = input.state;
          return 'https://enterprise.example/dingtalk/start';
        }),
        exchangeDingTalkAuthorizationCode: vi.fn(async () => dingTalkLogin()),
        getMe: vi.fn(async () => {
          throw new EnterpriseHttpError(
            'ENTERPRISE_AGENT_FORBIDDEN',
            'response',
            403,
            'agent_forbidden',
            undefined,
            'req_auth_me_test'
          );
        })
      }),
      transportSecurity: 'secure_https'
    });
    await manager.prepareDingTalkLogin!(
      'http://127.0.0.1:49152/enterprise/dingtalk/callback'
    );

    await expect(manager.handleDingTalkCallback!({
      state,
      code: 'c'.repeat(43)
    })).resolves.toEqual({
      signedIn: false,
      reason: 'dingtalk_account_unavailable'
    });

    const diagnostic = warn.mock.calls
      .map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
      .find(event =>
        event.stage === 'session_validation'
        && event.outcome === 'failed'
      );
    expect(diagnostic).toMatchObject({
      type: 'enterprise_dingtalk_auth',
      stage: 'session_validation',
      outcome: 'failed',
      reason: 'dingtalk_account_unavailable',
      errorCode: 'ENTERPRISE_AGENT_FORBIDDEN',
      upstreamCode: 'agent_forbidden',
      statusCode: 403,
      requestId: 'req_auth_me_test'
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('dingtalk-session-token');
  });

  it('revokes DingTalk tokens that cannot be bound to this Agent or persisted', async () => {
    const logout = vi.fn(async () => undefined);
    const run = async (input: {
      login: ReturnType<typeof dingTalkLogin>;
      store: EnterpriseCredentialStore;
    }) => {
      let state = '';
      const manager = createEnterpriseSessionManager({
        agentIdentityStore: createAgentIdentityStore(),
        credentialStore: input.store,
        httpClient: createClient({
          prepareDingTalkAuthorization: vi.fn(async request => {
            state = request.state;
            return 'https://enterprise.example/dingtalk/start';
          }),
          exchangeDingTalkAuthorizationCode: vi.fn(async () => input.login),
          logout
        }),
        transportSecurity: 'secure_https'
      });
      await manager.prepareDingTalkLogin!(
        'http://127.0.0.1:49152/enterprise/dingtalk/callback'
      );
      return manager.handleDingTalkCallback!({ state, code: 'c'.repeat(43) });
    };

    await expect(run({
      login: { ...dingTalkLogin(), agentId: 'clawee_123e4567-e89b-42d3-a456-426614174000' },
      store: createStore()
    })).resolves.toEqual({
      signedIn: false,
      reason: 'service_unavailable'
    });
    const failingStore = createStore();
    failingStore.write.mockRejectedValueOnce(new EnterpriseCredentialStoreError('write'));
    await expect(run({ login: dingTalkLogin(), store: failingStore })).resolves.toEqual({
      signedIn: false,
      reason: 'secure_storage_unavailable'
    });
    expect(logout).toHaveBeenCalledTimes(2);
  });
});

function createStore(
  initial?: EnterpriseCredential
): EnterpriseCredentialStore & {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  return {
    read: vi.fn(async () => current),
    write: vi.fn(async (next: EnterpriseCredential) => {
      current = next;
    }),
    delete: vi.fn(async () => {
      current = undefined;
    })
  };
}

function createClient(
  overrides: Partial<EnterpriseHttpClient> = {}
): EnterpriseHttpClient {
  return {
    register: vi.fn(async () => undefined),
    login: vi.fn(async () => ({
      account: {
        subjectId: 'acct_01JZ8W6A2M4S',
        email: 'user@example.com',
        name: 'User'
      },
      agentId,
      accessToken: credential.accessToken,
      tokenType: 'Bearer' as const,
      expiresAt: credential.expiresAt
    })),
    getMe: vi.fn(async () => activeMe()),
    logout: vi.fn(async () => undefined),
    revealAccountMcpToken: vi.fn(),
    getMcpCatalog: vi.fn(),
    listKnowledgeBases: vi.fn(async () => ({
      knowledgeBases: [],
      meta: { nextCursor: '', hasNext: false }
    })),
    listKnowledgeDocuments: vi.fn(async () => ({
      documents: [],
      meta: { nextCursor: '', hasNext: false }
    })),
    uploadKnowledgeDocument: vi.fn(async () => {
      throw new Error('not implemented');
    }),
    listSharedSpaces: vi.fn(),
    listSharedFiles: vi.fn(),
    getSharedFileDetail: vi.fn(),
    downloadSharedFileContent: vi.fn(),
    uploadSharedFileContent: vi.fn(),
    listSkills: vi.fn(async () => []),
    getSkillDetail: vi.fn(async () => {
      throw new Error('not implemented');
    }),
    downloadSkillPackage: vi.fn(async () => {
      throw new Error('not implemented');
    }),
    ...overrides
  };
}

function activeMe(): EnterpriseMeResult {
  return {
    account: {
      subjectId: 'acct_01JZ8W6A2M4S',
      email: 'user@example.com',
      name: 'User'
    },
    agentId,
    status: 'active',
    frontendAllowed: true,
    activityReportingEnabled: false
  };
}

function dingTalkLogin() {
  return {
    account: activeMe().account,
    agentId,
    accessToken: 'dingtalk-session-token',
    tokenType: 'Bearer' as const,
    expiresAt: credential.expiresAt
  };
}

function createAgentIdentityStore(): EnterpriseAgentIdentityStore {
  return {
    getOrCreate: vi.fn(async () => agentId)
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
