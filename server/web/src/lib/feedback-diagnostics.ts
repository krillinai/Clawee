export type ConsoleError = {
  at: string;
  kind: string;
  message: string;
  stack: string;
  method: string;
  path: string;
  status: number;
};

const errors: ConsoleError[] = [];
let enabled = false;
let dropped = 0;

export function redactConsoleText(value: string) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/[a-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)[a-z0-9_-]*["\s]*[:=]["\s]*(?:bearer\s+)?[^\s"',}\]]+/gi, '[REDACTED]')
    .replace(/\bbearer\s+[a-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(?:\/Users\/[^/\s"']+|\/home\/[^/\s"']+|[a-z]:\\Users\\[^\\\s"']+)/gi, '[USER_HOME]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '[REDACTED]');
}

function record(entry: Partial<ConsoleError> & Pick<ConsoleError, 'kind'>) {
  if (!enabled || !/^\/admin(?:\/|$)/.test(location.pathname)) return;
  const message = redactConsoleText(entry.message ?? '');
  const stack = redactConsoleText(entry.stack ?? '');
  if (message.length > 1024 || stack.length > 4096) dropped++;
  errors.push({ at: new Date().toISOString(), kind: entry.kind, message: message.slice(0, 1024), stack: stack.slice(0, 4096), method: entry.method ?? '', path: entry.path ?? '', status: entry.status ?? 0 });
  if (errors.length > 50) { errors.shift(); dropped++; }
}

export function recordFeedbackRequestFailure(method: string, path: string, status = 0) {
  record({ kind: status ? 'http_error' : 'network_error', method, path: redactConsoleText(path.split(/[?#]/)[0] ?? '').slice(0, 256), status });
}

export function startFeedbackDiagnostics() {
  enabled = true;
  const onError = (event: ErrorEvent) => record({ kind: 'web_error', message: event.message, stack: event.error instanceof Error ? event.error.stack : '' });
  const onRejection = (event: PromiseRejectionEvent) => record({ kind: 'unhandled_rejection', message: event.reason instanceof Error ? event.reason.message : typeof event.reason === 'string' ? event.reason : 'Unhandled rejection', stack: event.reason instanceof Error ? event.reason.stack : '' });
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    enabled = false; errors.length = 0; dropped = 0;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

export function feedbackDiagnosticsSnapshot() {
  return { errors: errors.map(entry => ({ ...entry })), dropped_errors: dropped };
}

export function feedbackRandomToken() {
  const data = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
