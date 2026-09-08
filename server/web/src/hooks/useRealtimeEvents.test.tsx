import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RealtimeEnvelope, SessionItem } from "../lib/office-api";
import { fixtureAgent, fixtureAgentDetail, fixtureOffice } from "../test/office-fixtures";
import { agentDetailQueryKey } from "./useAgentDetail";
import { useRealtimeEvents } from "./useRealtimeEvents";
import { officeQueryKey } from "./useOfficeSnapshot";

const originalEventSource = globalThis.EventSource;

describe("useRealtimeEvents", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.EventSource = originalEventSource;
  });

  it("applies scoped session updates only to matching agent detail queries", async () => {
    const eventSources: FakeEventSource[] = [];
    globalThis.EventSource = fakeEventSourceClass(eventSources) as unknown as typeof EventSource;
    const queryClient = createQueryClient();
    const matchingKey = agentDetailQueryKey(fixtureAgent.collector_id, fixtureAgent.agent_id);
    const otherKey = agentDetailQueryKey("collector_2", fixtureAgent.agent_id);
    queryClient.setQueryData(matchingKey, fixtureAgentDetail);
    queryClient.setQueryData(otherKey, {
      ...fixtureAgentDetail,
      agent: { ...fixtureAgentDetail.agent, collector_id: "collector_2" },
    });

    renderWithClient(queryClient, <RealtimeProbe />);
    await waitFor(() => expect(eventSources).toHaveLength(1));

    const session: SessionItem = {
      ...fixtureAgentDetail.current_session!,
      summary: "实时更新后的 session",
    };
    act(() => {
      eventSources[0].emit("session.upserted", envelope("session.upserted", {
        scope: { collector_id: fixtureAgent.collector_id, agent_id: fixtureAgent.agent_id, session_id: session.session_id },
        data: { session },
      }));
    });

    expect(queryClient.getQueryData<typeof fixtureAgentDetail>(matchingKey)?.current_session?.summary).toBe("实时更新后的 session");
    expect(queryClient.getQueryData<typeof fixtureAgentDetail>(otherKey)?.current_session?.summary).toBe(
      fixtureAgentDetail.current_session?.summary,
    );
  });

  it("invalidates office and agent detail queries when snapshot is required", async () => {
    const eventSources: FakeEventSource[] = [];
    globalThis.EventSource = fakeEventSourceClass(eventSources) as unknown as typeof EventSource;
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    queryClient.setQueryData(officeQueryKey, fixtureOffice);
    queryClient.setQueryData(agentDetailQueryKey(fixtureAgent.collector_id, fixtureAgent.agent_id), fixtureAgentDetail);

    renderWithClient(queryClient, <RealtimeProbe />);
    await waitFor(() => expect(eventSources).toHaveLength(1));

    act(() => {
      eventSources[0].emit("snapshot.required", envelope("snapshot.required", { data: { reason: "test" } }));
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: officeQueryKey });
      expect(invalidateSpy).toHaveBeenCalledWith({ predicate: expect.any(Function) });
    });
  });

  it("uses the default office realtime SSE url when no url is provided", async () => {
    const eventSources: FakeEventSource[] = [];
    globalThis.EventSource = fakeEventSourceClass(eventSources) as unknown as typeof EventSource;
    const queryClient = createQueryClient();

    renderWithClient(queryClient, <DefaultRealtimeProbe />);

    await waitFor(() => expect(eventSources).toHaveLength(1));
    expect(eventSources[0].url).toBe("/api/v1/admin/activity/events");
  });

  it("removes event listeners and closes the event source on unmount", async () => {
    const eventSources: FakeEventSource[] = [];
    globalThis.EventSource = fakeEventSourceClass(eventSources) as unknown as typeof EventSource;
    const queryClient = createQueryClient();

    const view = renderWithClient(queryClient, <RealtimeProbe />);
    await waitFor(() => expect(eventSources).toHaveLength(1));

    view.unmount();

    expect(eventSources[0].removeCalls).toHaveLength(11);
    expect(eventSources[0].closed).toBe(true);
  });
});

function RealtimeProbe() {
  useRealtimeEvents("/test/events");
  return null;
}

function DefaultRealtimeProbe() {
  useRealtimeEvents();
  return null;
}

function renderWithClient(queryClient: QueryClient, children: ReactNode) {
  return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function envelope(eventType: RealtimeEnvelope["event_type"], overrides: Partial<RealtimeEnvelope>): RealtimeEnvelope {
  return {
    schema_version: "office.v1",
    event_id: `${eventType}-1`,
    event_type: eventType,
    emitted_at: "2026-06-03T10:21:36Z",
    cursor: "cursor-1",
    scope: {},
    data: {},
    ...overrides,
  };
}

function fakeEventSourceClass(instances: FakeEventSource[]) {
  return class extends FakeEventSource {
    constructor(url: string) {
      super(url);
      instances.push(this);
    }
  };
}

class FakeEventSource {
  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  removeCalls: Array<{ type: string; listener: (event: MessageEvent) => void }> = [];
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set<(event: MessageEvent) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.removeCalls.push({ type, listener });
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: RealtimeEnvelope) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
