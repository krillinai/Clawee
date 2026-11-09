import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import TOML from '@iarna/toml';
import { isIncidentObservation, resolveFeedbackOrigin, type IncidentObservation } from '@clawee/protocol';
import type { IpcMainInvokeEvent } from 'electron';

export function readIncidentEnterpriseKey(configPath: string | undefined): string {
  if (configPath === undefined) return '';
  try {
    const config = TOML.parse(readFileSync(configPath, 'utf8'));
    if (typeof config.gateway !== 'string' || !config.gateway.trim()) return 'unknown';
    const gateway = new URL(config.gateway.trim());
    if (!['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password
      || gateway.pathname !== '/' || gateway.search || gateway.hash) return 'unknown';
    return createHash('sha256').update(gateway.origin).digest('hex');
  } catch { return 'unknown'; }
}

export function readIncidentGatewayOrigin(configPath: string | undefined): string | undefined {
  if (configPath === undefined) return undefined;
  try {
    const config = TOML.parse(readFileSync(configPath, 'utf8'));
    return typeof config.gateway === 'string' ? resolveFeedbackOrigin(config.gateway) : undefined;
  } catch { return undefined; }
}

export function createDesktopIncidentGate(observe: (observation: IncidentObservation) => void) {
  let stopped = false;
  let restarting = 0;
  return {
    stop() { stopped = true; },
    resume() { stopped = false; },
    async restart<T>(work: () => Promise<T>): Promise<T> {
      restarting++;
      try { return await work(); }
      finally { restarting--; }
    },
    observe(event: IpcMainInvokeEvent, observation: unknown) {
      if (stopped || restarting > 0 || event.senderFrame !== event.sender.mainFrame) return;
      if (!isIncidentObservation(observation) || observation.source !== 'web') return;
      observe(observation);
    }
  };
}

export function incidentE2EFetch(runId: string | undefined, origin: string | undefined): typeof fetch | undefined {
  if (runId === undefined || origin === undefined) return undefined;
  const target = new URL(origin);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('INCIDENT_E2E_ORIGIN_FORBIDDEN');
  }
  return (url, init) => fetch(new URL(new URL(String(url)).pathname, target), init);
}
