/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(process.cwd(), "src/styles/globals.css"), "utf8");

function reducedMotionRuleDisablesAnimation(css: string, selector: string) {
  const mediaStart = css.search(/@media\s+\(prefers-reduced-motion:\s*reduce\)\s*\{/);
  if (mediaStart === -1) {
    return false;
  }

  const openBrace = css.indexOf("{", mediaStart);
  let depth = 0;

  for (let i = openBrace; i < css.length; i += 1) {
    if (css[i] === "{") {
      depth += 1;
    } else if (css[i] === "}") {
      depth -= 1;
    }

    if (depth === 0) {
      const mediaBlock = css.slice(openBrace + 1, i);
      const rules = mediaBlock.matchAll(/([^{}]+)\{([^{}]*)\}/g);

      for (const [, selectors, body] of rules) {
        const selectorList = selectors.split(",").map((item) => item.trim());
        if (selectorList.includes(selector) && /animation:\s*none;/.test(body)) {
          return true;
        }
      }

      return false;
    }
  }

  return false;
}

describe("MCP gateway topology styles", () => {
  it("defines bounded flow and gateway emphasis animations with reduced-motion support", () => {
    expect(css).toContain(".mcp-topology-flow");
    expect(css).toContain(".mcp-topology-gateway-pulse");
    expect(css).toContain("@keyframes mcp-topology-flow");
    expect(css).toContain("@keyframes mcp-topology-gateway-pulse");
    expect(reducedMotionRuleDisablesAnimation(css, ".mcp-topology-flow")).toBe(true);
    expect(reducedMotionRuleDisablesAnimation(css, ".mcp-topology-gateway-pulse")).toBe(true);
  });
});
