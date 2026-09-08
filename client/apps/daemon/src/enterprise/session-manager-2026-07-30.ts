import type {
  EnterpriseDingTalkLoginPrepareResponse,
  EnterpriseLoginRequest,
  EnterpriseQrLoginStartRequest,
  EnterpriseQrLoginStartResponse,
  EnterpriseQrLoginStatusResponse,
  EnterpriseRegisterRequest,
  EnterpriseSessionReason,
  EnterpriseSessionResponse,
  EnterpriseTransportSecurity,
  RuntimeErrorCode
} from '@clawee/protocol';
import {
  createHash,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import type {
  EnterpriseCredential,
  EnterpriseCredentialStore
} from './credential-store-2026-07-30.js';
import { EnterpriseCredentialStoreError } from './credential-store-2026-07-30.js';
import type {
  EnterpriseAgentIdentityStore
} from './agent-identity-2026-08-02.js';
import {
  EnterpriseAgentIdentityStoreError
} from './agent-identity-2026-08-02.js';
import type {
  EnterpriseHttpClient,
  EnterpriseLoginResult
} from './http-client-2026-07-30.js';
import { EnterpriseHttpError } from './http-client-2026-07-30.js';

export type EnterpriseSessionManager = {
  startRestore(): void;
  getSnapshot(): EnterpriseSessionResponse;
  refresh(): Promise<EnterpriseSessionResponse>;
  login(input: EnterpriseLoginRequest): Promise<EnterpriseSessionResponse>;
  register(input: EnterpriseRegisterRequest): Promise<EnterpriseSessionResponse>;
  startQrLogin?(
    input: EnterpriseQrLoginStartRequest
  ): Promise<EnterpriseQrLoginStartResponse>;
  pollQrLogin?(
    requestId: string
  ): Promise<EnterpriseQrLoginStatusResponse>;
  prepareDingTalkLogin?(
    redirectUri: string
  ): Promise<EnterpriseDingTalkLoginPrepareResponse>;
  handleDingTalkCallback?(input: {
    state?: string;
    code?: string;
    error?: string;
  }): Promise<EnterpriseDingTalkCallbackResult>;
  logout(): Promise<EnterpriseSessionResponse>;
  requireAccessToken(): Promise<string>;
  invalidateUnauthorized(reason?: 'session_expired'): Promise<void>;
  close(): Promise<void>;
};

type EnterpriseDingTalkAuthenticationFailureReason =
  | 'dingtalk_denied'
  | 'dingtalk_expired'
  | 'dingtalk_account_unavailable'
  | 'secure_storage_unavailable'
  | 'service_unavailable';

export type EnterpriseDingTalkCallbackFailureReason =
  | 'invalid_callback'
  | 'request_missing'
  | 'state_mismatch'
  | EnterpriseDingTalkAuthenticationFailureReason;

export type EnterpriseDingTalkProviderError =
  | 'oauth_provider_denied'
  | 'oauth_state_invalid'
  | 'dingtalk_upstream_unavailable'
  | 'not_enterprise_member'
  | 'dingtalk_email_missing'
  | 'account_binding_required'
  | 'auto_provision_disabled'
  | 'system_not_initialized'
  | 'account_disabled'
  | 'identity_conflict'
  | 'account_profile_conflict'
  | 'agent_id_conflict'
  | 'agent_forbidden'
  | 'agent_provisioning_unavailable'
  | 'dingtalk_disabled'
  | 'internal_error';

export type EnterpriseDingTalkCallbackResult =
  | { signedIn: true }
  | {
      signedIn: false;
      reason: EnterpriseDingTalkCallbackFailureReason;
      providerError?: EnterpriseDingTalkProviderError;
    };

export type EnterpriseIdentity = {
  subjectId: string;
  agentId: string;
  accessToken: string;
};

export type EnterpriseSignedInIdentity = EnterpriseIdentity & {
  activityReportingEnabled: boolean;
};

export type EnterpriseIdentityProvider = {
  requireIdentity(): Promise<EnterpriseIdentity>;
};

export class EnterpriseSessionError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>,
    readonly diagnostic?: EnterpriseSessionDiagnostic
  ) {
    super(`${code}: enterprise session operation failed`);
    this.name = 'EnterpriseSessionError';
  }
}

type EnterpriseSessionDiagnostic = {
  upstreamCode?: string;
  requestId?: string;
};

type PendingDingTalkLogin = {
  agentId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: string;
  generation: number;
};

const DINGTALK_LOGIN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CREDENTIAL_READ_TIMEOUT_MS = 15_000;
const BASE64_URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createEnterpriseSessionManager(input: {
  agentIdentityStore: EnterpriseAgentIdentityStore;
  initialAgentId?: string;
  credentialStore: EnterpriseCredentialStore;
  credentialReadTimeoutMs?: number;
  httpClient: EnterpriseHttpClient;
  transportSecurity: EnterpriseTransportSecurity;
  onSignedIn?(identity: EnterpriseSignedInIdentity): void;
  onSignedOut?(): void;
}): EnterpriseSessionManager & EnterpriseIdentityProvider {
  let generation = 0;
  let closed = false;
  let credential: EnterpriseCredential | undefined;
  let accountCache: EnterpriseSessionResponse['account'];
  let agentIdCache = input.initialAgentId;
  let snapshot: EnterpriseSessionResponse = checkingSnapshot();
  let pendingDingTalkLogin: PendingDingTalkLogin | undefined;
  let pendingDingTalkTimer: ReturnType<typeof setTimeout> | undefined;
  let credentialMutation = Promise.resolve();
  let pendingCredentialRead:
    Promise<EnterpriseCredential | undefined> | undefined;

  function checkingSnapshot(): EnterpriseSessionResponse {
    return {
      status: 'checking',
      ...(agentIdCache === undefined ? {} : { agentId: agentIdCache }),
      transportSecurity: input.transportSecurity
    };
  }

  function signedOutSnapshot(
    reason?: EnterpriseSessionReason
  ): EnterpriseSessionResponse {
    return {
      status: 'signed_out',
      ...(agentIdCache === undefined ? {} : { agentId: agentIdCache }),
      ...(reason === undefined ? {} : { reason }),
      transportSecurity: input.transportSecurity
    };
  }

  function publish(
    operationGeneration: number,
    next: EnterpriseSessionResponse
  ): boolean {
    if (closed || operationGeneration !== generation) return false;
    snapshot = next;
    if (next.status === 'signed_out') input.onSignedOut?.();
    return true;
  }

  function beginOperation(): number {
    clearPendingDingTalkLogin();
    generation += 1;
    snapshot = checkingSnapshot();
    return generation;
  }

  function beginPassiveAuthentication(): number {
    clearPendingDingTalkLogin();
    generation += 1;
    snapshot = signedOutSnapshot();
    return generation;
  }

  function clearPendingDingTalkLogin(): void {
    if (pendingDingTalkTimer !== undefined) {
      clearTimeout(pendingDingTalkTimer);
      pendingDingTalkTimer = undefined;
    }
    pendingDingTalkLogin = undefined;
  }

  function setPendingDingTalkLogin(pending: PendingDingTalkLogin): void {
    clearPendingDingTalkLogin();
    pendingDingTalkLogin = pending;
    pendingDingTalkTimer = setTimeout(() => {
      if (
        pendingDingTalkLogin?.generation !== pending.generation
        || generation !== pending.generation
      ) {
        return;
      }
      clearPendingDingTalkLogin();
      publish(pending.generation, signedOutSnapshot('dingtalk_expired'));
      logDingTalkAuth({
        stage: 'authorization_wait',
        outcome: 'failed',
        reason: 'dingtalk_expired'
      });
    }, Math.max(0, Date.parse(pending.expiresAt) - Date.now()));
    pendingDingTalkTimer.unref?.();
  }

  async function mutateCredential<T>(operation: () => Promise<T>): Promise<T> {
    const result = credentialMutation.then(operation, operation);
    credentialMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readCredential(
    operationGeneration: number
  ): Promise<EnterpriseCredential | undefined> {
    if (credential !== undefined) return credential;
    try {
      const stored = await waitForCredentialRead();
      if (operationGeneration === generation) credential = stored;
      return stored;
    } catch (error) {
      if (error instanceof EnterpriseCredentialStoreError) {
        publish(
          operationGeneration,
          signedOutSnapshot('secure_storage_unavailable')
        );
        throw new EnterpriseSessionError(
          'ENTERPRISE_SECURE_STORAGE_UNAVAILABLE',
          503
        );
      }
      publish(operationGeneration, signedOutSnapshot());
      throw new EnterpriseSessionError(
        'ENTERPRISE_PROTOCOL_ERROR',
        500
      );
    }
  }

  function waitForCredentialRead(): Promise<EnterpriseCredential | undefined> {
    const sharedRead = getPendingCredentialRead();
    const timeoutMs = input.credentialReadTimeoutMs
      ?? DEFAULT_CREDENTIAL_READ_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new EnterpriseCredentialStoreError('read'));
      }, timeoutMs);
      timer.unref?.();

      void sharedRead.then(
        stored => {
          clearTimeout(timer);
          resolve(stored);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function getPendingCredentialRead():
    Promise<EnterpriseCredential | undefined> {
    if (pendingCredentialRead !== undefined) return pendingCredentialRead;

    const current = input.credentialStore.read();
    pendingCredentialRead = current;
    void current.then(
      () => {
        if (pendingCredentialRead === current) pendingCredentialRead = undefined;
      },
      () => {
        if (pendingCredentialRead === current) pendingCredentialRead = undefined;
      }
    );
    return current;
  }

  async function clearCredential(
    operationGeneration: number,
    reason?: EnterpriseSessionReason
  ): Promise<void> {
    try {
      await mutateCredential(() => input.credentialStore.delete());
      if (operationGeneration === generation) {
        credential = undefined;
        accountCache = undefined;
      }
      publish(operationGeneration, signedOutSnapshot(reason));
    } catch (error) {
      if (error instanceof EnterpriseCredentialStoreError) {
        publish(
          operationGeneration,
          signedOutSnapshot('secure_storage_unavailable')
        );
        throw new EnterpriseSessionError(
          'ENTERPRISE_SECURE_STORAGE_UNAVAILABLE',
          503
        );
      }
      publish(operationGeneration, signedOutSnapshot());
      throw new EnterpriseSessionError(
        'ENTERPRISE_PROTOCOL_ERROR',
        500
      );
    }
  }

  async function readAgentId(operationGeneration: number): Promise<string> {
    try {
      const agentId = await input.agentIdentityStore.getOrCreate();
      if (operationGeneration === generation) agentIdCache = agentId;
      return agentId;
    } catch (error) {
      publish(operationGeneration, signedOutSnapshot());
      if (error instanceof EnterpriseAgentIdentityStoreError) {
        throw new EnterpriseSessionError(
          'ENTERPRISE_PROTOCOL_ERROR',
          500
        );
      }
      throw new EnterpriseSessionError(
        'ENTERPRISE_PROTOCOL_ERROR',
        500
      );
    }
  }

  async function validateAuthenticatedSession(request: {
    operationGeneration: number;
    credential: EnterpriseCredential;
    expectedAgentId: string;
    persist: boolean;
    notifySignedIn: boolean;
  }): Promise<EnterpriseSessionResponse> {
    let me;
    try {
      me = await input.httpClient.getMe(request.credential.accessToken);
    } catch (error) {
      if (error instanceof EnterpriseHttpError) {
        if (error.code === 'ENTERPRISE_UNAUTHORIZED') {
          if (request.persist) {
            await revokeQuietly(request.credential.accessToken);
            publish(
              request.operationGeneration,
              signedOutSnapshot('session_expired')
            );
          } else {
            await clearCredential(
              request.operationGeneration,
              'session_expired'
            );
          }
          throw new EnterpriseSessionError(
            request.persist
              ? 'ENTERPRISE_UNAUTHORIZED'
              : 'ENTERPRISE_SESSION_EXPIRED',
            401,
            undefined,
            enterpriseHttpDiagnostic(error)
          );
        }
        if (error.code === 'ENTERPRISE_SERVICE_UNAVAILABLE') {
          if (request.persist) {
            await revokeQuietly(request.credential.accessToken);
          } else if (request.operationGeneration === generation) {
            credential = request.credential;
          }
          publish(request.operationGeneration, {
            status: 'service_unavailable',
            ...(agentIdCache === undefined ? {} : { agentId: agentIdCache }),
            ...(accountCache === undefined
              ? {}
              : { account: accountCache }),
            expiresAt: request.credential.expiresAt,
            reason: 'service_unavailable',
            transportSecurity: input.transportSecurity
          });
          throw new EnterpriseSessionError(
            'ENTERPRISE_SERVICE_UNAVAILABLE',
            503,
            undefined,
            enterpriseHttpDiagnostic(error)
          );
        }
        await rejectUnusableCredential(request);
        throw sessionErrorFromHttp(error);
      }
      await rejectUnusableCredential(request);
      throw new EnterpriseSessionError(
        'ENTERPRISE_PROTOCOL_ERROR',
        500
      );
    }

    if (closed || request.operationGeneration !== generation) {
      if (request.persist) await revokeQuietly(request.credential.accessToken);
      throw new EnterpriseSessionError('ENTERPRISE_UNAUTHORIZED', 401);
    }

    if (me.agentId !== request.expectedAgentId) {
      await rejectUnusableCredential(request);
      throw new EnterpriseSessionError(
        'ENTERPRISE_PROTOCOL_ERROR',
        502
      );
    }

    if (me.status !== 'active') {
      if (request.persist) {
        await revokeQuietly(request.credential.accessToken);
        publish(
          request.operationGeneration,
          signedOutSnapshot('account_inactive')
        );
      } else {
        await clearCredential(
          request.operationGeneration,
          'account_inactive'
        );
      }
      throw new EnterpriseSessionError(
        'ENTERPRISE_ACCOUNT_INACTIVE',
        403
      );
    }

    if (!me.frontendAllowed) {
      if (request.persist) {
        await revokeQuietly(request.credential.accessToken);
        publish(
          request.operationGeneration,
          signedOutSnapshot('frontend_forbidden')
        );
      } else {
        await clearCredential(
          request.operationGeneration,
          'frontend_forbidden'
        );
      }
      throw new EnterpriseSessionError(
        'ENTERPRISE_FRONTEND_FORBIDDEN',
        403
      );
    }

    if (request.persist) {
      try {
        const committed = await mutateCredential(async () => {
          if (closed || request.operationGeneration !== generation) return false;
          await input.credentialStore.write(request.credential);
          if (closed || request.operationGeneration !== generation) {
            await input.credentialStore.delete();
            return false;
          }
          return true;
        });
        if (!committed) {
          await revokeQuietly(request.credential.accessToken);
          throw new EnterpriseSessionError('ENTERPRISE_UNAUTHORIZED', 401);
        }
      } catch (error) {
        if (error instanceof EnterpriseSessionError) throw error;
        await revokeQuietly(request.credential.accessToken);
        if (error instanceof EnterpriseCredentialStoreError) {
          publish(
            request.operationGeneration,
            signedOutSnapshot('secure_storage_unavailable')
          );
          throw new EnterpriseSessionError(
            'ENTERPRISE_SECURE_STORAGE_UNAVAILABLE',
            503
          );
        }
        publish(request.operationGeneration, signedOutSnapshot());
        throw new EnterpriseSessionError(
          'ENTERPRISE_PROTOCOL_ERROR',
          500
        );
      }
    }

    if (request.operationGeneration === generation) {
      credential = request.credential;
      accountCache = me.account;
    }
    const next: EnterpriseSessionResponse = {
      status: 'signed_in',
      agentId: request.expectedAgentId,
      account: me.account,
      expiresAt: request.credential.expiresAt,
      transportSecurity: input.transportSecurity
    };
    const published = publish(request.operationGeneration, next);
    if (published && request.notifySignedIn) {
      input.onSignedIn?.({
        subjectId: me.account.subjectId,
        agentId: me.agentId,
        accessToken: request.credential.accessToken,
        activityReportingEnabled: me.activityReportingEnabled === true
      });
    }
    return next;
  }

  async function authenticateNew(
    operationGeneration: number,
    request: EnterpriseLoginRequest,
    agentId: string
  ): Promise<EnterpriseSessionResponse> {
    let login: EnterpriseLoginResult;
    try {
      login = await input.httpClient.login(request, agentId);
    } catch (error) {
      publish(operationGeneration, signedOutSnapshot());
      if (error instanceof EnterpriseHttpError) {
        throw sessionErrorFromHttp(error);
      }
      throw new EnterpriseSessionError(
        'ENTERPRISE_PROTOCOL_ERROR',
        500
      );
    }
    return authenticateLoginResult(operationGeneration, login, agentId);
  }

  async function authenticateLoginResult(
    operationGeneration: number,
    login: EnterpriseLoginResult,
    agentId: string
  ): Promise<EnterpriseSessionResponse> {
    if (closed || operationGeneration !== generation) {
      await revokeQuietly(login.accessToken);
      throw new EnterpriseSessionError('ENTERPRISE_UNAUTHORIZED', 401);
    }
    if (login.agentId !== agentId) {
      await revokeQuietly(login.accessToken);
      publish(operationGeneration, signedOutSnapshot());
      throw new EnterpriseSessionError(
        'ENTERPRISE_PROTOCOL_ERROR',
        502
      );
    }
    return validateAuthenticatedSession({
      operationGeneration,
      credential: {
        accessToken: login.accessToken,
        expiresAt: login.expiresAt
      },
      expectedAgentId: agentId,
      persist: true,
      notifySignedIn: true
    });
  }

  async function refreshForGeneration(
    operationGeneration: number
  ): Promise<EnterpriseSessionResponse> {
    const stored = await readCredential(operationGeneration);
    if (stored === undefined) {
      const next = signedOutSnapshot();
      publish(operationGeneration, next);
      return next;
    }
    const agentId = await readAgentId(operationGeneration);
    return validateAuthenticatedSession({
      operationGeneration,
      credential: stored,
      expectedAgentId: agentId,
      persist: false,
      notifySignedIn: true
    });
  }

  async function rejectUnusableCredential(request: {
    operationGeneration: number;
    credential: EnterpriseCredential;
    persist: boolean;
  }): Promise<void> {
    if (request.persist) {
      await revokeQuietly(request.credential.accessToken);
      publish(request.operationGeneration, signedOutSnapshot());
      return;
    }
    await clearCredential(request.operationGeneration);
  }

  async function revokeQuietly(accessToken: string): Promise<void> {
    try {
      await input.httpClient.logout(accessToken);
    } catch {
      console.warn('Enterprise session revocation failed after authentication rejection');
    }
  }

  async function prepareDingTalkLogin(
    redirectUri: string
  ): Promise<EnterpriseDingTalkLoginPrepareResponse> {
    const operationGeneration = beginPassiveAuthentication();
    logDingTalkAuth({
      stage: 'prepare',
      outcome: 'started'
    });
    let agentId: string;
    try {
      agentId = await readAgentId(operationGeneration);
    } catch (error) {
      logDingTalkAuth({
        stage: 'prepare',
        outcome: 'failed',
        reason: 'agent_identity_unavailable',
        ...dingTalkAuthErrorFields(error)
      });
      throw error;
    }
    const state = randomBase64Url32();
    const codeVerifier = randomBase64Url32();
    const codeChallenge = base64UrlSha256(codeVerifier);
    const expiresAt = new Date(Date.now() + DINGTALK_LOGIN_TTL_MS).toISOString();
    const prepareAuthorization = input.httpClient.prepareDingTalkAuthorization;
    if (prepareAuthorization === undefined) {
      publish(operationGeneration, signedOutSnapshot('service_unavailable'));
      logDingTalkAuth({
        stage: 'prepare',
        outcome: 'failed',
        reason: 'dingtalk_not_supported',
        errorCode: 'ENTERPRISE_SERVICE_UNAVAILABLE',
        statusCode: 503
      });
      throw new EnterpriseSessionError('ENTERPRISE_SERVICE_UNAVAILABLE', 503);
    }
    let authorizationUrl: string;
    try {
      authorizationUrl = await prepareAuthorization({
        agentId,
        redirectUri,
        state,
        codeChallenge
      });
    } catch (error) {
      publish(operationGeneration, signedOutSnapshot('service_unavailable'));
      logDingTalkAuth({
        stage: 'prepare',
        outcome: 'failed',
        reason: error instanceof EnterpriseHttpError
          && error.upstreamCode === 'dingtalk_disabled'
          ? 'dingtalk_disabled'
          : 'service_unavailable',
        ...dingTalkAuthErrorFields(error)
      });
      if (error instanceof EnterpriseHttpError) {
        throw new EnterpriseSessionError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          503,
          error.upstreamCode === 'dingtalk_disabled'
            ? { reason: 'dingtalk_disabled' }
            : undefined
        );
      }
      throw new EnterpriseSessionError('ENTERPRISE_PROTOCOL_ERROR', 500);
    }
    if (closed || operationGeneration !== generation) {
      logDingTalkAuth({
        stage: 'prepare',
        outcome: 'failed',
        reason: 'operation_superseded',
        errorCode: 'ENTERPRISE_INVALID_REQUEST',
        statusCode: 409
      });
      throw new EnterpriseSessionError('ENTERPRISE_INVALID_REQUEST', 409);
    }
    setPendingDingTalkLogin({
      agentId,
      state,
      codeVerifier,
      redirectUri,
      expiresAt,
      generation: operationGeneration
    });
    logDingTalkAuth({
      stage: 'prepare',
      outcome: 'succeeded'
    });
    return { authorizationUrl, expiresAt };
  }

  async function handleDingTalkCallback(request: {
    state?: string;
    code?: string;
    error?: string;
  }): Promise<EnterpriseDingTalkCallbackResult> {
    const pending = pendingDingTalkLogin;
    if (pending === undefined) {
      logDingTalkAuth({
        stage: 'callback_validation',
        outcome: 'failed',
        reason: 'no_pending_login'
      });
      return {
        signedIn: false,
        reason: snapshot.reason === 'dingtalk_expired'
          ? 'dingtalk_expired'
          : 'request_missing'
      };
    }
    if (pending.generation !== generation) {
      logDingTalkAuth({
        stage: 'callback_validation',
        outcome: 'failed',
        reason: 'operation_superseded'
      });
      return { signedIn: false, reason: 'request_missing' };
    }
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      clearPendingDingTalkLogin();
      publish(pending.generation, signedOutSnapshot('dingtalk_expired'));
      logDingTalkAuth({
        stage: 'callback_validation',
        outcome: 'failed',
        reason: 'dingtalk_expired'
      });
      return { signedIn: false, reason: 'dingtalk_expired' };
    }
    if (!constantTimeBase64UrlEqual(request.state, pending.state)) {
      logDingTalkAuth({
        stage: 'callback_validation',
        outcome: 'failed',
        reason: 'state_mismatch'
      });
      return { signedIn: false, reason: 'state_mismatch' };
    }

    const hasCode = request.code !== undefined;
    const hasError = request.error !== undefined;
    if (hasCode === hasError) {
      logDingTalkAuth({
        stage: 'callback_validation',
        outcome: 'failed',
        reason: 'invalid_callback_shape'
      });
      return { signedIn: false, reason: 'invalid_callback' };
    }
    if (hasCode && !isBase64Url32(request.code)) {
      logDingTalkAuth({
        stage: 'callback_validation',
        outcome: 'failed',
        reason: 'invalid_authorization_code'
      });
      return { signedIn: false, reason: 'invalid_callback' };
    }
    const providerError = isStableDingTalkError(request.error)
      ? request.error
      : undefined;
    if (hasError && providerError === undefined) {
      logDingTalkAuth({
        stage: 'callback_validation',
        outcome: 'failed',
        reason: 'invalid_gateway_error'
      });
      return { signedIn: false, reason: 'invalid_callback' };
    }

    clearPendingDingTalkLogin();
    logDingTalkAuth({
      stage: 'callback_validation',
      outcome: 'succeeded'
    });
    if (providerError !== undefined) {
      const reason = dingTalkReasonFromGatewayCode(providerError);
      publish(
        pending.generation,
        signedOutSnapshot(reason)
      );
      logDingTalkAuth({
        stage: 'gateway_callback_error',
        outcome: 'failed',
        reason,
        upstreamCode: providerError
      });
      return {
        signedIn: false,
        reason,
        providerError
      };
    }

    const exchangeAuthorizationCode =
      input.httpClient.exchangeDingTalkAuthorizationCode;
    if (exchangeAuthorizationCode === undefined) {
      publish(pending.generation, signedOutSnapshot('service_unavailable'));
      logDingTalkAuth({
        stage: 'token_exchange',
        outcome: 'failed',
        reason: 'dingtalk_not_supported',
        errorCode: 'ENTERPRISE_SERVICE_UNAVAILABLE',
        statusCode: 503
      });
      return { signedIn: false, reason: 'service_unavailable' };
    }
    let login: EnterpriseLoginResult;
    logDingTalkAuth({
      stage: 'token_exchange',
      outcome: 'started'
    });
    try {
      login = await exchangeAuthorizationCode({
        agentId: pending.agentId,
        code: request.code!,
        redirectUri: pending.redirectUri,
        codeVerifier: pending.codeVerifier
      });
    } catch (error) {
      const reason = dingTalkReasonFromHttpError(error);
      const providerError = error instanceof EnterpriseHttpError
        && isStableDingTalkError(error.upstreamCode)
        ? error.upstreamCode
        : undefined;
      publish(
        pending.generation,
        signedOutSnapshot(reason)
      );
      logDingTalkAuth({
        stage: 'token_exchange',
        outcome: 'failed',
        reason,
        ...dingTalkAuthErrorFields(error)
      });
      return {
        signedIn: false,
        reason,
        ...(providerError === undefined ? {} : { providerError })
      };
    }
    logDingTalkAuth({
      stage: 'token_exchange',
      outcome: 'succeeded'
    });

    logDingTalkAuth({
      stage: 'session_validation',
      outcome: 'started'
    });
    try {
      await authenticateLoginResult(
        pending.generation,
        login,
        pending.agentId
      );
      logDingTalkAuth({
        stage: 'session_validation',
        outcome: 'succeeded'
      });
      logDingTalkAuth({
        stage: 'complete',
        outcome: 'succeeded'
      });
      return { signedIn: true };
    } catch (error) {
      const reason = dingTalkReasonFromSessionError(error);
      publish(
        pending.generation,
        signedOutSnapshot(reason)
      );
      logDingTalkAuth({
        stage: 'session_validation',
        outcome: 'failed',
        reason,
        ...dingTalkAuthErrorFields(error)
      });
      return { signedIn: false, reason };
    }
  }

  return {
    startRestore() {
      const operationGeneration = beginOperation();
      void refreshForGeneration(operationGeneration).catch(error => {
        if (snapshot.status === 'checking') {
          publish(operationGeneration, signedOutSnapshot());
        }
        console.warn(
          `Enterprise session restore failed [${sessionErrorCode(error)}]`
        );
      });
    },

    getSnapshot() {
      return snapshot;
    },

    async refresh() {
      return refreshForGeneration(beginOperation());
    },

    prepareDingTalkLogin,

    handleDingTalkCallback,

    async login(request) {
      const operationGeneration = beginOperation();
      const agentId = await readAgentId(operationGeneration);
      return authenticateNew(operationGeneration, request, agentId);
    },

    async register(request) {
      const operationGeneration = beginOperation();
      const agentId = await readAgentId(operationGeneration);
      try {
        await input.httpClient.register(request, agentId);
      } catch (error) {
        publish(operationGeneration, signedOutSnapshot());
        if (error instanceof EnterpriseHttpError) {
          throw sessionErrorFromHttp(error);
        }
        throw new EnterpriseSessionError(
          'ENTERPRISE_PROTOCOL_ERROR',
          500
        );
      }
      try {
        return await authenticateNew(
          operationGeneration,
          {
            email: request.email,
            password: request.password
          },
          agentId
        );
      } catch {
        const email = request.email.trim().toLowerCase();
        throw new EnterpriseSessionError(
          'ENTERPRISE_REGISTERED_LOGIN_REQUIRED',
          409,
          { email }
        );
      }
    },

    async startQrLogin(request) {
      const startQrLogin = input.httpClient.startQrLogin;
      if (startQrLogin === undefined) {
        throw new EnterpriseSessionError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          503
        );
      }
      const operationGeneration = beginPassiveAuthentication();
      const agentId = await readAgentId(operationGeneration);
      try {
        return await startQrLogin(request, agentId);
      } catch (error) {
        if (error instanceof EnterpriseHttpError) {
          throw sessionErrorFromHttp(error);
        }
        throw new EnterpriseSessionError(
          'ENTERPRISE_PROTOCOL_ERROR',
          500
        );
      }
    },

    async pollQrLogin(requestId) {
      const pollQrLogin = input.httpClient.pollQrLogin;
      if (pollQrLogin === undefined) {
        throw new EnterpriseSessionError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          503
        );
      }
      const operationGeneration = generation;
      const agentId = await readAgentId(operationGeneration);
      let result;
      try {
        result = await pollQrLogin(requestId, agentId);
      } catch (error) {
        if (error instanceof EnterpriseHttpError) {
          throw sessionErrorFromHttp(error);
        }
        throw new EnterpriseSessionError(
          'ENTERPRISE_PROTOCOL_ERROR',
          500
        );
      }
      if (result.status !== 'signed_in') {
        return {
          requestId: result.requestId,
          provider: result.provider,
          status: result.status,
          ...(result.pollAfterMs === undefined
            ? {}
            : { pollAfterMs: result.pollAfterMs })
        };
      }
      const authenticationGeneration = beginOperation();
      const session = await authenticateLoginResult(
        authenticationGeneration,
        result.login,
        agentId
      );
      return {
        requestId: result.requestId,
        provider: result.provider,
        status: 'signed_in',
        session
      };
    },

    async logout() {
      const operationGeneration = beginOperation();
      const stored = await readCredential(operationGeneration);
      if (stored === undefined) {
        const next = signedOutSnapshot();
        publish(operationGeneration, next);
        return next;
      }

      try {
        await input.httpClient.logout(stored.accessToken);
      } catch (error) {
        if (
          error instanceof EnterpriseHttpError &&
          error.code === 'ENTERPRISE_UNAUTHORIZED'
        ) {
          await clearCredential(operationGeneration, 'session_expired');
          return snapshot;
        }
        if (
          error instanceof EnterpriseHttpError &&
          error.code === 'ENTERPRISE_SERVICE_UNAVAILABLE'
        ) {
          if (operationGeneration === generation) credential = stored;
          publish(operationGeneration, {
            status: 'service_unavailable',
            ...(agentIdCache === undefined ? {} : { agentId: agentIdCache }),
            ...(accountCache === undefined
              ? {}
              : { account: accountCache }),
            expiresAt: stored.expiresAt,
            reason: 'service_unavailable',
            transportSecurity: input.transportSecurity
          });
          throw new EnterpriseSessionError(
            'ENTERPRISE_SERVICE_UNAVAILABLE',
            503
          );
        }
        if (operationGeneration === generation) credential = stored;
        publish(operationGeneration, {
          status: 'service_unavailable',
          ...(agentIdCache === undefined ? {} : { agentId: agentIdCache }),
          ...(accountCache === undefined
            ? {}
            : { account: accountCache }),
          expiresAt: stored.expiresAt,
          reason: 'service_unavailable',
          transportSecurity: input.transportSecurity
        });
        if (error instanceof EnterpriseHttpError) {
          throw sessionErrorFromHttp(error);
        }
        throw new EnterpriseSessionError(
          'ENTERPRISE_PROTOCOL_ERROR',
          500
        );
      }

      await clearCredential(operationGeneration, 'session_expired');
      const next = signedOutSnapshot();
      publish(operationGeneration, next);
      return next;
    },

    async requireAccessToken() {
      const operationGeneration = generation;
      const stored = await readCredential(operationGeneration);
      if (stored === undefined || snapshot.status !== 'signed_in') {
        throw new EnterpriseSessionError('ENTERPRISE_UNAUTHORIZED', 401);
      }
      return stored.accessToken;
    },

    async requireIdentity() {
      const operationGeneration = beginOperation();
      const stored = await readCredential(operationGeneration);
      if (stored === undefined) {
        publish(operationGeneration, signedOutSnapshot());
        throw new EnterpriseSessionError('ENTERPRISE_UNAUTHORIZED', 401);
      }
      const agentId = await readAgentId(operationGeneration);
      const verified = await validateAuthenticatedSession({
        operationGeneration,
        credential: stored,
        expectedAgentId: agentId,
        persist: false,
        notifySignedIn: false
      });
      if (operationGeneration !== generation) {
        throw new EnterpriseSessionError('ENTERPRISE_UNAUTHORIZED', 401);
      }
      if (verified.status !== 'signed_in' || verified.account === undefined) {
        throw new EnterpriseSessionError('ENTERPRISE_UNAUTHORIZED', 401);
      }
      return {
        subjectId: verified.account.subjectId,
        agentId,
        accessToken: stored.accessToken
      };
    },

    async invalidateUnauthorized(reason = 'session_expired') {
      await clearCredential(beginOperation(), reason);
    },

    async close() {
      closed = true;
      clearPendingDingTalkLogin();
      generation += 1;
      credential = undefined;
      accountCache = undefined;
      agentIdCache = undefined;
    }
  };
}

function sessionErrorFromHttp(error: EnterpriseHttpError): EnterpriseSessionError {
  switch (error.code) {
    case 'ENTERPRISE_INVALID_REQUEST':
      return new EnterpriseSessionError(
        error.code,
        400,
        undefined,
        enterpriseHttpDiagnostic(error)
      );
    case 'ENTERPRISE_UNAUTHORIZED':
      return new EnterpriseSessionError(
        error.code,
        401,
        undefined,
        enterpriseHttpDiagnostic(error)
      );
    case 'ENTERPRISE_SERVICE_UNAVAILABLE':
      return new EnterpriseSessionError(
        error.code,
        503,
        undefined,
        enterpriseHttpDiagnostic(error)
      );
    default:
      return new EnterpriseSessionError(
        error.code,
        error.statusCode ?? 500,
        undefined,
        enterpriseHttpDiagnostic(error)
      );
  }
}

function enterpriseHttpDiagnostic(
  error: EnterpriseHttpError
): EnterpriseSessionDiagnostic {
  return {
    upstreamCode: error.upstreamCode,
    requestId: error.requestId
  };
}

function dingTalkAuthErrorFields(error: unknown): {
  errorCode: string;
  statusCode?: number;
  upstreamCode?: string;
  requestId?: string;
} {
  if (error instanceof EnterpriseHttpError) {
    return {
      errorCode: error.code,
      statusCode: error.statusCode,
      upstreamCode: error.upstreamCode,
      requestId: error.requestId
    };
  }
  if (error instanceof EnterpriseSessionError) {
    return {
      errorCode: error.code,
      statusCode: error.statusCode,
      upstreamCode: error.diagnostic?.upstreamCode,
      requestId: error.diagnostic?.requestId
    };
  }
  return { errorCode: 'ENTERPRISE_PROTOCOL_ERROR' };
}

function logDingTalkAuth(event: {
  stage:
    | 'prepare'
    | 'authorization_wait'
    | 'callback_validation'
    | 'gateway_callback_error'
    | 'token_exchange'
    | 'session_validation'
    | 'complete';
  outcome: 'started' | 'succeeded' | 'failed';
  reason?: string;
  errorCode?: string;
  statusCode?: number;
  upstreamCode?: string;
  requestId?: string;
}): void {
  console.warn(JSON.stringify({
    type: 'enterprise_dingtalk_auth',
    ...event
  }));
}

function sessionErrorCode(error: unknown): string {
  if (
    error instanceof EnterpriseSessionError
    || error instanceof EnterpriseHttpError
  ) {
    return error.code;
  }
  return 'ENTERPRISE_PROTOCOL_ERROR';
}

function randomBase64Url32(): string {
  return randomBytes(32).toString('base64url');
}

function base64UrlSha256(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('base64url');
}

function isBase64Url32(value: string | undefined): value is string {
  if (value === undefined || !BASE64_URL_32_PATTERN.test(value)) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.byteLength === 32 && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}

function constantTimeBase64UrlEqual(
  candidate: string | undefined,
  expected: string
): boolean {
  if (!isBase64Url32(candidate) || !isBase64Url32(expected)) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

const stableDingTalkErrors = new Set<EnterpriseDingTalkProviderError>([
  'oauth_provider_denied',
  'oauth_state_invalid',
  'dingtalk_upstream_unavailable',
  'not_enterprise_member',
  'dingtalk_email_missing',
  'account_binding_required',
  'auto_provision_disabled',
  'system_not_initialized',
  'account_disabled',
  'identity_conflict',
  'account_profile_conflict',
  'agent_id_conflict',
  'agent_forbidden',
  'agent_provisioning_unavailable',
  'dingtalk_disabled',
  'internal_error'
]);

function isStableDingTalkError(
  value: string | undefined
): value is EnterpriseDingTalkProviderError {
  return value !== undefined && stableDingTalkErrors.has(
    value as EnterpriseDingTalkProviderError
  );
}

function dingTalkReasonFromGatewayCode(
  code: string
): EnterpriseDingTalkAuthenticationFailureReason {
  if (code === 'oauth_provider_denied') return 'dingtalk_denied';
  if (code === 'oauth_state_invalid' || code === 'invalid_grant') {
    return 'dingtalk_expired';
  }
  if (
    code === 'not_enterprise_member'
    || code === 'dingtalk_email_missing'
    || code === 'account_binding_required'
    || code === 'auto_provision_disabled'
    || code === 'system_not_initialized'
    || code === 'account_disabled'
    || code === 'identity_conflict'
    || code === 'account_profile_conflict'
    || code === 'agent_id_conflict'
    || code === 'agent_forbidden'
    || code === 'agent_provisioning_unavailable'
  ) {
    return 'dingtalk_account_unavailable';
  }
  return 'service_unavailable';
}

function dingTalkReasonFromHttpError(
  error: unknown
): EnterpriseDingTalkAuthenticationFailureReason {
  if (!(error instanceof EnterpriseHttpError)) return 'service_unavailable';
  if (error.upstreamCode !== undefined) {
    return dingTalkReasonFromGatewayCode(error.upstreamCode);
  }
  if (
    error.code === 'ENTERPRISE_AGENT_FORBIDDEN'
    || error.code === 'ENTERPRISE_AGENT_ID_CONFLICT'
    || error.code === 'ENTERPRISE_ACCOUNT_INACTIVE'
    || error.code === 'ENTERPRISE_FRONTEND_FORBIDDEN'
    || error.code === 'ENTERPRISE_FORBIDDEN'
  ) {
    return 'dingtalk_account_unavailable';
  }
  if (error.code === 'ENTERPRISE_INVALID_REQUEST') return 'dingtalk_expired';
  return 'service_unavailable';
}

function dingTalkReasonFromSessionError(
  error: unknown
): EnterpriseDingTalkAuthenticationFailureReason {
  if (!(error instanceof EnterpriseSessionError)) return 'service_unavailable';
  if (error.code === 'ENTERPRISE_SECURE_STORAGE_UNAVAILABLE') {
    return 'secure_storage_unavailable';
  }
  if (error.code === 'ENTERPRISE_SERVICE_UNAVAILABLE') {
    return 'service_unavailable';
  }
  if (
    error.code === 'ENTERPRISE_ACCOUNT_INACTIVE'
    || error.code === 'ENTERPRISE_FRONTEND_FORBIDDEN'
    || error.code === 'ENTERPRISE_AGENT_FORBIDDEN'
    || error.code === 'ENTERPRISE_AGENT_ID_CONFLICT'
    || error.code === 'ENTERPRISE_FORBIDDEN'
  ) {
    return 'dingtalk_account_unavailable';
  }
  if (
    error.code === 'ENTERPRISE_UNAUTHORIZED'
    || error.code === 'ENTERPRISE_SESSION_EXPIRED'
    || error.code === 'ENTERPRISE_INVALID_REQUEST'
  ) {
    return 'dingtalk_expired';
  }
  return 'service_unavailable';
}
