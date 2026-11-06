import type {
  AgentEventEnvelope,
  AttachmentResponse,
  PublicRunStatus,
  ThreadHistoryItem
} from '@clawee/protocol';
import type { RunHistoryEvents } from '../storage/repositories.js';

export type RunHistorySource = {
  id: string;
  publicPrompt?: string;
  attachments?: AttachmentResponse[];
  createdAt: string;
  status: PublicRunStatus;
};

export function mergeRunEventsIntoThreadHistory(
  historyItems: readonly ThreadHistoryItem[],
  runsNewestFirst: readonly RunHistorySource[],
  listEvents: (runId: string) => readonly AgentEventEnvelope[] | RunHistoryEvents
): ThreadHistoryItem[] {
  const identitiesByRun = new Map<string, RunHistoryEvents['identities']>();
  const eventsByRun = new Map(runsNewestFirst.map(run => {
    const source = listEvents(run.id);
    const { events, identities } = 'events' in source ? source : { events: source, identities: source };
    identitiesByRun.set(run.id, identities);
    return [run.id, [...events].sort((a, b) => a.seq - b.seq)] as const;
  }));
  let enrichedHistoryItems = attachRunAttachmentsToThreadHistory(
    reconcileRunPromptsInThreadHistory(historyItems, runsNewestFirst),
    runsNewestFirst
  );
  const runsByTurn = new Map<string, string>();
  const runsByItem = new Map<string, Set<string>>();
  for (const [runId, identities] of identitiesByRun) {
    for (const event of identities) {
      if (event.turnId !== undefined) runsByTurn.set(event.turnId, runId);
      if (event.rawEventId !== undefined) {
        const candidates = runsByItem.get(event.rawEventId) ?? new Set<string>();
        candidates.add(runId); runsByItem.set(event.rawEventId, candidates);
      }
    }
  }
  for (const item of enrichedHistoryItems) {
    if (item.runId !== undefined && item.turnId !== undefined) runsByTurn.set(item.turnId, item.runId);
  }
  enrichedHistoryItems = enrichedHistoryItems.map(item => {
    const rawEventId = item.rawEventId ?? (['done', 'user_message', 'schedule_trigger'].includes(item.type) ? undefined : item.id.replace(/:(use|result)$/, ''));
    const candidates = rawEventId === undefined ? undefined : runsByItem.get(rawEventId);
    const runId = item.runId ?? (item.turnId === undefined ? undefined : runsByTurn.get(item.turnId))
      ?? (candidates?.size === 1 ? [...candidates][0] : undefined);
    return { ...item, ...(runId === undefined ? {} : { runId }), ...(rawEventId === undefined ? {} : { rawEventId }) };
  });
  const runItems: ThreadHistoryItem[] = [];
  const runItemIndexes = new Map<string, number>();

  const appendRunItem = (item: ThreadHistoryItem, reasoningDelta = false) => {
    const existingIndex = runItemIndexes.get(item.id);
    if (existingIndex !== undefined) {
      const previous = runItems[existingIndex]!;
      runItems[existingIndex] = previous.type === 'assistant_message' && item.type === 'assistant_message'
        ? { ...item, createdAt: previous.createdAt, text: item.messageState === 'streaming' ? previous.text + item.text : item.text }
        : previous.type === 'reasoning_summary' && item.type === 'reasoning_summary'
          ? { ...item, createdAt: previous.createdAt, text: reasoningDelta ? previous.text + item.text : item.text }
        : item;
      return;
    }
    runItemIndexes.set(item.id, runItems.length);
    runItems.push(item);
  };

  for (const run of [...runsNewestFirst].reverse()) {
    const toolNames = new Map<string, string>();
    const events = eventsByRun.get(run.id) ?? [];
    const hasRunInput = enrichedHistoryItems.some(item => (
      (item.type === 'user_message' || item.type === 'schedule_trigger')
      && item.runId === run.id
    )) || events.some(event => event.type === 'schedule_trigger');
    if (
      run.publicPrompt !== undefined
      && run.publicPrompt.length > 0
      && !hasRunInput
    ) {
      appendRunItem({
        id: `run-prompt:${run.id}`,
        type: 'user_message',
        text: run.publicPrompt,
        runId: run.id,
        createdAt: run.createdAt,
        ...runAttachmentFields(run)
      });
    }
    for (const event of events) {
      const mapped = runEventToHistoryItem(event, toolNames);
      const item = mapped === undefined ? undefined : { ...mapped, runId: event.runId,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...(event.rawEventId === undefined ? {} : { rawEventId: event.rawEventId }), eventId: event.id, eventSeq: event.seq };
      if (item !== undefined) appendRunItem(item, event.type === 'reasoning_summary' && event.payload.delivery === 'delta');
    }
  }

  const combined = [...enrichedHistoryItems];
  for (const item of runItems) {
    const signature = richItemSignature(item);
    const index = signature === undefined ? -1 : combined.findIndex(existing => richItemSignature(existing) === signature);
    const existing = combined[index];
    if (existing === undefined) combined.push(item);
    // 正文和覆盖水位必须来自同一份事件聚合，避免重放再次追加 Runtime 快照中的字符。
    else combined[index] = { ...existing, ...item, id: existing.id, createdAt: existing.createdAt } as ThreadHistoryItem;
  }
  const runOrder = new Map([...runsNewestFirst].reverse().map((run, index) => [run.id, index]));
  // 完成快照一次校正；未完成正文仍保留失败或取消前的部分输出。
  return combined.map(item => item.type === 'assistant_message' && item.messageState === 'streaming'
    && runsNewestFirst.some(run => run.id === item.runId && run.status !== 'running' && run.status !== 'queued')
      ? { ...item, messageState: 'interrupted' as const } : item)
    .map((item, index) => ({ item, index }))
    .sort((left, right) => (
      (left.item.runId !== undefined && right.item.runId !== undefined && left.item.runId !== right.item.runId
        ? (runOrder.get(left.item.runId) ?? 0) - (runOrder.get(right.item.runId) ?? 0) : 0)
      || compareHistoryItems(left.item, right.item)
      || left.index - right.index
    ))
    .map(entry => entry.item);
}

export function reconcileRunPromptsInThreadHistory(
  historyItems: readonly ThreadHistoryItem[],
  runsNewestFirst: readonly RunHistorySource[]
): ThreadHistoryItem[] {
  const candidates = [...runsNewestFirst]
    .reverse()
    .filter((run): run is RunHistorySource & { publicPrompt: string } => (
      run.publicPrompt !== undefined && run.publicPrompt.length > 0
    ));
  const matchedRunIds = new Set<string>();

  return historyItems.map(item => {
    if (item.type !== 'user_message') return item;
    const unmatched = candidates.filter(run => !matchedRunIds.has(run.id));
    const matchedById = item.runId === undefined
      ? undefined
      : unmatched.find(run => run.id === item.runId);
    const publicPromptCandidates = unmatched.filter(run => (
      run.publicPrompt === item.text
      || item.text.trimEnd().endsWith(run.publicPrompt.trimEnd())
    ));
    const matched = matchedById ?? (item.runId === undefined ? nearestRun(item.createdAt, publicPromptCandidates) : undefined);
    if (matched === undefined) return item;
    matchedRunIds.add(matched.id);
    return {
      ...item,
      text: matched.publicPrompt,
      runId: matched.id
    };
  });
}

export function attachRunAttachmentsToThreadHistory(
  historyItems: readonly ThreadHistoryItem[],
  runsNewestFirst: readonly RunHistorySource[]
): ThreadHistoryItem[] {
  const candidates = [...runsNewestFirst]
    .reverse()
    .filter(run => (run.attachments?.length ?? 0) > 0);
  const matchedRunIds = new Set<string>();

  return historyItems.map(item => {
    if (item.type !== 'user_message') return item;

    const itemTime = Date.parse(item.createdAt);
    let matchedRun: RunHistorySource | undefined;
    let matchedDistance = Number.POSITIVE_INFINITY;
    for (const run of candidates) {
      if (
        matchedRunIds.has(run.id)
        || (
          run.publicPrompt !== undefined
          && run.publicPrompt.length > 0
          && run.publicPrompt !== item.text
        )
        || (item.runId !== undefined && item.runId !== run.id)
      ) {
        continue;
      }

      const runTime = Date.parse(run.createdAt);
      const distance = Number.isFinite(itemTime) && Number.isFinite(runTime)
        ? Math.abs(itemTime - runTime)
        : Number.POSITIVE_INFINITY;
      if (matchedRun === undefined || distance < matchedDistance) {
        matchedRun = run;
        matchedDistance = distance;
      }
    }
    if (matchedRun === undefined || (item.runId === undefined && nearestRun(item.createdAt, candidates.filter(run =>
      !matchedRunIds.has(run.id) && (run.publicPrompt === undefined || run.publicPrompt === item.text)))?.id !== matchedRun.id)) return item;

    matchedRunIds.add(matchedRun.id);
    return {
      ...item,
      runId: matchedRun.id,
      attachments: matchedRun.attachments
    };
  });
}

function nearestRun<T extends RunHistorySource>(
  itemCreatedAt: string,
  candidates: readonly T[]
): T | undefined {
  const itemTime = Date.parse(itemCreatedAt);
  let matched: T | undefined;
  let matchedDistance = Number.POSITIVE_INFINITY;
  const nearby = candidates.filter(run => Math.abs(Date.parse(run.createdAt) - itemTime) <= 5_000);
  if (nearby.length !== 1) return undefined;
  for (const run of nearby) {
    const runTime = Date.parse(run.createdAt);
    const distance = Number.isFinite(itemTime) && Number.isFinite(runTime)
      ? Math.abs(itemTime - runTime)
      : Number.POSITIVE_INFINITY;
    if (matched === undefined || distance < matchedDistance) {
      matched = run;
      matchedDistance = distance;
    }
  }
  return matched;
}

function runAttachmentFields(
  run: RunHistorySource
): Pick<Extract<ThreadHistoryItem, { type: 'user_message' }>, 'runId' | 'attachments'> | Record<string, never> {
  if ((run.attachments?.length ?? 0) === 0) return {};
  return {
    runId: run.id,
    attachments: run.attachments
  };
}

function runEventToHistoryItem(
  event: AgentEventEnvelope,
  toolNames: Map<string, string>
): ThreadHistoryItem | undefined {
  if ((event.type === 'error' || event.type === 'diagnostic') && event.payload.modelResponse) {
    return {
      id: event.id,
      type: 'diagnostic',
      severity: event.type === 'error' ? 'error' : event.payload.severity,
      code: event.payload.code,
      message: event.payload.message,
      modelResponse: event.payload.modelResponse,
      runId: event.runId,
      createdAt: event.ts
    };
  }
  if (event.type === 'schedule_trigger') {
    return {
      id: historyItemId(event),
      type: 'schedule_trigger',
      prompt: event.payload.prompt,
      triggeredAt: event.payload.triggeredAt,
      createdAt: event.ts,
      runId: event.runId
    };
  }
  if (
    event.type === 'assistant_message'
  ) {
    return {
      id: historyItemId(event),
      type: 'assistant_message',
      text: event.payload.text,
      messageState: event.payload.delivery === 'delta' ? 'streaming' : 'complete',
      createdAt: event.ts
    };
  }
  if (event.type === 'reasoning_summary') {
    return {
      id: historyItemId(event),
      type: 'reasoning_summary',
      text: event.payload.text,
      createdAt: event.ts
    };
  }
  if (event.type === 'tool_use') {
    toolNames.set(event.payload.toolCallId, event.payload.name);
    return {
      id: historyItemId(event, ':use'),
      type: 'tool_use',
      name: event.payload.name,
      input: event.payload.input,
      createdAt: event.ts
    };
  }
  if (event.type === 'tool_result') {
    return {
      id: historyItemId(event, ':result'),
      type: 'tool_result',
      name:
        toolNames.get(event.payload.toolCallId)
        ?? event.payload.toolCallId,
      output: event.payload.output || (event.payload.response === undefined ? '' : JSON.stringify(event.payload.response)),
      isError: event.payload.isError,
      createdAt: event.ts,
      runId: event.runId
    };
  }
  if (event.type === 'file_change') {
    return {
      id: historyItemId(event),
      type: 'file_change',
      changes: event.payload.changes,
      status: event.payload.status,
      createdAt: event.ts
    };
  }
  if (event.type === 'done') {
    return {
      id: historyItemId(event),
      type: 'done',
      terminalSource: 'daemon',
      status: event.payload.status,
      runId: event.runId,
      terminationReason: event.payload.terminationReason,
      createdAt: event.ts
    };
  }
  return undefined;
}

function historyItemId(
  event: AgentEventEnvelope,
  rawEventSuffix = ''
): string {
  return `${event.runId}:${event.rawEventId ?? event.id}${rawEventSuffix}`;
}

function compareHistoryItems(
  left: ThreadHistoryItem,
  right: ThreadHistoryItem
): number {
  if (left.runId !== undefined && left.runId === right.runId) {
    if (left.type === 'user_message' || left.type === 'schedule_trigger') return -1;
    if (right.type === 'user_message' || right.type === 'schedule_trigger') return 1;
    if (left.eventSeq !== undefined && right.eventSeq !== undefined) return left.eventSeq - right.eventSeq;
    if (left.turnId !== undefined && left.turnId === right.turnId) return 0;
  }
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const leftSecond = Number.isFinite(leftTime)
    ? Math.floor(leftTime / 1_000)
    : 0;
  const rightSecond = Number.isFinite(rightTime)
    ? Math.floor(rightTime / 1_000)
    : 0;
  return leftSecond - rightSecond || leftTime - rightTime;
}

function richItemSignature(
  item: ThreadHistoryItem
): string | undefined {
  const scope = item.runId ?? item.turnId;
  if (scope === undefined) return undefined;
  if (item.type === 'done') return `${scope}:done`;
  if (item.type === 'schedule_trigger') return `${scope}:schedule`;
  if (item.rawEventId !== undefined) return `${scope}:${item.type}:${item.rawEventId}`;
  const second = Math.floor(Date.parse(item.createdAt) / 1_000);
  if (item.type === 'user_message') {
    return `${scope}:user:${second}:${item.text}`;
  }
  if (item.type === 'assistant_message') {
    return `${scope}:assistant:${second}:${item.text}`;
  }
  if (item.type === 'reasoning_summary') {
    return `${scope}:reasoning:${second}:${item.text}`;
  }
  if (item.type === 'tool_use') {
    return `${scope}:tool-use:${second}:${item.name}:${
      typeof item.input.command === 'string'
        ? item.input.command
        : JSON.stringify(item.input)
    }`;
  }
  if (item.type === 'tool_result') {
    return `${scope}:tool-result:${second}:${item.name}:${item.output}:${
      String(item.isError)
    }`;
  }
  if (item.type === 'file_change') {
    return `${scope}:file-change:${second}:${item.status}:${
      JSON.stringify(item.changes)
    }`;
  }
  return undefined;
}
