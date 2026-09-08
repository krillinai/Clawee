import { describe, expect, it } from "vitest";

import { readQueryParam, updateQueryParams } from "./url-state";

describe("url-state", () => {
  it("reads query params from a search string", () => {
    expect(readQueryParam("?status=failed&owner=ops", "status")).toBe("failed");
  });

  it("updates and removes query params", () => {
    expect(updateQueryParams("?status=queued&page=2", { status: "failed", page: null })).toBe(
      "?status=failed"
    );
  });
});
