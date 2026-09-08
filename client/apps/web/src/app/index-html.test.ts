import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync('index.html', 'utf8');
const darkFavicon = readFileSync('public/favicon-dark.svg', 'utf8');
const lightFavicon = readFileSync('public/favicon-light.svg', 'utf8');

describe('index html assets', () => {
  it('uses a visible Clawee mark for light and dark browser surfaces', () => {
    expect(indexHtml).toContain(
      '<link rel="icon" type="image/svg+xml" href="/favicon-dark.svg" media="(prefers-color-scheme: dark)" />'
    );
    expect(indexHtml).toContain(
      '<link rel="icon" type="image/svg+xml" href="/favicon-light.svg" media="(prefers-color-scheme: light)" />'
    );
    expect(darkFavicon).toContain('viewBox="70 70 340 340"');
    expect(darkFavicon).toContain('fill="white"');
    expect(lightFavicon).toContain('viewBox="70 70 340 340"');
    expect(lightFavicon).toContain('fill="#2E2E2E"');
  });
});
