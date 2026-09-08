import type { DesktopPlatform } from '../host/bridge.js';

export function applyDesktopPlatform(platform: DesktopPlatform | undefined): void {
  if (platform === undefined) {
    delete document.documentElement.dataset.platform;
    return;
  }
  document.documentElement.dataset.platform = platform;
}
