import type { IncidentObservation } from '@clawee/protocol';

type WebObservation = Omit<IncidentObservation, 'event_id' | 'source' | 'layer'>;
let observedBridge: Window['claweeDesktop'];
const pendingIncidents = new Map<string, Set<string>>();

export function reportWebIncident(input: WebObservation, recoveryKey = input.stage): void {
  if (typeof window === 'undefined' || !window.claweeDesktop?.reportIncident) return;
  if (observedBridge !== window.claweeDesktop) {
    observedBridge = window.claweeDesktop;
    pendingIncidents.clear();
  }
  const scope = `${input.run_id ?? 'connection'}:${input.stage}`;
  const key = `${input.stage}:${recoveryKey}`;
  let pending = pendingIncidents.get(scope);
  if (input.event_type === 'error') {
    if (!pending) {
      if (pendingIncidents.size >= 100) return;
      pending = new Set();
      pendingIncidents.set(scope, pending);
    }
    if (pending.size >= 100 && !pending.has(key)) return;
    pending.add(key);
  } else if (input.event_type === 'recovered') {
    if (!pending?.delete(key) || pending.size > 0) return;
    pendingIncidents.delete(scope);
  }
  try { void window.claweeDesktop.reportIncident({ ...input, event_id: crypto.randomUUID(), source: 'web', layer: 'web_daemon' }).catch(() => {}); } catch { }
}

export function createWebIncidentObserver() {
  const bridge = typeof window === 'undefined' ? undefined : window.claweeDesktop;
  let active = true;
  return {
    report(input: WebObservation, recoveryKey?: string) {
      if (active && (typeof window === 'undefined' || window.claweeDesktop === bridge)) reportWebIncident(input, recoveryKey);
    },
    dispose() {
      active = false;
    }
  };
}

export function installWindowIncidentReporting(): () => void {
  const error = () => reportWebIncident({ event_type: 'error', stage: 'browser', error_code: 'WEB_UNHANDLED_ERROR' });
  const rejection = () => reportWebIncident({ event_type: 'error', stage: 'browser', error_code: 'WEB_UNHANDLED_REJECTION' });
  window.addEventListener('error', error);
  window.addEventListener('unhandledrejection', rejection);
  return () => {
    window.removeEventListener('error', error);
    window.removeEventListener('unhandledrejection', rejection);
  };
}
