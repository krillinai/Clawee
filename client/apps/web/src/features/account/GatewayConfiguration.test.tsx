import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GatewayConfiguration } from './GatewayConfiguration.js';

const configuration = {
  gateway: 'https://current.example',
  gateways: ['https://current.example', 'https://other.example'],
  configurable: true
};

describe('服务器配置', () => {
  it('退出登录后可修改当前地址并保留其他服务器', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    render(<GatewayConfiguration connected onRead={async () => configuration} onSave={onSave} />);
    await screen.findByLabelText('服务器');
    await user.click(screen.getByRole('button', { name: '编辑当前服务器' }));
    const address = screen.getByLabelText('服务端地址');
    expect(address).toHaveValue(configuration.gateway);
    await user.clear(address);
    await user.type(address, 'https://updated.example');
    await user.click(screen.getByRole('button', { name: '保存地址' }));
    expect(onSave).toHaveBeenCalledWith('https://updated.example', ['https://updated.example', 'https://other.example']);
    expect(screen.getByLabelText('服务器')).toHaveValue('https://updated.example');
  });

  it('新增地址只保存列表，不自动切换当前服务器', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    render(<GatewayConfiguration connected onRead={async () => configuration} onSave={onSave} />);
    await screen.findByLabelText('服务器');
    await user.click(screen.getByRole('button', { name: '添加服务器' }));
    await user.type(screen.getByLabelText('服务端地址'), 'https://new.example/');
    await user.click(screen.getByRole('button', { name: '保存地址' }));
    expect(onSave).toHaveBeenCalledWith(configuration.gateway, [...configuration.gateways, 'https://new.example']);
    expect(screen.getByLabelText('服务器')).toHaveValue(configuration.gateway);
    expect(screen.getByRole('option', { name: 'https://new.example' })).toBeInTheDocument();
  });

  it('加载已保存列表，设置页可编辑、删除和保存其他地址', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    render(<GatewayConfiguration connected mode="settings" onRead={async () => ({ ...configuration, gateways: [...configuration.gateways, 'https://remove.example'] })} onSave={onSave} />);
    expect(await screen.findByLabelText('当前服务器')).toBeDisabled();
    expect(screen.getByLabelText('服务器地址 1（当前）')).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除服务器 1' })).toBeDisabled();
    const other = screen.getByLabelText('服务器地址 2');
    await user.clear(other);
    await user.type(other, 'http://updated.example:1904/');
    await user.click(screen.getByRole('button', { name: '删除服务器 3' }));
    await user.click(screen.getByRole('button', { name: '添加服务器' }));
    await user.type(screen.getByLabelText('服务器地址 3'), 'https://new.example');
    await user.click(screen.getByRole('button', { name: '保存服务器配置' }));
    expect(onSave).toHaveBeenCalledWith(configuration.gateway, [configuration.gateway, 'http://updated.example:1904', 'https://new.example']);
    await screen.findByText('服务器配置已保存');
  });

  it.each(['https://user:secret@example.com', 'https://new.example/path', 'file:///tmp'])('拒绝非法地址 %s', async address => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    render(<GatewayConfiguration connected onRead={async () => ({ gateway: '', gateways: [], configurable: true })} onSave={onSave} />);
    await user.type(await screen.findByLabelText('服务端地址'), address);
    await user.click(screen.getByRole('button', { name: '保存地址' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请输入有效的 HTTP 或 HTTPS');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('保存失败保留当前选择并允许重试', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValueOnce(new Error('请先退出登录')).mockResolvedValueOnce(undefined);
    render(<GatewayConfiguration connected onRead={async () => configuration} onSave={onSave} />);
    const select = await screen.findByLabelText('服务器');
    await user.selectOptions(select, 'https://other.example');
    expect(await screen.findByRole('alert')).toHaveTextContent('请先退出登录');
    expect(select).toHaveValue(configuration.gateway);
    await user.selectOptions(select, 'https://other.example');
    await screen.findByText('服务端地址已保存');
    expect(select).toHaveValue('https://other.example');
  });

  it('未配置占位地址不会出现在表单和下拉列表中', async () => {
    render(<GatewayConfiguration connected onRead={async () => ({ gateway: 'https://enterprise.invalid', configurable: true })} onSave={vi.fn()} />);
    expect(await screen.findByLabelText('服务端地址')).toHaveValue('');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('只读部署不展示无效编辑入口', async () => {
    render(<GatewayConfiguration connected onRead={async () => ({ ...configuration, configurable: false })} onSave={vi.fn()} />);
    expect(await screen.findByLabelText('服务器')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '添加服务器' })).not.toBeInTheDocument();
  });
});
