import { app, dialog } from 'electron';
import { createReadStream } from 'node:fs';
import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import sharp from 'sharp';
import { redactText } from './redaction.js';
import type { DesktopLogger } from './logger.js';
import type { DesktopBootstrapState, DesktopHostResult } from '../shared/types.js';

const lifecycle = new Set(['Clawee Desktop starting', 'Desktop shutdown started', 'Desktop shutdown cleanup completed']);
export async function collectDesktopFeedback(input: { threadId: string; logDir: string; logger: DesktopLogger }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.threadId)) throw new Error('Invalid thread');
  const warnings = ['历史 Desktop 日志无法完整关联会话，只包含白名单生命周期字段。'];
  let flushed = false;
  await Promise.race([input.logger.flush().then(() => { flushed = true; }), new Promise<void>(resolve => { const timer = setTimeout(resolve, 1000); timer.unref(); })]);
  if (!flushed) warnings.push('Desktop 日志 flush 超时。');
  const records: unknown[] = [];
  for (const name of ['desktop-main.log.1', 'desktop-main.log']) {
    try {
      const path = join(input.logDir, name); const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe');
      const stream = createReadStream(path, { end: stat.size - 1 }); const reader = createInterface({ input: stream, crlfDelay: Infinity });
      try { for await (const line of reader) { const entry = JSON.parse(line) as { at?: string; level?: string; message?: string; details?: { thread_id?: string; run_id?: string; request_id?: string } }; if (lifecycle.has(entry.message ?? '') || entry.details?.thread_id === input.threadId) { if (records.length >= 500) { warnings.push('Desktop 导出记录超限，资料为 partial。'); break; } records.push({ timestamp: entry.at, level: entry.level, event: entry.message, thread_id: entry.details?.thread_id, run_id: entry.details?.run_id, request_id: entry.details?.request_id }); } } }
      finally { reader.close(); stream.destroy(); }
    } catch { warnings.push(`${name}:unavailable`); }
  }
  return { environment: { app_version: app.getVersion(), electron_version: process.versions.electron ?? '', platform: process.platform, arch: process.arch }, records, warnings };
}
export async function exportEmergencyFeedback(input: { description: string; screenshots?: import('@clawee/protocol').EmergencyFeedbackScreenshot[]; logDir: string; logger: DesktopLogger; state: DesktopBootstrapState }): Promise<DesktopHostResult> {
  if (!input.description.trim() || input.description.length > 10000) return { ok: false, code: 'FAILED', message: '问题描述无效' };
  const screenshots = []; if ((input.screenshots?.length ?? 0) > 5) throw new Error('截图超限');
  for (const screenshot of input.screenshots ?? []) { if (!(screenshot.data instanceof Uint8Array) || screenshot.data.byteLength > 10 * 1024 * 1024) throw new Error('截图超限'); const data = Buffer.from(screenshot.data); const image = sharp(data, { limitInputPixels: 25000000 }); const info = await image.metadata(); if (!['png', 'jpeg', 'webp'].includes(info.format ?? '') || `image/${info.format}` !== screenshot.content_type || (info.pages ?? 1) > 1) throw new Error('截图格式无效'); await image.raw().toBuffer(); screenshots.push({ content_type: screenshot.content_type, data_base64: data.toString('base64') }); }
  const result = await dialog.showSaveDialog({ title: '导出本地应急反馈', defaultPath: 'clawee-feedback-partial.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return { ok: false, code: 'FAILED', message: '已取消导出' };
  const native = await collectDesktopFeedback({ threadId: 'emergency_local', logDir: input.logDir, logger: input.logger });
  await writeFile(result.filePath, JSON.stringify({ schema_version: 1, description: redactText(input.description), screenshots, completeness: 'partial', missing_items: ['daemon:unavailable', 'conversation:unavailable'], desktop_phase: input.state.phase, native }), { mode: 0o600 }); return { ok: true };
}
