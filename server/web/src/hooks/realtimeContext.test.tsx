import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RealtimeProvider } from "./realtimeContext";
import { useOfficeSnapshot } from "./useOfficeSnapshot";

vi.mock("./useOfficeSnapshot", async () => {
  const actual = await vi.importActual<typeof import("./useOfficeSnapshot")>("./useOfficeSnapshot");
  return {
    ...actual,
    useOfficeSnapshot: vi.fn(),
  };
});

const mockedUseOfficeSnapshot = vi.mocked(useOfficeSnapshot);
const originalEventSource = globalThis.EventSource;

describe("RealtimeProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockedUseOfficeSnapshot.mockReset();
    globalThis.EventSource = originalEventSource;
  });

  it("passes snapshot sse_url into the realtime hook", async () => {
    const eventSources: FakeEventSource[] = [];
    globalThis.EventSource = fakeEventSourceClass(eventSources) as unknown as typeof EventSource;
    mockedUseOfficeSnapshot.mockReturnValue({
      data: { sse_url: "/custom/realtime/events" },
    } as ReturnType<typeof useOfficeSnapshot>);

    renderWithClient(
      createQueryClient(),
      <RealtimeProvider>
        <div>probe</div>
      </RealtimeProvider>,
    );

    await waitFor(() => expect(eventSources).toHaveLength(1));
    expect(eventSources[0].url).toBe("/custom/realtime/events");
  });
});

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

  constructor(url: string) {
    this.url = url;
  }

  addEventListener() {}

  removeEventListener() {}

  close() {}
}
