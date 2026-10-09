import type { EnterpriseGatewayConfiguration } from '@clawee/protocol';
import { LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import './gateway-configuration.css';

export type GatewayConfigurationProps = {
  connected: boolean;
  mode?: 'login' | 'settings';
  disabled?: boolean;
  onRead(): Promise<EnterpriseGatewayConfiguration>;
  onSave(gateway: string, gateways?: string[]): Promise<void>;
  onBusyChange?(busy: boolean): void;
  onReadyChange?(ready: boolean): void;
};

export function GatewayConfiguration(props: GatewayConfigurationProps) {
  const inputId = useId();
  const [configuration, setConfiguration] = useState<EnterpriseGatewayConfiguration>();
  const [addresses, setAddresses] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingCurrent, setEditingCurrent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const callbacks = useRef(props);
  callbacks.current = props;
  const settings = props.mode === 'settings';
  const disabled = !props.connected || props.disabled === true || saving;

  useEffect(() => {
    let canceled = false;
    setConfiguration(undefined);
    setError(undefined);
    callbacks.current.onReadyChange?.(false);
    if (!props.connected) return;
    void callbacks.current.onRead().then(value => {
      if (canceled) return;
      const gateway = value.gateway === 'https://enterprise.invalid' ? '' : value.gateway;
      const gateways = [...new Set([...(value.gateways ?? []), gateway])]
        .filter(address => address !== '' && address !== 'https://enterprise.invalid');
      setConfiguration({ ...value, gateway, gateways });
      setAddresses(gateways);
      setAdding(gateways.length === 0);
      setEditingCurrent(false);
      callbacks.current.onReadyChange?.(gateway !== '');
    }).catch(reason => {
      if (!canceled) setError(reason instanceof Error ? reason.message : '服务器配置加载失败');
    });
    return () => { canceled = true; };
  }, [props.connected, reloadKey]);

  async function save(gateway: string, gateways: string[]) {
    if (disabled || !configuration?.configurable) return;
    let normalizedGateway: string;
    let normalizedAddresses: string[];
    try {
      normalizedGateway = normalizeAddress(gateway);
      normalizedAddresses = [...new Set(gateways.map(normalizeAddress))];
    } catch {
      setNotice(undefined);
      setError('请输入有效的 HTTP 或 HTTPS 服务器地址，不包含路径、账号或密码');
      return;
    }
    setSaving(true);
    props.onBusyChange?.(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await props.onSave(normalizedGateway, normalizedAddresses);
      setConfiguration({ ...configuration, gateway: normalizedGateway, gateways: normalizedAddresses });
      setAddresses(normalizedAddresses);
      setDraft('');
      setAdding(false);
      setEditingCurrent(false);
      setNotice(settings ? '服务器配置已保存' : '服务端地址已保存');
      props.onReadyChange?.(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '服务器配置保存失败');
    } finally {
      setSaving(false);
      props.onBusyChange?.(false);
    }
  }

  if (!props.connected) return <p className="gateway-configuration-message" role="status">本地服务连接后可配置服务器。</p>;
  if (configuration === undefined) {
    return (
      <div className="gateway-configuration">
        {error ? <><p role="alert">{error}</p><button type="button" className="gateway-configuration-button" onClick={() => setReloadKey(value => value + 1)}>重新加载</button></>
          : <p className="gateway-configuration-message" role="status">正在加载服务器配置…</p>}
      </div>
    );
  }

  return (
    <section className="gateway-configuration" aria-label="服务器配置">
      {configuration.gateway ? (
        <div className="gateway-configuration-field">
          <label htmlFor={`${inputId}-select`}>{settings ? '当前服务器' : '服务器'}</label>
          <div className="gateway-configuration-control">
            <select id={`${inputId}-select`} value={configuration.gateway}
              disabled={disabled || settings || !configuration.configurable}
              onChange={event => {
                const selected = event.target.value;
                if (selected === 'add-server' || selected === 'edit-server') {
                  const editing = selected === 'edit-server';
                  setDraft(editing ? configuration.gateway : '');
                  setEditingCurrent(editing);
                  setAdding(true);
                  setNotice(undefined);
                  setError(undefined);
                  return;
                }
                void save(selected, configuration.gateways ?? []);
              }}>
              <optgroup label="已保存服务器">
                {(configuration.gateways ?? []).map(address => <option key={address} value={address}>{address}</option>)}
              </optgroup>
              {!settings && configuration.configurable ? (
                <optgroup label="管理服务器">
                  <option value="add-server">添加服务器</option>
                  <option value="edit-server">编辑当前服务器</option>
                </optgroup>
              ) : null}
            </select>
          </div>
        </div>
      ) : <p className="gateway-configuration-message">添加服务器地址，保存后即可登录。</p>}
      {!configuration.configurable ? <p className="gateway-configuration-message">服务器由部署配置管理，当前客户端不可修改。</p> : settings ? (
        <form className="gateway-configuration-editor" onSubmit={event => {
          event.preventDefault();
          void save(configuration.gateway || addresses[0] || '', addresses);
        }}>
          <p className="gateway-configuration-message">可添加、修改或删除其他服务器。修改或切换当前服务器，请先退出登录并等待运行中的任务结束。</p>
          {addresses.map((address, index) => {
            const current = address === configuration.gateway;
            return (
              <div key={index} className="gateway-configuration-field">
                <label htmlFor={`${inputId}-${index}`}>服务器地址 {index + 1}{current ? '（当前）' : ''}</label>
                <div className="gateway-configuration-control">
                  <input id={`${inputId}-${index}`} type="url" value={address} required autoComplete="off" spellCheck={false}
                    disabled={disabled || current} placeholder="https://gateway.example.com"
                    onChange={event => setAddresses(values => values.map((value, position) => position === index ? event.target.value : value))} />
                  <button type="button" className="gateway-configuration-button" aria-label={`删除服务器 ${index + 1}`}
                    disabled={disabled || current} onClick={() => setAddresses(values => values.filter((_, position) => position !== index))}>
                    <Trash2 size={16} aria-hidden="true" />删除
                  </button>
                </div>
              </div>
            );
          })}
          <div className="gateway-configuration-actions">
            <button type="button" className="gateway-configuration-button" disabled={disabled} onClick={() => setAddresses(values => [...values, ''])}>
              <Plus size={16} aria-hidden="true" />添加服务器
            </button>
            <button type="submit" className="gateway-configuration-button gateway-configuration-primary" disabled={disabled || addresses.length === 0}>
              {saving ? <LoaderCircle size={16} aria-hidden="true" className="spin" /> : <Save size={16} aria-hidden="true" />}
              {saving ? '保存中' : '保存服务器配置'}
            </button>
          </div>
        </form>
      ) : adding ? (
        <form className="gateway-configuration-editor" onSubmit={event => {
          event.preventDefault();
          if (editingCurrent) {
            void save(draft, (configuration.gateways ?? []).map(address => address === configuration.gateway ? draft : address));
          } else {
            void save(configuration.gateway || draft, [...(configuration.gateways ?? []), draft]);
          }
        }}>
          <div className="gateway-configuration-field">
            <label htmlFor={inputId}>服务端地址</label>
            <input id={inputId} type="url" value={draft} required autoComplete="off" spellCheck={false}
              placeholder="https://gateway.example.com" disabled={disabled} onChange={event => setDraft(event.target.value)} />
          </div>
          <div className="gateway-configuration-actions">
            <button type="submit" className="gateway-configuration-button gateway-configuration-primary" disabled={disabled || !draft.trim()}>
              {saving ? <LoaderCircle size={16} aria-hidden="true" className="spin" /> : <Save size={16} aria-hidden="true" />}
              {saving ? '保存中' : '保存地址'}
            </button>
            {configuration.gateway ? <button type="button" className="gateway-configuration-button" disabled={disabled} onClick={() => { setAdding(false); setEditingCurrent(false); setDraft(''); setError(undefined); }}>取消</button> : null}
          </div>
        </form>
      ) : null}
      {error ? <p className="enterprise-account-error" role="alert">{error}</p> : null}
      {notice ? <p className="enterprise-account-notice" role="status">{notice}</p> : null}
    </section>
  );
}

function normalizeAddress(value: string): string {
  const address = new URL(value.trim());
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password
    || address.pathname !== '/' || address.search || address.hash || address.origin === 'https://enterprise.invalid') {
    throw new Error('invalid address');
  }
  return address.origin;
}
