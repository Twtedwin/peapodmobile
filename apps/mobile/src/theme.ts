/**
 * MODULE: apps/mobile/src/theme.ts
 *
 * PURPOSE
 *   The only colour, spacing, and type-scale tokens the screens read. Dark
 *   green, pea-green accent, cream text is the product look; light mode is a
 *   cream-paper inversion of the same palette so the toggle on the You tab
 *   is a real theme, not a grey filter.
 *
 * INPUTS  : a `dark` boolean from the session store
 * OUTPUTS : a frozen palette + spacing/radius helpers
 *
 * CONSUMED BY : every screen and shared component in this app
 */

/** Shared colour token names. Values differ between dark and light palettes. */
export interface Colors {
  bg: string;
  bgElevated: string;
  card: string;
  cardBorder: string;
  text: string;
  textMuted: string;
  accent: string;
  accentDim: string;
  accentText: string;
  danger: string;
  dangerDim: string;
  cream: string;
  overlay: string;
  map: string;
}

/** Dark-mode colours. Default, and the look the rest of the product was designed against. */
export const darkColors: Colors = {
  bg: '#0F1512',
  bgElevated: '#171F1B',
  card: '#1C2621',
  cardBorder: 'rgba(245, 236, 220, 0.08)',
  text: '#F5ECDC',
  textMuted: 'rgba(245, 236, 220, 0.62)',
  accent: '#7CDB6A',
  accentDim: 'rgba(124, 219, 106, 0.16)',
  accentText: '#0F1512',
  danger: '#E07A5F',
  dangerDim: 'rgba(224, 122, 95, 0.16)',
  cream: '#F5ECDC',
  overlay: 'rgba(8, 12, 10, 0.72)',
  map: '#0F1512',
};

/** Light-mode inversion: cream paper, ink text, the same pea-green accent. */
export const lightColors: Colors = {
  bg: '#F5ECDC',
  bgElevated: '#EFE4D0',
  card: '#FFFFFF',
  cardBorder: 'rgba(15, 21, 18, 0.08)',
  text: '#0F1512',
  textMuted: 'rgba(15, 21, 18, 0.55)',
  accent: '#3FA82E',
  accentDim: 'rgba(63, 168, 46, 0.14)',
  accentText: '#FFFFFF',
  danger: '#C45C42',
  dangerDim: 'rgba(196, 92, 66, 0.12)',
  cream: '#F5ECDC',
  overlay: 'rgba(15, 21, 18, 0.45)',
  map: '#E8F0E4',
};

/** 4-pt spacing scale. Named so screens never invent a magic padding. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 10,
  md: 16,
  lg: 22,
  xl: 28,
  pill: 999,
} as const;

export const type = {
  hero: { fontSize: 32, fontWeight: '700' as const, letterSpacing: -0.6 },
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.3 },
  subtitle: { fontSize: 16, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '500' as const, letterSpacing: 0.2 },
  overline: {
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 1.6,
    textTransform: 'uppercase' as const,
  },
};

/** Palette for member markers / avatars. Index by a stable hash of the user id. */
export const memberPalette = ['#7CDB6A', '#4A90C8', '#E07A5F', '#A07CE0', '#E0B04A', '#5FB07A', '#EC4899'];

/**
 * Picks a member colour that is stable for a given id.
 *
 * @param id User id, or any string. Empty string hashes to the first colour.
 */
export function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return memberPalette[Math.abs(hash) % memberPalette.length]!;
}

/**
 * Returns the active palette.
 *
 * @param dark True for the default dark-green look.
 */
export function themeColors(dark: boolean): Colors {
  return dark ? darkColors : lightColors;
}
