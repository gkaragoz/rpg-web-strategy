import { describe, expect, it } from 'vitest';
import { sortKinds } from '../../app/gallerySort';

const hp = [100, 300, 200, 300];
const value = (k: number): number | string => hp[k];

describe('gallery sort', () => {
  it('default keeps the input order', () => {
    expect(sortKinds([3, 1, 2, 0], 'default', 'desc', value)).toEqual([3, 1, 2, 0]);
  });
  it('sorts ascending and descending; ties keep the lower kind first', () => {
    expect(sortKinds([0, 1, 2, 3], 'hp', 'asc', value)).toEqual([0, 2, 1, 3]);
    expect(sortKinds([0, 1, 2, 3], 'hp', 'desc', value)).toEqual([1, 3, 2, 0]);
  });
  it('sorts names', () => {
    const names = ['Cat', 'ant', 'Bee'];
    expect(sortKinds([0, 1, 2], 'name', 'asc', (k) => names[k])).toEqual([1, 2, 0]);
  });
  it('does not mutate the input', () => {
    const a = [0, 1, 2];
    sortKinds(a, 'hp', 'desc', value);
    expect(a).toEqual([0, 1, 2]);
  });
});
