import { it } from 'vitest';
import { LAYOUTS, PRESETS, DEFAULT_MAP, type MapSpec } from '../mapSpec';
import { Terrain } from '../terrain';

it('map stats', () => {
  const opts = { spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 };
  const rows: string[] = [];
  const specs: Array<[string, MapSpec]> = [...PRESETS.map((p) => [p.id, p.spec] as [string, MapSpec])];
  for (const l of LAYOUTS) specs.push([`layout:${l}`, { ...DEFAULT_MAP, layout: l }]);
  for (const [name, spec] of specs) {
    let ramps = 0, sealed = 0, worst = 0;
    for (const size of [56, 100]) for (let seed = 1; seed <= 4; seed++) {
      const t = new Terrain(size, { seed, spec, ...opts });
      ramps += t.fixInfo.ramps; sealed += t.fixInfo.sealed; worst = Math.max(worst, t.fixInfo.sealed / (size * size));
    }
    if (ramps || sealed) rows.push(`${name.padEnd(22)} ramps ${ramps}  sealed ${sealed}  worst sealed ${(worst * 100).toFixed(1)}%`);
  }
  console.log(rows.join('\n'));
}, 300000);
