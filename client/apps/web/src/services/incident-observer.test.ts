import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebIncidentObserver, installWindowIncidentReporting, reportWebIncident } from './incident-observer.js';

const originalBridge = window.claweeDesktop;
afterEach(() => { window.claweeDesktop = originalBridge; });

describe('Web异常恢复关联', () => {
  it('captures unhandled page errors by type without forwarding private error text', () => {
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    const dispose = installWindowIncidentReporting();
    try {
      window.dispatchEvent(new ErrorEvent('error', { message: 'private page content' }));
      window.dispatchEvent(new Event('unhandledrejection'));
      expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({ stage: 'browser', error_code: 'WEB_UNHANDLED_ERROR' }));
      expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({ stage: 'browser', error_code: 'WEB_UNHANDLED_REJECTION' }));
      expect(JSON.stringify(reportIncident.mock.calls)).not.toContain('private page content');
    } finally { dispose(); }
  });
  it('无关请求成功不恢复故障；同范围全部故障恢复后才通知队列', () => {
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    const incident = { stage: 'request', error_code: 'WEB_HTTP_FAILED' };
    reportWebIncident({ ...incident, event_type: 'error' }, 'GET:/runs');
    reportWebIncident({ ...incident, event_type: 'error' }, 'POST:/threads');
    reportWebIncident({ ...incident, event_type: 'recovered' }, 'GET:/healthz');
    reportWebIncident({ ...incident, event_type: 'recovered' }, 'GET:/runs');
    expect(reportIncident).toHaveBeenCalledTimes(2);
    reportWebIncident({ ...incident, event_type: 'recovered' }, 'POST:/threads');
    expect(reportIncident).toHaveBeenCalledTimes(3);
    expect(reportIncident).toHaveBeenLastCalledWith(expect.objectContaining({ event_type: 'recovered' }));
    expect(JSON.stringify(reportIncident.mock.calls)).not.toContain('/threads');
  });

  it('dispose阻止晚到结果；独立run互不恢复', () => {
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    const observer = createWebIncidentObserver();
    observer.report({ event_type: 'error', stage: 'event_stream', error_code: 'WEB_STREAM_ENDED', run_id: 'run_1' });
    observer.report({ event_type: 'recovered', stage: 'event_stream', error_code: 'WEB_STREAM_ENDED', run_id: 'run_2' });
    observer.dispose();
    observer.report({ event_type: 'recovered', stage: 'event_stream', error_code: 'WEB_STREAM_ENDED', run_id: 'run_1' });
    expect(reportIncident).toHaveBeenCalledTimes(1);
  });

  it('连接恢复不等待未重试的请求故障', () => {
    const reportIncident = vi.fn(async () => {});
    window.claweeDesktop = { reportIncident } as unknown as typeof window.claweeDesktop;
    reportWebIncident({ event_type: 'error', stage: 'request', error_code: 'WEB_REQUEST_FAILED' }, 'GET:/runs');
    reportWebIncident({ event_type: 'error', stage: 'connection', error_code: 'WEB_DISCONNECTED' });
    reportWebIncident({ event_type: 'recovered', stage: 'connection', error_code: 'WEB_DISCONNECTED' });
    expect(reportIncident).toHaveBeenCalledTimes(3);
    expect(reportIncident).toHaveBeenLastCalledWith(expect.objectContaining({ event_type: 'recovered', stage: 'connection' }));
  });
});
