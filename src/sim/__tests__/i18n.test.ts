import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allStrings } from '../../i18n';

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.includes('__tests__')) out.push(p);
  }
  return out;
}

describe('i18n', () => {
  const { en, tr } = allStrings();

  it('English and Turkish tables have exactly the same keys and placeholders', () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en)) {
      const ph = (s: string): string[] => (s.match(/\{[a-zA-Z0-9]+\}/g) ?? []).sort();
      expect(ph(tr[k]), `placeholders of ${k}`).toEqual(ph(en[k]));
    }
  });

  it('every t(...) key used in the source exists', () => {
    const used = new Set<string>();
    for (const f of walk('src')) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
    }
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });

  it('no Turkish text is hard-coded in UI or network code (it must go through src/i18n)', () => {
    const bad: string[] = [];
    const dirs = ['src/app', 'src/net', 'src/render', 'src/ui'];
    for (const d of dirs) {
      for (const f of walk(d)) {
        const lines = readFileSync(f, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments are checked separately
          if (/[çğıöşüÇĞİÖŞÜ]/.test(line.replace(/\/\/.*$/, ''))) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
      }
    }
    expect(bad).toEqual([]);
  });
});
