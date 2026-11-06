import type { ModelResponseError } from '@clawee/protocol';
import type { TimelineItem } from './timeline-model.js';

type DiagnosticItem = Extract<TimelineItem, { kind: 'diagnostic' }>;

function responseError(item: DiagnosticItem): ModelResponseError | undefined {
  if (item.modelResponse) return item.modelResponse;
  try {
    const payload = JSON.parse(item.content) as { code?: string };
    if (payload.code !== 'CODEX_STREAM_RETRYING') return undefined;
    return { errorCode: 'responseStreamDisconnected', reason: '模型响应连接中断，具体原因未返回',
      suggestion: '请联系管理员，按排查编号核对模型接口日志', retrying: true, diagnostics: {} };
  } catch { return undefined; }
}

function updateState(item: DiagnosticItem, state: NonNullable<DiagnosticItem['modelResponseState']>): DiagnosticItem {
  const error = item.modelResponse!;
  const progress = error.retryAttempt === undefined ? '' : `（${error.retryAttempt}/${error.retryLimit}）`;
  const message = state === 'retrying' ? `${error.reason}，正在重试${progress}`
    : state === 'recovered' ? '模型响应已恢复，任务继续执行'
      : state === 'canceled' ? `任务已取消；最后已知原因：${error.reason}`
        : state === 'failed' ? `${error.errorCode === 'responseTooManyFailedAttempts' ? '多次重试后仍未恢复，本次任务失败' : '本次任务失败'}；最后已知原因：${error.reason}`
          : `任务已结束，未确认响应是否恢复；最后已知原因：${error.reason}`;
  return { ...item, modelResponseState: state, message, severity: state === 'failed' ? 'error' : state === 'retrying' ? 'warning' : 'info' };
}

export function collapseModelResponseErrors(items: TimelineItem[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  const latest = new Map<string, number>();
  const statuses = new Map<string, string>();
  for (const item of items) {
    if (item.kind === 'user_message' && item.runId && item.runStatus) statuses.set(item.runId, item.runStatus);
    const index = item.runId ? latest.get(item.runId) : undefined;
    const previous = index === undefined ? undefined : result[index] as DiagnosticItem;
    const error = item.kind === 'diagnostic' && item.runId ? responseError(item) : undefined;
    if (error && item.kind === 'diagnostic' && item.runId) {
      const sameFailure = previous?.modelResponseState === 'retrying' || previous?.modelResponseState === 'failed';
      const hasNoCause = error.errorCode === 'RUNTIME_ERROR' && !error.runtimeMessage && !error.runtimeDetails && Object.keys(error.diagnostics).length === 0;
      const latestError = sameFailure && (hasNoCause || (error.errorCode === 'responseTooManyFailedAttempts'
        && error.reason === '模型请求重试次数已耗尽，具体原因未返回'))
        ? { ...previous.modelResponse!, ...error, reason: previous.modelResponse!.reason, suggestion: previous.modelResponse!.suggestion,
          runtimeMessage: [...new Set([previous.modelResponse!.runtimeMessage, error.runtimeMessage].filter(Boolean))].join('\n') || undefined,
          runtimeDetails: [...new Set([previous.modelResponse!.runtimeDetails, error.runtimeDetails].filter(Boolean))].join('\n') || undefined,
          diagnostics: { ...previous.modelResponse!.diagnostics, ...error.diagnostics } } : error;
      const current = updateState({ ...item, id: sameFailure ? previous.id : item.id, modelResponse: latestError }, error.retrying ? 'retrying' : 'failed');
      if (sameFailure && index !== undefined) result[index] = current;
      else { latest.set(item.runId, result.length); result.push(current); }
      continue;
    }
    if (previous?.modelResponseState === 'retrying' && index !== undefined && item.kind === 'assistant_message' && item.text.trim()) {
      result[index] = updateState(previous, 'recovered');
    }
    if (item.kind === 'done' && item.runId) statuses.set(item.runId, item.status);
    result.push(item);
  }
  for (const [runId, index] of latest) {
    const item = result[index] as DiagnosticItem;
    const status = statuses.get(runId);
    if (status === 'canceled') { result[index] = updateState(item, 'canceled'); continue; }
    if (item.modelResponseState !== 'retrying') continue;
    if (status === 'failed' || status === 'canceled' || status === 'succeeded') {
      result[index] = updateState(item, status === 'succeeded' ? 'unknown' : status);
    }
  }
  return result;
}
