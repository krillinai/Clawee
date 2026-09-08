import { beforeEach, describe, expect, it } from 'vitest';
import { applyDesktopPlatform } from './platform.js';

describe('desktop platform styling', () => {
  beforeEach(() => {
    delete document.documentElement.dataset.platform;
  });

  it.each(['darwin', 'win32', 'linux'] as const)(
    'exposes %s to platform-scoped CSS',
    platform => {
      applyDesktopPlatform(platform);
      expect(document.documentElement).toHaveAttribute('data-platform', platform);
    }
  );

  it('keeps browser rendering on the shared baseline', () => {
    applyDesktopPlatform(undefined);
    expect(document.documentElement).not.toHaveAttribute('data-platform');
  });
});
