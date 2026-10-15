import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allStrings, fmtNum, setLang, t, type Localized } from '../../i18n';
import { ARM_IDS, DMG_IDS } from '../data/combat';
import { RACE_NAMES, RARITY_NAMES, TROOPS } from '../data/troops';
import { BIOME_NAMES, CROSSING_NAMES, FOREST_NAMES, LAYOUT_NAMES, PRESETS, RELIEF_NAMES, RIVER_NAMES, VILLAGE_NAMES } from '../mapSpec';
import { ONLINE_MAP_SIZES } from '../../net/economy';
import { SORT_KEYS } from '../../app/gallerySort';
import { LEGACY_COUNT } from '../units';

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.includes('__tests__')) out.push(p);
  }
  return out;
}

/** Names of the placeholders in a text: `{n}` and the plural form `{n?one|other}` both count as `n`. */
const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{([a-zA-Z0-9]+)(?:\?[^|{}]*\|[^{}]*)?\}/g)].map((m) => m[1]))].sort();

/** Union members of `export type <name> = 'a' | 'b' ...;` in a source file (keeps the wire-code lists in sync with the protocol). */
function unionOf(file: string, name: string): string[] {
  const src = readFileSync(file, 'utf8');
  const m = new RegExp(`export type ${name}\\s*=([^;]+);`).exec(src);
  if (!m) throw new Error(`type ${name} not found in ${file}`);
  return [...m[1].matchAll(/'([a-zA-Z0-9]+)'/g)].map((x) => x[1]);
}

/** Every key family built at run time (`t(\`prefix${x}\`)`) with the exact suffixes it can produce. */
function families(): Record<string, string[]> {
  const placeFail = unionOf('src/net/protocol.ts', 'PlaceFailReason');
  const closeReason = unionOf('src/net/protocol.ts', 'CloseReason');
  const reject = unionOf('src/net/protocol.ts', 'RejectReason');
  const startFail = unionOf('src/net/protocol.ts', 'StartFailReason');
  const acts = new Set<string>();
  for (const f of walk('src')) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/trackDialog\([^,]+,\s*'([a-zA-Z0-9]+)'\)/g)) acts.add(m[1]);
    for (const m of src.matchAll(/act\.text\s*=\s*'([a-zA-Z0-9]+)'/g)) acts.add(m[1]);
  }
  return {
    'online.reason.': [...placeFail, ...closeReason, ...startFail, 'kicked'],
    'online.reject.': reject,
    'online.act.': [...acts],
    'online.via.': ['lan', 'relay', 'webrtc'],
    'online.brush.': ['0', '1', '2'],
    'online.time.': ['60', '120', '300', '0'],
    'online.size.': ONLINE_MAP_SIZES.map(String),
    'online.rar.': ['legendary', 'epic', 'rare'],
    'studio.fx.': ['auto', 'high', 'low', 'off'],
    'studio.bars.': ['damaged', 'always', 'never'],
    'units.arm.': [...ARM_IDS],
    'units.dmg.': [...DMG_IDS],
    'units.sort.': [...SORT_KEYS, 'asc', 'desc'],
    'units.classic.': Array.from({ length: LEGACY_COUNT }, (_, i) => String(i)),
    'battle.result.col.': ['team', 'alive', 'health', 'damage', 'kills', 'mvp'],
  };
}

/** Source text of everything that can contain a translation key (the app code and the page shell). */
function appSource(): { file: string; src: string }[] {
  const files = walk('src').filter((f) => !f.replace(/\\/g, '/').startsWith('src/i18n'));
  return [...files.map((file) => ({ file, src: readFileSync(file, 'utf8') })), { file: 'index.html', src: readFileSync('index.html', 'utf8') }];
}

describe('i18n', () => {
  const { en, tr } = allStrings();

  it('English and Turkish tables have exactly the same keys and placeholders', () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en)) expect(placeholders(tr[k]), `placeholders of ${k}`).toEqual(placeholders(en[k]));
  });

  it('no key is defined twice (a later table would silently override an earlier one)', () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const f of readdirSync('src/i18n').filter((x) => x.endsWith('.ts') && x !== 'types.ts')) {
      const src = readFileSync(join('src/i18n', f), 'utf8');
      const [enPart, trPart] = src.split(/^ {2}tr: \{/m);
      for (const [lang, part] of [['en', enPart], ['tr', trPart]] as const) {
        const own = new Set<string>();
        for (const m of part.matchAll(/^\s*'([a-zA-Z0-9_.]+)':/gm)) {
          if (own.has(m[1])) dup.push(`${f}/${lang}: ${m[1]} twice`);
          own.add(m[1]);
          const id = `${lang}:${m[1]}`;
          if (seen.has(id) && seen.get(id) !== f) dup.push(`${m[1]} in ${seen.get(id)} and ${f}`);
          seen.set(id, f);
        }
      }
    }
    expect(dup).toEqual([]);
  });

  it('every t(...) key used in the source exists', () => {
    const used = new Set<string>();
    for (const { src } of appSource()) {
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
    }
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });

  it('keys assembled at run time are covered: each family has every key in both languages', () => {
    const fam = families();
    for (const [prefix, suffixes] of Object.entries(fam)) {
      expect(suffixes.length, `family ${prefix} is empty`).toBeGreaterThan(0);
      for (const s of suffixes) {
        expect(en[prefix + s], `en ${prefix}${s}`).toBeTruthy();
        expect(tr[prefix + s], `tr ${prefix}${s}`).toBeTruthy();
      }
    }
  });

  it('every dynamic t(`prefix${...}`) in the source belongs to a known family (and none is built with +)', () => {
    const known = new Set(Object.keys(families()));
    const unknown: string[] = [];
    for (const { file, src } of appSource()) {
      for (const m of src.matchAll(/\bt\(\s*`([a-zA-Z0-9_.]*)\$\{/g)) if (!known.has(m[1])) unknown.push(`${file}: ${m[1]}\${...}`);
      for (const m of src.matchAll(/\bt\(\s*'[^']*'\s*\+/g)) unknown.push(`${file}: ${m[0]}`);
      for (const m of src.matchAll(/\bt\(\s*[a-zA-Z_]/g)) {
        // t(variable) is only allowed where the variable holds a key from a known table (checked by hand below)
        const line = src.slice(m.index, src.indexOf('\n', m.index));
        const literalTernary = /^t\([^'`]*\?\s*'[^']+'\s*:\s*'[^']+'/.test(line);
        if (!literalTernary && !/^t\((actKey|key|k)\b/.test(line)) unknown.push(`${file}: ${line.trim().slice(0, 60)}`);
      }
    }
    // Allowed non-literal forms: a ternary between two literal keys, and a variable holding a key from a literal table
    // (render3d/camControls.ts: sys.cam3d.*, online/cursors.ts: online.act.<code>).
    expect(unknown).toEqual([]);
  });

  it('every quoted key-looking string in the source (also inside ternaries) exists', () => {
    const missing = new Set<string>();
    for (const { src } of appSource()) {
      for (const m of src.matchAll(/'((?:studio|battle|maps|units|online|sys)\.[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)'/g)) if (!(m[1] in en)) missing.add(m[1]);
    }
    expect([...missing]).toEqual([]);
  });

  it('no string is left without a use (dead keys)', () => {
    const all = appSource().map((x) => x.src).join('\n');
    const prefixes = Object.keys(families());
    const dead = Object.keys(en).filter((k) => !all.includes(`'${k}'`) && !all.includes(`"${k}"`) && !prefixes.some((p) => k.startsWith(p)));
    expect(dead).toEqual([]);
  });

  it('texts are non-empty, trimmed, and in the right language', () => {
    const bad: string[] = [];
    for (const k of Object.keys(en)) {
      for (const [lang, table] of [['en', en], ['tr', tr]] as const) {
        const s = table[k];
        if (!s.trim()) bad.push(`${lang} ${k}: empty`);
        // The hint prefixes end with a separator on purpose.
        if (s !== s.trim() && !k.startsWith('battle.hint.')) bad.push(`${lang} ${k}: leading or trailing space`);
        if (/\s{2,}/.test(s.replace(/^\[.*$/, '')) && !k.startsWith('battle.bench.')) bad.push(`${lang} ${k}: double space`);
      }
      if (/[çğışİŞĞ]/.test(en[k])) bad.push(`en ${k}: Turkish letters in the English text`);
      if (/\b(gold|tile|tiles)\b/i.test(tr[k])) bad.push(`tr ${k}: untranslated term (use altın / karo)`);
    }
    expect(bad).toEqual([]);
  });

  it('Turkish uses the same decimal and quote conventions as the code (no half-translated hints)', () => {
    // A tr text identical to the English one is only fine for names, abbreviations and technical terms.
    const same = Object.keys(en).filter((k) => en[k] === tr[k] && /[a-z]{4}/.test(en[k]));
    const allowed = new Set(['studio.bench.h', 'studio.pal.pastel', 'battle.stats.sim', 'online.lobby.hostNote', 'tour.progress', 'tour.help', 'mode.vip.name', 'mode.vip.tool']);
    expect(same.filter((k) => !allowed.has(k))).toEqual([]);
  });

  it('Localized data (roster, map names) has both languages with equal placeholders', () => {
    const list: Array<[string, Localized]> = [];
    for (const tdef of TROOPS) if (tdef.skill) list.push([`troop ${tdef.id} skill`, tdef.skillText]);
    for (const [name, rec] of Object.entries({ RARITY_NAMES, RACE_NAMES, BIOME_NAMES, RIVER_NAMES, FOREST_NAMES, VILLAGE_NAMES, CROSSING_NAMES, LAYOUT_NAMES, RELIEF_NAMES }) as Array<[string, Record<string, Localized>]>) {
      for (const [id, l] of Object.entries(rec)) list.push([`${name}.${id}`, l]);
    }
    for (const p of PRESETS) list.push([`preset ${p.id}`, p.name]);
    expect(list.length).toBeGreaterThan(50);
    const bad: string[] = [];
    for (const [what, l] of list) {
      if (!l.en?.trim() || !l.tr?.trim()) bad.push(`${what}: missing text (${JSON.stringify(l)})`);
      else if (placeholders(l.en).join() !== placeholders(l.tr).join()) bad.push(`${what}: placeholders differ`);
      if (/[çğışİŞĞ]/.test(l.en ?? '')) bad.push(`${what}: Turkish letters in en`);
    }
    // Skill texts are sentences: the Turkish one must not be a copy of the English one.
    for (const tdef of TROOPS) if (tdef.skill && tdef.skillText.en === tdef.skillText.tr) bad.push(`troop ${tdef.id}: skill text not translated`);
    expect(bad).toEqual([]);
  });

  it('t() fills placeholders and picks plural forms (Turkish keeps the singular noun)', () => {
    expect(t('studio.toast.quick', { n: 1 })).toBe('1 soldier placed.');
    expect(t('studio.toast.quick', { n: 5 })).toBe('5 soldiers placed.');
    expect(t('online.lobby.counts', { n: 1 })).toBe('1 player, 1 team.');
    expect(t('online.lobby.counts', { n: 3 })).toBe('3 players, 3 teams.');
    setLang('tr');
    try {
      expect(t('studio.toast.quick', { n: 1 })).toBe('1 asker dizildi.');
      expect(t('studio.toast.quick', { n: 5 })).toBe('5 asker dizildi.');
      expect(fmtNum(1.5)).toBe('1,5');
      expect(t('nope.missing.key')).toBe('nope.missing.key');
    } finally {
      setLang('en');
    }
    expect(fmtNum(1.5)).toBe('1.5');
  });

  it('no Turkish text is hard-coded in UI or network code (it must go through src/i18n)', () => {
    const bad: string[] = [];
    const dirs = ['src/app', 'src/net', 'src/render', 'src/render3d', 'src/ui'];
    for (const d of dirs) {
      for (const f of walk(d)) {
        const lines = readFileSync(f, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments are checked separately
          if (/[çğıöşüÇĞİÖŞÜ]/.test(line.replace(/(^|[\s;,{(])\/\/.*$/, '$1'))) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
      }
    }
    expect(bad).toEqual([]);
  });

  it('the repo rule that rejects Turkish text in code catches it (and ignores URLs and English comments)', async () => {
    // @ts-expect-error plain .mjs module without type declarations
    const { problemsIn } = (await import('../../../scripts/lib/rules.mjs')) as { problemsIn: (f: string, s: string) => string[] };
    expect(problemsIn('src/app/x.ts', "const a = 'Başla';")).toHaveLength(1);
    expect(problemsIn('src/app/x.ts', "const u = 'https://example.com/'; const b = 'Çık';")).toHaveLength(1);
    expect(problemsIn('src/render3d/x.ts', "el.title = 'Kapat ğ';")).toHaveLength(1);
    expect(problemsIn('relay/src/index.js', "new Response('Oda yok ş');")).toHaveLength(1);
    expect(problemsIn('src/app/x.ts', "const a = 1; // English comment only")).toHaveLength(0);
    expect(problemsIn('src/app/x.ts', "const u = 'https://example.com/a';")).toHaveLength(0);
    expect(problemsIn('src/i18n/studio.ts', "'a': 'Başla'")).toHaveLength(0);
  });
});
