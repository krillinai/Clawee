import type {
  EnterpriseDingTalkLoginPrepareResponse,
  EnterpriseLoginRequest,
  EnterpriseRegisterRequest,
  EnterpriseSessionReason,
  EnterpriseSessionResponse
} from '@clawee/protocol';
import {
  LoaderCircle,
  LogOut,
  RefreshCw,
  Save,
  ShieldCheck,
  WifiOff
} from 'lucide-react';
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import { ConfirmDialog } from '../../components/dialogs/ConfirmDialog.js';
import { ApiClientError } from '../../runtime/errors.js';

type AccountMode = 'login' | 'register';
type AccountOperation = AccountMode | 'refresh' | 'logout';

const enterpriseEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EnterpriseAccountPageProps = {
  connected: boolean;
  sessionInitialized?: boolean;
  required?: boolean;
  session: EnterpriseSessionResponse;
  checkingTimedOut?: boolean;
  onLogin(input: EnterpriseLoginRequest): Promise<EnterpriseSessionResponse>;
  onRegister(input: EnterpriseRegisterRequest): Promise<EnterpriseSessionResponse>;
  onPrepareDingTalkLogin?(): Promise<EnterpriseDingTalkLoginPrepareResponse>;
  onOpenDingTalkLogin?(authorizationUrl: string): Promise<void>;
  onCheckSession?(): Promise<EnterpriseSessionResponse>;
  onLogout(): Promise<EnterpriseSessionResponse>;
  onRefresh(): Promise<EnterpriseSessionResponse>;
  onReadGateway?(): Promise<{ gateway: string; configurable: boolean }>;
  onSaveGateway?(gateway: string): Promise<void>;
};

export function EnterpriseAccountPage(props: EnterpriseAccountPageProps) {
  const [accountMode, setAccountMode] = useState<AccountMode>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [agreementDialogOpen, setAgreementDialogOpen] = useState(false);
  const [operation, setOperation] = useState<AccountOperation>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [gateway, setGateway] = useState('');
  const [gatewayConfigurable, setGatewayConfigurable] = useState(false);
  const [savingGateway, setSavingGateway] = useState(false);
  const readGatewayRef = useRef(props.onReadGateway);
  readGatewayRef.current = props.onReadGateway;
  useEffect(() => {
    if (!props.connected) return;
    let canceled = false;
    void readGatewayRef.current?.().then(value => {
      if (!canceled) { setGateway(value.gateway); setGatewayConfigurable(value.configurable); }
    }).catch(() => { if (!canceled) setGatewayConfigurable(false); });
    return () => { canceled = true; };
  }, [props.connected]);
  const [dingTalkAuthorization, setDingTalkAuthorization] =
    useState<EnterpriseDingTalkLoginPrepareResponse>();
  const [dingTalkPreparing, setDingTalkPreparing] = useState(false);
  const [dingTalkWaiting, setDingTalkWaiting] = useState(false);
  const [dingTalkError, setDingTalkError] = useState<string>();
  const accountFormRef = useRef<HTMLFormElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const confirmationRef = useRef<HTMLInputElement | null>(null);
  const prepareDingTalkLoginRef = useRef(props.onPrepareDingTalkLogin);
  const checkSessionRef = useRef(props.onCheckSession);
  const agreementActionRef = useRef<'account' | 'dingtalk'>('account');
  const normalizedEmail = email.trim();
  const accountFieldsValid = !savingGateway && enterpriseEmailPattern.test(normalizedEmail)
    && password.length >= 8
    && (
      accountMode === 'login'
      || (
        passwordConfirmation.length >= 8
        && passwordConfirmation === password
      )
    );

  prepareDingTalkLoginRef.current = props.onPrepareDingTalkLogin;
  checkSessionRef.current = props.onCheckSession;

  function clearSecretValues() {
    if (passwordRef.current !== null) passwordRef.current.value = '';
    if (confirmationRef.current !== null) confirmationRef.current.value = '';
    setPassword('');
    setPasswordConfirmation('');
  }

  useLayoutEffect(() => {
    return () => {
      if (passwordRef.current !== null) passwordRef.current.value = '';
      if (confirmationRef.current !== null) confirmationRef.current.value = '';
    };
  }, [accountMode, props.session.status]);

  useEffect(() => {
    if (props.session.status === 'signed_in') clearSecretValues();
  }, [props.session.status]);

  useEffect(() => {
    if (!dingTalkWaiting || dingTalkAuthorization === undefined) return;
    let canceled = false;
    const timer = window.setTimeout(() => {
      const checkSession = checkSessionRef.current;
      if (checkSession === undefined) return;
      void checkSession()
        .then(response => {
          if (canceled) return;
          if (response.status === 'signed_in') {
            setDingTalkWaiting(false);
            setNotice('登录成功，正在进入 Clawee。');
            return;
          }
          if (
            response.status === 'signed_out'
            && isDingTalkTerminalReason(response.reason)
          ) {
            setDingTalkWaiting(false);
            setDingTalkError(formatDingTalkSessionReason(response.reason));
            return;
          }
          if (Date.parse(dingTalkAuthorization.expiresAt) <= Date.now()) {
            setDingTalkWaiting(false);
            setDingTalkError('登录请求已失效，请重新发起。');
          }
        })
        .catch(reason => {
          if (!canceled) {
            setDingTalkWaiting(false);
            setDingTalkError(formatAccountError(reason));
          }
        });
    }, 1_000);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [dingTalkAuthorization, dingTalkWaiting, props.session]);

  function switchAccountMode(nextMode: AccountMode) {
    if (nextMode === accountMode || dingTalkWaiting) return;
    clearSecretValues();
    setAccountMode(nextMode);
    setError(undefined);
    setNotice(undefined);
  }

  async function runAccountOperation() {
    if (savingGateway || operation !== undefined || dingTalkWaiting || !props.connected) return;
    if (!accountFieldsValid) {
      setError('请输入有效邮箱和至少 8 位密码。');
      return;
    }
    if (accountMode === 'register' && password !== passwordConfirmation) {
      setError('两次输入的密码不一致。');
      return;
    }

    setError(undefined);
    setNotice(undefined);
    setOperation(accountMode);
    try {
      const response = accountMode === 'login'
        ? await props.onLogin({ email: normalizedEmail, password })
        : await props.onRegister({
            email: normalizedEmail,
            ...(name.trim().length === 0 ? {} : { name: name.trim() }),
            password
          });
      clearSecretValues();
      if (response.status === 'signed_in') {
        setNotice('登录成功，正在进入 Clawee。');
      }
    } catch (reason) {
      clearSecretValues();
      if (
        reason instanceof ApiClientError
        && reason.code === 'ENTERPRISE_REGISTERED_LOGIN_REQUIRED'
      ) {
        const registeredEmail = reason.details?.email;
        if (typeof registeredEmail === 'string' && registeredEmail.length > 0) {
          setEmail(registeredEmail);
        }
        setAccountMode('login');
        setNotice('账户已创建，请使用该邮箱登录。');
        window.setTimeout(() => passwordRef.current?.focus(), 0);
      } else {
        setError(formatAccountError(reason));
        if (
          reason instanceof ApiClientError
          && (reason.code === 'ENTERPRISE_UNAUTHORIZED' || reason.status === 401)
        ) {
          window.setTimeout(() => passwordRef.current?.focus(), 0);
        }
      }
    } finally {
      setOperation(undefined);
    }
  }

  function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingGateway || operation !== undefined || dingTalkWaiting || !props.connected) return;
    if (!acceptedTerms) {
      setError(undefined);
      agreementActionRef.current = 'account';
      setAgreementDialogOpen(true);
      return;
    }
    if (!event.currentTarget.reportValidity()) return;
    void runAccountOperation();
  }

  function acceptAgreementAndContinue() {
    setAcceptedTerms(true);
    setAgreementDialogOpen(false);
    if (agreementActionRef.current === 'dingtalk') {
      agreementActionRef.current = 'account';
      void openDingTalkLogin();
      return;
    }
    if (accountFormRef.current === null || !accountFormRef.current.reportValidity()) {
      return;
    }
    void runAccountOperation();
  }

  function requestDingTalkLogin() {
    if (
      savingGateway || dingTalkPreparing
      || dingTalkWaiting
      || !props.connected
      || props.sessionInitialized === false
      || props.session.status !== 'signed_out'
    ) {
      return;
    }
    if (!acceptedTerms) {
      agreementActionRef.current = 'dingtalk';
      setAgreementDialogOpen(true);
      return;
    }
    void openDingTalkLogin();
  }

  async function openDingTalkLogin() {
    const prepare = prepareDingTalkLoginRef.current;
    const open = props.onOpenDingTalkLogin;
    if (
      prepare === undefined
      || open === undefined
      || savingGateway
      || dingTalkPreparing
      || dingTalkWaiting
      || !props.connected
      || props.sessionInitialized === false
      || props.session.status !== 'signed_out'
    ) {
      return;
    }
    setError(undefined);
    setNotice(undefined);
    setDingTalkError(undefined);
    setDingTalkAuthorization(undefined);
    setDingTalkPreparing(true);
    let authorizationPrepared = false;
    try {
      const authorization = await prepare();
      authorizationPrepared = true;
      setDingTalkAuthorization(authorization);
      await open(authorization.authorizationUrl);
      setDingTalkWaiting(true);
    } catch (reason) {
      setDingTalkWaiting(false);
      setDingTalkAuthorization(undefined);
      setDingTalkError(
        authorizationPrepared
          ? '无法打开系统浏览器，请稍后重试。'
          : formatDingTalkPrepareError(reason)
      );
    } finally {
      setDingTalkPreparing(false);
    }
  }

  async function runSessionOperation(kind: 'refresh' | 'logout') {
    if (operation !== undefined || !props.connected) return;
    setError(undefined);
    setNotice(undefined);
    setOperation(kind);
    try {
      await (kind === 'refresh' ? props.onRefresh() : props.onLogout());
    } catch (reason) {
      setError(formatAccountError(reason));
    } finally {
      setOperation(undefined);
    }
  }

  return (
    <section className="enterprise-account-page" aria-label="企业账户">
      {props.session.status === 'checking' ? (
        <SessionPanel
          icon={<LoaderCircle className="enterprise-account-spinner" size={24} />}
          title="正在验证企业会话"
          description="Clawee 正在从本地私有凭据文件恢复登录状态。"
          action={props.checkingTimedOut ? (
            <button
              className="enterprise-account-secondary-action"
              type="button"
              disabled={operation !== undefined || !props.connected}
              onClick={() => void runSessionOperation('refresh')}
            >
              <RefreshCw size={16} aria-hidden="true" />
              <span>重新检测</span>
            </button>
          ) : undefined}
        />
      ) : props.session.status === 'service_unavailable' ? (
        <SessionPanel
          icon={<WifiOff size={24} />}
          title="企业服务暂时不可用"
          description={props.required
            ? '服务恢复后请重新检测，完成登录后才能继续使用 Clawee。'
            : '服务恢复后可重新检测，不影响本地工作。'}
          action={(
            <button
              className="enterprise-account-secondary-action"
              type="button"
              disabled={operation !== undefined || !props.connected}
              onClick={() => void runSessionOperation('refresh')}
            >
              {operation === 'refresh' ? (
                <LoaderCircle className="enterprise-account-spinner" size={16} />
              ) : (
                <RefreshCw size={16} aria-hidden="true" />
              )}
              <span>重试连接</span>
            </button>
          )}
        />
      ) : props.session.status === 'signed_in' && props.session.account !== undefined ? (
        <div className="enterprise-account-panel enterprise-account-profile">
          <div className="enterprise-account-profile-icon" aria-hidden="true">
            <ShieldCheck size={24} />
          </div>
          <div className="enterprise-account-profile-copy">
            <span>已连接企业账户</span>
            <h2>{props.session.account.name}</h2>
            <p>{props.session.account.email}</p>
            {props.session.expiresAt !== undefined ? (
              <small>会话有效期至 {formatExpiry(props.session.expiresAt)}</small>
            ) : null}
          </div>
          <div className="enterprise-account-actions">
            <button
              className="enterprise-account-secondary-action"
              type="button"
              disabled={operation !== undefined || !props.connected}
              onClick={() => void runSessionOperation('logout')}
            >
              {operation === 'logout' ? (
                <LoaderCircle className="enterprise-account-spinner" size={16} />
              ) : (
                <LogOut size={16} aria-hidden="true" />
              )}
              <span>退出登录</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="enterprise-auth-card">
          <header className="enterprise-auth-header">
            <img
              className="enterprise-auth-logo enterprise-auth-logo-dark"
              src="/logo-v2-white-logo.svg"
              alt=""
              aria-hidden="true"
            />
            <img
              className="enterprise-auth-logo enterprise-auth-logo-light"
              src="/logo-v2-black-logo.svg"
              alt=""
              aria-hidden="true"
            />
            <div>
              <h1>欢迎使用 Clawee</h1>
              <p>登录后即可进入企业智能工作台</p>
            </div>
          </header>

          {!props.connected ? (
            <div className="enterprise-account-status" role="status">
              <WifiOff size={18} aria-hidden="true" />
              <div>
                <strong>正在等待本地 Runtime</strong>
                <span>连接恢复后即可继续登录。</span>
              </div>
            </div>
          ) : null}

          {error !== undefined ? (
            <p className="enterprise-account-error" role="alert">{error}</p>
          ) : null}
          {notice !== undefined ? (
            <p className="enterprise-account-notice" role="status">{notice}</p>
          ) : null}

          <div className="enterprise-auth-content">
            <div className="enterprise-email-auth">
              {gatewayConfigurable && props.onSaveGateway ? (
                <form className="enterprise-email-form" onSubmit={event => {
                  event.preventDefault();
                  setSavingGateway(true);
                  setError(undefined);
                  clearSecretValues();
                  void props.onSaveGateway!(gateway).then(() => setNotice('服务端地址已保存'))
                    .catch(reason => setError(reason instanceof Error ? reason.message : '服务端地址保存失败'))
                    .finally(() => setSavingGateway(false));
                }}>
                  <label htmlFor="clawee-gateway">服务端地址</label>
                  <input id="clawee-gateway" type="url" value={gateway} required
                    disabled={savingGateway || operation !== undefined || dingTalkWaiting}
                    onChange={event => setGateway(event.target.value)} />
                  <button type="submit" className="enterprise-account-secondary-action"
                    disabled={savingGateway || operation !== undefined || dingTalkWaiting}>
                    <Save size={16} aria-hidden="true" /><span>{savingGateway ? '保存中' : '保存地址'}</span>
                  </button>
                </form>
              ) : null}
              <div className="enterprise-email-mode" role="group" aria-label="账户操作">
                  <button
                    type="button"
                    aria-pressed={accountMode === 'login'}
                    disabled={savingGateway || operation !== undefined || dingTalkWaiting}
                    onClick={() => switchAccountMode('login')}
                  >
                    登录
                  </button>
                  <button
                    type="button"
                    aria-pressed={accountMode === 'register'}
                    disabled={savingGateway || operation !== undefined || dingTalkWaiting}
                    onClick={() => switchAccountMode('register')}
                  >
                    注册
                  </button>
                </div>
                <form
                  ref={accountFormRef}
                  className="enterprise-email-form"
                  noValidate
                  onSubmit={submitAccount}
                >
                  {accountMode === 'register' ? (
                    <label className="enterprise-email-field">
                      <span className="app-visually-hidden">名称</span>
                      <input
                        aria-label="名称"
                        type="text"
                        autoComplete="name"
                        placeholder="名称（选填）"
                        disabled={savingGateway || operation !== undefined || dingTalkWaiting}
                        value={name}
                        onChange={event => setName(event.target.value)}
                      />
                    </label>
                  ) : null}
                  <label className="enterprise-email-field">
                    <span className="app-visually-hidden">邮箱</span>
                    <input
                      aria-label="邮箱"
                      type="email"
                      autoComplete="email"
                      placeholder="请输入邮箱"
                      required
                      disabled={savingGateway || operation !== undefined || dingTalkWaiting}
                      value={email}
                      onChange={event => setEmail(event.target.value)}
                    />
                  </label>
                  <label className="enterprise-email-field">
                    <span className="app-visually-hidden">密码</span>
                    <input
                      ref={element => {
                        if (element !== null) passwordRef.current = element;
                      }}
                      aria-label="密码"
                      type="password"
                      autoComplete={accountMode === 'login' ? 'current-password' : 'new-password'}
                      minLength={8}
                      placeholder="请输入密码（至少 8 位）"
                      required
                      disabled={savingGateway || operation !== undefined || dingTalkWaiting}
                      value={password}
                      onChange={event => setPassword(event.target.value)}
                    />
                  </label>
                  {accountMode === 'register' ? (
                    <label className="enterprise-email-field">
                      <span className="app-visually-hidden">确认密码</span>
                      <input
                        ref={element => {
                          if (element !== null) confirmationRef.current = element;
                        }}
                        aria-label="确认密码"
                        type="password"
                        autoComplete="new-password"
                        minLength={8}
                        placeholder="请再次输入密码"
                        required
                        disabled={savingGateway || operation !== undefined || dingTalkWaiting}
                        value={passwordConfirmation}
                        onChange={event => setPasswordConfirmation(event.target.value)}
                      />
                    </label>
                  ) : null}
                  <button
                    className="enterprise-account-primary-action enterprise-email-submit"
                    type="submit"
                    disabled={
                      operation !== undefined
                      || dingTalkWaiting
                      || !props.connected
                      || !accountFieldsValid
                    }
                  >
                    {operation === accountMode ? (
                      <LoaderCircle className="enterprise-account-spinner" size={17} />
                    ) : null}
                    <span>{accountMode === 'login' ? '登录' : '注册'}</span>
                  </button>
                  {accountMode === 'login' ? (
                    <div className="enterprise-dingtalk-login">
                      <div className="enterprise-auth-divider"><span>或</span></div>
                      <button
                        className="enterprise-dingtalk-action"
                        type="button"
                        disabled={
                          savingGateway || operation !== undefined
                          || dingTalkPreparing
                          || dingTalkWaiting
                          || !props.connected
                          || props.sessionInitialized === false
                          || props.session.status !== 'signed_out'
                          || props.onPrepareDingTalkLogin === undefined
                          || props.onOpenDingTalkLogin === undefined
                        }
                        onClick={requestDingTalkLogin}
                      >
                        {dingTalkPreparing || dingTalkWaiting ? (
                          <LoaderCircle
                            className="enterprise-account-spinner"
                            size={18}
                            aria-hidden="true"
                          />
                        ) : (
                          <img src="/auth/dingtalk.svg" alt="" aria-hidden="true" />
                        )}
                        <span>{dingTalkWaiting ? '等待钉钉授权' : '钉钉登录'}</span>
                      </button>
                      {dingTalkError !== undefined ? (
                        <p className="enterprise-dingtalk-status" role="status">
                          {dingTalkError}
                        </p>
                      ) : dingTalkWaiting ? (
                        <p className="enterprise-dingtalk-status" role="status">
                          请在系统浏览器中完成授权
                        </p>
                      ) : null}
                    </div>
                  ) : null}
              </form>
            </div>
          </div>

          <label className="enterprise-auth-agreement">
            <input
              type="checkbox"
              checked={acceptedTerms}
              disabled={dingTalkWaiting}
              onChange={event => {
                setAcceptedTerms(event.target.checked);
                if (event.target.checked) setAgreementDialogOpen(false);
                setError(undefined);
              }}
            />
            <span>我已阅读并同意《服务协议》和《隐私政策》</span>
          </label>
          <ConfirmDialog
            open={agreementDialogOpen}
            title="服务协议及隐私政策"
            description="我已阅读并同意《服务协议》和《隐私政策》"
            confirmLabel="同意并继续"
            className="enterprise-agreement-dialog"
            onCancel={() => {
              agreementActionRef.current = 'account';
              setAgreementDialogOpen(false);
            }}
            onConfirm={acceptAgreementAndContinue}
          />
        </div>
      )}
    </section>
  );
}

function SessionPanel(props: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="enterprise-account-panel enterprise-account-session-panel">
      <span aria-hidden="true">{props.icon}</span>
      <div>
        <h2>{props.title}</h2>
        <p>{props.description}</p>
      </div>
      {props.action}
    </div>
  );
}

function isDingTalkTerminalReason(
  reason: EnterpriseSessionReason | undefined
): reason is EnterpriseSessionReason {
  return reason === 'dingtalk_denied'
    || reason === 'dingtalk_expired'
    || reason === 'dingtalk_account_unavailable'
    || reason === 'secure_storage_unavailable'
    || reason === 'service_unavailable';
}

function formatDingTalkSessionReason(reason: EnterpriseSessionReason): string {
  switch (reason) {
    case 'dingtalk_denied':
      return '已取消钉钉授权。';
    case 'dingtalk_expired':
      return '登录请求已失效，请重新发起。';
    case 'dingtalk_account_unavailable':
      return '企业账户暂不可用，请前往企业管理页处理或联系管理员。';
    case 'secure_storage_unavailable':
      return '本地私有凭据文件不可用，无法保存登录状态。';
    default:
      return '企业服务暂时不可用，请稍后重试。';
  }
}

function formatDingTalkPrepareError(error: unknown): string {
  if (
    error instanceof ApiClientError
    && error.details?.reason === 'dingtalk_disabled'
  ) {
    return '钉钉登录暂未启用。';
  }
  return formatAccountError(error);
}

function formatAccountError(error: unknown): string {
  if (!(error instanceof ApiClientError)) return '企业账户操作失败，请稍后重试。';
  if (error.status === 404) return '企业登录服务暂未启用，请稍后重试。';
  switch (error.code) {
    case 'ENTERPRISE_UNAUTHORIZED':
      return '邮箱或密码不正确，请重新输入。';
    case 'ENTERPRISE_ACCOUNT_INACTIVE':
      return '该企业账户当前不可用。';
    case 'ENTERPRISE_FRONTEND_FORBIDDEN':
      return '该账户没有 Clawee 企业前端访问权限。';
    case 'ENTERPRISE_AGENT_FORBIDDEN':
      return '当前 Clawee Agent 状态不可用。';
    case 'ENTERPRISE_AGENT_ID_CONFLICT':
      return '当前 Clawee Agent 已绑定到其他企业账户。';
    case 'ENTERPRISE_SECURE_STORAGE_UNAVAILABLE':
      return '本地私有凭据文件不可用，无法保存企业会话。';
    case 'ENTERPRISE_RATE_LIMITED':
      return '操作过于频繁，请稍后重试。';
    case 'ENTERPRISE_SERVICE_UNAVAILABLE':
      return '企业登录服务暂时不可用，请稍后重试。';
    case 'VALIDATION_FAILED':
    case 'ENTERPRISE_INVALID_REQUEST':
      return '请检查邮箱、名称和密码后重试。';
    default:
      return error.message || '企业账户操作失败，请稍后重试。';
  }
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

export default EnterpriseAccountPage;
