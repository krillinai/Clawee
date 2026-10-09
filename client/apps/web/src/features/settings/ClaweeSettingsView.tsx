import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent
} from 'react';
import { Check, Eye, EyeOff, KeyRound, LoaderCircle, Moon, Server, Sun } from 'lucide-react';
import type {
  CodexAvailabilityProbe,
  CodexProfileListResponse,
  CodexStatusResponse,
  ConfigureModelServiceRequest,
  ModelAccessMode,
  ModelServiceConfiguration
} from '@clawee/protocol';
import { CLAWEE_APP_VERSION } from '../../app-version.js';
import type { ColorMode } from '../../styles/color-mode.js';
import {
  defaultCustomAccentColor,
  normalizeHexColor,
  type AccentColor
} from '../../styles/accent-color.js';
import type { ProjectPermission } from '../projects/project-model.js';
import { ProfileSettingsView, type ProfileSettingsService } from './ProfileSettingsView.js';
import { CleanupSettingsView, type CleanupSettingsService } from './CleanupSettingsView.js';
import { DiagnosticsSettingsView } from './DiagnosticsSettingsView.js';
import {
  MemorySettingsView,
  type MemoryScopeOption,
  type MemorySettingsService
} from './MemorySettingsView.js';
import './settings-management.css';
import { GatewayConfiguration, type GatewayConfigurationProps } from '../account/GatewayConfiguration.js';
import { DesktopUpdateSettings, type DesktopUpdates } from './DesktopUpdates.js';

export type RuntimeStatus = {
  connected: boolean;
  runtimeVersion?: string;
  codexVersion?: string;
  codexPath?: string;
  codexHome?: string;
  lastCheckedAt?: string;
};

export type DefaultPermissionPreference = 'follow-project' | ProjectPermission;

export type ClaweeSettingsViewProps = {
  initialTab?: 'general' | 'model';
  desktopUpdates?: DesktopUpdates;
  runtimeStatus: RuntimeStatus;
  agentId?: string;
  defaultPermission?: DefaultPermissionPreference;
  defaultPermissionError?: string;
  onDefaultPermissionChange?(permission: DefaultPermissionPreference): void;
  colorMode?: ColorMode;
  onColorModeChange?(mode: ColorMode): void;
  accentColor?: AccentColor;
  onAccentColorChange?(color: AccentColor): void;
  customAccentColor?: string;
  brandAccentColor?: string;
  onCustomAccentColorChange?(color: string): void;
  desktopCloseBehavior?: 'hide' | 'quit';
  onDesktopCloseBehaviorChange?(behavior: 'hide' | 'quit'): void;
  profileService?: ProfileSettingsService | null;
  profileData?: CodexProfileListResponse;
  onProfileDataChange?(data: CodexProfileListResponse): void;
  cleanupService?: CleanupSettingsService | null;
  memoryService?: MemorySettingsService | null;
  memoryProjects?: MemoryScopeOption[];
  memoryThreads?: MemoryScopeOption[];
  codexStatus?: CodexStatusResponse;
  modelServiceConfiguration?: ModelServiceConfiguration | null;
  modelServiceMode?: ModelAccessMode;
  onModelServiceReadApiKey?(): Promise<{ apiKey: string | null }>;
  onModelServiceCheck?(input?: ConfigureModelServiceRequest): Promise<CodexAvailabilityProbe>;
  onModelServiceConfigure?(input: ConfigureModelServiceRequest): Promise<void>;
  onReadGateway?: GatewayConfigurationProps['onRead'];
  onSaveGateway?: GatewayConfigurationProps['onSave'];
  onBack(): void;
};

type SettingsTab = 'general' | 'server' | 'model' | 'plugins' | 'memory' | 'profiles' | 'cleanup' | 'diagnostics' | 'about';

const tabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: '常规' },
  { id: 'server', label: '服务器配置' },
  { id: 'model', label: 'AI模型配置' },
  { id: 'plugins', label: '插件' },
  { id: 'memory', label: '记忆' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'cleanup', label: '清理' },
  { id: 'diagnostics', label: '诊断' },
  { id: 'about', label: '关于 Clawee' }
];

const defaultPermissionOptions: Array<{
  value: DefaultPermissionPreference;
  label: string;
}> = [
  { value: 'follow-project', label: '跟随项目设置' },
  { value: 'workspace-write', label: '请求批准' },
  { value: 'danger-full-access', label: '完全访问权限' }
];

export function ClaweeSettingsView(props: ClaweeSettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(props.initialTab ?? 'general');
  useEffect(() => { setActiveTab(props.initialTab ?? 'general'); }, [props.initialTab]);

  return (
    <div className="settings-page">
      <aside className="settings-sidebar" aria-label="设置导航">
        <button className="settings-back" type="button" onClick={props.onBack}>
          返回应用
        </button>
        <label className="settings-search">
          <span>搜索设置</span>
          <input type="search" placeholder="搜索暂不可用" aria-describedby="settings-search-disabled" disabled />
          <span id="settings-search-disabled">搜索暂不可用</span>
        </label>
        <nav className="settings-nav" aria-label="设置分类">
          {tabs.filter(tab => tab.id !== 'server' || (props.onReadGateway && props.onSaveGateway)).map(tab => (
            <button
              key={tab.id}
              type="button"
              aria-current={activeTab === tab.id ? 'page' : undefined}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="settings-content">
        {activeTab === 'server' && props.onReadGateway && props.onSaveGateway ? (
          <section className="settings-section" aria-labelledby="settings-server-title">
            <header><h1 id="settings-server-title">服务器配置</h1><p>管理保存在本机的服务器地址，登录时可从列表中选择。</p></header>
            <GatewayConfiguration mode="settings" connected={props.runtimeStatus.connected}
              onRead={props.onReadGateway} onSave={props.onSaveGateway} />
          </section>
        ) : null}
        {activeTab === 'general' ? (
          <GeneralSettings
            defaultPermission={props.defaultPermission ?? 'danger-full-access'}
            defaultPermissionError={props.defaultPermissionError}
            onDefaultPermissionChange={props.onDefaultPermissionChange}
            colorMode={props.colorMode ?? 'dark'}
            onColorModeChange={props.onColorModeChange}
            accentColor={props.accentColor ?? 'neutral'}
            onAccentColorChange={props.onAccentColorChange}
            customAccentColor={props.customAccentColor ?? defaultCustomAccentColor}
            brandAccentColor={props.brandAccentColor}
            onCustomAccentColorChange={props.onCustomAccentColorChange}
            desktopCloseBehavior={props.desktopCloseBehavior}
            onDesktopCloseBehaviorChange={props.onDesktopCloseBehaviorChange}
          />
        ) : null}
        {activeTab === 'plugins' ? <PluginSettings runtimeStatus={props.runtimeStatus} /> : null}
        {activeTab === 'model' ? (
          <ModelServiceSettings
            connected={props.runtimeStatus.connected}
            configuration={props.modelServiceConfiguration ?? null}
            mode={props.modelServiceMode}
            onReadApiKey={props.onModelServiceReadApiKey}
            onCheck={props.onModelServiceCheck}
            onConfigure={props.onModelServiceConfigure}
          />
        ) : null}
        {activeTab === 'memory' ? (
          <MemorySettingsView
            connected={props.runtimeStatus.connected}
            service={props.memoryService ?? null}
            projects={props.memoryProjects ?? []}
            threads={props.memoryThreads ?? []}
          />
        ) : null}
        {activeTab === 'profiles' ? (
          <ProfileSettingsView
            connected={props.runtimeStatus.connected}
            service={props.profileService ?? null}
            data={props.profileData}
            onDataChange={props.onProfileDataChange}
          />
        ) : null}
        {activeTab === 'cleanup' ? (
          <CleanupSettingsView
            connected={props.runtimeStatus.connected}
            service={props.cleanupService ?? null}
          />
        ) : null}
        {activeTab === 'diagnostics' ? (
          <DiagnosticsSettingsView
            connected={props.runtimeStatus.connected}
            runtimeVersion={props.runtimeStatus.runtimeVersion}
            codexStatus={props.codexStatus}
          />
        ) : null}
        {activeTab === 'about' ? (
          <AboutSettings runtimeStatus={props.runtimeStatus} agentId={props.agentId} desktopUpdates={props.desktopUpdates} />
        ) : null}
      </main>
    </div>
  );
}

function ModelServiceSettings(props: {
  connected: boolean;
  configuration: ModelServiceConfiguration | null;
  mode?: ModelAccessMode;
  onReadApiKey?(): Promise<{ apiKey: string | null }>;
  onCheck?(input?: ConfigureModelServiceRequest): Promise<CodexAvailabilityProbe>;
  onConfigure?(input: ConfigureModelServiceRequest): Promise<void>;
}) {
  const [baseUrl, setBaseUrl] = useState(props.configuration?.baseUrl ?? '');
  const [model, setModel] = useState(props.configuration?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingKey, setLoadingKey] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<CodexAvailabilityProbe>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setBaseUrl(props.configuration?.baseUrl ?? '');
    setModel(props.configuration?.model ?? '');
  }, [props.configuration?.baseUrl, props.configuration?.model]);

  const platformManaged = props.mode === 'platform_managed';
  const available = props.connected && props.onConfigure !== undefined && !platformManaged;
  const busy = saving || checking || loadingKey;

  useEffect(() => {
    let canceled = false;
    setApiKey('');
    setShowApiKey(false);
    setLoadingKey(false);
    if (!props.connected || platformManaged || props.onReadApiKey === undefined) return;
    setLoadingKey(true);
    void props.onReadApiKey().then(response => {
      if (!canceled) setApiKey(response.apiKey ?? '');
    }).catch(() => {
      if (!canceled) setError('本机密钥读取失败，请重新输入或稍后重试');
    }).finally(() => {
      if (!canceled) setLoadingKey(false);
    });
    return () => { canceled = true; };
  }, [props.connected, platformManaged, props.onReadApiKey]);

  useEffect(() => { setCheckResult(undefined); }, [baseUrl, model, apiKey]);

  function draft(): ConfigureModelServiceRequest {
    return { baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim() };
  }

  async function check(form: HTMLFormElement | null) {
    if (!props.connected || props.onCheck === undefined || busy) return;
    if (!platformManaged && !form?.reportValidity()) return;
    setChecking(true);
    setCheckResult(undefined);
    setError(undefined);
    try {
      setCheckResult(await props.onCheck(platformManaged ? undefined : draft()));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '模型检测失败');
    } finally {
      setChecking(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!available || busy || !event.currentTarget.reportValidity()) return;
    setSaving(true);
    setError(undefined);
    try {
      await props.onConfigure!(draft());
      setCheckResult({ status: 'succeeded', checkedAt: new Date().toISOString() });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '模型配置保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="settings-section settings-management model-settings"
      aria-labelledby="settings-model-title"
    >
      <header className="settings-management__header">
        <div>
          <h1 id="settings-model-title">AI模型配置</h1>
          <p>配置本机 Codex Runtime 使用的模型服务。</p>
        </div>
      </header>
      {!props.connected ? (
        <p className="settings-notice">本地服务未连接，无法配置模型服务。</p>
      ) : null}
      {props.connected && props.onConfigure === undefined ? (
        <p className="settings-notice">模型配置服务当前不可用。</p>
      ) : null}
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
      {platformManaged ? <p className="settings-notice">模型由平台统一管理，配置只读，密钥不回显。</p> : null}
      <form className="settings-card settings-form-grid" aria-label="AI模型配置" onSubmit={save}>
        <label className="settings-form-wide">
          <span><Server size={15} aria-hidden="true" />Base URL</span>
          <input
            aria-label="Base URL"
            type="url"
            inputMode="url"
            autoComplete="url"
            required
            maxLength={2048}
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            readOnly={platformManaged}
            disabled={!props.connected || busy}
            onChange={event => setBaseUrl(event.target.value)}
          />
        </label>
        {!platformManaged ? <label className="settings-form-wide">
          <span><KeyRound size={15} aria-hidden="true" />API Key</span>
          <span className="settings-secret-field">
            <input
              aria-label="API Key"
              type={showApiKey ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={apiKey}
              placeholder="输入 API Key"
              disabled={!available || busy}
              onChange={event => setApiKey(event.target.value)}
            />
            <button
              type="button"
              aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
              title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
              disabled={busy}
              onClick={() => setShowApiKey(value => !value)}
            >
              {showApiKey
                ? <EyeOff size={15} aria-hidden="true" />
                : <Eye size={15} aria-hidden="true" />}
            </button>
          </span>
          <small>API Key 仅保存到本机私有凭据文件，默认隐藏，点击眼睛可查看。</small>
        </label> : null}
        <label className="settings-form-wide">
          <span>模型名字</span>
          <input
            aria-label="模型名字"
            type="text"
            autoComplete="off"
            required
            maxLength={200}
            value={model}
            placeholder="手动输入模型名字"
            readOnly={platformManaged}
            disabled={!props.connected || busy}
            onChange={event => setModel(event.target.value)}
          />
        </label>
        <button className="settings-primary-button" type="button" disabled={!props.connected || props.onCheck === undefined || busy}
          onClick={event => void check(event.currentTarget.form)}>
          {checking ? '正在检测' : '检测模型'}
        </button>
        {!platformManaged ? <button className="settings-primary-button" type="submit" disabled={!available || busy}>
          {saving
            ? <LoaderCircle className="settings-spin" size={15} aria-hidden="true" />
            : <Check size={15} aria-hidden="true" />}
          {saving ? '正在保存' : '保存配置'}
        </button> : null}
        {checkResult ? <p className={checkResult.status === 'succeeded' ? 'settings-notice settings-form-wide' : 'settings-error settings-form-wide'} role="status">
          {checkResult.status === 'succeeded' ? '模型检测通过' : checkResult.message ?? '模型检测失败'}
          {checkResult.checkedAt ? ` · 检测时间：${new Date(checkResult.checkedAt).toLocaleString()}` : ''}
        </p> : null}
      </form>
    </section>
  );
}

function GeneralSettings(props: {
  defaultPermission: DefaultPermissionPreference;
  defaultPermissionError?: string;
  onDefaultPermissionChange?(permission: DefaultPermissionPreference): void;
  colorMode: ColorMode;
  onColorModeChange?(mode: ColorMode): void;
  accentColor: AccentColor;
  onAccentColorChange?(color: AccentColor): void;
  customAccentColor: string;
  brandAccentColor?: string;
  onCustomAccentColorChange?(color: string): void;
  desktopCloseBehavior?: 'hide' | 'quit';
  onDesktopCloseBehaviorChange?(behavior: 'hide' | 'quit'): void;
}) {
  return (
    <section className="settings-section" aria-labelledby="settings-general-title">
      <header>
        <h1 id="settings-general-title">常规</h1>
        <p>调整 Clawee 的默认偏好和桌面显示方式。</p>
      </header>
      <div className="settings-card">
        <SettingsColorModeRow
          value={props.colorMode}
          onChange={(mode) => props.onColorModeChange?.(mode)}
        />
        <SettingsAccentColorRow
          value={props.accentColor}
          customColor={props.customAccentColor}
          brandColor={props.brandAccentColor}
          onChange={(color) => props.onAccentColorChange?.(color)}
          onCustomColorChange={(color) => props.onCustomAccentColorChange?.(color)}
        />
        <SettingsSelectRow
          label="默认权限"
          value={props.defaultPermission}
          options={defaultPermissionOptions}
          onChange={(permission) => {
            if (
              permission === 'danger-full-access'
              && props.defaultPermission !== 'danger-full-access'
              && !window.confirm(
                '完全访问权限允许 Clawee 访问本机文件并执行本地操作。确定要设为默认权限吗？'
              )
            ) {
              return;
            }
            props.onDefaultPermissionChange?.(permission);
          }}
        />
        <SettingsRow label="默认文件打开方式" value="系统默认应用" />
        <SettingsRow label="语言" value="中文" />
        {props.desktopCloseBehavior === undefined ? (
          <SettingsRow label="菜单栏显示" value="浏览器模式" />
        ) : (
          <label className="settings-row settings-control-row" htmlFor="settings-desktop-close-behavior">
            <span>关闭窗口时</span>
            <select
              id="settings-desktop-close-behavior"
              className="settings-select"
              value={props.desktopCloseBehavior}
              onChange={event => props.onDesktopCloseBehaviorChange?.(
                event.target.value as 'hide' | 'quit'
              )}
            >
              <option value="hide">隐藏到菜单栏</option>
              <option value="quit">退出 Clawee</option>
            </select>
          </label>
        )}
      </div>
      {props.defaultPermissionError ? (
        <p className="settings-error" role="alert">{props.defaultPermissionError}</p>
      ) : null}
    </section>
  );
}

function SettingsColorModeRow(props: { value: ColorMode; onChange(mode: ColorMode): void }) {
  const labelId = 'settings-color-mode-label';

  return (
    <div className="settings-row settings-control-row">
      <span id={labelId}>颜色模式</span>
      <div className="settings-color-mode" role="group" aria-labelledby={labelId}>
        <button
          type="button"
          aria-pressed={props.value === 'light'}
          onClick={() => props.onChange('light')}
        >
          <Sun size={14} aria-hidden="true" />
          浅色
        </button>
        <button
          type="button"
          aria-pressed={props.value === 'dark'}
          onClick={() => props.onChange('dark')}
        >
          <Moon size={14} aria-hidden="true" />
          深色
        </button>
      </div>
    </div>
  );
}

const accentColorOptions: Array<{
  value: AccentColor;
  label: string;
  swatch: string;
}> = [
  { value: 'neutral', label: '默认灰', swatch: '#85858b' },
  { value: 'blue', label: '蓝色', swatch: '#3b82f6' },
  { value: 'cyan', label: '青色', swatch: '#06b6d4' },
  { value: 'purple', label: '紫色', swatch: '#8b5cf6' },
  { value: 'orange', label: '橙色', swatch: '#f97316' },
  { value: 'red', label: '红色', swatch: '#ef4444' }
];

function SettingsAccentColorRow(props: {
  value: AccentColor;
  customColor: string;
  brandColor?: string;
  onChange(color: AccentColor): void;
  onCustomColorChange(color: string): void;
}) {
  const labelId = 'settings-accent-color-label';
  const inputId = 'settings-custom-accent-color';
  const normalizedCustomColor = normalizeHexColor(props.customColor) ?? defaultCustomAccentColor;
  const [draft, setDraft] = useState(normalizedCustomColor);
  const [error, setError] = useState<string>();
  const inputFocusedRef = useRef(false);

  useEffect(() => {
    if (!inputFocusedRef.current) setDraft(normalizedCustomColor);
  }, [normalizedCustomColor]);

  function commitDraft() {
    const normalized = normalizeHexColor(draft);
    if (normalized === undefined) {
      setError('请输入 3 位或 6 位十六进制色值');
      return;
    }
    setDraft(normalized);
    setError(undefined);
    props.onCustomColorChange(normalized);
  }

  return (
    <div className="settings-row settings-control-row settings-accent-row">
      <span id={labelId}>重点色</span>
      <div className="settings-accent-controls">
        <div className="settings-accent-color">
          <div className="settings-accent-options" role="radiogroup" aria-labelledby={labelId}>
            <button className="settings-brand-accent-choice" type="button" role="radio" aria-checked={props.value === 'brand'} aria-label="跟随品牌" title="跟随品牌"
              style={{ '--settings-accent-swatch': normalizeHexColor(props.brandColor ?? '') ?? '#85858b' } as CSSProperties}
              onClick={() => props.onChange('brand')}>
              <span className="settings-accent-swatch" aria-hidden="true" />
              跟随品牌
              {props.value === 'brand' ? <Check size={11} strokeWidth={2.5} aria-hidden="true" /> : null}
            </button>
            {accentColorOptions.map(option => {
              const selected = props.value === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={option.label}
                  title={option.label}
                  style={{ '--settings-accent-swatch': option.swatch } as CSSProperties}
                  onClick={() => props.onChange(option.value)}
                >
                  <span className="settings-accent-swatch" aria-hidden="true">
                    {selected ? <Check size={11} strokeWidth={2.5} /> : null}
                  </span>
                </button>
              );
            })}
            <div className="settings-custom-accent-option">
              <span className="settings-accent-separator" aria-hidden="true">｜</span>
              <button
                className="settings-custom-accent-choice"
                type="button"
                role="radio"
                aria-checked={props.value === 'custom'}
                aria-label="自定义"
                title="自定义"
                style={{ '--settings-accent-swatch': normalizedCustomColor } as CSSProperties}
                onClick={() => props.onChange('custom')}
              >
                <span className="settings-accent-swatch" aria-hidden="true">
                  {props.value === 'custom' ? <Check size={11} strokeWidth={2.5} /> : null}
                </span>
                <span className="settings-custom-accent-text">自定义</span>
              </button>
            </div>
          </div>
          <div className="settings-custom-accent">
            <label className="settings-custom-accent-input-label" htmlFor={inputId}>
              自定义重点色色值
            </label>
            <input
              id={inputId}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              aria-invalid={error === undefined ? undefined : 'true'}
              aria-describedby={error === undefined ? undefined : `${inputId}-error`}
              onFocus={() => {
                inputFocusedRef.current = true;
              }}
              onChange={event => {
                const nextDraft = event.target.value;
                setDraft(nextDraft);
                const normalized = normalizeHexColor(nextDraft);
                if (normalized === undefined) return;
                setError(undefined);
                props.onCustomColorChange(normalized);
              }}
              onBlur={() => {
                inputFocusedRef.current = false;
                commitDraft();
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitDraft();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setDraft(normalizedCustomColor);
                  setError(undefined);
                }
              }}
            />
            {error === undefined ? null : (
              <p id={`${inputId}-error`} className="settings-custom-accent-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PluginSettings(props: { runtimeStatus: RuntimeStatus }) {
  const checkedAt = props.runtimeStatus.lastCheckedAt ?? '尚未检测';
  const status = props.runtimeStatus.connected ? '本地能力已就绪' : '等待本地能力连接';

  return (
    <section className="settings-section" aria-labelledby="settings-plugins-title">
      <header>
        <h1 id="settings-plugins-title">插件</h1>
        <p>管理 Clawee 可使用的本机扩展能力。</p>
      </header>
      <div className="settings-card">
        <SettingsRow label="Skills 状态" value={status} />
        <SettingsRow label="MCP 服务状态" value={props.runtimeStatus.connected ? '本地服务可用' : '本地服务未连接'} />
        <SettingsRow label="最近检测时间" value={checkedAt} />
      </div>
    </section>
  );
}

function AboutSettings(props: { runtimeStatus: RuntimeStatus; agentId?: string; desktopUpdates?: DesktopUpdates }) {
  const runtimeStatusText = props.runtimeStatus.connected ? '正常' : '未连接';

  return (
    <section className="settings-section" aria-labelledby="settings-about-title">
      <header>
        <h1 id="settings-about-title">关于 Clawee</h1>
        <p>查看版本、数据目录和本地运行信息。</p>
      </header>
      <div className="settings-card">
        <SettingsRow label="Clawee 版本" value={props.desktopUpdates?.state?.currentVersion ?? CLAWEE_APP_VERSION} />
        <SettingsRow label="Runtime 版本" value={props.runtimeStatus.runtimeVersion ?? '未知'} />
        <SettingsRow label="数据目录" value={props.runtimeStatus.codexHome ?? '未设置'} />
      </div>
      <DesktopUpdateSettings updates={props.desktopUpdates} />
      <section className="settings-card settings-advanced" aria-label="高级信息">
        <h2>高级信息</h2>
        <SettingsRow label="当前 Agent ID" value={props.agentId ?? '未知'} />
        <SettingsRow label="Codex CLI 版本" value={props.runtimeStatus.codexVersion ?? '未知'} />
        <SettingsRow label="Codex CLI 路径" value={props.runtimeStatus.codexPath ?? '未设置'} />
        <SettingsRow label="CODEX_HOME" value={props.runtimeStatus.codexHome ?? '未设置'} />
        <SettingsRow label="本地运行内核状态" value={runtimeStatusText} />
        <SettingsRow label="最近一次检测时间" value={props.runtimeStatus.lastCheckedAt ?? '尚未检测'} />
      </section>
    </section>
  );
}

function SettingsRow(props: { label: string; value: string }) {
  return (
    <div className="settings-row">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function SettingsSelectRow(props: {
  label: string;
  value: DefaultPermissionPreference;
  options: Array<{ value: DefaultPermissionPreference; label: string }>;
  onChange(value: DefaultPermissionPreference): void;
}) {
  const labelId = `settings-select-${props.label}`;

  return (
    <label className="settings-row settings-control-row" htmlFor={labelId}>
      <span>{props.label}</span>
      <select
        id={labelId}
        className="settings-select"
        value={props.value}
        onChange={event => props.onChange(event.target.value as DefaultPermissionPreference)}
      >
        {props.options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}
