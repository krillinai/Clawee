import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fixtureOffice } from "../test/office-fixtures";
import { officeQueryKey, useOfficeSnapshot } from "./useOfficeSnapshot";

const mockFetch = vi.fn();

describe("useOfficeSnapshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it("loads office snapshot data from the office admin endpoint", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(fixtureOffice), { status: 200 }));
    const queryClient = createQueryClient();

    const { result } = renderHook(() => useOfficeSnapshot(), {
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const expected = { ...fixtureOffice, sse_url: "/api/v1/admin/activity/events" };
    expect(result.current.data).toEqual(expected);
    expect(queryClient.getQueryData(officeQueryKey)).toEqual(expected);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/activity/overview",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
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

void (0 as unknown as ReactNode);
