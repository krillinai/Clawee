import { useEffect, useRef } from 'react';
import type { HostBridge } from '../../host/bridge.js';
import type { ConnectionConfig } from '../../runtime/types.js';
import type { ConnectionState, createConnectionService } from '../../services/connection-service.js';

type Input = {
  hostBridge: HostBridge;
  config: ConnectionConfig | null;
  service: ReturnType<typeof createConnectionService> | null;
  onConfig(config: ConnectionConfig | null): void;
  onState(state: ConnectionState): void;
  onResume?(): void | Promise<void>;
};

export function useRuntimeConnection(input: Input) {
  const latest = useRef(input);
  latest.current = input;
  const retryRef = useRef<() => Promise<void>>(async () => {});
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let canceled = false;
    let reading: Promise<void> | undefined;
    let version = 0;
    let firstRead = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resumeWork: Promise<void> | undefined;
    const applyConfig = (config: ConnectionConfig | null, force = false) => {
      const current = latest.current.config;
      if (force || current?.baseUrl !== config?.baseUrl || current?.token !== config?.token || (current === null) !== (config === null)) {
        input.onConfig(config === null ? null : { ...config });
      }
    };
    const readConfig = (): Promise<void> => {
      if (reading !== undefined) return reading;
      const request = version;
      reading = readConfigWithTimeout(input.hostBridge).then(config => {
        if (!canceled && request === version) { applyConfig(config, firstRead); firstRead = false; }
      }).catch(() => undefined).finally(() => { reading = undefined; });
      return reading;
    };
    const refresh = async () => {
      if (canceled) return;
      await readConfig();
      if (!canceled) await retryRef.current();
    };
    refreshRef.current = refresh;
    const refreshAndNotify = () => {
      if (resumeWork !== undefined) return resumeWork;
      const work = refresh().then(() => {
        if (!canceled && document.visibilityState === 'visible') {
          return latest.current.onResume?.();
        }
      }).then(() => undefined).finally(() => {
        if (resumeWork === work) resumeWork = undefined;
      });
      resumeWork = work;
      return work;
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshAndNotify().catch(() => undefined); };
    const onFocus = () => { void refreshAndNotify().catch(() => undefined); };
    const onOnline = () => { void refreshAndNotify().catch(() => undefined); };
    const pollConfig = () => {
      if (canceled) return;
      if (latest.current.config === null) refresh();
      timer = setTimeout(pollConfig, 2_000);
    };
    const unsubscribe = input.hostBridge.subscribeConnectionConfig?.(config => {
      version += 1;
      if (canceled) return;
      applyConfig(config, true);
      if (config === null) input.onState({ status: 'disconnected', message: '正在恢复本地服务连接' });
      else void retryRef.current();
    });
    refresh();
    timer = setTimeout(pollConfig, 2_000);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      canceled = true;
      clearTimeout(timer);
      unsubscribe?.();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [input.hostBridge]);

  useEffect(() => {
    let canceled = false;
    let checking = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const service = input.service;
    const check = async () => {
      if (canceled || checking) return;
      clearTimeout(timer);
      if (service === null) {
        input.onState({ status: 'disconnected', message: '正在等待本地服务' });
        return;
      }
      checking = true;
      try {
        const state = await service.check();
        if (canceled) return;
        input.onState(state);
        const available = state.status === 'connected' || state.status === 'configuration_required';
        failures = available ? 0 : failures + 1;
      } finally {
        checking = false;
        if (!canceled) timer = setTimeout(() => void check(), failures === 0 ? 15_000 : Math.min(1_000 * 2 ** (failures - 1), 15_000));
      }
    };
    retryRef.current = check;
    void check();
    return () => { canceled = true; clearTimeout(timer); };
  }, [input.service]);

  return () => refreshRef.current();
}

async function readConfigWithTimeout(hostBridge: HostBridge): Promise<ConnectionConfig | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => hostBridge.readConnectionConfig()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('读取本地连接超时')), 5_000);
      })
    ]);
  } finally { clearTimeout(timer); }
}
