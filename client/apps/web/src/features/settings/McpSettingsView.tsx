import type {
  AddCodexMcpRequest,
  CodexMcpAddResponse,
  CodexMcpAuthResponse,
  CodexMcpEnableResponse,
  CodexMcpListResponse,
  CodexMcpRemoveResponse,
  CodexMcpServerDetailResponse,
  CodexMcpServerResponse
} from '@clawee/protocol';
import {
  Globe2,
  KeyRound,
  LoaderCircle,
  LogIn,
  LogOut,
  Plus,
  Server,
  Settings2,
  Terminal,
  Trash2,
  X
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiClientError } from '../../runtime/errors.js';

export type McpSettingsService = {
  listServers(): Promise<CodexMcpListResponse>;
  getServer(name: string): Promise<CodexMcpServerDetailResponse>;
  addServer(input: AddCodexMcpRequest): Promise<CodexMcpAddResponse>;
  setServerEnabled(
    name: string,
    enabled: boolean,
    confirmWriteToCodexHome?: boolean
  ): Promise<CodexMcpEnableResponse>;
  removeServer(name: string, confirmWriteToCodexHome?: boolean): Promise<CodexMcpRemoveResponse>;
  loginServer(name: string, confirmWriteToCodexHome?: boolean): Promise<CodexMcpAuthResponse>;
  logoutServer(name: string, confirmWriteToCodexHome?: boolean): Promise<CodexMcpAuthResponse>;
};

export type McpCapabilities = Partial<{
  mcpAdd: boolean;
  mcpRemove: boolean;
  mcpLogin: boolean;
  mcpLogout: boolean;
  mcpAddEnv: boolean;
  mcpAddUrl: boolean;
  mcpAddBearerTokenEnvVar: boolean;
  mcpAddOAuth: boolean;
}>;

type EnvEntry = { id: number; key: string; value: string };

export function McpSettingsView(props: {
  connected: boolean;
  service: McpSettingsService | null;
  data?: CodexMcpListResponse;
  capabilities?: McpCapabilities;
  onDataChange?(data: CodexMcpListResponse): void;
  confirmWrite?(): boolean;
  confirmRemove?(server: CodexMcpServerResponse): boolean;
}) {
  const [data, setData] = useState(props.data);
  const [loading, setLoading] = useState(
    props.data === undefined && props.connected && props.service !== null
  );
  const [error, setError] = useState<string>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [busyName, setBusyName] = useState<string>();

  useEffect(() => {
    setData(props.data);
  }, [props.data]);

  useEffect(() => {
    if (props.data !== undefined || !props.connected || props.service === null) return;
    let canceled = false;
    setLoading(true);
    props.service.listServers()
      .then(response => {
        if (!canceled) updateData(response);
      })
      .catch(reason => {
        if (!canceled) setError(formatMcpError(reason, '无法加载 MCP 服务'));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [props.connected, props.data, props.service]);

  function updateData(next: CodexMcpListResponse) {
    setData(next);
    props.onDataChange?.(next);
  }

  async function runServerAction(
    server: CodexMcpServerResponse,
    action: 'login' | 'logout' | 'remove'
  ) {
    if (props.service === null) return;
    if (action === 'remove' && !(props.confirmRemove?.(server) ?? window.confirm(`删除 MCP ${server.name}？`))) return;
    const confirmed = !data?.requiresWriteConfirmation
      || (props.confirmWrite?.() ?? window.confirm('此操作会修改全局 CODEX_HOME，是否继续？'));
    if (!confirmed) return;

    setBusyName(server.name);
    setError(undefined);
    try {
      if (action === 'login') await props.service.loginServer(server.name, data?.requiresWriteConfirmation);
      if (action === 'logout') await props.service.logoutServer(server.name, data?.requiresWriteConfirmation);
      if (action === 'remove') {
        await props.service.removeServer(server.name, data?.requiresWriteConfirmation);
        if (data !== undefined) {
          updateData({ ...data, servers: data.servers.filter(item => item.name !== server.name) });
        }
      }
    } catch (reason) {
      setError(formatMcpError(reason, `无法${actionLabel(action)} ${server.name}`));
    } finally {
      setBusyName(undefined);
    }
  }

  const canAdd = props.connected && props.service !== null && props.capabilities?.mcpAdd === true;

  return (
    <section className="settings-section settings-management" aria-labelledby="settings-mcp-title">
      <header className="settings-management__header">
        <div>
          <h1 id="settings-mcp-title">MCP 服务</h1>
          <p>管理 Codex 可连接的本机命令和远程 MCP 服务。</p>
        </div>
        <button
          className="settings-primary-button"
          type="button"
          disabled={!canAdd}
          onClick={() => setEditorOpen(true)}
        >
          <Plus size={16} />
          新增 MCP
        </button>
      </header>

      {!props.connected || props.service === null ? (
        <p className="settings-notice">本地服务连接后可以管理 MCP。</p>
      ) : null}
      {props.connected && props.service !== null && props.capabilities?.mcpAdd !== true ? (
        <p className="settings-notice">当前 Codex 版本不支持新增 MCP</p>
      ) : null}
      {data?.requiresWriteConfirmation ? (
        <p className="settings-notice">写操作会修改全局 CODEX_HOME，每次操作都需要确认。</p>
      ) : null}
      {error ? <p className="settings-error" role="alert">{error}</p> : null}

      {editorOpen ? (
        <McpEditor
          capabilities={props.capabilities}
          requiresWriteConfirmation={data?.requiresWriteConfirmation === true}
          onCancel={() => setEditorOpen(false)}
          onSubmit={async input => {
            if (props.service === null) return;
            setError(undefined);
            const confirmed = !data?.requiresWriteConfirmation
              || (props.confirmWrite?.() ?? window.confirm('此操作会修改全局 CODEX_HOME，是否继续？'));
            if (!confirmed) return;
            try {
              const result = await props.service.addServer({
                ...input,
                ...(data?.requiresWriteConfirmation ? { confirmWriteToCodexHome: true as const } : {})
              });
              const next = result.server;
              if (next !== undefined && data !== undefined) {
                updateData({
                  ...data,
                  servers: [...data.servers.filter(server => server.name !== next.name), next]
                    .sort((left, right) => left.name.localeCompare(right.name))
                });
              } else {
                updateData(await props.service.listServers());
              }
              setEditorOpen(false);
            } catch (reason) {
              setError(formatMcpError(reason, '无法新增 MCP'));
            }
          }}
        />
      ) : null}

      {loading ? (
        <div className="settings-state" role="status">
          <LoaderCircle size={20} className="settings-spin" />
          正在加载 MCP 服务
        </div>
      ) : data !== undefined && data.servers.length === 0 ? (
        <div className="settings-state">
          <Server size={22} />
          暂无 MCP 服务
        </div>
      ) : (
        <ul className="settings-item-list" aria-label="MCP 服务列表">
          {data?.servers.map(server => {
            const busy = busyName === server.name;
            return (
              <li className="settings-item" key={server.name}>
                <div className="settings-item__main">
                  <div className="settings-item__title">
                    <Server size={16} />
                    <h2>{server.name}</h2>
                    <span data-status={server.status}>{server.status === 'configured' ? '已配置' : server.status}</span>
                  </div>
                  <p>{mcpEndpoint(server)}</p>
                  {server.envKeys.length > 0 ? (
                    <div className="settings-tags" aria-label={`${server.name} 环境变量`}>
                      <KeyRound size={14} />
                      {server.envKeys.map(key => <code key={key}>{key}</code>)}
                    </div>
                  ) : null}
                  {server.diagnostics.map(diagnostic => (
                    <p className="settings-inline-warning" key={diagnostic}>{diagnostic}</p>
                  ))}
                </div>
                <div className="settings-item__actions">
                  <button
                    type="button"
                    aria-label={`登录 ${server.name}`}
                    title="登录"
                    disabled={busy || props.capabilities?.mcpLogin !== true}
                    onClick={() => void runServerAction(server, 'login')}
                  >
                    <LogIn size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label={`退出 ${server.name}`}
                    title="退出"
                    disabled={busy || props.capabilities?.mcpLogout !== true}
                    onClick={() => void runServerAction(server, 'logout')}
                  >
                    <LogOut size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label={`删除 ${server.name}`}
                    title="删除"
                    disabled={busy || props.capabilities?.mcpRemove !== true}
                    onClick={() => void runServerAction(server, 'remove')}
                  >
                    {busy ? <LoaderCircle size={16} className="settings-spin" /> : <Trash2 size={16} />}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function McpEditor(props: {
  capabilities?: McpCapabilities;
  requiresWriteConfirmation: boolean;
  onCancel(): void;
  onSubmit(input: AddCodexMcpRequest): Promise<void>;
}) {
  const [mode, setMode] = useState<'local' | 'remote'>('local');
  const [remoteTransport, setRemoteTransport] = useState<'http' | 'sse'>('http');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [bearerTokenEnvVar, setBearerTokenEnvVar] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthResource, setOauthResource] = useState('');
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const supportsRemote = props.capabilities?.mcpAddUrl === true;
  const supportsAdvanced = (
    props.capabilities?.mcpAddEnv === true
    || (
      mode === 'remote'
      && (
        props.capabilities?.mcpAddBearerTokenEnvVar === true
        || props.capabilities?.mcpAddOAuth === true
      )
    )
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return setFormError('请输入 MCP 名称');
    const env = Object.fromEntries(
      envEntries
        .map(entry => [entry.key.trim(), entry.value] as const)
        .filter(([key]) => key.length > 0)
    );
    let input: AddCodexMcpRequest;
    if (mode === 'local') {
      if (command.trim().length === 0) return setFormError('请输入启动命令');
      input = {
        name: trimmedName,
        transport: 'stdio',
        command: command.trim(),
        args: args.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        ...(Object.keys(env).length > 0 ? { env } : {})
      };
    } else {
      if (url.trim().length === 0) return setFormError('请输入远程 MCP 地址');
      input = {
        name: trimmedName,
        transport: remoteTransport,
        url: url.trim(),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(bearerTokenEnvVar.trim() ? { bearerTokenEnvVar: bearerTokenEnvVar.trim() } : {}),
        ...(oauthClientId.trim() ? { oauthClientId: oauthClientId.trim() } : {}),
        ...(oauthResource.trim() ? { oauthResource: oauthResource.trim() } : {})
      };
    }
    setSaving(true);
    setFormError(undefined);
    try {
      await props.onSubmit(input);
      setEnvEntries([]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-editor" aria-label="新增 MCP" onSubmit={submit}>
      <header>
        <div>
          <p>新增连接</p>
          <h2>配置 MCP 服务</h2>
        </div>
        <button type="button" aria-label="关闭 MCP 编辑器" title="关闭" onClick={props.onCancel}>
          <X size={17} />
        </button>
      </header>
      {formError ? <p className="settings-error" role="alert">{formError}</p> : null}
      <div className="settings-connection-mode" role="group" aria-label="连接方式">
        <button
          type="button"
          aria-pressed={mode === 'local'}
          onClick={() => {
            setMode('local');
            setFormError(undefined);
          }}
        >
          <Terminal size={16} aria-hidden="true" />
          本机命令
        </button>
        <button
          type="button"
          aria-pressed={mode === 'remote'}
          disabled={!supportsRemote}
          onClick={() => {
            setMode('remote');
            setFormError(undefined);
          }}
        >
          <Globe2 size={16} aria-hidden="true" />
          远程地址
        </button>
      </div>
      <div className="settings-form-grid">
        <label className="settings-form-wide">
          <span>名称</span>
          <input
            aria-label="名称"
            placeholder="例如：linear"
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </label>
        {mode === 'local' ? (
          <>
            <label className="settings-form-wide">
              <span>启动命令</span>
              <input
                aria-label="启动命令"
                placeholder="例如：npx"
                value={command}
                onChange={event => setCommand(event.target.value)}
              />
            </label>
            <label className="settings-form-wide">
              <span>启动参数（每行一个）</span>
              <textarea
                aria-label="启动参数"
                rows={3}
                placeholder={'例如：\n-y\n@modelcontextprotocol/server-filesystem'}
                value={args}
                onChange={event => setArgs(event.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            <label className="settings-form-wide">
              <span>远程 MCP 地址</span>
              <input
                aria-label="远程 MCP 地址"
                type="url"
                placeholder="https://example.com/mcp"
                value={url}
                onChange={event => setUrl(event.target.value)}
              />
            </label>
            <label>
              <span>远程协议</span>
              <select
                aria-label="远程协议"
                value={remoteTransport}
                onChange={event => setRemoteTransport(
                  event.target.value as typeof remoteTransport
                )}
              >
                <option value="http">HTTP</option>
                <option value="sse">SSE</option>
              </select>
            </label>
          </>
        )}
      </div>
      {supportsAdvanced ? (
        <details className="settings-advanced-fields">
          <summary>
            <Settings2 size={15} aria-hidden="true" />
            高级配置
          </summary>
          <div className="settings-advanced-fields__content">
            {mode === 'remote' ? (
              <div className="settings-form-grid">
                {props.capabilities?.mcpAddBearerTokenEnvVar === true ? (
                  <label>
                    <span>Bearer Token 变量名</span>
                    <input
                      aria-label="Bearer Token 变量名"
                      placeholder="例如：MCP_TOKEN"
                      value={bearerTokenEnvVar}
                      onChange={event => setBearerTokenEnvVar(event.target.value)}
                    />
                  </label>
                ) : null}
                {props.capabilities?.mcpAddOAuth === true ? (
                  <>
                    <label>
                      <span>OAuth Client ID</span>
                      <input
                        aria-label="OAuth Client ID"
                        value={oauthClientId}
                        onChange={event => setOauthClientId(event.target.value)}
                      />
                    </label>
                    <label>
                      <span>OAuth Resource</span>
                      <input
                        aria-label="OAuth Resource"
                        value={oauthResource}
                        onChange={event => setOauthResource(event.target.value)}
                      />
                    </label>
                  </>
                ) : null}
              </div>
            ) : null}
            {props.capabilities?.mcpAddEnv === true ? (
              <fieldset className="settings-env-editor">
                <legend>环境变量</legend>
                {envEntries.map((entry, index) => (
                  <div key={entry.id}>
                    <input
                      aria-label={index === 0 ? '环境变量名' : `环境变量名 ${index + 1}`}
                      placeholder="变量名"
                      value={entry.key}
                      onChange={event => setEnvEntries(current => current.map(item => (
                        item.id === entry.id ? { ...item, key: event.target.value } : item
                      )))}
                    />
                    <input
                      aria-label={index === 0 ? '环境变量值' : `环境变量值 ${index + 1}`}
                      type="password"
                      autoComplete="off"
                      placeholder="保存后不在页面显示"
                      value={entry.value}
                      onChange={event => setEnvEntries(current => current.map(item => (
                        item.id === entry.id ? { ...item, value: event.target.value } : item
                      )))}
                    />
                    <button
                      type="button"
                      aria-label={`移除环境变量 ${index + 1}`}
                      onClick={() => setEnvEntries(current => current.filter(
                        item => item.id !== entry.id
                      ))}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                <button
                  className="settings-text-button"
                  type="button"
                  onClick={() => setEnvEntries(current => [
                    ...current,
                    {
                      id: current.reduce(
                        (maximum, entry) => Math.max(maximum, entry.id),
                        0
                      ) + 1,
                      key: '',
                      value: ''
                    }
                  ])}
                >
                  <Plus size={15} />
                  添加变量
                </button>
              </fieldset>
            ) : null}
          </div>
        </details>
      ) : null}
      {props.requiresWriteConfirmation ? <p className="settings-notice">保存时将再次确认全局写入。</p> : null}
      <footer>
        <button className="settings-secondary-button" type="button" onClick={props.onCancel}>取消</button>
        <button className="settings-primary-button" type="submit" disabled={saving}>
          {saving ? <LoaderCircle size={16} className="settings-spin" /> : <Server size={16} />}
          保存 MCP
        </button>
      </footer>
    </form>
  );
}

function mcpEndpoint(server: CodexMcpServerResponse): string {
  if (server.transport === 'stdio') {
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') || 'stdio';
  }
  return server.url ?? server.transport;
}

function actionLabel(action: 'login' | 'logout' | 'remove'): string {
  if (action === 'login') return '登录';
  if (action === 'logout') return '退出';
  return '删除';
}

function formatMcpError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiClientError)) return fallback;
  const hints: Record<string, string> = {
    MCP_WRITE_CONFIRMATION_REQUIRED: '请确认修改全局 CODEX_HOME 后重试',
    MCP_SERVER_NOT_FOUND: '该服务已不存在，请重新加载',
    MCP_SERVER_EXISTS: '请更换 MCP 名称',
    MCP_SERVER_INVALID: '请检查命令、URL 和环境变量配置',
    CODEX_INCOMPATIBLE: '请更新 Codex CLI 或调整当前配置',
    MCP_COMMAND_FAILED: '请检查 Codex 登录状态和 MCP 命令输出'
  };
  return `${error.code}：${hints[error.code] ?? error.message}`;
}
