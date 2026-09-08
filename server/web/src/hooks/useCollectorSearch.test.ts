import { describe, expect, it } from "vitest";

import type { CollectorItem } from "../lib/office-api";
import { filterCollectors } from "./useCollectorSearch";

const collectors: CollectorItem[] = [
  {
    collector_id: "collector_mac_01",
    device_id: "device_01",
    device_name: "工程负责人 MacBook",
    hostname: "mbp-xugang.local",
    os: "darwin",
    arch: "arm64",
    collector_version: "0.1.0",
    registered_agent_count: 1,
    token_created_at: "2026-06-03T09:41:00Z",
    status: "online",
    token_status: "active",
  },
  {
    collector_id: "collector_build_02",
    device_id: "device_02",
    device_name: "构建机 02",
    hostname: "build-host-02.local",
    os: "linux",
    arch: "amd64",
    collector_version: "0.1.0",
    registered_agent_count: 0,
    token_created_at: "2026-06-03T09:42:00Z",
    status: "offline",
    token_status: "active",
  },
];

describe("filterCollectors", () => {
  it("returns every collector for an empty query", () => {
    expect(filterCollectors(collectors, "")).toHaveLength(2);
  });

  it("matches collector id, device name, device id, and hostname", () => {
    expect(filterCollectors(collectors, "mac_01")).toHaveLength(1);
    expect(filterCollectors(collectors, "构建机")).toHaveLength(1);
    expect(filterCollectors(collectors, "device_02")).toHaveLength(1);
    expect(filterCollectors(collectors, "xugang")).toHaveLength(1);
  });

  it("is case insensitive", () => {
    expect(filterCollectors(collectors, "BUILD-HOST")).toHaveLength(1);
  });
});
