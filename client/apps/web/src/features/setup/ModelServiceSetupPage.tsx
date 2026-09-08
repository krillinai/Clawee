import type {
  ConfigureModelServiceRequest,
  ModelServiceConfigurationStatusResponse
} from '@clawee/protocol';
import {
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LogOut,
  Play,
  RefreshCw,
  Server
} from 'lucide-react';
import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useRef,
  useState
} from 'react';
import { ApiClientError } from '../../runtime/errors.js';

export type ModelServiceSetupPageProps = {
  status: ModelServiceConfigurationStatusResponse;
  integratedTitleBar?: {
    integratedTitleBar: true;
    titleBarHeight: number;
    trafficLightInset: number;
  };
  onConfigure(input: ConfigureModelServiceRequest): Promise<void>;
};

export function ModelServiceSetupPage(
  props: ModelServiceSetupPageProps
) {
  const [baseUrl, setBaseUrl] = useState(
    props.status.configuration?.baseUrl ?? ''
  );
  const [model, setModel] = useState(
    props.status.configuration?.model ?? ''
  );
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const apiKeyRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setBaseUrl(props.status.configuration?.baseUrl ?? '');
    setModel(props.status.configuration?.model ?? '');
  }, [props.status.configuration]);

  const shellStyle = props.integratedTitleBar === undefined
    ? undefined
    : {
        '--clawee-titlebar-height':
          `${props.integratedTitleBar.titleBarHeight}px`,
        '--clawee-traffic-light-inset':
          `${props.integratedTitleBar.trafficLightInset}px`
      } as CSSProperties;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !event.currentTarget.reportValidity()) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await props.onConfigure({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim()
      });
      setApiKey('');
      if (apiKeyRef.current !== null) apiKeyRef.current.value = '';
    } catch (reason) {
      setApiKey('');
      if (apiKeyRef.current !== null) apiKeyRef.current.value = '';
      setError(formatConfigurationError(reason));
      window.setTimeout(() => apiKeyRef.current?.focus(), 0);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="app-drop-shell model-service-setup"
      data-integrated-title-bar={
        props.integratedTitleBar?.integratedTitleBar === true
          ? 'true'
          : undefined
      }
      style={shellStyle}
    >
      {props.integratedTitleBar?.integratedTitleBar === true ? (
        <div className="desktop-titlebar-drag-region" aria-hidden="true" />
      ) : null}
      <main className="model-service-setup__main">
        <header className="model-service-setup__header">
          <span className="model-service-setup__brand">Clawee</span>
          <h1>配置 Codex 模型服务</h1>
          <p>验证通过后才能进入工作台。</p>
        </header>

        <form
          className="model-service-setup__form"
          aria-label="Codex 模型服务配置"
          onSubmit={submit}
        >
          <label>
            <span><Server size={16} aria-hidden="true" />Base URL</span>
            <input
              aria-label="Base URL"
              autoFocus
              type="url"
              inputMode="url"
              autoComplete="url"
              required
              maxLength={2048}
              value={baseUrl}
              placeholder="https://api.example.com/v1"
              disabled={submitting}
              onChange={event => setBaseUrl(event.target.value)}
            />
          </label>

          <label>
            <span>Model</span>
            <input
              aria-label="Model"
              type="text"
              autoComplete="off"
              required
              maxLength={200}
              value={model}
              placeholder="gpt-5"
              disabled={submitting}
              onChange={event => setModel(event.target.value)}
            />
          </label>

          <label>
            <span><KeyRound size={16} aria-hidden="true" />API Key</span>
            <span className="model-service-setup__secret">
              <input
                aria-label="API Key"
                ref={apiKeyRef}
                type={showApiKey ? 'text' : 'password'}
                autoComplete="new-password"
                required
                value={apiKey}
                placeholder="输入 API Key"
                disabled={submitting}
                onChange={event => setApiKey(event.target.value)}
              />
              <button
                type="button"
                aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                disabled={submitting}
                onClick={() => setShowApiKey(value => !value)}
              >
                {showApiKey
                  ? <EyeOff size={17} aria-hidden="true" />
                  : <Eye size={17} aria-hidden="true" />}
              </button>
            </span>
            <small>API Key 仅保存到本机私有凭据文件。</small>
          </label>

          {error !== undefined ? (
            <p className="model-service-setup__error" role="alert">
              {error}
            </p>
          ) : null}

          <button
            className="model-service-setup__submit"
            type="submit"
            disabled={submitting}
          >
            {submitting
              ? (
                  <LoaderCircle
                    size={17}
                    className="model-service-setup__spinner"
                    aria-hidden="true"
                  />
                )
              : <Play size={17} fill="currentColor" />}
            {submitting ? '正在验证模型服务' : '验证并启动 Clawee'}
          </button>
        </form>
      </main>
    </div>
  );
}

export function ModelAccessStatusPage(props: {
  status: 'resolving' | 'unavailable';
  integratedTitleBar?: ModelServiceSetupPageProps['integratedTitleBar'];
  onRetry(): void;
  onLogout(): void;
}) {
  const shellStyle = props.integratedTitleBar === undefined
    ? undefined
    : {
        '--clawee-titlebar-height':
          `${props.integratedTitleBar.titleBarHeight}px`,
        '--clawee-traffic-light-inset':
          `${props.integratedTitleBar.trafficLightInset}px`
      } as CSSProperties;
  return (
    <div
      className="app-drop-shell model-service-setup"
      data-integrated-title-bar={
        props.integratedTitleBar?.integratedTitleBar === true
          ? 'true'
          : undefined
      }
      style={shellStyle}
    >
      {props.integratedTitleBar?.integratedTitleBar === true ? (
        <div className="desktop-titlebar-drag-region" aria-hidden="true" />
      ) : null}
      <main className="model-service-setup__main">
        <header className="model-service-setup__header">
          <span className="model-service-setup__brand">Clawee</span>
          <h1>{props.status === 'resolving' ? '正在准备模型服务' : '模型服务暂不可用'}</h1>
          <p>{props.status === 'resolving' ? '正在验证当前部署的模型配置。' : '请重试或退出当前企业账户。'}</p>
        </header>
        <div className="model-service-setup__form">
          {props.status === 'resolving' ? (
            <LoaderCircle
              aria-label="正在准备模型服务"
              className="model-service-setup__spinner"
              size={22}
            />
          ) : (
            <button className="model-service-setup__submit" type="button" onClick={props.onRetry}>
              <RefreshCw size={17} aria-hidden="true" />重试
            </button>
          )}
          <button type="button" onClick={props.onLogout}>
            <LogOut size={17} aria-hidden="true" />退出账户
          </button>
        </div>
      </main>
    </div>
  );
}

function formatConfigurationError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'MODEL_SERVICE_VALIDATION_FAILED') {
      return '验证失败，请检查 Base URL、API Key 和模型名称。';
    }
    if (error.code === 'MODEL_SERVICE_SECURE_STORAGE_UNAVAILABLE') {
      return '本地私有凭据文件不可用，无法保存 API Key。';
    }
    if (error.code === 'MODEL_SERVICE_CONFIGURATION_BUSY') {
      return '模型服务正在验证，请稍候。';
    }
    if (error.code === 'MODEL_SERVICE_CONFIGURATION_INVALID') {
      return error.message.replace(
        /^MODEL_SERVICE_CONFIGURATION_INVALID:\s*/,
        ''
      );
    }
  }
  return error instanceof Error ? error.message : '模型服务配置失败';
}
