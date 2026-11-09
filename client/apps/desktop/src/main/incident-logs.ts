import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { INCIDENT_LOG_MAX_BYTES, type AutomaticIncident } from '@clawee/protocol';
import { redactText, redactValue } from './redaction.js';

export function captureIncidentLogs(input: { logDir: string; dataDir: string; incident: AutomaticIncident }): string {
  const sources = ['desktop-main.log.1', 'desktop-main.log'].map(name => ({ name, path: join(input.logDir, name) }));
  if (input.incident.run_id && /^[A-Za-z0-9_-]{1,128}$/.test(input.incident.run_id)) {
    sources.push({ name: 'runtime-stderr.log', path: join(input.dataDir, 'runs', input.incident.run_id, 'stderr.redacted.log') });
  }
  const records = sources.map(source => {
    let descriptor: number | undefined;
    try {
      // Windows does not expose O_NOFOLLOW; reject links before opening on every platform.
      const entry = lstatSync(source.path, { bigint: true });
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('not_regular_file');
      descriptor = openSync(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = fstatSync(descriptor, { bigint: true });
      if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error('not_regular_file');
      const size = Number(stat.size);
      const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
      const length = readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      let content = buffer.subarray(0, length).toString('utf8');
      if (size > buffer.length) {
        const newline = content.indexOf('\n');
        if (newline >= 0) content = content.slice(newline + 1);
      }
      return { source: source.name, content: redactText(content), total_bytes: size, truncated: size > buffer.length, missing: false };
    } catch {
      return { source: source.name, content: '', total_bytes: 0, truncated: false, missing: true };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  });
  const header = { captured_at: new Date().toISOString(), incident_id: input.incident.incident_id, run_id: input.incident.run_id, scope: 'first_error_snapshot', credentials_filtered: true,
    incident: redactValue({ source: input.incident.source, layer: input.incident.layer, stage: input.incident.stage, error_code: input.incident.error_code,
      http_status: input.incident.http_status, duration_ms: input.incident.duration_ms, diagnostics: input.incident.first_diagnostics ?? input.incident.diagnostics }) };
  const encode = () => [header, ...records].map(record => JSON.stringify(record)).join('\n') + '\n';
  let text = encode();
  while (Buffer.byteLength(text) > INCIDENT_LOG_MAX_BYTES) {
    for (const record of records) {
      record.content = record.content.slice(Math.floor(record.content.length / 2));
      if (!record.missing) record.truncated = true;
    }
    text = encode();
  }
  return text;
}
