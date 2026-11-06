export const accentColors = [
  'brand',
  'neutral',
  'blue',
  'cyan',
  'purple',
  'orange',
  'red',
  'custom'
] as const;

export type AccentColor = typeof accentColors[number];

export const accentColorStorageKey = 'clawee.preferences.accentColor';
export const customAccentColorStorageKey = 'clawee.preferences.customAccentColor';
export const defaultAccentColor: AccentColor = 'neutral';
export const defaultCustomAccentColor = '#3b82f6';

export function readAccentColorPreference(): AccentColor {
  try {
    const value = window.localStorage.getItem(accentColorStorageKey);
    return accentColors.includes(value as AccentColor)
      ? value as AccentColor
      : 'brand';
  } catch {
    return 'brand';
  }
}

export function writeAccentColorPreference(color: AccentColor): void {
  try {
    window.localStorage.setItem(accentColorStorageKey, color);
  } catch {
    return;
  }
}

export function readCustomAccentColorPreference(): string {
  try {
    return normalizeHexColor(window.localStorage.getItem(customAccentColorStorageKey) ?? '')
      ?? defaultCustomAccentColor;
  } catch {
    return defaultCustomAccentColor;
  }
}

export function writeCustomAccentColorPreference(color: string): void {
  const normalized = normalizeHexColor(color);
  if (normalized === undefined) return;
  try {
    window.localStorage.setItem(customAccentColorStorageKey, normalized);
  } catch {
    return;
  }
}

export function applyAccentColor(
  color: AccentColor,
  customColor = defaultCustomAccentColor,
  brandColor?: string
): void {
  const normalizedBrandColor = normalizeHexColor(brandColor ?? '');
  const normalizedCustomColor = (color === 'brand' ? normalizedBrandColor : normalizeHexColor(customColor)) ?? defaultCustomAccentColor;
  document.documentElement.dataset.accent = color === 'brand'
    ? (normalizedBrandColor === undefined ? defaultAccentColor : 'brand')
    : color;
  document.documentElement.style.setProperty('--custom-accent-value', normalizedCustomColor);
  document.documentElement.style.setProperty(
    '--custom-on-accent',
    contrastColor(normalizedCustomColor)
  );
  if (color === 'brand' && normalizedBrandColor !== undefined) {
    const [hue, saturation, lightness] = hexToHsl(normalizedBrandColor);
    document.documentElement.style.setProperty('--brand-accent-value', normalizedBrandColor);
    document.documentElement.style.setProperty('--brand-light-soft', lightness >= 0.85
      ? normalizedBrandColor
      : hslToHex(hue, saturation, 0.93));
    for (const theme of ['light', 'dark'] as const) {
      const accent = deriveBrandAccent(hue, saturation, lightness, theme);
      document.documentElement.style.setProperty(`--brand-${theme}-accent`, accent);
      document.documentElement.style.setProperty(`--brand-${theme}-on-accent`, contrastColor(accent));
    }
  }
}

export function normalizeHexColor(value: string): string | undefined {
  const match = value.trim().match(/^#?([\da-f]{3}|[\da-f]{6})$/i);
  if (match === null) return undefined;
  const hex = match[1]!.toLowerCase();
  return hex.length === 3
    ? `#${hex.split('').map(channel => channel.repeat(2)).join('')}`
    : `#${hex}`;
}

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16));
  return channels
    .map(channel => channel / 255)
    .map(channel => channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) =>
      total + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}

function contrastColor(color: string): '#111113' | '#f8fafc' {
  const luminance = relativeLuminance(color);
  const darkContrast = (luminance + 0.05) / 0.055;
  const lightContrast = 1.05 / (luminance + 0.05);
  return darkContrast >= lightContrast ? '#111113' : '#f8fafc';
}

function hexToHsl(color: string): [number, number, number] {
  const [red, green, blue] = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) / 255) as [number, number, number];
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const difference = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  if (difference === 0) return [0, 0, lightness];
  const hue = maximum === red ? (green - blue) / difference
    : maximum === green ? (blue - red) / difference + 2
      : (red - green) / difference + 4;
  return [(hue * 60 + 360) % 360, difference / (1 - Math.abs(2 * lightness - 1)), lightness];
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  return `#${[0, 8, 4].map(offset => {
    const segment = (offset + hue / 30) % 12;
    const channel = lightness - amplitude * Math.max(-1, Math.min(segment - 3, 9 - segment, 1));
    return Math.round(channel * 255).toString(16).padStart(2, '0');
  }).join('')}`;
}

function deriveBrandAccent(hue: number, saturation: number, lightness: number, theme: 'light' | 'dark'): string {
  const dark = theme === 'dark';
  const background = relativeLuminance(dark ? '#282a2e' : '#e4e4e6');
  const accentSaturation = saturation === 0 ? 0 : Math.max(0.4, saturation);
  let accentLightness = dark ? Math.min(0.78, Math.max(0.7, lightness)) : Math.min(0.48, lightness);
  let accent = hslToHex(hue, accentSaturation, accentLightness);
  while (dark
    ? (relativeLuminance(accent) + 0.05) / (background + 0.05) < 4.5
    : (background + 0.05) / (relativeLuminance(accent) + 0.05) < 4.5) {
    accentLightness = Math.max(0, Math.min(1, accentLightness + (dark ? 0.01 : -0.01)));
    accent = hslToHex(hue, accentSaturation, accentLightness);
  }
  return accent;
}
