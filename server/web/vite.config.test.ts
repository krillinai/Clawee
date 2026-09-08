import { describe, expect, it, vi } from "vitest";

vi.mock("@vitejs/plugin-react", () => ({ default: () => ({ name: "react" }) }));
vi.mock("rollup-plugin-visualizer", () => ({ visualizer: () => ({ name: "visualizer" }) }));
vi.mock("vitest/config", () => ({ defineConfig: (config: unknown) => config }));

describe("vite dev proxy", () => {
  it("forwards only the supported API namespaces to the backend", async () => {
    const { default: config } = await import("./vite.config");

    expect(Object.keys(config.server?.proxy ?? {})).toEqual([
      "/api/v1/auth",
      "/api/v1/app",
      "/api/v1/admin"
    ]);
  });
});
