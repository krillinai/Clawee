import type { AgentEventEnvelope } from '@clawee/protocol';
import { createWebIncidentObserver } from '../../services/incident-observer.js';
import {
  subscribeRunEvents as defaultSubscribeRunEvents,
  type SubscribeRunEventsInput
} from '../../runtime/sse.js';

export type RunEventControllerState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export type StartRunEventControllerInput = Omit<
  SubscribeRunEventsInput,
  'fromSeq' | 'onError' | 'onEvent' | 'signal'
> & {
  fromSeq?: number;
  onEvent(event: AgentEventEnvelope): void;
  onStateChange(state: RunEventControllerState): void;
  onError(error: Error): void;
  onStreamEnd?(lastSeq: number): Promise<boolean>;
};

export type RunEventController = {
  start(input: StartRunEventControllerInput): void;
  stop(): void;
};

type ControllerOptions = {
  subscribe?: (input: SubscribeRunEventsInput) => Promise<void>;
  reconnectDelays?: number[];
};

type ActiveSubscription = {
  generation: number;
  input: StartRunEventControllerInput;
  lastSeq: number;
  reconnectAttempt: number;
  abortController?: AbortController;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  done: boolean;
  state?: RunEventControllerState;
  incidentObserver: ReturnType<typeof createWebIncidentObserver>;
  disconnectedAt?: number;
};

const DEFAULT_RECONNECT_DELAYS = [500, 1_000, 2_000, 4_000, 8_000];

export function createRunEventController(
  options: ControllerOptions = {}
): RunEventController {
  const subscribe = options.subscribe ?? defaultSubscribeRunEvents;
  const reconnectDelays = options.reconnectDelays ?? DEFAULT_RECONNECT_DELAYS;
  let generation = 0;
  let active: ActiveSubscription | undefined;

  function isCurrent(subscription: ActiveSubscription): boolean {
    return active === subscription && subscription.generation === generation;
  }

  function clearActiveSubscription(): void {
    const current = active;
    active = undefined;
    generation += 1;
    if (current?.reconnectTimer !== undefined) clearTimeout(current.reconnectTimer);
    current?.abortController?.abort();
    current?.incidentObserver.dispose();
  }

  function setState(
    subscription: ActiveSubscription,
    state: RunEventControllerState
  ): void {
    if (subscription.state === state) return;
    subscription.state = state;
    subscription.input.onStateChange(state);
  }

  function stop(): void {
    clearActiveSubscription();
  }

  function start(input: StartRunEventControllerInput): void {
    clearActiveSubscription();
    const subscription: ActiveSubscription = {
      generation,
      input,
      lastSeq: input.fromSeq ?? 0,
      reconnectAttempt: 0,
      done: false,
      incidentObserver: createWebIncidentObserver()
    };
    active = subscription;
    setState(subscription, 'connecting');
    void connect(subscription);
  }

  async function connect(subscription: ActiveSubscription): Promise<void> {
    if (!isCurrent(subscription) || subscription.done) return;

    const abortController = new AbortController();
    subscription.abortController = abortController;
    let connectionError: Error | undefined;
    const startedAt = Date.now();

    try {
      await subscribe({
        ...subscription.input,
        fromSeq: subscription.lastSeq,
        signal: abortController.signal,
        onEvent(event) {
          if (
            !isCurrent(subscription)
            || abortController.signal.aborted
            || event.runId !== subscription.input.runId
            || event.seq <= subscription.lastSeq
          ) return;

          subscription.lastSeq = event.seq;
          subscription.reconnectAttempt = 0;
          setState(subscription, 'connected');
          if (subscription.disconnectedAt !== undefined) {
            subscription.incidentObserver.report({ event_type: 'recovered', stage: 'event_stream', error_code: 'WEB_STREAM_ENDED', run_id: event.runId, duration_ms: Math.max(0, Date.now() - subscription.disconnectedAt) });
            subscription.disconnectedAt = undefined;
          }
          subscription.input.onEvent(event);
          if (event.type === 'done') {
            subscription.done = true;
            subscription.incidentObserver.dispose();
            setState(subscription, 'idle');
          }
        },
        onError(error) {
          if (!isCurrent(subscription) || abortController.signal.aborted) return;
          connectionError = error;
        }
      });
    } catch (error) {
      connectionError = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (subscription.abortController === abortController) {
        subscription.abortController = undefined;
      }
    }

    if (!isCurrent(subscription) || abortController.signal.aborted || subscription.done) return;
    if (connectionError === undefined && subscription.input.onStreamEnd !== undefined) {
      try {
        const synchronized = await subscription.input.onStreamEnd(subscription.lastSeq);
        if (!isCurrent(subscription)) return;
        if (synchronized) {
          subscription.done = true;
          subscription.incidentObserver.dispose();
          setState(subscription, 'idle');
          return;
        }
      } catch (error) {
        connectionError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (!isCurrent(subscription)) return;
    subscription.disconnectedAt ??= Date.now();
    subscription.incidentObserver.report({ event_type: 'error', stage: 'event_stream', error_code: 'WEB_STREAM_ENDED', run_id: subscription.input.runId, duration_ms: Math.max(0, Date.now() - startedAt) });
    scheduleReconnect(
      subscription,
      connectionError ?? new Error('SSE connection closed unexpectedly')
    );
  }

  function scheduleReconnect(subscription: ActiveSubscription, error: Error): void {
    if (!isCurrent(subscription) || subscription.done) return;
    const delay = reconnectDelays[subscription.reconnectAttempt];
    if (delay === undefined) {
      subscription.incidentObserver.dispose();
      setState(subscription, 'disconnected');
      subscription.input.onError(error);
      return;
    }

    subscription.reconnectAttempt += 1;
    setState(subscription, 'reconnecting');
    subscription.reconnectTimer = setTimeout(() => {
      subscription.reconnectTimer = undefined;
      void connect(subscription);
    }, delay);
  }

  return { start, stop };
}
