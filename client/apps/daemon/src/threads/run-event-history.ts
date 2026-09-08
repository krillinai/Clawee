import type {
  AgentEventEnvelope,
  AttachmentResponse,
  PublicRunStatus,
  ThreadHistoryItem
} from '@clawee/protocol';

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
  listEvents: (runId: string) => readonly AgentEventEnvelope[]
): ThreadHistoryItem[] {
  const enrichedHistoryItems = attachRunAttachmentsToThreadHistory(
    reconcileRunPromptsInThreadHistory(historyItems, runsNewestFirst),
    runsNewestFirst
  );
  const existingIds = new Set(enrichedHistoryItems.map(item => item.id));
  const existingSignatures = new Set(
    enrichedHistoryItems.flatMap(item => {
      const signature = richItemSignature(item);
      return signature === undefined ? [] : [signature];
    })
  );
  const runItems: ThreadHistoryItem[] = [];
  const runItemIndexes = new Map<string, number>();

  const appendRunItem = (item: ThreadHistoryItem) => {
    if (existingIds.has(item.id)) return;
    const signature = richItemSignature(item);
    if (signature !== undefined && existingSignatures.has(signature)) return;
    const existingIndex = runItemIndexes.get(item.id);
    if (existingIndex !== undefined) {
      runItems[existingIndex] = item;
      return;
    }
    runItemIndexes.set(item.id, runItems.length);
    runItems.push(item);
  };

  for (const run of [...runsNewestFirst].reverse()) {
    const toolNames = new Map<string, string>();
    if (run.publicPrompt !== undefined && run.publicPrompt.length > 0) {
      appendRunItem({
        id: `run-prompt:${run.id}`,
        type: 'user_message',
        text: run.publicPrompt,
        createdAt: run.createdAt,
        ...runAttachmentFields(run)
      });
    }
    for (const event of listEvents(run.id)) {
      const item = runEventToHistoryItem(event, toolNames);
      if (item !== undefined) appendRunItem(item);
    }
  }

  return [...enrichedHistoryItems, ...runItems]
    .map((item, index) => ({ item, index }))
    .sort((left, right) => (
      compareHistoryItems(left.item, right.item)
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
    const matched = matchedById
      ?? nearestRun(item.createdAt, publicPromptCandidates);
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
    if (matchedRun === undefined) return item;

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
  for (const run of candidates) {
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
    && event.payload.delivery === 'message'
  ) {
    return {
      id: historyItemId(event),
      type: 'assistant_message',
      text: event.payload.text,
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
      output: event.payload.output,
      isError: event.payload.isError,
      createdAt: event.ts
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
      status: event.payload.status,
      createdAt: event.ts
    };
  }
  return undefined;
}

function historyItemId(
  event: AgentEventEnvelope,
  rawEventSuffix = ''
): string {
  return event.rawEventId === undefined
    ? `run-event:${event.id}`
    : `${event.rawEventId}${rawEventSuffix}`;
}

function compareHistoryItems(
  left: ThreadHistoryItem,
  right: ThreadHistoryItem
): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const leftSecond = Number.isFinite(leftTime)
    ? Math.floor(leftTime / 1_000)
    : 0;
  const rightSecond = Number.isFinite(rightTime)
    ? Math.floor(rightTime / 1_000)
    : 0;
  return leftSecond - rightSecond
    || historyItemPriority(left) - historyItemPriority(right)
    || leftTime - rightTime;
}

function historyItemPriority(item: ThreadHistoryItem): number {
  if (
    item.type === 'user_message'
    || item.type === 'schedule_trigger'
  ) {
    return 0;
  }
  if (
    item.type === 'reasoning_summary'
    || item.type === 'tool_use'
    || item.type === 'tool_result'
    || item.type === 'file_change'
  ) {
    return 1;
  }
  if (item.type === 'assistant_message') return 2;
  return 3;
}

function richItemSignature(
  item: ThreadHistoryItem
): string | undefined {
  const second = Math.floor(Date.parse(item.createdAt) / 1_000);
  if (item.type === 'user_message') {
    return `user:${second}:${item.text}`;
  }
  if (item.type === 'schedule_trigger') {
    return `schedule:${second}:${item.prompt}:${item.triggeredAt}`;
  }
  if (item.type === 'assistant_message') {
    return `assistant:${second}:${item.text}`;
  }
  if (item.type === 'reasoning_summary') {
    return `reasoning:${second}:${item.text}`;
  }
  if (item.type === 'tool_use') {
    return `tool-use:${second}:${item.name}:${
      typeof item.input.command === 'string'
        ? item.input.command
        : JSON.stringify(item.input)
    }`;
  }
  if (item.type === 'tool_result') {
    return `tool-result:${second}:${item.name}:${item.output}:${
      String(item.isError)
    }`;
  }
  if (item.type === 'file_change') {
    return `file-change:${second}:${item.status}:${
      JSON.stringify(item.changes)
    }`;
  }
  if (item.type === 'done') {
    return `done:${second}:${item.status}`;
  }
  return undefined;
}
