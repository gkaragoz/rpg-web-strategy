export const CHANNEL_THRESHOLD: number;
export interface Image {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Buffer;
}
export function readPng(buf: Buffer): Image;
export function writePng(img: Image): Buffer;
export function compare(a: Image, b: Image): { ratio: number; diff: Image | null; sizeMismatch?: boolean };
