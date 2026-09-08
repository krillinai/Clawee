/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(process.cwd(), "src/styles/globals.css"), "utf8");

const requiredDarkTokens = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "success",
  "warning",
  "danger"
];

describe("theme styles", () => {
  it("defines complete light and dark color schemes", () => {
    const rootBlock = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
    const darkBlock = css.match(/\.dark\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(rootBlock).toMatch(/color-scheme:\s*light/);
    expect(darkBlock).toMatch(/color-scheme:\s*dark/);
    requiredDarkTokens.forEach((token) => {
      expect(darkBlock, `missing --${token}`).toMatch(new RegExp(`--${token}:\\s*[^;]+;`));
    });
  });
});
