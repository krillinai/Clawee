import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/features/drive/shared-drive.css', 'utf8');

describe('shared drive typography', () => {
  it('fills the available workbench viewport at large window sizes', () => {
    expect(css).toMatch(/\.shared-drive-page\s*\{[^}]*min-height:\s*0;[^}]*height:\s*100%;/s);
    expect(css).toMatch(/\.shared-drive-page__inner\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*min-height:\s*100%;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(css).toMatch(/\.shared-drive-workbench\s*\{[^}]*flex:\s*1 0 590px;[^}]*min-height:\s*590px;/s);
    expect(css).not.toMatch(/\.shared-drive-page__inner\s*\{[^}]*width:\s*min\(/s);
  });

  it('keeps all visible text at twelve pixels or larger', () => {
    const fontSizes = Array.from(
      css.matchAll(/font-size:\s*(\d+)px/g),
      match => Number(match[1])
    );

    expect(fontSizes.length).toBeGreaterThan(0);
    expect(Math.min(...fontSizes)).toBeGreaterThanOrEqual(12);
  });

  it('uses readable sizes for primary file content', () => {
    expect(css).toMatch(/\.shared-drive-table th,\s*\.shared-drive-table td\s*\{[^}]*font-size:\s*13px;/s);
    expect(css).toMatch(/\.shared-drive-file-name strong\s*\{[^}]*font-size:\s*14px;/s);
    expect(css).toMatch(/\.shared-drive-file-name small\s*\{[^}]*font-size:\s*12px;/s);
  });

  it('keeps the right-side control slot evenly padded', () => {
    expect(css).toMatch(/\.shared-drive-table th:nth-child\(6\)\s*\{\s*width:\s*86px;\s*\}/);
    expect(css).toMatch(/\.shared-drive-table \.shared-drive-actions-cell\s*\{[^}]*padding-right:\s*12px;[^}]*padding-left:\s*12px;/s);
    expect(css).toMatch(/\.shared-drive-row-actions\s*\{[^}]*width:\s*100%;[^}]*justify-content:\s*center;/s);
  });
});
