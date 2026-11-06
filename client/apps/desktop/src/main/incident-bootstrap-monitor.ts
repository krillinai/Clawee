import { randomUUID } from 'node:crypto';
import { incidentErrorDiagnostics, safeIncidentIdentifier } from '@clawee/protocol';
import type { DesktopBootstrapState } from '../shared/types.js';
import type { AutoIncidentReporter } from './auto-incidents.js';

export class IncidentBootstrapMonitor {
  private attempt = -1;
  private scope = randomUUID();
  private state?: DesktopBootstrapState;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  constructor(private readonly reporter: Pick<AutoIncidentReporter, 'observe'>) {}
  update(state: DesktopBootstrapState) {
    this.state = state;
    if (this.stopped) return;
    if (['idle', 'migrating_data'].includes(state.phase)) { clearTimeout(this.timer); return; }
    if (this.attempt !== state.attempt) {
      clearTimeout(this.timer); this.attempt = state.attempt; this.scope = randomUUID();
      this.timer = undefined;
    }
    if (this.timer === undefined && !['ready', 'failed', 'workspace_failed'].includes(state.phase)) {
      this.timer = setTimeout(() => {
        if (!this.state || this.stopped) return;
        this.reporter.observe({ event_id: randomUUID(), event_type: 'error', source: 'desktop', layer: 'desktop_bootstrap',
          stage: this.state.phase, error_code: 'RUNTIME_STARTUP_STALLED', scope_id: this.scope, duration_ms: 60_000 });
      }, 60_000);
      this.timer.unref?.();
    }
    if (state.phase === 'ready' || state.phase === 'failed' || state.phase === 'workspace_failed') {
      clearTimeout(this.timer); this.timer = undefined;
      if (state.phase === 'ready') this.reporter.observe({ event_id: randomUUID(), event_type: 'recovered', source: 'desktop', layer: 'desktop_bootstrap', stage: 'ready', error_code: 'RUNTIME_READY', scope_id: this.scope });
      else if (state.error?.code !== 'DAEMON_START_CANCELLED') {
        this.reporter.observe({ event_id: randomUUID(), event_type: 'error', source: 'desktop', layer: 'desktop_bootstrap', stage: state.phase,
          error_code: safeIncidentIdentifier(state.error?.code) ?? 'RUNTIME_START_FAILED', scope_id: this.scope, diagnostics: incidentErrorDiagnostics(state.error) });
        this.reporter.observe({ event_id: randomUUID(), event_type: 'finished', source: 'desktop', layer: 'desktop_bootstrap', stage: state.phase,
          error_code: 'RUNTIME_START_FAILED', scope_id: this.scope, task_outcome: 'failed' });
      }
    }
  }
  exit(event: { code: number | null; reason: string }) {
    if (this.stopped || event.reason !== 'unexpected') return;
    if (this.state?.phase === 'ready') this.scope = randomUUID();
    this.reporter.observe({ event_id: randomUUID(), event_type: 'error', source: 'desktop', layer: 'desktop_bootstrap', stage: 'daemon_exit',
      error_code: 'DAEMON_UNEXPECTED_EXIT', scope_id: this.scope, ...(event.code === null ? {} : { exit_code: event.code }) });
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
  resume() { this.stopped = false; this.attempt = -1; }
}
