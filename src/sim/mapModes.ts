import { DEFAULT_MAP, LAYOUT_NAMES, PRESETS, lanesSpec, randomSpec, sameSpec, type LayoutType, type MapPreset, type MapSpec } from './mapSpec';
import type { GameModeId } from './modes/types';

// Which maps a game mode can be played on. Pure data and helpers (no app/i18n imports): the sim (`effectiveMapSpec`), the online host and the
// app all use the same table, so a battle can never start on a map its mode cannot use.
//
// The table is by LAYOUT (`MapSpec.layout`): a custom recipe is compatible when its layout is listed. A new mode MUST add its row here (the
// `Record` type makes that a compile error) and a map/layout is only listed after the audit in `mapmodes.test.ts` proves the mode's required
// points are walkable and reachable on it (hill control points, ctf bases, siege core, horde gates) for several seeds, sizes and team counts.
// The order of a row is the order of `mapsFor(mode)`: the first layout's first preset is the mode's default and the fallback.

/** Layouts per mode, in picker order. `classic` lists every ordinary layout (the 'lanes' layout is forced by its mode only). */
export const MODE_LAYOUTS_TABLE: Readonly<Record<GameModeId, readonly LayoutType[]>> = {
  classic: ['classic', 'valley', 'citadel', 'archipelago', 'crossroads', 'arena', 'forts', 'plateau'],
  // Open ground with a central point and two flanks: arenas and plateaus first, bridged islands are left out (every flank would be an island hop).
  hill: ['arena', 'plateau', 'classic', 'valley', 'crossroads', 'citadel'],
  // The VIP has no map-specific point: every ordinary layout works, the open arena is the default.
  vip: ['arena', 'classic', 'valley', 'citadel', 'archipelago', 'crossroads', 'forts', 'plateau'],
  // Two bases joined by a route a flag carrier can run: forts first (the flags sit in the strongholds), no islands and no citadel (its keep blocks the middle).
  ctf: ['forts', 'arena', 'classic', 'valley', 'crossroads'],
  // A core to defend: the citadel keep, a fort or the plateau.
  siege: ['citadel', 'forts', 'plateau'],
  // Waves arrive at the map border and walk in: a last stand on the plateau, an open arena, or the open classic layouts.
  horde: ['plateau', 'arena', 'classic', 'crossroads', 'citadel'],
  lanes: ['lanes'],
};

/** The layouts a mode can be played on (classic and `undefined` are the same). */
export function compatibleLayouts(mode: GameModeId | undefined): readonly LayoutType[] {
  return MODE_LAYOUTS_TABLE[mode ?? 'classic'];
}

/** Lane Conquest plays on one forced map (`lanesSpec`): the picker has nothing to offer. */
export function modeHasFixedMap(mode: GameModeId | undefined): boolean {
  return mode === 'lanes';
}

/** The single synthetic preset of a fixed-map mode (id 'lanes'); the biome of the recipe is the only thing a room can still choose. */
export const LANES_PRESET: MapPreset = { id: 'lanes', name: LAYOUT_NAMES.lanes, spec: lanesSpec(DEFAULT_MAP) };

const cache = new Map<GameModeId, MapPreset[]>();

/**
 * The presets a mode can be played on, in stable order. The FIRST entry is the mode's default and the fallback (`fallbackPreset`).
 * Classic (and `undefined`) returns every preset in `PRESETS` order. Lane Conquest returns the one synthetic `LANES_PRESET`
 * (`modeHasFixedMap('lanes')` is true: the UI hides the picker). The returned array is shared: do not mutate it.
 */
export function mapsFor(mode: GameModeId | undefined): MapPreset[] {
  const id = mode ?? 'classic';
  let list = cache.get(id);
  if (!list) {
    if (id === 'classic') list = PRESETS.slice();
    else if (id === 'lanes') list = [LANES_PRESET];
    else list = compatibleLayouts(id).flatMap((layout) => PRESETS.filter((p) => p.spec.layout === layout));
    cache.set(id, list);
  }
  return list;
}

/** Is a recipe (preset or custom) playable in this mode: its layout is in the mode's row. */
export function isMapCompatible(spec: MapSpec, mode: GameModeId | undefined): boolean {
  return compatibleLayouts(mode).includes(spec.layout);
}

/** The default map of a mode and the replacement for an incompatible one: `mapsFor(mode)[0]`. */
export function fallbackPreset(mode: GameModeId | undefined): MapPreset {
  return mapsFor(mode)[0];
}

/**
 * Makes sure a battle of this mode is played on a map it can use.
 * - Compatible recipe: the very same object comes back (`changed` false); `presetId` is the id of the preset with an equal recipe, or null for a custom one.
 * - Incompatible recipe: a copy of `fallbackPreset(mode).spec` (the first supported map). The biome of the old recipe is NOT kept: the user's
 *   rule is "the first supported map of that mode", and every biome is only a look, so the fallback is predictable and identical on every client.
 * - Lane Conquest: always `lanesSpec(spec)` (the layout is forced, the biome is kept for the look); `changed` is false when that equals the input.
 */
export function fitMapToMode(spec: MapSpec, mode: GameModeId | undefined): { spec: MapSpec; presetId: string | null; changed: boolean } {
  if (mode === 'lanes') {
    const forced = lanesSpec(spec);
    const same = sameSpec(forced, spec);
    return { spec: same ? spec : forced, presetId: LANES_PRESET.id, changed: !same };
  }
  if (isMapCompatible(spec, mode)) return { spec, presetId: PRESETS.find((p) => sameSpec(p.spec, spec))?.id ?? null, changed: false };
  const fb = fallbackPreset(mode);
  return { spec: { ...fb.spec }, presetId: fb.id, changed: true };
}

/**
 * A random recipe the mode can use, for "random map" rooms. Classic (and `undefined`) is exactly `randomSpec(rnd)`, so existing seeds give
 * the same maps. Other modes draw the seven fields as `randomSpec` does and then pick the layout uniformly from the mode's row (one extra
 * draw), so the mode layouts appear too. Lane Conquest: a random biome on the forced layout.
 */
export function randomSpecFor(mode: GameModeId | undefined, rnd: () => number): MapSpec {
  const base = randomSpec(rnd);
  if (mode === undefined || mode === 'classic') return base;
  if (mode === 'lanes') return lanesSpec(base);
  const layouts = compatibleLayouts(mode);
  return { ...base, layout: layouts[Math.floor(rnd() * layouts.length) % layouts.length] };
}
