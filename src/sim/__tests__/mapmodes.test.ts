import { describe, expect, it } from 'vitest';
import { Battle, terrainFor, type BattleConfig } from '../battle';
import { effectiveMapSpec } from '../battleConfig';
import { GuestSession, HostSession } from '../../net/client';
import { teamZones } from '../../net/economy';
import { HostLobby } from '../../net/host';
import { PROTOCOL, type LobbySettings, type ServerMsg } from '../../net/protocol';
import { LoopbackHub } from '../../net/transport';
import {
  LANES_PRESET,
  MODE_LAYOUTS_TABLE,
  compatibleLayouts,
  fallbackPreset,
  fitMapToMode,
  isMapCompatible,
  mapsFor,
  modeHasFixedMap,
  randomSpecFor,
} from '../mapModes';
import { BIOMES, CROSSINGS, DEFAULT_MAP, FORESTS, LAYOUTS, MODE_LAYOUTS, PRESETS, RELIEFS, RIVERS, SELECTABLE_LAYOUTS, VILLAGES, lanesSpec, randomSpec, sameSpec, sanitizeSpec, type LayoutType, type MapSpec } from '../mapSpec';
import { arenaRadius, fortGeometry, plateauRadius } from '../terrainModes';
import { GAME_MODE_IDS, type GameModeId } from '../modes';
import { NEW_LAYOUTS, battleOn, detour, newPresets, opts } from '../testing/mapAudit';
import { mulberry32 } from '../random';
import { Terrain, T_BLOCKED } from '../terrain';
import { Kind } from '../units';


describe('map/mode table', () => {
  it('is total: every mode has maps, the first one is the default and every listed map is compatible', () => {
    for (const mode of GAME_MODE_IDS) {
      const list = mapsFor(mode);
      expect(list.length, mode).toBeGreaterThanOrEqual(1);
      expect(fallbackPreset(mode), mode).toBe(list[0]);
      expect(new Set(list.map((p) => p.id)).size, `${mode} ids unique`).toBe(list.length);
      expect(mapsFor(mode), `${mode} stable`).toBe(list);
      for (const p of list) expect(isMapCompatible(p.spec, mode), `${mode} ${p.id}`).toBe(true);
      expect(MODE_LAYOUTS_TABLE[mode].length, mode).toBeGreaterThanOrEqual(1);
      if (mode !== 'lanes') for (const l of compatibleLayouts(mode)) expect(list.some((p) => p.spec.layout === l), `${mode} has a preset of ${l}`).toBe(true);
    }
    expect(Object.keys(MODE_LAYOUTS_TABLE).sort()).toEqual([...GAME_MODE_IDS].sort());
  });

  it('classic (and undefined) lists every preset in PRESETS order and accepts them all; only lanes has a fixed map', () => {
    expect(mapsFor('classic')).toEqual(PRESETS);
    expect(mapsFor(undefined)).toBe(mapsFor('classic'));
    expect(fallbackPreset(undefined).id).toBe(PRESETS[0].id);
    for (const p of PRESETS) {
      expect(isMapCompatible(p.spec, 'classic'), p.id).toBe(true);
      expect(isMapCompatible(p.spec, undefined), p.id).toBe(true);
      expect(fitMapToMode(p.spec, 'classic').changed, p.id).toBe(false);
    }
    expect(isMapCompatible({ ...DEFAULT_MAP, layout: 'lanes' }, 'classic')).toBe(false);
    for (const mode of GAME_MODE_IDS) expect(modeHasFixedMap(mode), mode).toBe(mode === 'lanes');
    expect(modeHasFixedMap(undefined)).toBe(false);
    expect(mapsFor('lanes')).toEqual([LANES_PRESET]);
    expect(LANES_PRESET.spec.layout).toBe('lanes');
  });

  it('the final table', () => {
    // Documented in docs/SIMULATION.md; a change here must be a deliberate decision backed by the audits below.
    expect(MODE_LAYOUTS_TABLE).toEqual({
      classic: ['classic', 'valley', 'citadel', 'archipelago', 'crossroads', 'arena', 'forts', 'plateau'],
      hill: ['arena', 'plateau', 'classic', 'valley', 'crossroads', 'citadel'],
      vip: ['arena', 'classic', 'valley', 'citadel', 'archipelago', 'crossroads', 'forts', 'plateau'],
      ctf: ['forts', 'arena', 'classic', 'valley', 'crossroads'],
      siege: ['citadel', 'forts', 'plateau'],
      horde: ['plateau', 'arena', 'classic', 'crossroads', 'citadel'],
      lanes: ['lanes'],
    });
    expect(mapsFor('siege').map((p) => p.id).slice(0, 2)).toEqual(['citadel-hill', 'desert-fortress']);
    // Every mode layout is played by at least one mode besides classic, and the lanes layout by exactly its mode.
    for (const l of NEW_LAYOUTS) expect(GAME_MODE_IDS.filter((m) => m !== 'classic' && compatibleLayouts(m).includes(l)).length, l).toBeGreaterThanOrEqual(2);
    expect(GAME_MODE_IDS.filter((m) => compatibleLayouts(m).includes('lanes'))).toEqual(['lanes']);
  });

  it('new presets: unique ids, both languages, appended after the old presets, neutral names', () => {
    const fresh = newPresets();
    expect(fresh.length).toBeGreaterThanOrEqual(9);
    for (const l of NEW_LAYOUTS) expect(fresh.filter((p) => p.spec.layout === l).length, l).toBeGreaterThanOrEqual(2);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    const firstNew = PRESETS.findIndex((p) => NEW_LAYOUTS.includes(p.spec.layout));
    expect(PRESETS.slice(firstNew).every((p) => NEW_LAYOUTS.includes(p.spec.layout))).toBe(true);
    for (const p of fresh) {
      expect(p.name.en.length, p.id).toBeGreaterThan(2);
      expect(p.name.tr.length, p.id).toBeGreaterThan(2);
      expect(p.spec.river, p.id).toBe('none');
    }
    expect(new Set(fresh.filter((p) => p.spec.layout === 'arena').map((p) => p.spec.biome)).size).toBeGreaterThanOrEqual(3);
  });
});

describe('fit and random', () => {
  it('fitMapToMode returns the same object when compatible, the fallback preset spec (a copy) when not', () => {
    const arena = PRESETS.find((p) => p.id === 'pillar-arena')!;
    expect(fitMapToMode(arena.spec, 'hill')).toEqual({ spec: arena.spec, presetId: 'pillar-arena', changed: false });
    expect(fitMapToMode(arena.spec, 'hill').spec).toBe(arena.spec);
    const classicMap = PRESETS[0];
    const fit = fitMapToMode(classicMap.spec, 'siege');
    expect(fit.changed).toBe(true);
    expect(fit.presetId).toBe(fallbackPreset('siege').id);
    expect(fit.spec).toEqual(fallbackPreset('siege').spec);
    expect(fit.spec).not.toBe(fallbackPreset('siege').spec);
    expect(isMapCompatible(fit.spec, 'siege')).toBe(true);
    // fitting is idempotent
    expect(fitMapToMode(fit.spec, 'siege').changed).toBe(false);
    // the biome of the old map is not kept: the fallback is "the first supported map"
    expect(fitMapToMode({ ...classicMap.spec, biome: 'swamp' }, 'siege').spec).toEqual(fallbackPreset('siege').spec);
  });

  it('custom recipes are judged by layout; a compatible custom recipe has no preset id', () => {
    const custom: MapSpec = { biome: 'swamp', river: 'lake', forest: 'ring', village: 'camp', crossing: 'ford', relief: 'hills', layout: 'valley' };
    expect(isMapCompatible(custom, 'hill')).toBe(true);
    expect(isMapCompatible(custom, 'siege')).toBe(false);
    expect(fitMapToMode(custom, 'hill')).toEqual({ spec: custom, presetId: null, changed: false });
    expect(fitMapToMode(custom, 'siege').changed).toBe(true);
    // every layout x mode pair agrees with the table
    for (const mode of GAME_MODE_IDS) for (const l of [...SELECTABLE_LAYOUTS, 'lanes' as LayoutType]) expect(isMapCompatible({ ...custom, layout: l }, mode), `${mode} ${l}`).toBe(compatibleLayouts(mode).includes(l));
  });

  it('lanes forces the lanes layout, keeps the biome and reports the synthetic preset', () => {
    const swamp = { ...PRESETS[0].spec, biome: 'swamp' as const };
    const fit = fitMapToMode(swamp, 'lanes');
    expect(fit.changed).toBe(true);
    expect(fit.presetId).toBe('lanes');
    expect(fit.spec).toEqual(lanesSpec(swamp));
    expect(fit.spec.biome).toBe('swamp');
    const again = fitMapToMode(fit.spec, 'lanes');
    expect(again.changed).toBe(false);
    expect(again.spec).toBe(fit.spec);
    expect(effectiveMapSpec({ mode: 'custom', perTeam: 0, rules: 'lanes', map: swamp })).toEqual(lanesSpec(swamp));
  });

  it('randomSpec is unchanged for existing seeds (the mode layouts are not in the random pool)', () => {
    // The pre-mode-maps algorithm, written out with literal lists.
    const old = (rnd: () => number): MapSpec => {
      const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length) % list.length];
      return {
        biome: pick(['forest', 'desert', 'snow', 'swamp'] as const),
        river: pick(['winding', 'straight', 'islands', 'lake', 'none'] as const),
        forest: pick(['dense', 'sparse', 'grove', 'ring', 'none'] as const),
        village: pick(['village', 'scattered', 'ruins', 'camp', 'none'] as const),
        crossing: pick(['wood', 'stone', 'ford'] as const),
        relief: pick(['flat', 'hills', 'ridge', 'plateau', 'peak'] as const),
        layout: pick(['classic', 'valley', 'citadel', 'archipelago', 'crossroads'] as const),
      };
    };
    expect(LAYOUTS).toEqual(['classic', 'valley', 'citadel', 'archipelago', 'crossroads']);
    expect(MODE_LAYOUTS).toEqual(NEW_LAYOUTS);
    for (let seed = 1; seed <= 300; seed++) {
      expect(randomSpec(mulberry32(seed)), `seed ${seed}`).toEqual(old(mulberry32(seed)));
      expect(randomSpecFor('classic', mulberry32(seed)), `seed ${seed} classic`).toEqual(old(mulberry32(seed)));
      expect(randomSpecFor(undefined, mulberry32(seed)), `seed ${seed} undefined`).toEqual(old(mulberry32(seed)));
    }
  });

  it('sanitizeSpec accepts the mode layouts, still refuses lanes and unknown layouts', () => {
    for (const l of NEW_LAYOUTS) expect(sanitizeSpec({ ...DEFAULT_MAP, layout: l }).layout).toBe(l);
    expect(sanitizeSpec({ ...DEFAULT_MAP, layout: 'lanes' }).layout).toBe('classic');
    expect(sanitizeSpec({ ...DEFAULT_MAP, layout: 'moon' }).layout).toBe('classic');
    for (const p of PRESETS) expect(sanitizeSpec(p.spec), p.id).toEqual(p.spec);
  });

  it('randomSpecFor always gives a compatible, valid, deterministic recipe and reaches every layout of the mode', () => {
    for (const mode of GAME_MODE_IDS) {
      const seen = new Set<LayoutType>();
      for (let seed = 1; seed <= 400; seed++) {
        const s = randomSpecFor(mode, mulberry32(seed));
        expect(isMapCompatible(s, mode), `${mode} seed ${seed}`).toBe(true);
        expect(randomSpecFor(mode, mulberry32(seed)), `${mode} deterministic`).toEqual(s);
        expect(BIOMES).toContain(s.biome);
        expect(RIVERS).toContain(s.river);
        expect(FORESTS).toContain(s.forest);
        expect(VILLAGES).toContain(s.village);
        expect(CROSSINGS).toContain(s.crossing);
        expect(RELIEFS).toContain(s.relief);
        seen.add(s.layout);
      }
      // Classic keeps the old random pool (the mode layouts are not in it); every other mode reaches all of its layouts.
      expect([...seen].sort(), mode).toEqual([...(mode === 'classic' ? LAYOUTS : compatibleLayouts(mode))].sort());
    }
  });
});

describe('new layouts: layout rules', () => {
  it('arena: an open round disc, wide open centre, forest wall in the corners, ponds with bridges, pillars', () => {
    for (const p of newPresets().filter((q) => q.spec.layout === 'arena')) {
      for (const size of [56, 100, 200]) {
        const t = new Terrain(size, { seed: 3, spec: p.spec, ...opts });
        const c = size / 2;
        const where = `${p.id} ${size}`;
        let centreBlocked = 0;
        let outsideWalkable = 0;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const dist = Math.hypot(x + 0.5 - c, y + 0.5 - c);
            if (dist < size * 0.14 && !t.walkable(x + 0.5, y + 0.5)) centreBlocked++;
            if (dist > arenaRadius(size) + 0.6 && t.walkable(x + 0.5, y + 0.5)) outsideWalkable++;
          }
        }
        expect(centreBlocked, `${where} centre`).toBe(0);
        expect(outsideWalkable, `${where} outside the disc`).toBe(0);
        expect(t.crossWaterTiles.length, `${where} pond tiles`).toBeGreaterThan(8);
        expect(t.crossBridgeTiles.length, `${where} bridge tiles`).toBeGreaterThan(2);
        expect(t.crossWaterTiles.length % 2 + t.crossBridgeTiles.length % 2, `${where} pond pairs`).toBe(0);
        for (const i of t.crossBridgeTiles) expect(t.flags[i]).toBe(2);
        expect(t.decor.filter((d) => d.kind === 'wall' || d.kind === 'boulder').length, `${where} pillars`).toBeGreaterThanOrEqual(8);
        expect(t.bridges.length, `${where} no river`).toBe(0);
        expect(t.riverKind).toBe('none');
        // No long barriers: pillar pieces (wall/boulder decor) form clusters of a few tiles at most, so the arena has no corridors.
        const piece = new Set<number>();
        for (const d of t.decor) if ((d.kind === 'wall' || d.kind === 'boulder') && Math.hypot(d.x - c, d.y - c) < arenaRadius(size) - 3) piece.add(Math.floor(d.y) * size + Math.floor(d.x));
        const seen = new Set<number>();
        for (const start of piece) {
          if (seen.has(start)) continue;
          let count = 0;
          const stack = [start];
          seen.add(start);
          while (stack.length) {
            const i = stack.pop()!;
            count++;
            for (const j of [i + 1, i - 1, i + size, i - size]) if (piece.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); }
          }
          expect(count, `${where} pillar cluster`).toBeLessThanOrEqual(8);
        }
      }
    }
  });

  it('forts: two walled fortresses with two gates each, keeps (towers) inside, open field between, bases fit inside', () => {
    for (const p of newPresets().filter((q) => q.spec.layout === 'forts')) {
      for (const size of [56, 80, 120, 200]) {
        const t = new Terrain(size, { seed: 3, spec: p.spec, ...opts });
        const g = fortGeometry(size);
        const where = `${p.id} ${size}`;
        const half = g.half;
        const forts = [[g.fx0, g.fy0], [g.fx1, g.fy1]];
        // Walls: the ring is blocked except the gates; the interior and the gate approaches are walkable and reachable.
        for (const [fx, fy] of forts) {
          expect(t.walkable(fx, fy) && t.reachable(fx, fy), `${where} fort centre`).toBe(true);
          const wallTiles = (dx: number, dy: number): number => {
            let blocked = 0;
            for (let k = -half; k <= half; k++) {
              const x = fx + dx * half + (dx === 0 ? k : 0);
              const y = fy + dy * half + (dy === 0 ? k : 0);
              if (!t.walkable(x, y)) blocked++;
            }
            return blocked;
          };
          const sides = [wallTiles(1, 0), wallTiles(-1, 0), wallTiles(0, 1), wallTiles(0, -1)];
          // Exactly two of the four walls have a gate (their count is lower by about the gate width), the others are closed.
          const sorted = [...sides].sort((a, b) => a - b);
          expect(sorted[1] + g.gate - 1, `${where} gated walls ${sides}`).toBeLessThanOrEqual(sorted[2] + 1);
          expect(sorted[2] - sorted[1], `${where} closed walls match ${sides}`).toBeGreaterThanOrEqual(g.gate - 2);
          // Straight lines out of the fort through both gates reach the field.
          const gateTiles = [[fx + (fx < size / 2 ? half : -half), fy], [fx, fy + (fy < size / 2 ? half : -half)]];
          for (const [gx, gy] of gateTiles) {
            expect(t.walkable(gx, gy) && t.reachable(gx, gy), `${where} gate at ${gx},${gy}`).toBe(true);
            const d = detour(t, { x: fx, y: fy }, { x: size / 2 + (gx - size / 2) * 0.2, y: size / 2 + (gy - size / 2) * 0.2 });
            expect(d, `${where} gate route`).not.toBeNull();
          }
        }
        // The two forts are point mirrors and connected by a sane route through the field.
        const d = detour(t, { x: g.fx0, y: g.fy0 }, { x: g.fx1, y: g.fy1 });
        expect(d, `${where} fort to fort`).not.toBeNull();
        expect(d!, `${where} fort to fort detour`).toBeLessThan(1.6);
        expect(t.decor.filter((q) => q.kind === 'tower').length, `${where} towers`).toBe(16);
        expect(t.decor.filter((q) => q.kind === 'keep').length, `${where} no keep (the siege core uses the defender's units)`).toBe(0);
        // The default zone centre of each team lies inside its fort, so a flag base and an army fit.
        const zones = teamZones(size, 2, t);
        zones.forEach((z, i) => {
          const [fx, fy] = forts[i];
          expect(Math.max(Math.abs(z.cx - fx), Math.abs(z.cy - fy)), `${where} zone ${i} centre inside its fort`).toBeLessThan(half + 1);
        });
        // Cover in the field.
        expect(t.decor.filter((q) => q.kind === 'wall').length, `${where} walls`).toBeGreaterThan(40 * (size / 56) / 2);
      }
    }
  });

  it('plateau: a raised centre with four ramps, a flat ring, the top reachable by every direction of the ramps only', () => {
    for (const p of newPresets().filter((q) => q.spec.layout === 'plateau')) {
      for (const size of [56, 80, 120]) {
        const t = new Terrain(size, { seed: 3, spec: p.spec, ...opts });
        const c = size / 2;
        const rp = plateauRadius(size);
        const where = `${p.id} ${size}`;
        expect(t.hasRelief, where).toBe(true);
        expect(t.maxH, `${where} height`).toBeGreaterThanOrEqual(5);
        expect(t.heightAt(c, c), `${where} top`).toBeGreaterThan(5);
        expect(t.walkable(c, c) && t.reachable(c, c), `${where} top reachable`).toBe(true);
        // Flat ring: the ground at 1.5 radii is level.
        for (const a of [0.3, 1.9, 3.4, 5.2]) expect(t.heightAt(c + Math.cos(a) * rp * 1.5, c + Math.sin(a) * rp * 1.5), `${where} ring`).toBeLessThan(0.3);
        // Four ramps: walking from the centre outwards along the diagonals works, along the axes the rim blocks it.
        const open = (ang: number): boolean => t.lineWalkable(c, c, c + Math.cos(ang) * (rp + 3), c + Math.sin(ang) * (rp + 3));
        const ramps = [-Math.PI / 4, Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4];
        for (const a of ramps) expect(open(a), `${where} ramp ${a}`).toBe(true);
        for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) expect(open(a), `${where} cliff ${a}`).toBe(false);
        // The rim is cliffs: blocked tiles all around except at the ramps.
        expect(t.cliffTiles.length, `${where} cliffs`).toBeGreaterThan(rp * 2);
        // Siege puts the core on top, hill puts the middle point there.
        const { b } = battleOn(p.spec, 'siege', size, 2, 3);
        const h = b.modeHud();
        if (h.kind !== 'siege') throw new Error('not siege');
        expect(Math.hypot(h.x - c, h.y - c), `${where} core on the plateau`).toBeLessThan(2.5);
      }
    }
  });

  it('terrain data stays compatible with the renderers: pond tiles are cross water/bridge tiles, towers are blocked tiles', () => {
    for (const p of newPresets()) {
      const t = new Terrain(80, { seed: 5, spec: p.spec, ...opts });
      for (const i of t.crossWaterTiles) expect(t.flags[i]).toBe(1);
      for (const d of t.decor) {
        if (d.kind === 'tower') expect(t.flags[(Math.floor(d.y) - 1) * 80 + Math.floor(d.x) - 1], `${p.id} tower tile`).toBe(T_BLOCKED);
        expect(d.x >= 0 && d.y >= 0 && d.x <= 80 && d.y <= 80, p.id).toBe(true);
      }
    }
  });
});

describe('enforcement in the sim', () => {
  const base = (rules: GameModeId | undefined, map: MapSpec | undefined): BattleConfig => ({ mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 56, env: true, terrainSeed: 3, map, rules, layout: new Float32Array([0, Kind.Warrior, 10, 40, 1, Kind.Warrior, 44, 12]) });

  it('an incompatible recipe is played on the first map of the mode; a compatible one is untouched; classic never changes', () => {
    for (const mode of GAME_MODE_IDS) {
      if (mode === 'lanes') continue;
      const fb = fallbackPreset(mode);
      for (const p of PRESETS) {
        const cfg = base(mode, p.spec);
        const eff = effectiveMapSpec(cfg)!;
        if (isMapCompatible(p.spec, mode)) expect(eff, `${mode} ${p.id}`).toBe(p.spec);
        else {
          expect(eff, `${mode} ${p.id}`).toEqual(fb.spec);
          const t = terrainFor(cfg)!;
          const ref = new Terrain(56, { seed: 3, spec: fb.spec, ...opts });
          expect(t.layout).toBe(fb.spec.layout);
          expect(Array.from(t.flags), `${mode} ${p.id} terrain is the fallback's`).toEqual(Array.from(ref.flags));
        }
      }
    }
    // Classic and unset rules: every preset is returned as is (same object), an unset recipe stays unset.
    for (const rules of [undefined, 'classic'] as const) {
      for (const p of PRESETS) expect(effectiveMapSpec(base(rules, p.spec)), p.id).toBe(p.spec);
      expect(effectiveMapSpec(base(rules, undefined))).toBeUndefined();
    }
    // An unset recipe is the default forest map: fine for hill, replaced for siege.
    expect(effectiveMapSpec(base('hill', undefined))).toBeUndefined();
    expect(effectiveMapSpec(base('siege', undefined))).toEqual(fallbackPreset('siege').spec);
  });

  it('a real battle on an incompatible recipe runs on the fallback terrain (and keeps working for every mode)', () => {
    for (const mode of GAME_MODE_IDS) {
      const b = new Battle(7, base(mode, PRESETS[0].spec));
      // The default forest map (classic layout) is kept where the mode lists it and replaced by the first map of the mode elsewhere.
      const want = mode === 'lanes' ? 'lanes' : isMapCompatible(PRESETS[0].spec, mode) ? 'classic' : fallbackPreset(mode).spec.layout;
      expect(b.terrain!.layout, mode).toBe(want);
      for (let i = 0; i < 20; i++) b.step(1 / 30);
    }
  });

  it('the recipes in the table play a battle without trouble in their mode (smoke, every mode, first map and a mode layout)', () => {
    for (const mode of GAME_MODE_IDS) {
      if (mode === 'lanes') continue;
      for (const p of [mapsFor(mode)[0], mapsFor(mode)[mapsFor(mode).length - 1]]) {
        const teams = mode === 'horde' ? 2 : 3;
        const { b } = battleOn(p.spec, mode, 56, teams, 2);
        for (let i = 0; i < 60; i++) b.step(1 / 30);
        expect(b.terrain!.spec, `${mode} ${p.id}`).toBe(p.spec);
      }
    }
  });
});

// ---------------------------------------------------------------- online

interface Rig {
  hub: LoopbackHub;
  host: HostLobby;
  hs: HostSession;
}

function rig(seed = 5): Rig {
  const hub = new LoopbackHub();
  const clock = { t: 1000 };
  const host = new HostLobby(hub.host, 'Host', 0, { now: () => clock.t, rnd: mulberry32(seed) });
  return { hub, host, hs: new HostSession(host, false) };
}

function lobby(guests: number, settings: Partial<LobbySettings>, seed = 5): { r: Rig; gs: GuestSession[] } {
  const r = rig(seed);
  const gs = Array.from({ length: guests }, (_, i) => new GuestSession(r.hub.connect(), { name: `G${i}`, color: i + 1 }));
  r.hs.send({ t: 'settings', settings: { gold: 600, openPlacement: true, ...settings } });
  for (const g of gs) g.send({ t: 'ready', ready: true });
  return { r, gs };
}

describe('online: the host keeps the room on a map its mode can use', () => {
  it('the protocol version moved to 17 (or later)', () => {
    expect(PROTOCOL).toBeGreaterThanOrEqual(17);
  });

  it('choosing a mode fits the stored map at once, tells the host and updates the lobby state for everybody', () => {
    const { r, gs } = lobby(1, { mapMode: 'fixed', map: PRESETS[0].spec });
    const seen: ServerMsg[] = [];
    r.hs.model.listeners.push((m) => seen.push(m));
    const guestSeen: ServerMsg[] = [];
    gs[0].model.listeners.push((m) => guestSeen.push(m));
    r.hs.send({ t: 'settings', settings: { gameMode: 'siege' } });
    const want = fallbackPreset('siege');
    expect(r.hs.model.state!.settings.map).toEqual(want.spec);
    expect(gs[0].model.state!.settings.map, 'guests see the fitted map').toEqual(want.spec);
    expect(seen.filter((m) => m.t === 'mapFitted')).toEqual([{ t: 'mapFitted', presetId: want.id, mode: 'siege' }]);
    expect(r.hs.model.mapFit).toEqual({ presetId: want.id, mode: 'siege' });
    expect(guestSeen.filter((m) => m.t === 'mapFitted'), 'only the host is told').toEqual([]);
    // a compatible mode afterwards keeps the (now compatible) map and sends nothing
    seen.length = 0;
    r.hs.send({ t: 'settings', settings: { gameMode: 'hill' } });
    expect(r.hs.model.state!.settings.map).toEqual(want.spec); // the citadel map is fine for hill too
    expect(seen.filter((m) => m.t === 'mapFitted')).toEqual([]);
  });

  it('a manual pick that the mode cannot use is coerced to the first map of the mode and answered with a code; a compatible pick is kept', () => {
    const { r } = lobby(1, { gameMode: 'ctf', mapMode: 'fixed' });
    const seen: ServerMsg[] = [];
    r.hs.model.listeners.push((m) => seen.push(m));
    const bad = PRESETS.find((p) => p.spec.layout === 'citadel')!;
    r.hs.send({ t: 'settings', settings: { map: bad.spec } });
    expect(r.hs.model.state!.settings.map).toEqual(fallbackPreset('ctf').spec);
    expect(seen.filter((m) => m.t === 'mapFitted')).toEqual([{ t: 'mapFitted', presetId: fallbackPreset('ctf').id, mode: 'ctf' }]);
    seen.length = 0;
    const good = PRESETS.find((p) => p.id === 'desert-bastions')!;
    r.hs.send({ t: 'settings', settings: { map: good.spec } });
    expect(r.hs.model.state!.settings.map).toEqual(good.spec);
    expect(seen.filter((m) => m.t === 'mapFitted')).toEqual([]);
    // other settings changes do not touch the map or send the code
    r.hs.send({ t: 'settings', settings: { gold: 900 } });
    expect(r.hs.model.state!.settings.map).toEqual(good.spec);
    expect(seen.filter((m) => m.t === 'mapFitted')).toEqual([]);
  });

  it('a guest cannot pick maps or modes; a random-map room is not told about a replaced base recipe', () => {
    const { r, gs } = lobby(1, { gameMode: 'siege', mapMode: 'fixed' });
    const before = r.hs.model.state!.settings.map;
    gs[0].send({ t: 'settings', settings: { map: PRESETS[0].spec, gameMode: 'classic' } });
    expect(r.hs.model.state!.settings.map).toEqual(before);
    expect(r.hs.model.state!.settings.gameMode).toBe('siege');
    const random = lobby(1, { mapMode: 'random', map: PRESETS[0].spec });
    const seen: ServerMsg[] = [];
    random.r.hs.model.listeners.push((m) => seen.push(m));
    random.r.hs.send({ t: 'settings', settings: { gameMode: 'horde' } });
    expect(isMapCompatible(random.r.hs.model.state!.settings.map, 'horde')).toBe(true);
    expect(seen.filter((m) => m.t === 'mapFitted')).toEqual([]);
  });

  it('Lane Conquest keeps the stored map (forced at start) and the pick is still there after leaving the mode', () => {
    const pick = PRESETS.find((p) => p.id === 'glacier-river')!;
    const { r, gs } = lobby(1, { mapMode: 'fixed', map: pick.spec });
    const seen: ServerMsg[] = [];
    r.hs.model.listeners.push((m) => seen.push(m));
    r.hs.send({ t: 'settings', settings: { gameMode: 'lanes' } });
    gs.forEach((g) => g.send({ t: 'ready', ready: true }));
    expect(r.hs.model.state!.settings.map).toEqual(pick.spec);
    expect(seen.filter((m) => m.t === 'mapFitted')).toEqual([]);
    r.hs.send({ t: 'start' });
    expect(r.hs.model.state!.init!.spec).toEqual(lanesSpec(pick.spec));
  });

  it('start() always hands out a compatible map: fixed picks, a stale incompatible setting, and random rooms of every mode', () => {
    for (const mode of GAME_MODE_IDS) {
      // fixed, with the stored recipe forced to an incompatible one behind the host's back
      const guests = mode === 'horde' || mode === 'lanes' ? 1 : 2;
      const { r } = lobby(guests, { gameMode: mode, mapMode: 'fixed' });
      r.host.settings.map = { ...PRESETS[0].spec, layout: mode === 'lanes' ? 'classic' : mode === 'classic' ? 'lanes' : 'archipelago' };
      r.hs.send({ t: 'start' });
      const init = r.hs.model.state!.init!;
      expect(init, mode).toBeTruthy();
      expect(isMapCompatible(init.spec, mode), `${mode} fixed`).toBe(true);
      // random rooms over many seeds
      for (let seed = 1; seed <= 12; seed++) {
        const rnd = lobby(guests, { gameMode: mode, mapMode: 'random', mapSize: 0 }, seed);
        rnd.r.hs.send({ t: 'start' });
        const ri = rnd.r.hs.model.state!.init!;
        expect(isMapCompatible(ri.spec, mode), `${mode} random seed ${seed}`).toBe(true);
        if (mode === 'classic') expect(ri.spec, `classic random is the old randomSpec(seed)`).toEqual(randomSpec(mulberry32(ri.seed)));
        else if (mode !== 'lanes') expect(ri.spec, `${mode} random reproducible from the seed`).toEqual(randomSpecFor(mode, mulberry32(ri.seed)));
      }
    }
  });

  it('the map that the host builds zones on is the one every client simulates', () => {
    const { r } = lobby(2, { gameMode: 'siege', mapMode: 'fixed' });
    r.hs.send({ t: 'start' });
    const init = r.hs.model.state!.init!;
    const cfg: BattleConfig = { mode: 'custom', perTeam: 0, teamCount: init.teams, mapSize: init.size, env: true, terrainSeed: init.seed, map: init.spec, rules: init.gameMode };
    expect(effectiveMapSpec(cfg)).toBe(init.spec);
    expect(sameSpec(init.spec, fallbackPreset('siege').spec)).toBe(true);
  });
});
