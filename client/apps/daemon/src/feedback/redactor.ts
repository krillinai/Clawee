import { homedir } from 'node:os';
import { redactText, redactValue } from '../security/redaction.js';

const sensitiveKey = /^(?:api[_-]?key|.*token|.*secret|.*password|passwd|authorization|.*cookie|private[_-]?key|credential)$/i;
export function redactFeedback(value: unknown, paths: string[] = []): unknown {
  if (typeof value === 'string') {
    let text = redactText(value).replace(/("[^"\n]*(?:token|secret|password|api[_-]?key|authorization|cookie)[^"\n]*"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2').replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]');
    const prefixes = [...new Set([homedir(), ...paths].filter(path => path.length > 1))].sort((a, b) => b.length - a.length);
    for (const prefix of prefixes) text = text.split(prefix).join(prefix === homedir() ? '[USER_HOME]' : `[PATH_${paths.indexOf(prefix) + 1}]`);
    return text;
  }
  if (Array.isArray(value)) return value.map(entry => redactFeedback(entry, paths));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : redactFeedback(entry, paths)]));
  return redactValue(value);
}
