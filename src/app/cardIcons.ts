/** Small inline SVG icons for the unit cards (24x24 grid, stroke only; colour comes from `currentColor`). */
const PATHS = {
  heart: 'M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.4-7 10-7 10z',
  flame: 'M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.2 2-4.2 0 2 1 3 2 3 0-3-1-5 1-8.8z',
  range: 'M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3',
  bolt: 'M13 3 6 13h5l-1 8 7-10h-5z',
  sword: 'M19 5l-11 11M19 5h-3.5M19 5v3.5M7 13l4 4M7.5 16.5 4 20',
  bow: 'M6 4c8 2 8 14 0 16M6 4v16M6 12h13M16 9l3 3-3 3',
  healer: 'M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.4-7 10-7 10zM12 9v5M9.5 11.5h5',
  burst: 'M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  target: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  slash: 'M4 20C10 18 16 12 20 4M15 4h5v5',
  pierce: 'M3 12h16M14 7l5 5-5 5',
  blunt: 'M6 6h9v6H6zM10.5 12v8',
  magic: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z',
  light: 'M5 19c8 0 14-6 14-14C11 5 5 11 5 19zM5 19l8-8',
  medium: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z',
  heavy: 'M5 8l7-4 7 4v8l-7 4-7-4zM9 12h6',
  spirit: 'M12 3c-4 0-6 3-6 7v10l3-2 3 2 3-2 3 2V10c0-4-2-7-6-7zM10 10v.5M14 10v.5',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  coin: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v8M9.5 10.2c0-1 1.2-1.7 2.5-1.7s2.5.7 2.5 1.7-1.2 1.4-2.5 1.8-2.5.8-2.5 1.8 1.2 1.7 2.5 1.7 2.5-.7 2.5-1.7',
} as const;

export type CardIcon = keyof typeof PATHS;

/** Returns an inline `<svg>` string for the icon (decorative: aria-hidden). */
export function cardIcon(name: CardIcon, size = 14): string {
  return `<svg class="ci" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`;
}
