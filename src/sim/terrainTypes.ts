import type { MapSpec } from './mapSpec';

// Terrain constants and data types (shared by terrain.ts and the generation modules; terrain.ts re-exports them).

export const T_GRASS = 0;
export const T_WATER = 1;
export const T_BRIDGE = 2;
export const T_BLOCKED = 3;
export const T_PATH = 4;

/** On-screen height of one elevation step (pixels). */
export const LEVEL_PX = 26;
export const MAX_LEVEL_H = 8;
/** Tile height units: 16 units per step; a neighbor difference >= CLIFF_UNITS makes a cliff. */
export const H_UNITS = 16;
export const CLIFF_UNITS = 24;

const R = Math.SQRT1_2;
/** River axes: u = army axis (horizontal on screen), v = river direction (vertical on screen). */
export const U_X = R;
export const U_Y = -R;
export const V_X = R;
export const V_Y = R;

export type DecorKind = 'tree' | 'rock' | 'boulder' | 'house' | 'wall' | 'rubble' | 'tower' | 'keep';

export interface Decor {
  kind: DecorKind;
  /** tree: size 0..2; rock/boulder: 0..2; house: size*2+style (0..5); wall/rubble: 0..1. */
  variant: number;
  /** World (tile) coordinates: the sprite's foot/bottom-corner point. */
  x: number;
  y: number;
}

export interface Bridge {
  /** Position along the river axis (v). */
  s: number;
  /** u-offset and width of the river center at this position. */
  o: number;
  w: number;
  /** Half length of the board (along u) and half width (along s). */
  halfLen: number;
  halfW: number;
}

export interface TerrainOptions {
  seed: number;
  /** The |d| range covered by army spawns and their half width (s). */
  spawnD0: number;
  spawnD1: number;
  spawnHalfS: number;
  /** Map recipe (defaults to the first-version forest map). */
  spec?: MapSpec;
}
