import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fixtureAgentDetail } from "../test/office-fixtures";
import { agentDetailQueryKey, useAgentDetail } from "./useAgentDetail";

const mockFetch = vi.fn();

describe("useAgentDetail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it("loads agent detail with encoded collector and agent ids", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(fixtureAgentDetail), { status: 200 }));
    const queryClient = createQueryClient();

    const { result } = renderHook(() => useAgentDetail("collector 1", "agent/same"), {
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryData(agentDetailQueryKey("collector 1", "agent/same"))).toEqual(fixtureAgentDetail);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/activity/detail?collector_id=collector%201&agent_id=agent%2Fsame&include_history=false",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("does not run when collectorId or agentId is missing", async () => {
    vi.stubGlobal("fetch", mockFetch);
    const queryClient = createQueryClient();

    const { result } = renderHook(() => useAgentDetail("", "agent"), {
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}
