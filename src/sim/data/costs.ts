/**
 * Balance calibration produced by `npm run balance:calibrate` (do not edit by hand):
 *  - COST_ADJ: multiplier on the formula gold cost of `unitGold` (src/net/economy.ts), keyed by roster id or classic name;
 *  - STAT_ADJ: multiplier on hp and power of a roster unit (units that stay too strong/weak at any price are nerfed/buffed).
 */
export const COST_ADJ: Record<string, number> = {
  'archer': 1.950,
  'ash-fiend': 3.720,
  'axe-warden': 8.926,
  'berserker': 1.080,
  'blast-imps': 3.219,
  'bolt-thrower': 3.312,
  'bone-caller': 8.258,
  'bulwark-guard': 1.064,
  'cinder-golem': 5.031,
  'cutpurses': 1.030,
  'dawn-blade': 5.332,
  'dread-totem': 2.463,
  'dungeon-warden': 0.961,
  'ember-adept': 6.589,
  'flame-herald': 1.809,
  'frost-adept': 8.118,
  'granite-colossus': 3.651,
  'grenadier': 5.099,
  'hammer-tank': 1.129,
  'hex-poppets': 2.139,
  'hex-witch': 6.055,
  'hill-brute': 3.571,
  'horned-seer': 2.588,
  'javelineers': 3.598,
  'lancer-knight': 5.225,
  'longbowmen': 2.126,
  'lorekeeper': 5.855,
  'mender': 1.689,
  'militia': 0.956,
  'night-lancer': 7.009,
  'oathkeeper': 1.316,
  'pit-fighters': 1.740,
  'priest': 0.757,
  'pyre-sling': 8.317,
  'rime-archers': 2.656,
  'risen-guard': 1.586,
  'sand-king': 10.117,
  'scarecrow': 1.466,
  'shade-blades': 1.257,
  'shield-tank': 0.843,
  'soul-reaver': 4.943,
  'spark-novice': 2.398,
  'sun-priest': 6.747,
  'thornlings': 1.071,
  'tusk-rider': 4.040,
  'war-barge': 5.969,
  'warrior': 1.000,
  'wayfarers': 3.113,
  'zealot': 1.487,
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
