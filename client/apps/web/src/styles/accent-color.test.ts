import { beforeEach, describe, expect, it } from 'vitest';
import {
  accentColorStorageKey,
  applyAccentColor,
  customAccentColorStorageKey,
  defaultAccentColor,
  defaultCustomAccentColor,
  normalizeHexColor,
  readAccentColorPreference,
  readCustomAccentColorPreference,
  writeCustomAccentColorPreference,
  writeAccentColorPreference
} from './accent-color.js';

function contrastRatio(first: string, second: string): number {
  const luminance = (color: string) => [1, 3, 5]
    .map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

describe('accent color preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.accent;
    document.documentElement.style.removeProperty('--custom-accent-value');
    document.documentElement.style.removeProperty('--custom-on-accent');
    for (const property of Array.from(document.documentElement.style)) {
      if (property.startsWith('--brand-')) document.documentElement.style.removeProperty(property);
    }
  });

  it('follows branding by default without changing the built-in neutral color', () => {
    expect(readAccentColorPreference()).toBe('brand');
    applyAccentColor(readAccentColorPreference());
    expect(document.documentElement.dataset.accent).toBe(defaultAccentColor);

    window.localStorage.setItem(accentColorStorageKey, 'green');
    expect(readAccentColorPreference()).toBe('brand');
  });

  it('preserves the pale brand color while deriving visible light and dark accents', () => {
    applyAccentColor('brand', '#3b82f6', '#F2E9EA');
    expect(document.documentElement.dataset.accent).toBe('brand');
    expect(document.documentElement.style.getPropertyValue('--brand-accent-value')).toBe('#f2e9ea');
    expect(document.documentElement.style.getPropertyValue('--brand-light-soft')).toBe('#f2e9ea');
    expect(window.localStorage.getItem(customAccentColorStorageKey)).toBeNull();
    for (const [theme, background] of [['light', '#e4e4e6'], ['dark', '#282a2e']]) {
      const accent = document.documentElement.style.getPropertyValue(`--brand-${theme}-accent`);
      const foreground = document.documentElement.style.getPropertyValue(`--brand-${theme}-on-accent`);
      expect(accent).not.toBe('#f2e9ea');
      expect(contrastRatio(accent, background!)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(accent, foreground)).toBeGreaterThanOrEqual(4.5);
      const channels = [1, 3, 5].map(offset => Number.parseInt(accent.slice(offset, offset + 2), 16));
      expect(channels[0]).toBeGreaterThan(channels[2]!);
      expect(channels[2]).toBeGreaterThan(channels[1]!);
    }
  });

  it('does not override personal choices and falls back when branding is unavailable', () => {
    applyAccentColor('brand', '#3b82f6', '#F2E9EA');
    writeAccentColorPreference('purple');
    applyAccentColor(readAccentColorPreference(), '#3b82f6', '#F2E9EA');
    expect(document.documentElement.dataset.accent).toBe('purple');
    applyAccentColor('custom', '#ff55aa', '#F2E9EA');
    expect(document.documentElement.dataset.accent).toBe('custom');
    expect(document.documentElement.style.getPropertyValue('--custom-accent-value')).toBe('#ff55aa');
    writeAccentColorPreference('brand');
    applyAccentColor(readAccentColorPreference(), '#3b82f6');
    expect(document.documentElement.dataset.accent).toBe('neutral');
    applyAccentColor('brand', '#3b82f6', 'invalid');
    expect(document.documentElement.dataset.accent).toBe('neutral');
  });

  it.each(['#ffffff', '#000000', '#888888', '#ff0000', '#00ff00', '#0000ff', '#09f'])
  ('keeps brand accents readable for %s', color => {
    applyAccentColor('brand', '#3b82f6', color);
    for (const [theme, background] of [['light', '#e4e4e6'], ['dark', '#282a2e']]) {
      const accent = document.documentElement.style.getPropertyValue(`--brand-${theme}-accent`);
      const foreground = document.documentElement.style.getPropertyValue(`--brand-${theme}-on-accent`);
      expect(contrastRatio(accent, background!)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(accent, foreground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('persists and applies a supported accent color', () => {
    writeAccentColorPreference('purple');
    applyAccentColor(readAccentColorPreference());

    expect(window.localStorage.getItem(accentColorStorageKey)).toBe('purple');
    expect(document.documentElement).toHaveAttribute('data-accent', 'purple');
  });

  it('normalizes, persists, and applies a custom accent color', () => {
    expect(normalizeHexColor(' 09f ')).toBe('#0099ff');
    expect(normalizeHexColor('#12abEF')).toBe('#12abef');
    expect(normalizeHexColor('tomato')).toBeUndefined();

    writeAccentColorPreference('custom');
    writeCustomAccentColorPreference('#f5a');
    applyAccentColor(
      readAccentColorPreference(),
      readCustomAccentColorPreference()
    );

    expect(window.localStorage.getItem(accentColorStorageKey)).toBe('custom');
    expect(window.localStorage.getItem(customAccentColorStorageKey)).toBe('#ff55aa');
    expect(document.documentElement).toHaveAttribute('data-accent', 'custom');
    expect(document.documentElement).toHaveStyle({
      '--custom-accent-value': '#ff55aa'
    });
    expect(document.documentElement.style.getPropertyValue('--custom-on-accent')).not.toBe('');
  });

  it('uses the default custom color when the stored value is invalid', () => {
    window.localStorage.setItem(customAccentColorStorageKey, '#nope');
    expect(readCustomAccentColorPreference()).toBe(defaultCustomAccentColor);
  });
});
