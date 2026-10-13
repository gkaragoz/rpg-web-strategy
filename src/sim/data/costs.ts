/**
 * Balance calibration produced by `npm run balance:calibrate` (do not edit by hand):
 *  - COST_ADJ: multiplier on the formula gold cost of `unitGold` (src/net/economy.ts), keyed by roster id or classic name;
 *  - STAT_ADJ: multiplier on hp and power of a roster unit (units that stay too strong/weak at any price are nerfed/buffed).
 */
export const COST_ADJ: Record<string, number> = {
  'archer': 2.102,
  'ash-fiend': 4.380,
  'axe-warden': 9.058,
  'berserker': 1.150,
  'blast-imps': 3.509,
  'bolt-thrower': 3.291,
  'bone-caller': 8.924,
  'bulwark-guard': 1.086,
  'cinder-golem': 5.414,
  'cutpurses': 1.088,
  'dawn-blade': 5.750,
  'dread-totem': 2.549,
  'dungeon-warden': 1.008,
  'ember-adept': 6.575,
  'flame-herald': 1.920,
  'frost-adept': 7.790,
  'granite-colossus': 4.537,
  'grenadier': 5.302,
  'hammer-tank': 1.165,
  'hex-poppets': 2.257,
  'hex-witch': 6.479,
  'hill-brute': 3.773,
  'horned-seer': 2.583,
  'javelineers': 3.636,
  'lancer-knight': 5.798,
  'longbowmen': 2.046,
  'lorekeeper': 6.131,
  'mender': 1.773,
  'militia': 0.983,
  'night-lancer': 7.775,
  'oathkeeper': 1.341,
  'pit-fighters': 1.829,
  'priest': 0.497,
  'pyre-sling': 8.459,
  'rime-archers': 2.642,
  'risen-guard': 1.692,
  'sand-king': 10.027,
  'scarecrow': 1.544,
  'shade-blades': 1.294,
  'shield-tank': 0.863,
  'soul-reaver': 5.678,
  'spark-novice': 2.484,
  'sun-priest': 7.361,
  'thornlings': 1.086,
  'tusk-rider': 4.641,
  'war-barge': 5.874,
  'warrior': 1.000,
  'wayfarers': 3.212,
  'zealot': 1.555,
};
export const STAT_ADJ: Record<string, number> = {

};

/** Replaces both tables in place (used by the calibration tool; call refreshStats() in units.ts afterwards). */
export function setCalibration(cost: Record<string, number>, stat: Record<string, number>): void {
  for (const k of Object.keys(COST_ADJ)) delete COST_ADJ[k];
  for (const k of Object.keys(STAT_ADJ)) delete STAT_ADJ[k];
  Object.assign(COST_ADJ, cost);
  Object.assign(STAT_ADJ, stat);
}
