import { TROOP_BY_ID } from '../sim/data/troops';
import { KIND_COUNT, STATS, isHealer, isMelee } from '../sim/units';

/** Satir rolleri: on (yakin), orta (uzak), arka (sifaci/kusatma). */
export type Lane = 'front' | 'mid' | 'back';

const REF = Math.sqrt(160 * 16);

/** Birimin "savasci esdegeri" maliyeti: can ve guce gore (Savasci = 1). */
export function unitCost(kind: number): number {
  const s = STATS[kind];
  return Math.min(10, Math.max(0.5, Math.sqrt((s.hp * s.power) / Math.max(0.2, s.cooldown)) / REF / 1.2));
}

export function laneOf(kind: number): Lane {
  if (isHealer(kind)) return 'back';
  if (isMelee(kind)) return 'front';
  const t = STATS[kind].troop ? TROOP_BY_ID[STATS[kind].troop!] : undefined;
  // Kusatma makineleri ve cok uzun menzilliler en arkada.
  if (STATS[kind].range >= 10 || (t && t.move === 0 && t.atkSpd <= 0.35)) return 'back';
  return 'mid';
}

/** Yerlestirme listesinde bulunabilen turler (cagrilan birimler haric). */
export function placeableKinds(): number[] {
  const out: number[] = [];
  for (let k = 0; k < KIND_COUNT; k++) {
    const t = STATS[k].troop ? TROOP_BY_ID[STATS[k].troop!] : undefined;
    if (t?.summoned) continue;
    out.push(k);
  }
  return out;
}

const pick = <T>(rnd: () => number, list: T[]): T => list[Math.floor(rnd() * list.length) % list.length];

/**
 * Rol dengeli rastgele ordu: yakin/uzak/arka hat butceye gore doldurulur.
 * `anchor` verilirse o tur kendi hattinin ana birimi olur.
 */
export function composeArmy(rnd: () => number, budget = 26, anchor = -1): Record<Lane, number[]> {
  const pool: Record<Lane, number[]> = { front: [], mid: [], back: [] };
  for (const k of placeableKinds()) pool[laneOf(k)].push(k);
  const share: Record<Lane, number> = { front: 0.5, mid: 0.32, back: 0.18 };
  const rows: Record<Lane, number[]> = { front: [], mid: [], back: [] };
  const lanes: Lane[] = ['front', 'mid', 'back'];
  for (const lane of lanes) {
    const kinds: number[] = [];
    if (anchor >= 0 && laneOf(anchor) === lane) kinds.push(anchor);
    const extra = lane === 'front' ? 1 + Math.floor(rnd() * 2) : 1;
    while (kinds.length < (anchor >= 0 && laneOf(anchor) === lane ? 2 : extra + 0) && pool[lane].length) kinds.push(pick(rnd, pool[lane]));
    if (!kinds.length && pool[lane].length) kinds.push(pick(rnd, pool[lane]));
    let left = budget * share[lane];
    kinds.forEach((k, i) => {
      const portion = left / (kinds.length - i);
      const n = Math.max(1, Math.min(14, Math.round(portion / unitCost(k))));
      left -= n * unitCost(k);
      for (let c = 0; c < n; c++) rows[lane].push(k);
    });
  }
  return rows;
}

/** Tek turden ordu: secili turden, hatti ne olursa olsun, butceye gore adet (formasyon doldur). */
export function composeFromKind(kind: number, rnd: () => number, budget = 26): Record<Lane, number[]> {
  const army = composeArmy(rnd, budget, kind);
  return army;
}
