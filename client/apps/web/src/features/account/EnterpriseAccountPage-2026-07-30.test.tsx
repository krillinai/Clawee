import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { EnterpriseSessionResponse } from '@clawee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { EnterpriseAccountPage } from './EnterpriseAccountPage-2026-07-30.js';

const signedOutSession: EnterpriseSessionResponse = {
  status: 'signed_out',
  transportSecurity: 'secure_https'
};

describe('EnterpriseAccountPage', () => {
  it('saves the shared gateway and blocks login while the address is changing', async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const onSaveGateway = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    renderAccount({ onReadGateway: async () => ({ gateway: 'https://old.example', configurable: true }), onSaveGateway });
    const address = await screen.findByLabelText('服务端地址');
    await user.clear(address);
    await user.type(address, 'https://new.example');
    await user.type(screen.getByLabelText('邮箱'), 'member@example.com');
    await user.type(screen.getByLabelText('密码'), 'password123');
    await user.click(screen.getByRole('button', { name: '保存地址' }));
    expect(onSaveGateway).toHaveBeenCalledWith('https://new.example');
    expect(address).toBeDisabled();
    expect(screen.getByLabelText('密码')).toHaveValue('');
    expect(document.querySelector('.enterprise-email-submit')).toBeDisabled();
    finish();
    await screen.findByText('服务端地址已保存');
    expect(address).toBeEnabled();
  });

  it('supports the existing email login and registration flows', async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn(async () => signedOutSession);
    const onRegister = vi.fn(async () => signedOutSession);
    renderAccount({ onLogin, onRegister });

    expect(screen.getByRole('heading', { name: '欢迎使用 Clawee' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '账户操作' })).toBeInTheDocument();
    expect(screen.queryByText('扫码登录')).not.toBeInTheDocument();
    expect(screen.queryByText(/SSO/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('手机号')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('验证码')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('邮箱'), 'member@example.com');
    await user.type(screen.getByLabelText('密码'), 'password123');
    await user.click(screen.getByRole('checkbox'));
    await user.click(document.querySelector<HTMLButtonElement>('.enterprise-email-submit')!);
    expect(onLogin).toHaveBeenCalledWith({
      email: 'member@example.com',
      password: 'password123'
    });

    await user.click(screen.getByRole('button', { name: '注册', pressed: false }));
    await user.type(screen.getByLabelText('名称'), 'Enterprise Member');
    await user.type(screen.getByLabelText('密码'), 'register123');
    await user.type(screen.getByLabelText('确认密码'), 'register123');
    await user.click(document.querySelector<HTMLButtonElement>('.enterprise-email-submit')!);
    expect(onRegister).toHaveBeenCalledWith({
      email: 'member@example.com',
      name: 'Enterprise Member',
      password: 'register123'
    });
  });

  it('asks for agreement when login is submitted and continues after confirmation', async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn(async () => signedOutSession);
    renderAccount({ onLogin });
    const submit = document.querySelector<HTMLButtonElement>('.enterprise-email-submit')!;

    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('邮箱'), 'member@example.com');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('密码'), 'pass123');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('密码'), '4');
    expect(submit).toBeEnabled();

    await user.click(submit);

    const dialog = screen.getByRole('alertdialog', { name: '服务协议及隐私政策' });
    expect(dialog).toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();

    await user.click(submit);
    await user.click(screen.getByRole('button', { name: '同意并继续' }));

    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(onLogin).toHaveBeenCalledWith({
      email: 'member@example.com',
      password: 'pass1234'
    });
  });

  it('enables registration only after both passwords are valid and match', async () => {
    const user = userEvent.setup();
    renderAccount();

    await user.click(screen.getByRole('button', { name: '注册', pressed: false }));
    const submit = document.querySelector<HTMLButtonElement>('.enterprise-email-submit')!;
    await user.type(screen.getByLabelText('邮箱'), 'member@example.com');
    await user.type(screen.getByLabelText('密码'), 'register123');
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('确认密码'), 'register12');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('确认密码'), '3');
    expect(submit).toBeEnabled();
  });

  it('does not expose the unfinished QR login entry', () => {
    renderAccount({ connected: false });

    expect(screen.queryByRole('tablist', { name: '登录方式' })).not.toBeInTheDocument();
    expect(screen.queryByText('扫码登录')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '扫码平台' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '飞书' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '企业微信' })).not.toBeInTheDocument();
  });

  it('prepares DingTalk login on click before opening the system browser', async () => {
    const user = userEvent.setup();
    const onPrepareDingTalkLogin = vi.fn(async () => ({
      authorizationUrl: 'https://enterprise.example/dingtalk/start?state=prepared',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    const onOpenDingTalkLogin = vi.fn(async () => undefined);
    renderAccount({ onPrepareDingTalkLogin, onOpenDingTalkLogin });

    const button = await screen.findByRole('button', { name: '钉钉登录' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(onPrepareDingTalkLogin).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(button);

    await waitFor(() => {
      expect(onPrepareDingTalkLogin).toHaveBeenCalledOnce();
      expect(onOpenDingTalkLogin).toHaveBeenCalledWith(
        'https://enterprise.example/dingtalk/start?state=prepared'
      );
    });
    expect(screen.getByRole('button', { name: '等待钉钉授权' })).toBeDisabled();
    expect(screen.queryByText('扫码登录')).not.toBeInTheDocument();
    expect(screen.getByLabelText('邮箱')).toBeDisabled();
    expect(screen.getByText('请在系统浏览器中完成授权')).toBeInTheDocument();

    expect(JSON.stringify(onPrepareDingTalkLogin.mock.calls)).not.toContain('verifier');
  });

  it.each([
    ['dingtalk_denied', '已取消钉钉授权。'],
    ['dingtalk_expired', '登录请求已失效，请重新发起。'],
    [
      'dingtalk_account_unavailable',
      '企业账户暂不可用，请前往企业管理页处理或联系管理员。'
    ],
    ['service_unavailable', '企业服务暂时不可用，请稍后重试。']
  ] as const)('keeps the %s result visible until the next DingTalk login', async (
    reason,
    message
  ) => {
    const user = userEvent.setup();
    const onPrepareDingTalkLogin = vi.fn(async () => ({
      authorizationUrl: 'https://enterprise.example/dingtalk/start',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    const onCheckSession = vi.fn(async (): Promise<EnterpriseSessionResponse> => ({
      status: 'signed_out',
      reason,
      transportSecurity: 'secure_https'
    }));
    renderAccount({ onPrepareDingTalkLogin, onCheckSession });

    const button = await screen.findByRole('button', { name: '钉钉登录' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(screen.getByRole('checkbox'));
    await user.click(button);

    await waitFor(() => expect(onCheckSession).toHaveBeenCalledOnce(), {
      timeout: 2_000
    });
    expect(onPrepareDingTalkLogin).toHaveBeenCalledOnce();
    expect(screen.getByText(message)).toBeInTheDocument();

    await user.click(button);
    await waitFor(() => expect(onPrepareDingTalkLogin).toHaveBeenCalledTimes(2));
  });

  it('shows a fixed Chinese message when the system browser cannot be opened', async () => {
    const user = userEvent.setup();
    const onPrepareDingTalkLogin = vi.fn(async () => ({
      authorizationUrl: 'http://enterprise.example/dingtalk/start',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    const onOpenDingTalkLogin = vi.fn(async () => {
      throw new Error('Only HTTPS links are allowed');
    });
    renderAccount({ onPrepareDingTalkLogin, onOpenDingTalkLogin });

    const button = await screen.findByRole('button', { name: '钉钉登录' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(screen.getByRole('checkbox'));
    await user.click(button);

    expect(await screen.findByText('无法打开系统浏览器，请稍后重试。'))
      .toBeInTheDocument();
    expect(screen.queryByText('Only HTTPS links are allowed')).not.toBeInTheDocument();
    expect(onPrepareDingTalkLogin).toHaveBeenCalledOnce();

    await user.click(button);
    await waitFor(() => expect(onPrepareDingTalkLogin).toHaveBeenCalledTimes(2));
  });

  it('keeps DingTalk login disabled until the initial Runtime session probe settles', async () => {
    const user = userEvent.setup();
    const onPrepareDingTalkLogin = vi.fn(async () => ({
      authorizationUrl: 'https://enterprise.example/dingtalk/start',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    const view = renderAccount({
      sessionInitialized: false,
      onPrepareDingTalkLogin
    });

    const button = screen.getByRole('button', { name: '钉钉登录' });
    expect(button).toBeDisabled();
    expect(onPrepareDingTalkLogin).not.toHaveBeenCalled();

    view.rerender(createAccount({
      sessionInitialized: true,
      onPrepareDingTalkLogin
    }));
    await waitFor(() => expect(button).toBeEnabled());
    expect(onPrepareDingTalkLogin).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox'));
    await user.click(button);
    await waitFor(() => expect(onPrepareDingTalkLogin).toHaveBeenCalledOnce());
  });

  it('shows DingTalk login only in login mode', async () => {
    const user = userEvent.setup();
    renderAccount();
    expect(await screen.findByRole('button', { name: '钉钉登录' }))
      .toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '注册', pressed: false }));
    expect(screen.queryByRole('button', { name: '钉钉登录' })).not.toBeInTheDocument();
  });

  it('keeps login unavailable until the runtime is connected', async () => {
    renderAccount({ connected: false });

    expect(screen.getByText('正在等待本地 Runtime')).toBeInTheDocument();
    expect(screen.getByText('连接恢复后即可继续登录。')).toBeInTheDocument();
    expect(document.querySelector<HTMLButtonElement>('.enterprise-email-submit')).toBeDisabled();
  });

  it('renders checking, service unavailable, and signed-in session states', () => {
    const view = renderAccount({
      session: {
        status: 'checking',
        transportSecurity: 'secure_https'
      },
      checkingTimedOut: true
    });

    expect(screen.getByText('正在验证企业会话')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新检测' })).toBeInTheDocument();

    view.rerender(createAccount({
      session: {
        status: 'service_unavailable',
        reason: 'service_unavailable',
        transportSecurity: 'secure_https'
      }
    }));
    expect(screen.getByText('企业服务暂时不可用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试连接' })).toBeInTheDocument();

    view.rerender(createAccount({
      session: {
        status: 'signed_in',
        account: {
          subjectId: 'acct-member',
          email: 'member@example.com',
          name: 'Member'
        },
        expiresAt: '2026-08-30T12:00:00.000Z',
        transportSecurity: 'secure_https'
      }
    }));
    expect(screen.getByText('Member')).toBeInTheDocument();
    expect(screen.queryByText(/采集器/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试安装' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument();
  });
});

function renderAccount(
  overrides: Partial<Parameters<typeof createAccount>[0]> = {}
) {
  return render(createAccount(overrides));
}

function createAccount(
  overrides: {
    connected?: boolean;
    sessionInitialized?: boolean;
    session?: EnterpriseSessionResponse;
    checkingTimedOut?: boolean;
    onLogin?: EnterpriseAccountPageProps['onLogin'];
    onRegister?: EnterpriseAccountPageProps['onRegister'];
    onPrepareDingTalkLogin?: EnterpriseAccountPageProps['onPrepareDingTalkLogin'];
    onOpenDingTalkLogin?: EnterpriseAccountPageProps['onOpenDingTalkLogin'];
    onCheckSession?: EnterpriseAccountPageProps['onCheckSession'];
    onReadGateway?: EnterpriseAccountPageProps['onReadGateway'];
    onSaveGateway?: EnterpriseAccountPageProps['onSaveGateway'];
  } = {}
) {
  return (
    <EnterpriseAccountPage
      connected={overrides.connected ?? true}
      sessionInitialized={overrides.sessionInitialized}
      session={overrides.session ?? signedOutSession}
      checkingTimedOut={overrides.checkingTimedOut}
      onLogin={overrides.onLogin ?? (async () => signedOutSession)}
      onRegister={overrides.onRegister ?? (async () => signedOutSession)}
      onPrepareDingTalkLogin={overrides.onPrepareDingTalkLogin ?? (async () => ({
        authorizationUrl: 'https://enterprise.example/dingtalk/start',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }))}
      onOpenDingTalkLogin={overrides.onOpenDingTalkLogin ?? (async () => undefined)}
      onCheckSession={overrides.onCheckSession ?? (async () => signedOutSession)}
      onReadGateway={overrides.onReadGateway}
      onSaveGateway={overrides.onSaveGateway}
      onLogout={async () => signedOutSession}
      onRefresh={async () => signedOutSession}
    />
  );
}

type EnterpriseAccountPageProps = Parameters<typeof EnterpriseAccountPage>[0];
