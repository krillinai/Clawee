import { act, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelServiceSetupPage } from './ModelServiceSetupPage.js';

describe('ModelServiceSetupPage', () => {
  it('requires all fields and submits normalized configuration', async () => {
    const user = userEvent.setup();
    const onConfigure = vi.fn(async () => undefined);
    render(
      <ModelServiceSetupPage
        status={{
          status: 'configuration_required',
          configuration: null,
          apiKeyConfigured: false
        }}
        onConfigure={onConfigure}
      />
    );

    expect(screen.getByRole('heading', {
      name: '配置 Codex 模型服务'
    })).toBeInTheDocument();
    expect(screen.queryByText('欢迎使用 Clawee')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Base URL'), ' https://api.example.com/v1 ');
    await user.type(screen.getByLabelText('Model'), ' model-1 ');
    await user.type(screen.getByLabelText('API Key'), ' secret-key ');
    await user.click(screen.getByRole('button', {
      name: '验证并启动 Clawee'
    }));

    expect(onConfigure).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com/v1',
      model: 'model-1',
      apiKey: 'secret-key'
    });
  });

  it('clears the API key after a failed validation', async () => {
    const user = userEvent.setup();
    render(
      <ModelServiceSetupPage
        status={{
          status: 'configuration_required',
          configuration: {
            baseUrl: 'https://api.example.com/v1',
            model: 'model-1'
          },
          apiKeyConfigured: false
        }}
        onConfigure={async () => {
          throw new Error('validation failed');
        }}
      />
    );

    const apiKey = screen.getByLabelText('API Key');
    await user.type(apiKey, 'secret-key');
    await user.click(screen.getByRole('button', {
      name: '验证并启动 Clawee'
    }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'validation failed'
    );
    expect(apiKey).toHaveValue('');
  });

  it('shows the setup spinner while validation is pending', async () => {
    const user = userEvent.setup();
    let finishValidation: (() => void) | undefined;
    const onConfigure = vi.fn(() => new Promise<void>(resolve => {
      finishValidation = resolve;
    }));
    render(
      <ModelServiceSetupPage
        status={{
          status: 'configuration_required',
          configuration: null,
          apiKeyConfigured: false
        }}
        onConfigure={onConfigure}
      />
    );

    await user.type(screen.getByLabelText('Base URL'), 'https://api.example.com/v1');
    await user.type(screen.getByLabelText('Model'), 'model-1');
    await user.type(screen.getByLabelText('API Key'), 'secret-key');
    await user.click(screen.getByRole('button', {
      name: '验证并启动 Clawee'
    }));

    const submit = screen.getByRole('button', {
      name: '正在验证模型服务'
    });
    expect(submit).toBeDisabled();
    expect(
      submit.querySelector('.model-service-setup__spinner')
    ).toBeInTheDocument();

    await act(async () => {
      finishValidation?.();
    });
  });
});
