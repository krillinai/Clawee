import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  FileText,
  FileSpreadsheet,
  FilePenLine,
  GitBranch,
  Globe2,
  Image as ImageIcon,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  Pencil,
  Presentation,
  Quote,
  ShieldCheck,
  ShieldX
} from 'lucide-react';
import {
  Component,
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { MarkdownRenderer } from '../markdown/MarkdownRenderer.js';
import { copyToClipboard } from '../markdown/clipboard.js';
import { extractWorkspaceFilePaths, isWorkspaceFilePath } from '../markdown/markdown-inline.js';
import { ApprovalPanel } from '../../features/approvals/ApprovalPanel.js';
import type { TimelineItem } from './timeline-model.js';
import { collapseModelResponseErrors } from './model-response-status.js';
import { redactIncidentCredentials, type ModelResponseError, type RunResponse } from '@clawee/protocol';
import { useTimelineReading } from './use-timeline-reading.js';
import { DocumentArtifact, type DocumentArtifactActions } from './DocumentArtifact.js';

type ProcessTimelineItem = Extract<
  TimelineItem,
  { kind: 'reasoning_summary' | 'run_status' | 'tool_step' | 'diagnostic' | 'done' }
>;
type VisibleProcessItem = Extract<
  ProcessTimelineItem,
  { kind: 'reasoning_summary' | 'tool_step' | 'diagnostic' | 'done' }
>;
type ToolStepItem = Extract<ProcessTimelineItem, { kind: 'tool_step' }>;
type ToolCallView = {
  key: string;
  item: ToolStepItem;
  activity: string;
  title: string;
  command?: string;
  // The command, file path or URL shown when the group is expanded.
  detail?: string;
  running: boolean;
  result?: ToolResultSummary;
};
type ProcessDisplayStep =
  | { type: 'narration'; key: string; text: string; transient: boolean }
  | { type: 'tools'; key: string; calls: ToolCallView[] }
  | { type: 'status'; key: string; item: VisibleProcessItem }
  | { type: 'live'; key: string; text: string; idle: boolean; markdown?: boolean };

type ToolResultSummary = { failed: boolean; exitCode?: number; output: string };

type ProcessBlock = {
  type: 'process';
  key: string;
  runId?: string;
  terminalStatus?: string;
  approvedCommandExecution?: boolean;
  hasBody?: boolean;
  statusPending?: boolean;
  items: ProcessTimelineItem[];
};

type ChangeBlock = {
  type: 'changes';
  key: string;
  runId: string;
  items: Array<Extract<TimelineItem, { kind: 'change_card' }>>;
};

type TimelineRenderItem = { type: 'item'; item: TimelineItem } | ProcessBlock | ChangeBlock;
const PROCESS_ELAPSED_LABEL_DELAY_MS = 10_000;

function isProcessTimelineItem(item: TimelineItem): item is ProcessTimelineItem {
  if (item.kind === 'diagnostic') return hasRunId(item);

  return item.kind === 'reasoning_summary'
    || item.kind === 'run_status'
    || item.kind === 'tool_step'
    || item.kind === 'done';
}

function isInternalRuntimeDiagnostic(item: TimelineItem): boolean {
  if (item.kind !== 'diagnostic' || item.severity !== 'warning') return false;
  return /skill descriptions were shortened to fit the .*skills context budget/i.test(item.message);
}

function getTimelineTitle(item: TimelineItem): string {
  switch (item.kind) {
    case 'user_message':
      return '你';
    case 'schedule_trigger':
      return '定时执行';
    case 'workflow_start':
    case 'workflow_status':
      return '工作流';
    case 'assistant_message':
      return 'Clawee';
    case 'change_card':
      return '文件变更';
    case 'approval':
      return '需要确认';
    case 'reasoning_summary':
    case 'tool_step':
    case 'diagnostic':
    case 'run_status':
    case 'done':
      return '处理过程';
    default:
      const _exhaustive: never = item;
      return _exhaustive;
  }
}

function getTimelineAvatar(item: TimelineItem): string {
  if (item.kind === 'user_message') return '你';
  if (item.kind === 'schedule_trigger') return '定';
  if (item.kind === 'change_card') return 'Δ';
  if (item.kind === 'assistant_message') return 'C';
  return '·';
}

function renderTimelineAvatar(item: TimelineItem) {
  if (item.kind === 'assistant_message') {
    return <span className="timeline-avatar-logo" aria-hidden="true" />;
  }
  if (item.kind === 'schedule_trigger') {
    return <Clock3 aria-hidden="true" size={14} />;
  }
  if (item.kind === 'workflow_start' || item.kind === 'workflow_status') {
    return <GitBranch aria-hidden="true" size={14} />;
  }

  return getTimelineAvatar(item);
}

function shouldRenderTimelineHeader(item: TimelineItem) {
  return item.kind !== 'user_message'
    && item.kind !== 'assistant_message'
    && item.kind !== 'approval';
}

function isProcessComplete(process: ProcessBlock): boolean {
  return process.terminalStatus !== undefined || process.items.some(item => item.kind === 'done');
}

function hasFailedOrCanceledDone(process: ProcessBlock): boolean {
  return process.items.some(item => item.kind === 'done' && item.status !== 'succeeded');
}

function visibleProcessItems(process: ProcessBlock): VisibleProcessItem[] {
  return process.items.filter((item): item is VisibleProcessItem => {
    if (item.kind === 'done') return item.status !== 'succeeded';
    return item.kind === 'reasoning_summary'
      || item.kind === 'tool_step'
      || item.kind === 'diagnostic';
  });
}

function countVisibleProcessItems(process: ProcessBlock): number {
  let count = 0;
  for (const item of process.items) {
    if (item.kind === 'done') {
      if (item.status !== 'succeeded') count += 1;
      continue;
    }
    if (
      item.kind === 'reasoning_summary'
      || item.kind === 'tool_step'
      || item.kind === 'diagnostic'
    ) {
      count += 1;
    }
  }
  return count;
}

function hasVisibleProcessContent(process: ProcessBlock): boolean {
  return countVisibleProcessItems(process) > 0;
}

function hasStartedRun(process: ProcessBlock): boolean {
  return process.runId !== undefined
    && process.items.some(item => item.kind === 'run_status' && item.label !== 'queued');
}

function shouldRenderProcess(process: ProcessBlock): boolean {
  if (process.hasBody) return true;
  if (process.items.every(item => item.kind === 'run_status' && item.label === 'queued')) {
    return false;
  }
  return hasVisibleProcessContent(process) || !isProcessComplete(process) || hasStartedRun(process);
}

function getProcessDuration(process: ProcessBlock): string | undefined {
  const timestamps = process.items.flatMap(item => {
    if (item.timestamp === undefined) return [];
    const value = Date.parse(item.timestamp);
    return Number.isFinite(value) ? [value] : [];
  });
  if (timestamps.length < 2 || !isProcessComplete(process)) return undefined;
  return formatDuration(Math.max(...timestamps) - Math.min(...timestamps));
}

function getProcessStartedAt(process: ProcessBlock): number | undefined {
  const timestamps = process.items.flatMap(item => {
    if (item.timestamp === undefined) return [];
    const value = Date.parse(item.timestamp);
    return Number.isFinite(value) ? [value] : [];
  });
  return timestamps.length === 0 ? undefined : Math.min(...timestamps);
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}分钟` : `${minutes}分${seconds}秒`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}小时` : `${hours}小时${remainingMinutes}分钟`;
}

function safeParseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPayloadType(item: ProcessTimelineItem): string | undefined {
  if (!('content' in item) || typeof item.content !== 'string') return undefined;
  const payload = safeParseJson(item.content);
  if (!isRecord(payload)) return undefined;
  const type = payload.type;
  return typeof type === 'string' ? type : undefined;
}

function getToolCallId(item: ProcessTimelineItem): string | undefined {
  if (item.kind !== 'tool_step') return undefined;
  const payload = safeParseJson(item.content);
  if (!isRecord(payload)) return undefined;
  const toolCallId = payload.toolCallId;
  return typeof toolCallId === 'string' && toolCallId.length > 0 ? toolCallId : undefined;
}

function getStringField(record: Record<string, unknown>, fieldNames: string[]): string | undefined {
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function getStringArgs(record: Record<string, unknown>): string[] {
  const args = record.args;
  if (!Array.isArray(args)) return [];
  return args.filter((arg): arg is string => typeof arg === 'string' && arg.length > 0);
}

function formatCommandArg(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function formatCommandFromInput(input: Record<string, unknown>): string | undefined {
  const command = getStringField(input, ['command', 'cmd']);
  const args = getStringArgs(input);
  const argsText = args.map(formatCommandArg).join(' ');

  if (command !== undefined && argsText.length > 0) return `${command} ${argsText}`;
  if (command !== undefined) return command;
  if (argsText.length > 0) return argsText;

  const raw = input.raw;
  if (!isRecord(raw)) return undefined;
  return formatCommandFromInput(raw);
}

function getToolCommand(item: Extract<ProcessTimelineItem, { kind: 'tool_step' }>): string | undefined {
  const payload = safeParseJson(item.content);
  if (!isRecord(payload) || payload.type !== 'tool_use' || !isRecord(payload.input)) return undefined;
  return formatCommandFromInput(payload.input);
}

const TOOL_DETAIL_FIELDS = ['path', 'file_path', 'filePath', 'file', 'url', 'query', 'q', 'pattern'];
const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu;

function getPatchFiles(text: string): string[] {
  return [...text.matchAll(PATCH_FILE_HEADER)].map(match => match[1]!.trim());
}

function getToolDetail(item: Extract<ProcessTimelineItem, { kind: 'tool_step' }>): string | undefined {
  const payload = safeParseJson(item.content);
  if (!isRecord(payload) || payload.type !== 'tool_use') return undefined;
  const input = payload.input;
  if (typeof input === 'string') return getPatchFiles(input).join('\n') || undefined;
  if (!isRecord(input)) return undefined;
  const command = formatCommandFromInput(input);
  if (command !== undefined) return command;
  // MCP calls nest their parameters under `arguments`; commands keep the item under `raw`.
  const record = {
    ...(isRecord(input.raw) ? input.raw : {}),
    ...(isRecord(input.arguments) ? input.arguments : {}),
    ...input
  };
  const field = getStringField(record, TOOL_DETAIL_FIELDS);
  if (field !== undefined) return field;
  if (Array.isArray(record.changes)) {
    const paths = record.changes
      .map(change => (isRecord(change) ? getStringField(change, ['path', 'file_path']) : undefined))
      .filter((path): path is string => path !== undefined);
    if (paths.length > 0) return paths.join('\n');
  }
  for (const value of Object.values(record)) {
    if (typeof value !== 'string') continue;
    const files = getPatchFiles(value);
    if (files.length > 0) return files.join('\n');
  }
  return undefined;
}

function getToolResult(item: Extract<ProcessTimelineItem, { kind: 'tool_step' }>): ToolResultSummary | undefined {
  const payload = safeParseJson(item.content);
  if (!isRecord(payload) || payload.type !== 'tool_result') return undefined;
  const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : undefined;
  const output = typeof payload.output === 'string' ? payload.output.trimEnd() : '';
  return {
    failed: payload.isError === true || (exitCode !== undefined && exitCode !== 0),
    ...(exitCode === undefined ? {} : { exitCode }),
    output
  };
}

function getToolActivity(
  toolName: string,
  command?: string
): string {
  const normalizedName = toolName.toLocaleLowerCase().split(/[.:/]/u).at(-1) ?? toolName;
  if (
    normalizedName === 'exec_command'
    || normalizedName === 'command_execution'
    || normalizedName === 'shell'
    || normalizedName === 'bash'
  ) {
    return getCommandActivity(command);
  }
  if (
    normalizedName.includes('apply_patch')
    || normalizedName.includes('edit')
    || normalizedName.includes('write')
  ) return '修改项目文件';
  if (
    normalizedName.includes('image')
    || normalizedName.includes('screenshot')
  ) return '查看图片';
  if (
    normalizedName.includes('browser')
    || normalizedName.includes('chrome')
    || normalizedName.includes('playwright')
  ) return '操作浏览器';
  if (
    normalizedName.includes('web')
    || normalizedName.includes('query')
    || normalizedName.includes('search')
  ) return '查询资料';
  if (
    normalizedName.includes('read')
    || normalizedName.includes('open')
    || normalizedName.includes('find')
  ) return '查看项目内容';
  if (
    normalizedName.includes('lark')
    || normalizedName.includes('docs')
  ) return '处理飞书文档';
  return '执行开发操作';
}

function getCompletedActivityLabel(activity: string, count = 1): string {
  const label = (() => {
    switch (activity) {
      case '查看项目内容':
        return '已读取文件';
      case '搜索代码':
        return '已搜索代码';
      case '查看目录':
        return '已查看目录';
      case '查看图片':
        return '已查看图片';
      case '操作浏览器':
        return '已使用浏览器';
      case '查询资料':
        return '已查询资料';
      case '处理飞书文档':
        return '已处理飞书文档';
      case '修改项目文件':
        return '已更新文件';
      case '运行测试':
        return '已运行测试';
      case '打包应用':
        return '已打包应用';
      case '构建应用':
        return '已构建应用';
      case '检查代码变更':
        return '已检查代码变更';
      case '更新代码':
        return '已更新代码';
      default:
        return `已${activity}`;
    }
  })();

  if (count === 1) return label;
  return `${label}（${count} 次）`;
}

function unwrapShellCommand(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/u.exec(command.trim());
  return match === null ? command : match[2]!;
}

// Activities whose generic label is replaced by what the command actually touched.
const SPECIFIC_COMMAND_ACTIVITIES = new Set(['执行本地命令', '查看项目内容', '搜索代码', '查看目录', '更新代码']);
const SCRIPT_LANGUAGES: Record<string, string> = {
  python: 'Python', python3: 'Python', node: 'Node', bun: 'Bun', deno: 'Deno', tsx: 'Node', ruby: 'Ruby', perl: 'Perl'
};

function truncateLabel(text: string, max = 40): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function humanizeName(name: string): string {
  return name.split(/[-_]/u).filter(Boolean).map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ');
}

function urlHost(value: string): string {
  try {
    return new URL(value).host.replace(/^www\./u, '');
  } catch {
    return value;
  }
}

function isPathLike(value: string): boolean {
  return /^[\w.~@/-]+$/u.test(value) && /[./]/u.test(value) && !/^\d+(?:,\d+)?p$/u.test(value);
}

function basename(path: string): string {
  return path.replace(/\/+$/u, '').split('/').pop() || path;
}

/** Turns a shell command into a short verb and object, e.g. 请求 cnbc.com. */
function describeCommand(command: string): { verb: string; target: string } {
  const inner = unwrapShellCommand(command);
  const skill = /skills\/([^/\s'"]+)\/SKILL\.md/iu.exec(inner);
  if (skill !== null) return { verb: '读取', target: `${humanizeName(skill[1]!)} 技能` };

  const segments = inner.split(/\s*(?:&&|\|\||;)\s*|\s\|\s/u).map(part => part.trim()).filter(Boolean);
  const segment = segments.find(part => !/^cd\s/u.test(part)) ?? segments[0] ?? inner;
  const tokens = (segment.match(/"[^"]*"|'[^']*'|\S+/gu) ?? []).map(token => token.replace(/^(['"])([\s\S]*)\1$/u, '$2'));
  const program = basename(tokens[0] ?? '');
  const args = tokens.slice(1);
  if (['sh', 'bash', 'zsh'].includes(program)) {
    const scriptIndex = args.findIndex(arg => /^-[a-z]*c$/u.test(arg));
    const script = scriptIndex >= 0 ? args[scriptIndex + 1] : undefined;
    if (script !== undefined && script !== command) return describeCommand(script);
  }
  const operands = args.filter(arg => !arg.startsWith('-') && !arg.startsWith('<<'));
  const url = args.find(arg => /^https?:\/\//iu.test(arg));

  if (program === 'curl' || program === 'wget' || program === 'http') {
    return url === undefined ? { verb: '运行', target: program } : { verb: '请求', target: urlHost(url) };
  }
  if (program === 'open' || program === 'xdg-open') {
    return { verb: '打开', target: url === undefined ? basename(operands[0] ?? '文件') : urlHost(url) };
  }
  if (program === 'command' || program === 'which') {
    return { verb: '检查', target: operands.at(-1) ?? program };
  }
  const language = SCRIPT_LANGUAGES[program];
  if (language !== undefined) {
    const inline = args.some(arg => arg === '-' || arg === '-c' || arg === '-e') || segment.includes('<<');
    return { verb: '运行', target: inline || operands[0] === undefined ? `${language} 脚本` : basename(operands[0]) };
  }
  if (['cat', 'head', 'tail', 'sed', 'less', 'nl', 'wc', 'bat'].includes(program)) {
    const path = operands.slice().reverse().find(isPathLike);
    return { verb: '读取', target: path === undefined ? '文件' : basename(path) };
  }
  const searchArgs = program === 'git' && args[0] === 'grep' ? operands.slice(1) : operands;
  if (['rg', 'grep', 'ag'].includes(program) || (program === 'git' && args[0] === 'grep')) {
    return { verb: '搜索', target: searchArgs[0] === undefined ? '代码' : `“${truncateLabel(searchArgs[0], 24)}”` };
  }
  if (['ls', 'tree', 'find', 'fd', 'pwd'].includes(program)) {
    return operands[0] === undefined || operands[0] === '.'
      ? { verb: '查看当前目录', target: '' }
      : { verb: '查看', target: truncateLabel(operands[0]) };
  }
  if (program === 'git') return { verb: '运行', target: `git ${args[0] ?? ''}`.trim() };
  if (['pnpm', 'npm', 'yarn', 'npx'].includes(program)) {
    // `pnpm --filter @clawee/web typecheck` reads as "pnpm typecheck".
    const filterValues = new Set(args.flatMap((arg, index) => (
      arg === '--filter' || arg === '-F' ? [args[index + 1]] : []
    )));
    const script = operands.filter(arg => !filterValues.has(arg)).slice(0, 2);
    return { verb: '运行', target: truncateLabel([program, ...script].join(' ')) };
  }
  return { verb: '运行', target: program || '本地命令' };
}

function getCommandActivity(command: string | undefined): string {
  if (command === undefined) return '执行本地命令';
  const normalized = unwrapShellCommand(command).trim().toLocaleLowerCase();
  if (
    /\b(?:vitest|jest|pytest|go test|cargo test)\b/u.test(normalized)
    || /\b(?:pnpm|npm|yarn)\b[^\n]*\btest\b/u.test(normalized)
  ) return '运行测试';
  if (
    /\b(?:electron-builder|package-release)\b/u.test(normalized)
    || /\b(?:pnpm|npm|yarn)\b[^\n]*\bpackage\b/u.test(normalized)
  ) return '打包应用';
  if (
    /\b(?:vite build|tsc|electron-builder)\b/u.test(normalized)
    || /\b(?:pnpm|npm|yarn)\b[^\n]*\bbuild\b/u.test(normalized)
  ) return '构建应用';
  if (/^(?:rg|grep|ag|git\s+grep)\b/u.test(normalized)) return '搜索代码';
  if (/^git\s+(?:status|diff|log|show)\b/u.test(normalized)) return '检查代码变更';
  if (/^git\s+/u.test(normalized)) return '更新代码';
  if (/^(?:ls|find|tree|pwd|fd)\b/u.test(normalized)) return '查看目录';
  if (/^(?:sed|cat|head|tail|wc|less|nl)\b/u.test(normalized)) return '查看项目内容';
  return '执行本地命令';
}

function formatTerminationReason(reason: string | undefined): string {
  switch (reason) {
    case 'timeout':
      return '任务运行时间过长，已自动停止';
    case 'inactivity_timeout':
      return '任务长时间无响应，已自动停止';
    case 'spawn_timeout':
      return 'Codex 启动超时';
    case 'user_canceled':
      return '用户已取消';
    case 'daemon_restart':
      return '服务重启，任务已中断';
    case 'codex_exit_non_zero':
      return 'Codex 执行失败';
    case 'spawn_failed':
      return 'Codex 启动失败';
    case 'stream_error':
      return '运行失败，未收到具体原因';
    case undefined:
      return '未知原因';
    default:
      return reason;
  }
}

function getProcessStepTitle(item: ProcessTimelineItem): string {
  switch (item.kind) {
    case 'reasoning_summary':
      return item.text;
    case 'tool_step': {
      return getPayloadType(item) === 'tool_result'
        ? '操作已完成'
        : `正在${getToolActivity(item.name, getToolCommand(item))}`;
    }
    case 'diagnostic':
      return redactIncidentCredentials(item.message);
    case 'done':
      return item.status === 'canceled'
        ? `运行已取消：${formatTerminationReason(item.terminationReason ?? 'user_canceled')}`
        : item.status === 'failed'
          ? formatTerminationReason(item.terminationReason)
          : '';
    case 'run_status':
      return '';
    default:
      const _exhaustive: never = item;
      return _exhaustive;
  }
}

function getTransientProcessActivity(item: VisibleProcessItem): string | undefined {
  if (item.kind !== 'reasoning_summary') return undefined;
  const text = item.text.trim();
  if (text.length === 0 || text.length > 80 || text.includes('\n')) return undefined;
  if (/^正在\S/.test(text)) return text;
  if (/^planning\b/i.test(text)) return '正在确认执行方案';
  if (/^inspect(?:ing)?\b.*\b(?:site|website)\b/i.test(text)) return '正在检查网站可访问性';
  if (/^read(?:ing)?\b/i.test(text)) return '正在读取任务资料';
  if (/^search(?:ing)?\b/i.test(text)) return '正在查询资料';
  if (/^(?:check(?:ing)?|review(?:ing)?|analyz(?:ing)?)\b/i.test(text)) return '正在分析任务信息';
  if (/^(?:run(?:ning)?|execut(?:ing)?)\b/i.test(text)) return '正在执行任务';
  if (/^fetch(?:ing)?\b/i.test(text)) return '正在获取数据';
  return undefined;
}

function buildVisibleProcessSteps(process: ProcessBlock): ProcessDisplayStep[] {
  const completedToolCallIds = new Set<string>();
  const resultsByCallId = new Map<string, ToolResultSummary>();
  const hasFailureDetail = process.items.some(item => item.kind === 'diagnostic'
    && item.severity === 'error' && !item.modelResponse);
  let latestToolUseId: string | undefined;
  for (const item of process.items) {
    if (item.kind !== 'tool_step') continue;
    const payloadType = getPayloadType(item);
    if (payloadType === 'tool_use') latestToolUseId = item.id;
    const toolCallId = getToolCallId(item);
    if (payloadType !== 'tool_result' || toolCallId === undefined) continue;
    completedToolCallIds.add(toolCallId);
    const result = getToolResult(item);
    if (result !== undefined) resultsByCallId.set(toolCallId, result);
  }
  const processComplete = isProcessComplete(process);

  const steps: ProcessDisplayStep[] = [];
  const hasResponseFailure = process.items.some(item => item.kind === 'diagnostic'
    && (item.modelResponseState === 'failed' || item.modelResponseState === 'canceled'));
  let group: ToolCallView[] = [];
  let running: ToolCallView | undefined;
  const flushGroup = () => {
    if (group.length > 0) steps.push({ type: 'tools', key: `tools:${group[0]!.key}`, calls: group });
    group = [];
  };

  for (const item of visibleProcessItems(process)) {
    if (hasFailureDetail && item.kind === 'done' && item.status === 'failed') continue;
    if (hasResponseFailure && item.kind === 'done' && (item.terminationReason === 'stream_error' || item.status === 'canceled')) continue;
    if (item.kind === 'tool_step') {
      if (getPayloadType(item) !== 'tool_use') continue;
      const toolCallId = getToolCallId(item);
      const command = getToolCommand(item);
      const activity = getToolActivity(item.name, command);
      const result = toolCallId === undefined ? undefined : resultsByCallId.get(toolCallId);
      const isRunning = !processComplete && (
        toolCallId === undefined ? item.id === latestToolUseId : !completedToolCallIds.has(toolCallId)
      );
      const detail = getToolDetail(item);
      const call: ToolCallView = {
        key: item.id,
        item,
        activity,
        title: formatToolCallTitle(process, activity, command, isRunning, result?.failed === true),
        ...(command === undefined ? {} : { command }),
        ...(detail === undefined ? {} : { detail }),
        running: isRunning,
        ...(result === undefined ? {} : { result })
      };
      // Only the latest running call is the live line; an earlier unfinished
      // call (parallel tools) stays in its group.
      if (isRunning) {
        if (running !== undefined) group.push(running);
        running = call;
      } else {
        group.push(call);
      }
      continue;
    }
    if (item.kind === 'reasoning_summary') {
      if (item.text.trim().length === 0) continue;
      flushGroup();
      const transient = getTransientProcessActivity(item);
      steps.push({ type: 'narration', key: item.id, text: transient ?? item.text, transient: transient !== undefined });
      continue;
    }
    flushGroup();
    steps.push({ type: 'status', key: item.id, item });
  }
  flushGroup();

  if (processComplete) return steps;
  if (running !== undefined) {
    steps.push({ type: 'live', key: `live:${running.key}`, text: formatLiveActivity(running), idle: false });
    return steps;
  }
  // A trailing short status note becomes the live line instead of a history entry.
  const last = steps.at(-1);
  if (last?.type === 'narration' && last.transient) {
    steps.pop();
    steps.push({ type: 'live', key: `live:${last.key}`, text: last.text, idle: false, markdown: true });
    return steps;
  }
  if (steps.length > 0) steps.push({ type: 'live', key: 'live:idle', text: '正在思考', idle: true });
  return steps;
}

function formatLiveActivity(call: ToolCallView): string {
  const firstLine = (text: string) => text.split('\n')[0]!;
  if (call.command !== undefined) return `正在运行 ${firstLine(call.command)}`;
  return call.detail === undefined ? call.title : `${call.title} ${firstLine(call.detail)}`;
}

function formatToolCallTitle(
  process: ProcessBlock,
  activity: string,
  command: string | undefined,
  running: boolean,
  failed: boolean
): string {
  if (command !== undefined && SPECIFIC_COMMAND_ACTIVITIES.has(activity)) {
    const { verb, target } = describeCommand(command);
    const phrase = target === '' ? verb : `${verb} ${target}`;
    if (running) return `正在${phrase}`;
    if (failed) return `${phrase} 失败`;
    if (activity === '执行本地命令' && process.approvedCommandExecution === true) return `已允许并${phrase}`;
    return `已${phrase}`;
  }
  if (running) return `正在${activity}`;
  return failed ? `${activity}失败` : getProcessCompletedActivityLabel(process, activity);
}

const TOOL_GROUP_SUMMARY_MAX = 4;

function summarizeToolGroup(calls: ToolCallView[]): string {
  const titles = [...new Set(calls.map(call => call.title))];
  if (titles.length <= TOOL_GROUP_SUMMARY_MAX) return titles.join(' · ');
  return `${titles.slice(0, TOOL_GROUP_SUMMARY_MAX - 1).join(' · ')} 等 ${titles.length} 项`;
}

function getProcessCompletedActivityLabel(
  process: ProcessBlock,
  activity: string,
  count = 1
): string {
  if (activity === '执行本地命令' && process.approvedCommandExecution === true) {
    return count === 1 ? '已允许并执行本地命令' : `已允许并执行本地命令（${count} 次）`;
  }
  return getCompletedActivityLabel(activity, count);
}

function hasRunId(item: ProcessTimelineItem): item is ProcessTimelineItem & { runId: string } {
  return typeof item.runId === 'string' && item.runId.length > 0;
}

function getRunId(item: TimelineItem): string | undefined {
  if (!('runId' in item)) return undefined;
  return typeof item.runId === 'string' && item.runId.length > 0 ? item.runId : undefined;
}

function isTerminalTimelineRunStatus(status: string | undefined): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

function collectTerminalRunStatuses(items: TimelineItem[]): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const item of items) {
    if (
      item.kind === 'user_message'
      && item.runId !== undefined
      && isTerminalTimelineRunStatus(item.runStatus)
    ) {
      statuses.set(item.runId, item.runStatus as string);
    }
    if (item.kind === 'done' && item.runId !== undefined) {
      statuses.set(item.runId, item.status);
    }
  }
  return statuses;
}

function buildTimelineRenderItems(items: TimelineItem[], runs: readonly RunResponse[] = []): TimelineRenderItem[] {
  const renderItems: TimelineRenderItem[] = [];
  const processByKey = new Map<string, ProcessBlock>();
  let currentProcessKey: string | undefined;
  const terminalRunStatuses = collectTerminalRunStatuses(items);
  for (const run of runs) {
    if (!terminalRunStatuses.has(run.id) && isTerminalTimelineRunStatus(run.status)) terminalRunStatuses.set(run.id, run.status);
  }
  const completedCommandRunIds = collectCompletedCommandRunIds(items);
  const approvedCommandRunIds = new Set(items.flatMap(item => (
    item.kind === 'approval'
    && item.approval.status === 'approved'
    && item.approval.kind === 'command_execution'
    && completedCommandRunIds.has(item.runId)
      ? [item.runId]
      : []
  )));

  function getCurrentProcess(): ProcessBlock | undefined {
    if (currentProcessKey === undefined) return undefined;
    return processByKey.get(currentProcessKey);
  }

  function createProcess(key: string, runId?: string): ProcessBlock {
    const process: ProcessBlock = {
      type: 'process',
      key,
      runId,
      terminalStatus: runId === undefined ? undefined : terminalRunStatuses.get(runId),
      approvedCommandExecution: runId === undefined ? false : approvedCommandRunIds.has(runId),
      statusPending: runId === undefined || (!runs.some(run => run.id === runId)
        && !items.some(item => item.runId === runId && (item.eventSeq !== undefined || item.kind === 'user_message' && item.runStatus !== undefined
          || item.kind === 'run_status' && !item.historyOnly && ['running', 'initializing', 'finalizing', 'canceling'].includes(item.label)))),
      items: []
    };
    processByKey.set(key, process);
    renderItems.push(process);
    return process;
  }

  function renameCurrentOrphanProcess(nextKey: string, runId: string): ProcessBlock | undefined {
    const current = getCurrentProcess();
    if (current === undefined || current.runId !== undefined || isProcessComplete(current)) return undefined;
    processByKey.delete(current.key);
    current.key = nextKey;
    current.runId = runId;
    current.statusPending = !runs.some(run => run.id === runId)
      && !items.some(item => item.runId === runId && (item.eventSeq !== undefined || item.kind === 'user_message' && item.runStatus !== undefined
        || item.kind === 'run_status' && !item.historyOnly && ['running', 'initializing', 'finalizing', 'canceling'].includes(item.label)));
    current.approvedCommandExecution = approvedCommandRunIds.has(runId);
    processByKey.set(nextKey, current);
    currentProcessKey = nextKey;
    return current;
  }

  for (const item of items) {
    if (
      item.kind === 'approval'
      && item.approval.status === 'approved'
      && item.approval.kind === 'command_execution'
      && approvedCommandRunIds.has(item.runId)
    ) continue;
    const itemRunId = getRunId(item);
    if (
      item.kind === 'assistant_message'
      && itemRunId !== undefined
    ) {
      const process = processByKey.get(`run:${itemRunId}`) ?? createProcess(`run:${itemRunId}`, itemRunId);
      process.hasBody = true;
    }
    if (!isProcessTimelineItem(item)) {
      if (item.kind === 'change_card' && item.runId !== undefined) {
        const previous = renderItems.at(-1);
        if (previous?.type === 'changes' && previous.runId === item.runId) {
          previous.items.push(item);
          continue;
        }
        renderItems.push({
          type: 'changes',
          key: `changes:${item.runId}:${item.id}`,
          runId: item.runId,
          items: [item]
        });
        continue;
      }
      renderItems.push({ type: 'item', item });
      continue;
    }

    let key: string;
    let process: ProcessBlock | undefined;

    if (hasRunId(item)) {
      key = `run:${item.runId}`;
      process = processByKey.get(key) ?? renameCurrentOrphanProcess(key, item.runId);
      if (process === undefined) process = createProcess(key, item.runId);
    } else {
      const current = getCurrentProcess();
      if (current !== undefined && !isProcessComplete(current)) {
        key = current.key;
        process = current;
      } else {
        key = `process:${item.id}`;
        process = createProcess(key);
      }
    }

    process.items.push(item);
    currentProcessKey = item.kind === 'done' ? undefined : key;
  }

  for (let index = 0; index < renderItems.length; index += 1) {
    const renderItem = renderItems[index];
    if (renderItem?.type !== 'item') continue;
    if (renderItem.item.kind !== 'user_message' && renderItem.item.kind !== 'schedule_trigger') continue;
    const runId = getRunId(renderItem.item);
    if (runId === undefined) continue;
    const process = processByKey.get(`run:${runId}`);
    if (process === undefined) continue;
    const processIndex = renderItems.indexOf(process);
    if (processIndex < 0 || processIndex >= index) continue;
    renderItems.splice(processIndex, 1);
    renderItems.splice(index, 0, process);
  }

  return renderItems;
}

function collectCompletedCommandRunIds(items: TimelineItem[]): Set<string> {
  const commandUsesByCallId = new Map<string, string>();
  const completedRunIds = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'tool_step') continue;
    const toolCallId = getToolCallId(item);
    const runId = getRunId(item);
    if (toolCallId === undefined || runId === undefined) continue;
    const callKey = `${runId}:${toolCallId}`;
    const payloadType = getPayloadType(item);
    if (payloadType === 'tool_use' && getToolActivity(item.name, getToolCommand(item)) === '执行本地命令') {
      commandUsesByCallId.set(callKey, runId);
      continue;
    }
    if (payloadType !== 'tool_result') continue;
    const completedRunId = commandUsesByCallId.get(callKey);
    if (completedRunId !== undefined) completedRunIds.add(completedRunId);
  }
  return completedRunIds;
}

function MessageAttachment(props: {
  attachment: NonNullable<Extract<TimelineItem, { kind: 'user_message' }>['attachments']>[number];
  previewUrl?: string;
}) {
  const { attachment, previewUrl } = props;
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string>();
  const hasPreview = Boolean(previewUrl && attachment.mime.startsWith('image/') && previewUrl !== failedPreviewUrl);
  const pendingPreview = attachment.mime.startsWith('image/') && previewUrl === undefined;
  const extensionIndex = attachment.fileName.lastIndexOf('.');
  const extension = extensionIndex > 0 ? attachment.fileName.slice(extensionIndex) : '';
  const name = extensionIndex > 0 ? attachment.fileName.slice(0, extensionIndex) : attachment.fileName;
  const format = extension.slice(1).toUpperCase();
  const Icon = attachment.mime.startsWith('image/') ? ImageIcon
    : ['XLS', 'XLSX', 'CSV', 'TSV'].includes(format) ? FileSpreadsheet
    : ['PPT', 'PPTX'].includes(format) ? Presentation
    : FileText;

  return (
    <figure className={hasPreview || pendingPreview ? 'timeline-message-attachment-image' : 'timeline-message-attachment-compact'}>
      {hasPreview ? (
        <img src={previewUrl} alt={attachment.fileName} onError={() => setFailedPreviewUrl(previewUrl)} />
      ) : pendingPreview ? (
        <div className="timeline-message-attachment-placeholder" aria-hidden="true"><ImageIcon size={20} /></div>
      ) : (
        <div className="timeline-message-attachment-file" aria-hidden="true">
          <Icon size={20} />
        </div>
      )}
      <figcaption>
        <strong title={attachment.fileName} aria-label={attachment.fileName}>
          <span className="timeline-message-attachment-name">{name}</span>
          {extension ? <span className="timeline-message-attachment-extension">{extension}</span> : null}
        </strong>
        <span>{hasPreview || pendingPreview ? '' : format ? `${format} · ` : ''}{formatAttachmentSize(attachment.size)}</span>
      </figcaption>
    </figure>
  );
}

function renderMessageContent(
  item: Extract<TimelineItem, { kind: 'user_message' | 'assistant_message' }>,
  onOpenFile?: (path: string) => void,
  onEditUserMessage?: (item: Extract<TimelineItem, { kind: 'user_message' }>) => void,
  onPreviewImage?: (path: string) => Promise<string>,
  canOpenFile?: (path: string) => boolean,
  documentActions?: DocumentArtifactActions,
  artifactPaths?: readonly string[]
) {
  const canOpenWorkspaceFiles = item.kind === 'assistant_message' && onOpenFile !== undefined;
  const artifacts = canOpenWorkspaceFiles
    ? (artifactPaths ?? []).filter(path => canOpenFile?.(path) === true)
    : [];
  return (
    <>
      {item.kind === 'user_message' && (item.attachments?.length ?? 0) > 0 ? (
        <div className="timeline-message-attachments">
          {item.attachments?.map(attachment => (
            <MessageAttachment
              key={attachment.id}
              attachment={attachment}
              previewUrl={item.attachmentPreviewUrls?.[attachment.id]}
            />
          ))}
        </div>
      ) : null}
      <MarkdownRenderer
        text={item.text}
        variant={item.kind === 'user_message' ? 'user' : 'assistant'}
        linkifyWorkspaceFiles={canOpenWorkspaceFiles}
        onLinkClick={canOpenWorkspaceFiles
          ? (href, event) => {
              if (!isWorkspaceFilePath(href)) return;
              event.preventDefault();
              onOpenFile(href);
            }
          : undefined}
      />
      {artifacts.length > 0 ? (
        <div className="timeline-artifacts" aria-label="任务成果">
          {artifacts.map(path => {
            if (isImageArtifact(path)) {
              return <ImageArtifact key={path} path={path} onOpenFile={onOpenFile} onPreviewImage={onPreviewImage} />;
            }
            const fileName = artifactFileName(path);
            return (
              <DocumentArtifact
                key={path}
                path={path}
                fileName={fileName}
                typeLabel={artifactTypeLabel(path)}
                onPreview={onOpenFile}
                actions={documentActions}
              />
            );
          })}
        </div>
      ) : null}
    </>
  );
}

const DELIVERABLE_ARTIFACT_EXTENSIONS = new Set([
  'csv', 'doc', 'docx', 'html', 'htm', 'md', 'markdown', 'pdf', 'ppt', 'pptx', 'xls', 'xlsx',
  'png', 'jpg', 'jpeg', 'gif', 'webp'
]);

function artifactExtension(path: string): string {
  return path.split('.').at(-1)?.toLowerCase() ?? '';
}

function normalizeArtifactPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(?:\.\/)+/, '');
}

function isImageArtifact(path: string): boolean {
  return ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(artifactExtension(path));
}

function ImageArtifact(props: {
  path: string;
  onOpenFile?: (path: string) => void;
  onPreviewImage?: (path: string) => Promise<string>;
}) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const fileName = artifactFileName(props.path);

  useEffect(() => {
    if (!props.onPreviewImage) return;
    let active = true;
    let objectUrl: string | undefined;
    setPreviewUrl(undefined);
    setFailed(false);
    void props.onPreviewImage(props.path).then(url => {
      objectUrl = url;
      if (active) setPreviewUrl(url);
      else URL.revokeObjectURL(url);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [props.onPreviewImage, props.path]);

  return (
    <button
      type="button"
      className="timeline-artifact-card timeline-image-artifact"
      title={fileName}
      aria-label={`打开成果 ${fileName}`}
      onClick={() => props.onOpenFile?.(props.path)}
    >
      {previewUrl && !failed ? (
        <img src={previewUrl} alt={fileName} onError={() => setFailed(true)} />
      ) : (
        <span className="timeline-image-artifact-placeholder">
          <ImageIcon aria-hidden="true" size={24} />
          {failed ? '图片预览不可用' : '正在加载图片'}
        </span>
      )}
      <span className="timeline-artifact-copy">
        <strong>{fileName}</strong>
        <span>图片</span>
      </span>
      <span className="timeline-artifact-action">打开</span>
    </button>
  );
}

function isDeliverableArtifact(path: string): boolean {
  return DELIVERABLE_ARTIFACT_EXTENSIONS.has(artifactExtension(path));
}

function artifactFileName(path: string): string {
  const fileName = path.split(/[\\/]/).at(-1) ?? path;
  try {
    return decodeURIComponent(fileName);
  } catch {
    return fileName;
  }
}

function artifactTypeLabel(path: string): string {
  switch (artifactExtension(path)) {
    case 'html':
    case 'htm':
      return 'HTML 报告';
    case 'pdf':
      return 'PDF 文档';
    case 'doc':
    case 'docx':
      return 'Word 文档';
    case 'xls':
    case 'xlsx':
      return 'Excel 表格';
    case 'ppt':
    case 'pptx':
      return '演示文稿';
    case 'csv':
      return '数据表';
    default:
      return '文档';
  }
}

function renderResolvedApproval(approval: Extract<TimelineItem, { kind: 'approval' }>['approval']) {
  const approved = approval.status === 'approved';
  const Icon = approved ? ShieldCheck : ShieldX;
  return (
    <div className="approval-resolution-row">
      <Icon aria-hidden="true" size={14} />
      <span>{formatApprovalResolution(approval)}</span>
    </div>
  );
}

function formatApprovalResolution(approval: Extract<TimelineItem, { kind: 'approval' }>['approval']): string {
  const prefix = (() => {
    switch (approval.status) {
      case 'approved':
        return '已允许';
      case 'rejected':
        return '已拒绝';
      case 'expired':
        return '权限申请已过期';
      case 'canceled':
        return '权限申请已取消';
      case 'pending':
        return '等待批准';
    }
  })();
  if (approval.status === 'expired' || approval.status === 'canceled') return prefix;

  if (approval.kind === 'permissions') {
    const network = isRecord(approval.details.network) ? approval.details.network : undefined;
    const host = typeof network?.host === 'string' ? network.host : undefined;
    return host ? `${prefix}访问 ${host}` : `${prefix}获取权限`;
  }
  if (approval.kind === 'file_change') return `${prefix}修改文件`;
  return `${prefix}执行命令`;
}

function MessageMeta(props: {
  item: Extract<TimelineItem, { kind: 'user_message' | 'assistant_message' }>;
  latestAssistant?: boolean;
  onEdit?: (item: Extract<TimelineItem, { kind: 'user_message' }>) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [showTime, setShowTime] = useState(false);
  const timeId = useId();
  const itemLabel = props.item.kind === 'assistant_message' ? '回复' : '消息';
  const copyButton = (
    <button
      type="button"
      aria-label={
        copyState === 'copied'
          ? `已复制${itemLabel}`
          : copyState === 'failed'
            ? `复制${itemLabel}失败`
            : `复制${itemLabel}`
      }
      title={copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}
      onClick={async () => {
        setCopyState(await copyToClipboard(props.item.text) ? 'copied' : 'failed');
      }}
    >
      {copyState === 'copied' ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
    </button>
  );

  return (
    <div className={`timeline-message-meta${props.latestAssistant ? ' is-latest-assistant' : ''}`}>
      {copyButton}
      {props.item.timestamp ? (
        <span
          className="timeline-message-info"
          onMouseEnter={() => setShowTime(true)}
          onMouseLeave={() => setShowTime(false)}
        >
          <button
            type="button"
            aria-label="消息信息"
            aria-describedby={showTime ? timeId : undefined}
            onFocus={() => setShowTime(true)}
            onBlur={() => setShowTime(false)}
            onClick={() => setShowTime(true)}
            onKeyDown={event => {
              if (event.key === 'Escape') setShowTime(false);
            }}
          >
            <Clock3 size={14} aria-hidden="true" />
          </button>
          {showTime ? (
            <time id={timeId} role="tooltip" dateTime={props.item.timestamp}>
              {formatMessageTime(props.item.timestamp)}
            </time>
          ) : null}
        </span>
      ) : null}
      {props.item.kind === 'user_message' && props.onEdit ? (
        <button
          type="button"
          aria-label="编辑消息"
          title="编辑"
          onClick={() => {
            if (props.item.kind === 'user_message') props.onEdit?.(props.item);
          }}
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function renderScheduleTrigger(
  item: Extract<TimelineItem, { kind: 'schedule_trigger' }>
) {
  return (
    <div className="timeline-schedule-trigger-content">
      <time dateTime={item.triggeredAt}>{formatScheduleTriggerTime(item.triggeredAt)}</time>
      <MarkdownRenderer text={item.prompt} variant="user" />
    </div>
  );
}

function formatScheduleTriggerTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function renderChangeCard(item: Extract<TimelineItem, { kind: 'change_card' }>, onOpenFile?: (path: string) => void) {
  const content = (
    <>
      <strong>{item.title}</strong>
      <span>{item.path}</span>
      <code>{item.delta}</code>
      {onOpenFile ? <span className="change-card-action">打开</span> : null}
    </>
  );

  if (onOpenFile) {
    return (
      <button
        type="button"
        className="change-card-content change-card-button"
        aria-label={`打开文件 ${item.path}`}
        onClick={() => onOpenFile(item.path)}
      >
        {content}
      </button>
    );
  }

  return (
    <div className="change-card-content">
      {content}
    </div>
  );
}

function renderChangeBlock(
  block: ChangeBlock,
  onOpenFile?: (path: string) => void
) {
  if (block.items.length === 1) {
    return renderChangeCard(block.items[0]!, onOpenFile);
  }

  const paths = [...new Set(block.items.map(item => item.path))];
  const visiblePaths = paths.slice(0, 3);
  const hiddenCount = paths.length - visiblePaths.length;

  return (
    <div className="change-card-content change-card-group">
      <strong>{block.items.length} 次连续文件变更</strong>
      <span>{paths.length} 个文件</span>
      <div className="change-card-paths">
        {visiblePaths.map(path => (
          onOpenFile ? (
            <button
              key={path}
              type="button"
              className="change-card-path-button"
              aria-label={`打开文件 ${path}`}
              onClick={() => onOpenFile(path)}
            >
              {path}
            </button>
          ) : (
            <code key={path}>{path}</code>
          )
        ))}
        {hiddenCount > 0 ? <span>另有 {hiddenCount} 个文件</span> : null}
      </div>
    </div>
  );
}

function renderTimelineItemContent(
  item: TimelineItem,
  onOpenFile?: (path: string) => void,
  onPreviewImage?: (path: string) => Promise<string>,
  onEditUserMessage?: (item: Extract<TimelineItem, { kind: 'user_message' }>) => void,
  approvalState?: {
    resolving?: boolean;
    error?: string;
    onApprove(id: string): void;
    onReject(id: string): void;
  },
  canOpenFile?: (path: string) => boolean,
  documentActions?: DocumentArtifactActions,
  artifactPaths?: readonly string[]
) {
  switch (item.kind) {
    case 'workflow_start':
      return <div className="timeline-workflow-content">
        <strong>{item.workflowName} · {item.nodeTitle}</strong>
        <small>第 {item.nodeOrder + 1} 个节点 · 流程任务 {item.instanceId}</small>
        <MarkdownRenderer text={item.instruction} variant="user" />
        {item.input && <div className="timeline-workflow-input"><span>{item.nodeOrder === 0 ? '任务要求' : '工作流输入'}</span><pre>{item.input}</pre></div>}
        {item.customInput && item.customInput !== item.input && <div className="timeline-workflow-input"><span>本次要求</span><pre>{item.customInput}</pre></div>}
      </div>;
    case 'workflow_status': {
      const label = {
        pending: '正在生成回复，节点未完成',
        awaiting_confirmation: '待人工确认',
        submitting: '正在提交节点结果',
        submit_failed: '提交尚未确认，请重试',
        syncing: 'Agent 已完成，正在同步节点',
        completed: '节点已完成',
        failed: 'Agent 执行失败，节点未更新',
        sync_failed: '节点同步失败，结果尚未写回工作流',
        conflict: '节点状态已变化，未能同步结果'
      }[item.status] ?? '节点状态待确认';
      return <div className="timeline-workflow-content" role="status">
        <p className="timeline-workflow-status">{label}</p>
        {item.status === 'completed' && item.completion?.handledByName && <small>处理人：{item.completion.handledByName}</small>}
      </div>;
    }
    case 'user_message':
    case 'assistant_message':
      return renderMessageContent(item, onOpenFile, onEditUserMessage, onPreviewImage, canOpenFile, documentActions, artifactPaths);
    case 'schedule_trigger':
      return renderScheduleTrigger(item);
    case 'change_card':
      return renderChangeCard(item, onOpenFile);
    case 'approval':
      if (item.approval.status !== 'pending') return renderResolvedApproval(item.approval);
      return approvalState === undefined ? null : (
        <ApprovalPanel
          approval={item.approval}
          resolving={approvalState.resolving}
          error={approvalState.error}
          onApprove={approvalState.onApprove}
          onReject={approvalState.onReject}
        />
      );
    case 'diagnostic':
      if (item.modelResponse) return <ModelResponseDiagnostic item={item} />;
      return <RuntimeDiagnostic item={item} />;
    case 'reasoning_summary':
    case 'tool_step':
    case 'run_status':
    case 'done':
      return null;
    default:
      const _exhaustive: never = item;
      return _exhaustive;
  }
}

function renderProcessStep(step: ProcessDisplayStep) {
  switch (step.type) {
    case 'narration':
      return (
        <li key={step.key} className="process-step process-step-narration">
          <div className="process-reasoning-text">
            <MarkdownRenderer text={step.text} variant="process" />
          </div>
        </li>
      );
    case 'live':
      return (
        <li key={step.key} className="process-step is-live-activity" aria-live="polite">
          <div className="process-step-row">
            <LoaderCircle className="process-live-activity-icon is-running" aria-hidden="true" size={13} />
            {step.markdown ? (
              <div className="process-live-activity-text">
                <MarkdownRenderer text={step.text} variant="process" />
              </div>
            ) : (
              <span className="process-live-text" title={step.text}>{step.text}</span>
            )}
          </div>
        </li>
      );
    case 'status':
      if (step.item.kind === 'diagnostic' && step.item.modelResponse) {
        return <li key={step.key} className="process-step process-step-diagnostic"><ModelResponseDiagnostic item={step.item} /></li>;
      }
      if (step.item.kind === 'diagnostic') {
        return <li key={step.key} className="process-step process-step-diagnostic"><RuntimeDiagnostic item={step.item} /></li>;
      }
      return (
        <li key={step.key} className={`process-step process-step-${step.item.kind}`}>
          <div className="process-step-row">
            <span className="process-step-title">{getProcessStepTitle(step.item)}</span>
          </div>
        </li>
      );
    case 'tools':
      return renderToolGroup(step);
    default:
      const _exhaustive: never = step;
      return _exhaustive;
  }
}

function renderToolGroup(step: Extract<ProcessDisplayStep, { type: 'tools' }>) {
  const failed = step.calls.some(call => call.result?.failed);
  return (
    <li key={step.key} className={`process-step process-step-tools${failed ? ' is-failed' : ''}`}>
      <details className="process-tool-group" open={failed}>
        <summary>
          {failed
            ? <AlertTriangle className="process-milestone-icon" aria-hidden="true" size={14} />
            : renderMilestoneIcon(step.calls[0]!.activity)}
          <span className="process-step-title">{summarizeToolGroup(step.calls)}</span>
        </summary>
        <ol className="process-tool-calls">
          {step.calls.map(call => (
            <li key={call.key} className={`process-tool-call${call.result?.failed ? ' is-failed' : ''}`}>
              {/* A single call already reads its title in the group summary. */}
              {step.calls.length > 1 ? <span className="process-step-title">{call.title}</span> : null}
              {call.detail ? <div className="process-step-detail">{call.detail}</div> : null}
              {call.result?.failed && call.result.exitCode !== undefined ? (
                <div className="process-step-exit">退出码 {call.result.exitCode}</div>
              ) : null}
              {call.result && call.result.output.length > 0 ? (
                <details className="process-step-output" open={call.result.failed}>
                  <summary>{call.result.failed ? '错误输出' : '查看输出'}</summary>
                  <pre>{tailLines(call.result.output, PROCESS_OUTPUT_MAX_LINES)}</pre>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

function RuntimeDiagnostic({ item }: { item: Extract<TimelineItem, { kind: 'diagnostic' }> }) {
  const payload = safeParseJson(item.content);
  const details = isRecord(payload) && isRecord(payload.details) ? payload.details : undefined;
  const raw = isRecord(details?.raw) ? details.raw : details;
  const summary = item.severity === 'warning' && item.message === 'Codex warning'
    && typeof raw?.summary === 'string' && raw.summary.trim() ? raw.summary : item.message;
  const warningDetails = item.severity === 'warning' && typeof raw?.details === 'string' ? raw.details.trim() : '';
  const path = item.severity === 'warning' && typeof raw?.path === 'string' ? raw.path.trim() : '';
  return <div className="timeline-diagnostic-content">
    <div className="process-step-row">
      <span className={`process-step-severity ${item.severity}`}>{item.severity}</span>
      <span className="process-step-title">{redactIncidentCredentials(summary)}</span>
    </div>
    {warningDetails ? <pre className="process-step-detail">{redactIncidentCredentials(warningDetails)}</pre> : null}
    {path ? <p className="process-step-detail">配置文件：{redactIncidentCredentials(path)}</p> : null}
  </div>;
}

function ModelResponseDiagnostic({ item }: { item: Extract<TimelineItem, { kind: 'diagnostic' }> }) {
  const error = item.modelResponse!;
  const diagnostics = error.diagnostics;
  const fields = [error.errorCode, error.httpStatus === undefined ? undefined : `HTTP ${error.httpStatus}`,
    error.networkPath ? `网络路径：${modelNetworkPathLabel(error.networkPath)}` : undefined,
    error.proxyStage ? `代理阶段：${modelProxyStageLabel(error.proxyStage)}` : undefined,
    error.proxyErrorCode ? `代理错误：${error.proxyErrorCode}` : undefined,
    error.transportCode, error.requestId ? `上游请求标识：${error.requestId}` : undefined,
    diagnostics.error_message, diagnostics.additional_details].filter(Boolean);
  return <div className="model-response-diagnostic" role="status" aria-live="polite">
    <p>异常来源：Codex Runtime（模型执行层）</p>
    <div className="process-step-row">
      {item.modelResponseState === 'retrying' ? <LoaderCircle className="process-live-activity-icon is-running" size={14} aria-hidden="true" />
        : item.modelResponseState === 'recovered' ? <Check className="process-live-activity-icon" size={14} aria-hidden="true" /> : null}
      <span className="process-step-title">{item.message}</span>
    </div>
    {error.runtimeMessage || error.runtimeDetails ? <div>
      <p>Codex 返回的错误（已脱敏）</p>
      {error.runtimeMessage ? <pre>{error.runtimeMessage}</pre> : null}
      {error.runtimeDetails && error.runtimeDetails !== error.runtimeMessage ? <pre>{error.runtimeDetails}</pre> : null}
    </div> : null}
    {item.modelResponseState === 'failed' || item.modelResponseState === 'unknown' ? <p>{error.suggestion}</p> : null}
    <details>
      <summary>技术详情</summary>
      <pre>{fields.join('\n')}</pre>
    </details>
    <div className="model-response-reference"><span>排查编号：{item.runId}</span>
        <button className="icon-button" type="button" title="复制排查编号" aria-label="复制排查编号" onClick={() => void copyToClipboard(item.runId ?? '')}><Copy size={13} aria-hidden="true" /></button>
    </div>
  </div>;
}

function modelNetworkPathLabel(value: NonNullable<ModelResponseError['networkPath']>): string {
  return { direct: '直连', http_proxy: 'HTTP Proxy', system_proxy: '系统代理', unknown: '未知' }[value];
}

function modelProxyStageLabel(value: NonNullable<ModelResponseError['proxyStage']>): string {
  return {
    resolve: '代理地址解析', connect: '连接代理', tunnel: '建立 HTTPS 隧道',
    response_headers: '等待响应头', response_body: '读取响应', stream: '流式响应'
  }[value];
}

function renderMilestoneIcon(activity: string) {
  const props = { className: 'process-milestone-icon', 'aria-hidden': true, size: 14 } as const;
  switch (activity) {
    case '查看项目内容':
    case '搜索代码':
    case '查看目录':
    case '处理飞书文档':
      return <BookOpen {...props} />;
    case '查询资料':
    case '操作浏览器':
      return <Globe2 {...props} />;
    case '查看图片':
      return <ImageIcon {...props} />;
    case '修改项目文件':
      return <FilePenLine {...props} />;
    case '运行测试':
    case '构建应用':
    case '打包应用':
      return <PackageCheck {...props} />;
    default:
      return <Check {...props} />;
  }
}

function ProcessBlockView(props: {
  process: ProcessBlock;
  expanded: boolean;
  targeted?: boolean;
  onExpandedChange(expanded: boolean): void;
}) {
  const { process, expanded, onExpandedChange } = props;
  const complete = isProcessComplete(process);
  const duration = getProcessDuration(process);
  const fallbackStartedAtRef = useRef({ key: process.key, value: Date.now() });
  if (fallbackStartedAtRef.current.key !== process.key) {
    fallbackStartedAtRef.current = { key: process.key, value: Date.now() };
  }
  const startedAt = getProcessStartedAt(process) ?? fallbackStartedAtRef.current.value;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (complete || process.statusPending) return;
    setNow(Date.now());
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [complete, process.key, process.statusPending]);

  const activeDurationMs = Math.max(0, now - startedAt);
  const summaryLabel = complete
    ? duration === undefined ? '已完成' : `已处理 ${duration}`
    : process.statusPending ? '状态待确认'
    : process.items.some(item => item.kind === 'run_status' && item.label === 'finalizing') ? '收尾中'
    : activeDurationMs >= PROCESS_ELAPSED_LABEL_DELAY_MS
      ? `已处理 ${formatDuration(activeDurationMs)}`
      : '正在思考';

  // The header already says 正在思考 early on, so skip the idle live line then.
  const steps = expanded
    ? buildVisibleProcessSteps(process).filter(step => !(
      step.type === 'live' && step.idle && summaryLabel === '正在思考'
    ))
    : [];

  return (
    <article
      className={`timeline-item timeline-process${complete ? ' is-complete' : ''}`}
      data-search-target={props.targeted ? 'true' : undefined}
    >
      <details
        open={expanded}
      >
        <summary
          onClick={event => {
            event.preventDefault();
            onExpandedChange(!expanded);
          }}
        >
          {!complete && !process.statusPending && activeDurationMs < PROCESS_ELAPSED_LABEL_DELAY_MS ? (
            <LoaderCircle className="process-summary-spinner" aria-hidden="true" size={14} />
          ) : null}
          <span className="process-summary-label">
            {summaryLabel}
          </span>
          {complete ? (
            <ChevronRight className="process-summary-chevron" aria-hidden="true" size={13} />
          ) : null}
        </summary>
        {expanded && steps.length > 0 ? (
          <div className="process-detail">
            <ol className="process-steps">{steps.map(renderProcessStep)}</ol>
          </div>
        ) : null}
      </details>
    </article>
  );
}

// Small layout shifts near the end should not flip the follow-output state.
const TIMELINE_AT_BOTTOM_THRESHOLD_PX = 64;
// Inline tool output is a preview; the full log stays in the run detail panel.
const PROCESS_OUTPUT_MAX_LINES = 40;

function tailLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return [`… 省略前 ${lines.length - maxLines} 行`, ...lines.slice(-maxLines)].join('\n');
}

export type TimelineHandle = {
  scrollBy(deltaY: number): boolean;
};

type TimelineProps = {
  items: TimelineItem[];
  runs?: readonly RunResponse[];
  disconnectedRunIds?: readonly string[];
  onRetryConnection?(runId: string): void;
  onRetryDriveDownload?(runId: string): Promise<void>;
  conversationKey?: string;
  workflowDelivery?: { taskId: string; content: ReactNode };
  targetItemId?: string;
  targetRunId?: string;
  targetApprovalId?: string;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?(): Promise<void> | void;
  outputSyncing?: boolean;
  onOpenFile?(path: string): void;
  documentActions?: DocumentArtifactActions;
  canOpenFile?(path: string): boolean;
  resolveFilePath?(path: string): string;
  onPreviewImage?(path: string): Promise<string>;
  onEditUserMessage?(item: Extract<TimelineItem, { kind: 'user_message' }>): void;
  onQuote?(text: string): void;
  resolvingApprovalIds?: ReadonlySet<string>;
  approvalErrors?: Readonly<Record<string, string | undefined>>;
  onApproveApproval?(id: string): void;
  onRejectApproval?(id: string): void;
};

// 仅在前插旧页或自由阅读时正文更新的提交边界定位；
// 不监听 DOM 变化，也不在用户的正常滚动帧中测量或修正位置。
class TimelineLayoutAnchor extends Component<{
  firstItemIndex: number;
  contentVersion?: unknown;
  itemKeys: string[];
  virtuosoRef: RefObject<VirtuosoHandle>;
  children: ReactNode;
}> {
  private root: HTMLDivElement | null = null;
  private frame?: number;

  getSnapshotBeforeUpdate(previous: Readonly<TimelineLayoutAnchor['props']>) {
    const prepended = this.props.firstItemIndex < previous.firstItemIndex;
    const updated = previous.contentVersion !== undefined && this.props.contentVersion !== undefined
      && previous.contentVersion !== this.props.contentVersion;
    if (!prepended && !updated) return null;
    const scroller = this.root?.querySelector('.timeline-virtuoso');
    if (scroller === null || scroller === undefined) return null;
    const top = scroller.getBoundingClientRect().top;
    const item = [...scroller.querySelectorAll<HTMLElement>('[data-timeline-id]')]
      .find(node => node.getBoundingClientRect().bottom > top + 1);
    return item === undefined ? null : { id: item.dataset.timelineId, offset: item.getBoundingClientRect().top - top, prepended };
  }

  componentDidUpdate(_previous: Readonly<TimelineLayoutAnchor['props']>, _state: unknown, anchor: { id?: string; offset: number; prepended: boolean } | null) {
    if (anchor === null) return;
    this.cancelPositioning();
    const position = () => {
      const index = this.props.itemKeys.indexOf(anchor.id!);
      if (index >= 0) this.props.virtuosoRef.current?.scrollToIndex({ index, align: 'start', offset: -anchor.offset });
    };
    if (anchor.prepended) {
      // 等 Virtuoso 完成本次前插平移，再按实际消息位置定位一次。
      this.frame = requestAnimationFrame(() => { this.frame = requestAnimationFrame(position); });
    } else position();
  }

  private cancelPositioning = () => {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
  };

  componentWillUnmount() { this.cancelPositioning(); }

  render() {
    return <div ref={node => { this.root = node; }} style={{ height: '100%' }}
      onWheelCapture={this.cancelPositioning} onTouchMoveCapture={this.cancelPositioning}
      onPointerDownCapture={this.cancelPositioning} onKeyDownCapture={this.cancelPositioning}
    >{this.props.children}</div>;
  }
}

export const Timeline = forwardRef<TimelineHandle, TimelineProps>(function Timeline(props, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [quoteSelection, setQuoteSelection] = useState<{ text: string; left: number; top: number }>();
  const quoteEnabled = props.onQuote !== undefined;
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const userInteractedRef = useRef(false);
  const previousItemIdsRef = useRef<string[]>([]);
  const previousRenderItemCountRef = useRef(0);
  const firstItemIndexRef = useRef(100_000);
  const contentVersion = useMemo(() => props.items.filter(item => item.kind === 'assistant_message' || item.kind === 'user_message')
    .map(item => `${item.id}:${'text' in item ? item.text : ''}`).join('\n'), [props.items]);
  const targetKey = [props.targetItemId, props.targetRunId, props.targetApprovalId].filter(Boolean).join(':') || undefined;
  const appliedTargetRef = useRef<string>();
  const [processExpansionOverrides, setProcessExpansionOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setQuoteSelection(undefined);
    if (!quoteEnabled) return;
    const dismiss = () => setQuoteSelection(undefined);
    const updateSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !selection.toString().trim()) {
        dismiss();
        return;
      }
      const range = selection.getRangeAt(0);
      const messageBody = (node: Node) => (node instanceof Element ? node : node.parentElement)
        ?.closest('.timeline-assistant_message .markdown-prose[data-variant="assistant"]');
      const body = messageBody(range.startContainer);
      if (!body || !rootRef.current?.contains(body) || messageBody(range.endContainer) !== body) {
        dismiss();
        return;
      }
      const rect = range.getBoundingClientRect();
      setQuoteSelection({
        text: selection.toString(),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 80)),
        top: rect.bottom + 38 <= window.innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - 38)
      });
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    document.addEventListener('selectionchange', updateSelection);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('selectionchange', updateSelection);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [quoteEnabled, props.conversationKey]);

  useImperativeHandle(ref, () => ({
    scrollBy(deltaY) {
      const virtuoso = virtuosoRef.current;
      if (virtuoso === null) return false;
      userInteractedRef.current = true;
      reading.wheel(deltaY);
      virtuoso.scrollBy({ top: deltaY, behavior: 'auto' });
      return true;
    }
  }), []);

  const renderItems = useMemo(
    () => buildTimelineRenderItems(collapseModelResponseErrors(props.items.filter(item => (
      !isInternalRuntimeDiagnostic(item)
      && (item.kind !== 'change_card' || (props.canOpenFile?.(item.path) ?? true))
    ))), props.runs).filter(item => {
      if (item.type === 'process') return shouldRenderProcess(item);
      if (
        item.type === 'item'
        && item.item.kind === 'approval'
        && item.item.approval.status === 'pending'
      ) return false;
      return !(
        item.type === 'item'
        && item.item.kind === 'user_message'
        && (
          item.item.runStatus === 'queued'
          || (item.item.runStatus === 'canceled' && item.item.wasQueued === true)
        )
      );
    }),
    [props.items, props.runs, props.canOpenFile]
  );
  const driveRunsByAnchor = useMemo(() => {
    const result = new Map<string, RunResponse>();
    for (const run of props.runs ?? []) {
      if (!run.sharedDriveState || (!run.sharedDriveState.downloads.length && !run.sharedDriveState.uploads.length && !run.sharedDriveState.remoteDeliveries?.length)) continue;
      const anchor = [...renderItems].reverse().find(item => (item.type === 'item' ? getRunId(item.item) : item.runId) === run.id);
      if (anchor) result.set(getRenderItemKey(anchor), run);
    }
    return result;
  }, [renderItems, props.runs]);
  const artifactPathsByMessage = useMemo(() => {
    const result = new Map<string, string[]>();
    if (!props.onOpenFile) return result;
    const pathKey = (path: string) => normalizeArtifactPath(props.resolveFilePath?.(path) ?? path);
    const seenByRun = new Map([...driveRunsByAnchor.values()].map(run => [
      run.id, new Set(run.sharedDriveState!.downloads.flatMap(item => (
        item.status === 'downloaded' && item.relativePath ? [pathKey(item.relativePath)] : []
      )))
    ]));
    // 网盘交付优先；其余成果放在本轮最后一次引用它的回复下，正文链接始终保留。
    for (let index = renderItems.length - 1; index >= 0; index -= 1) {
      const renderItem = renderItems[index]!;
      if (renderItem.type !== 'item' || renderItem.item.kind !== 'assistant_message') continue;
      const item = renderItem.item;
      const scope = item.runId ?? item.id;
      const seen = seenByRun.get(scope) ?? new Set<string>();
      seenByRun.set(scope, seen);
      result.set(item.id, extractWorkspaceFilePaths(item.text).filter(path => {
        if (!isDeliverableArtifact(path) || props.canOpenFile?.(path) !== true) return false;
        const key = pathKey(path);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }));
    }
    return result;
  }, [renderItems, driveRunsByAnchor, props.onOpenFile, props.canOpenFile, props.resolveFilePath]);
  const reading = useTimelineReading(props.conversationKey, contentVersion, targetKey, {
    virtuosoRef, itemKeys: renderItems.map(getRenderItemKey)
  });
  const latestAssistantMessageId = useMemo(() => {
    for (let index = renderItems.length - 1; index >= 0; index -= 1) {
      const renderItem = renderItems[index];
      if (
        renderItem?.type === 'item'
        && renderItem.item.kind === 'assistant_message'
      ) {
        return renderItem.item.id;
      }
    }
    return undefined;
  }, [renderItems]);
  const targetRenderItemIndex = useMemo(
    () => renderItems.findIndex(item => renderItemMatchesTarget(
      item,
      props.targetItemId,
      props.targetRunId,
      props.targetApprovalId
    )),
    [props.targetApprovalId, props.targetItemId, props.targetRunId, renderItems]
  );
  const restoredState = targetKey === undefined ? reading.restoreStateFrom : undefined;
  const savedAnchorIndex = renderItems.findIndex(item => getRenderItemKey(item) === reading.savedAnchor?.id);
  const itemIds = props.items.map(item => item.id);
  const previousItemIds = previousItemIdsRef.current;
  const previousRenderItemCount = previousRenderItemCountRef.current;
  if (
    previousItemIds.length > 0
    && itemIds.length > previousItemIds.length
    && hasSuffix(itemIds, previousItemIds)
  ) {
    const prependedRenderItemCount = renderItems.length - previousRenderItemCount;
    if (prependedRenderItemCount > 0) {
      firstItemIndexRef.current -= prependedRenderItemCount;
    }
  } else if (
    previousItemIds.length > 0
    && itemIds.length > 0
    && !hasPrefix(itemIds, previousItemIds)
  ) {
    firstItemIndexRef.current = 100_000;
  }
  previousItemIdsRef.current = itemIds;
  previousRenderItemCountRef.current = renderItems.length;

  useEffect(() => {
    if (targetKey === undefined) { appliedTargetRef.current = undefined; return; }
    if (targetRenderItemIndex < 0 || appliedTargetRef.current === targetKey) return;
    appliedTargetRef.current = targetKey;
    reading.navigate();
    virtuosoRef.current?.scrollToIndex({
      index: targetRenderItemIndex,
      align: 'center',
      behavior: 'auto'
    });
  }, [
    props.targetApprovalId,
    props.targetItemId,
    props.targetRunId,
    targetRenderItemIndex
  ]);

  useEffect(() => {
    if (reading.mode.current === 'follow') virtuosoRef.current?.autoscrollToBottom();
  }, [contentVersion]);

  function loadOlder() {
    if (!props.hasMore || props.loadingOlder || props.onLoadOlder === undefined) return;
    void props.onLoadOlder();
  }

  function scrollToLatest() {
    if (renderItems.length === 0) return;
    virtuosoRef.current?.scrollToIndex({
      index: renderItems.length - 1,
      align: 'end',
      behavior: 'smooth'
    });
    reading.follow();
  }

  return (
    <div className="timeline-list" ref={rootRef}>
      {quoteSelection && props.onQuote ? createPortal(
        <button type="button" className="timeline-quote-action"
          style={{ left: quoteSelection.left, top: quoteSelection.top }}
          onMouseDown={event => event.preventDefault()}
          onClick={() => {
            props.onQuote?.(quoteSelection.text);
            window.getSelection()?.removeAllRanges();
            setQuoteSelection(undefined);
          }}
        ><Quote size={14} aria-hidden="true" />引用</button>, document.body
      ) : null}
      {props.outputSyncing ? <div role="status">输出同步中</div> : null}
      {props.disconnectedRunIds?.map(runId => <div key={runId} role="status" className="inline-error">
        连接中断
        <button type="button" className="inline-action" onClick={() => props.onRetryConnection?.(runId)}><RefreshCw size={14} aria-hidden="true" />重试连接</button>
      </div>)}
      {props.items.length === 0 ? (
        <div className="timeline-empty">
          <strong>暂无任务记录</strong>
          <span>发送任务后，Clawee 会在这里展示处理过程和结果。</span>
        </div>
      ) : (
        <div
          className="timeline-virtual-shell"
          data-reading-mode={reading.free ? 'free' : 'follow'}
          onWheel={event => {
            userInteractedRef.current = true;
            reading.handlers.onWheel(event);
          }}
          onTouchStart={reading.handlers.onTouchStart}
          onPointerDown={reading.handlers.onPointerDown}
          onTouchMove={event => {
            userInteractedRef.current = true;
            reading.handlers.onTouchMove(event);
          }}
          onKeyDown={event => {
            userInteractedRef.current = true;
            reading.handlers.onKeyDown(event);
          }}
        >
          <TimelineLayoutAnchor contentVersion={reading.free ? contentVersion : undefined} firstItemIndex={firstItemIndexRef.current} itemKeys={renderItems.map(getRenderItemKey)} virtuosoRef={virtuosoRef}>
          {/* 恢复快照时须省略 initialTopMostItemIndex；传 undefined 也会覆盖其内部定位。 */}
          <Virtuoso
            key={props.conversationKey}
            ref={virtuosoRef}
            className="timeline-virtuoso"
            scrollerRef={reading.scrollerRef}
            data={renderItems}
            firstItemIndex={firstItemIndexRef.current}
            defaultItemHeight={120}
            restoreStateFrom={restoredState}
            {...(restoredState !== undefined ? {} : { initialTopMostItemIndex: {
              index: targetRenderItemIndex >= 0 ? targetRenderItemIndex
                : savedAnchorIndex >= 0 ? savedAnchorIndex : 'LAST',
              align: targetRenderItemIndex >= 0 ? 'center' : savedAnchorIndex < 0 ? 'end' : 'start',
              offset: targetRenderItemIndex >= 0 || savedAnchorIndex < 0 ? undefined : -(reading.savedAnchor?.offset ?? 0)
            } })}
            computeItemKey={(_index, item) => getRenderItemKey(item)}
            atBottomThreshold={TIMELINE_AT_BOTTOM_THRESHOLD_PX}
            followOutput={reading.free ? false : () => 'auto'}
            atTopStateChange={nextAtTop => {
              if (nextAtTop && userInteractedRef.current) loadOlder();
            }}
            components={{
              Header: () => (
                <div className="timeline-load-older">
                  {props.hasMore ? (
                    <button
                      type="button"
                      className="inline-action"
                      disabled={props.loadingOlder}
                      onClick={loadOlder}
                    >
                      {props.loadingOlder ? (
                        <LoaderCircle className="spin" aria-hidden="true" size={14} />
                      ) : (
                        <ArrowUp aria-hidden="true" size={14} />
                      )}
                      <span>{props.loadingOlder ? '正在加载更早记录' : '加载更早记录'}</span>
                    </button>
                  ) : null}
                </div>
              ),
              Footer: () => <div className="timeline-end-spacer" aria-hidden="true" />
            }}
            itemContent={(_index, renderItem) => (
              <div className="timeline-virtual-item" data-timeline-id={getRenderItemKey(renderItem)}>
                {renderTimelineRenderItem(
                  renderItem,
                  props.targetItemId,
                  props.targetRunId,
                  props.targetApprovalId,
                  props.onOpenFile,
                  props.canOpenFile,
                  props.onPreviewImage,
                  props.onEditUserMessage,
                  props.resolvingApprovalIds,
                  props.approvalErrors,
                  props.onApproveApproval,
                  props.onRejectApproval,
                  latestAssistantMessageId,
                  renderItem.type === 'process'
                    ? processExpansionOverrides[renderItem.key]
                    : undefined,
                  (processKey, expanded) => {
                    reading.navigate();
                    setProcessExpansionOverrides(current => ({
                      ...current,
                      [processKey]: expanded
                    }));
                  },
                  props.workflowDelivery,
                  props.documentActions,
                  renderItem.type === 'item' ? artifactPathsByMessage.get(renderItem.item.id) : undefined
                )}
                {driveRunsByAnchor.get(getRenderItemKey(renderItem)) ? <SharedDriveArtifacts
                  run={driveRunsByAnchor.get(getRenderItemKey(renderItem))!}
                  canOpenFile={props.canOpenFile}
                  onOpenFile={props.onOpenFile}
                  onPreviewImage={props.onPreviewImage}
                  documentActions={props.documentActions}
                  onRetry={props.onRetryDriveDownload}
                /> : null}
              </div>
            )}
          />
          </TimelineLayoutAnchor>
          {reading.free ? (
            <button
              type="button"
              className="timeline-new-content"
              onClick={scrollToLatest}
            >
              <ArrowDown aria-hidden="true" size={15} />
              <span>{reading.hasNewContent ? '有新内容' : '回到底部'}</span>
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
});

function renderTimelineRenderItem(
  renderItem: TimelineRenderItem,
  targetItemId?: string,
  targetRunId?: string,
  targetApprovalId?: string,
  onOpenFile?: (path: string) => void,
  canOpenFile?: (path: string) => boolean,
  onPreviewImage?: (path: string) => Promise<string>,
  onEditUserMessage?: (item: Extract<TimelineItem, { kind: 'user_message' }>) => void,
  resolvingApprovalIds?: ReadonlySet<string>,
  approvalErrors?: Readonly<Record<string, string | undefined>>,
  onApproveApproval?: (id: string) => void,
  onRejectApproval?: (id: string) => void,
  latestAssistantMessageId?: string,
  processExpansionOverride?: boolean,
  onProcessExpandedChange?: (processKey: string, expanded: boolean) => void,
  workflowDelivery?: { taskId: string; content: ReactNode },
  documentActions?: DocumentArtifactActions,
  artifactPaths?: readonly string[]
) {
  if (renderItem.type === 'process') {
    const defaultExpanded = !isProcessComplete(renderItem) || hasFailedOrCanceledDone(renderItem)
      || renderItem.items.some(item => item.kind === 'diagnostic' && item.modelResponse);
    return (
      <ProcessBlockView
        process={renderItem}
        expanded={processExpansionOverride ?? defaultExpanded}
        targeted={renderItemMatchesTarget(
          renderItem,
          targetItemId,
          targetRunId,
          targetApprovalId
        )}
        onExpandedChange={expanded => onProcessExpandedChange?.(renderItem.key, expanded)}
      />
    );
  }

  if (renderItem.type === 'changes') {
    return (
      <article
        className="timeline-item timeline-change_card"
        data-search-target={renderItemMatchesTarget(
          renderItem,
          targetItemId,
          targetRunId,
          targetApprovalId
        ) ? 'true' : undefined}
      >
        <div className="timeline-bubble">{renderChangeBlock(renderItem, onOpenFile)}</div>
      </article>
    );
  }

  const item = renderItem.item;
  return (
    <article
      className={`timeline-item timeline-${item.kind}${
        item.kind === 'approval' && item.approval.status !== 'pending'
          ? ' timeline-approval-resolved'
          : ''
      }`}
      data-message-state={item.kind === 'assistant_message' ? item.messageState : undefined}
      data-search-target={renderItemMatchesTarget(
        renderItem,
        targetItemId,
        targetRunId,
        targetApprovalId
      ) ? 'true' : undefined}
    >
      {shouldRenderTimelineHeader(item) ? (
        <div className="timeline-item-header">
          <span className="timeline-avatar">{renderTimelineAvatar(item)}</span>
          <span className="timeline-kind">{getTimelineTitle(item)}</span>
        </div>
      ) : null}
      <div className="timeline-bubble">
        {item.kind === 'workflow_status' && workflowDelivery?.taskId === item.taskId ? workflowDelivery.content : renderTimelineItemContent(
          item,
          onOpenFile,
          onPreviewImage,
          onEditUserMessage,
          item.kind === 'approval'
            && onApproveApproval !== undefined
            && onRejectApproval !== undefined
            ? {
                resolving: resolvingApprovalIds?.has(item.approval.id),
                error: approvalErrors?.[item.approval.id],
                onApprove: onApproveApproval,
                onReject: onRejectApproval
              }
            : undefined,
          canOpenFile,
          documentActions,
          artifactPaths
        )}
      </div>
      {item.kind === 'user_message' || item.kind === 'assistant_message' ? (
        <MessageMeta
          item={item}
          latestAssistant={
            item.kind === 'assistant_message'
            && item.id === latestAssistantMessageId
          }
          onEdit={item.kind === 'user_message' ? onEditUserMessage : undefined}
        />
      ) : null}
    </article>
  );
}

function getRenderItemKey(item: TimelineRenderItem): string {
  if (item.type === 'item') return `item:${item.item.id}`;
  return item.key;
}

function renderItemContainsId(item: TimelineRenderItem, itemId: string): boolean {
  if (item.type === 'item') return item.item.id === itemId || item.item.historyIds?.includes(itemId) === true;
  return item.items.some(child => child.id === itemId || child.historyIds?.includes(itemId) === true);
}

function renderItemContainsRunId(item: TimelineRenderItem, runId: string): boolean {
  if (item.type === 'item') return getRunId(item.item) === runId;
  if (item.runId === runId) return true;
  return item.items.some(child => getRunId(child) === runId);
}

function renderItemMatchesTarget(
  item: TimelineRenderItem,
  targetItemId?: string,
  targetRunId?: string,
  targetApprovalId?: string
): boolean {
  if (targetItemId !== undefined && renderItemContainsId(item, targetItemId)) return true;
  if (targetApprovalId !== undefined && renderItemContainsApprovalId(item, targetApprovalId)) {
    return true;
  }
  return targetRunId !== undefined && renderItemContainsRunId(item, targetRunId);
}

function renderItemContainsApprovalId(
  item: TimelineRenderItem,
  approvalId: string
): boolean {
  if (item.type !== 'item' || item.item.kind !== 'approval') return false;
  return item.item.approval.id === approvalId;
}

function hasSuffix(values: string[], suffix: string[]): boolean {
  const offset = values.length - suffix.length;
  if (offset < 0) return false;
  return suffix.every((value, index) => values[offset + index] === value);
}

function hasPrefix(values: string[], prefix: string[]): boolean {
  if (values.length < prefix.length) return false;
  return prefix.every((value, index) => values[index] === value);
}

export function SharedDriveArtifacts(props: {
  run: RunResponse;
  canOpenFile?(path: string): boolean;
  onOpenFile?(path: string): void;
  onPreviewImage?(path: string): Promise<string>;
  documentActions?: DocumentArtifactActions;
  onRetry?(runId: string): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const state = props.run.sharedDriveState;
  if (!state) return null;
  const interrupted = isTerminalTimelineRunStatus(props.run.status);
  const unfinished = state.downloads.some(item => item.status !== 'downloaded');
  const failedUploads = state.uploads.filter(item => item.status !== 'uploaded');
  const incompleteRemoteDeliveries = state.remoteDeliveries?.filter(item => item.status === 'incomplete') ?? [];
  return <div className="timeline-artifacts" aria-label="网盘交付成果">
    {failedUploads.length || incompleteRemoteDeliveries.length ? <div role="status">
      <strong>文件未全部上传</strong>
      {failedUploads.map((item, index) => <p key={`upload-${index}`}>{item.path.split('/').pop()}：{item.error?.message ?? (interrupted ? '传输中断，尚未完成' : '正在上传')}</p>)}
      {incompleteRemoteDeliveries.map(delivery => <div key={delivery.taskId}>{delivery.errors.length
        ? delivery.errors.map((error, index) => <p key={index}>{error.file_name}：{error.message}</p>)
        : <p>远程任务文件上传未完成</p>}</div>)}
    </div> : null}
    {state.downloads.map(item => {
      const key = JSON.stringify([item.artifact.space_id, item.artifact.file_id, item.artifact.revision, item.artifact.sha256]);
      const path = item.relativePath;
      if (item.status === 'downloaded' && path && props.canOpenFile?.(path)) {
        return isImageArtifact(path) ? <ImageArtifact key={key} path={path} onOpenFile={props.onOpenFile} onPreviewImage={props.onPreviewImage} /> : <DocumentArtifact key={key} path={path} fileName={item.artifact.file_name} typeLabel={artifactTypeLabel(path)} onPreview={props.onOpenFile} actions={props.documentActions} />;
      }
      return <div key={key} className="timeline-artifact-card"><FileText aria-hidden="true" size={17} /><div><strong>{item.artifact.file_name}</strong><p>{item.status === 'downloaded' ? '本地文件不存在或不可读' : item.error?.message ?? (interrupted ? '传输中断，尚未完成' : '正在下载')}</p><small>网盘路径：{item.artifact.logical_path}</small></div></div>;
    })}
    {unfinished && props.onRetry ? <button type="button" className="inline-action" disabled={busy} onClick={() => { setBusy(true); setError(undefined); void props.onRetry!(props.run.id).catch(() => setError('下载失败，请检查登录状态与项目目录后重试。')).finally(() => setBusy(false)); }}>{busy ? '正在下载' : '重试下载'}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
