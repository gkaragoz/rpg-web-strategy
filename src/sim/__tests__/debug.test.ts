import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { Battle } from '../battle';
import { makeScenario } from '../testing/scenarios';
import { STATS } from '../units';

// Gelistirici araci:
//   DEBUG_SCN=9 DEBUG_AT=22,26 [DEBUG_UNIT=12] npx vitest run src/sim/__tests__/debug.test.ts
// test-results/debug-<id>.txt dosyasina belirtilen saniyelerde birim dokumu yazar.
// DEBUG_UNIT verilirse yalniz o birim ve hedefi, her 0.5 sn'de detayli izlenir.
const id = Number(process.env.DEBUG_SCN ?? 0);
const at = (process.env.DEBUG_AT ?? '30,120,299').split(',').map(Number);
const only = process.env.DEBUG_UNIT !== undefined ? Number(process.env.DEBUG_UNIT) : -1;

describe.skipIf(!id)('senaryo hata ayiklama dokumu', () => {
  it(`dokum #${id}`, () => {
    const sc = makeScenario(id);
    const b = new Battle(sc.simSeed, sc.config);
    const u = b.units;
    const out: string[] = [sc.desc];
    const targets = new Set(at.map((t) => Math.round(t * 30)));
    const line = (i: number): string => {
      const t = u.target[i];
      const d = t >= 0 && u.alive[t] ? Math.hypot(u.x[t] - u.x[i], u.y[t] - u.y[i]).toFixed(1) : '-';
      return `${i} T${u.team[i] + 1} ${STATS[u.kind[i]].name} @${u.x[i].toFixed(1)},${u.y[i].toFixed(1)} hp=${u.hp[i].toFixed(0)} hedef=${t}(${d}) kite=${u.kiteState[i]} stam=${u.stamina[i].toFixed(1)} rota=${u.route[i]}/${u.routePhase[i]} cd=${u.cooldown[i].toFixed(1)} swing=${u.swing[i].toFixed(2)} stun=${u.stunT[i].toFixed(1)} yan=${u.sideT[i].toFixed(1)} stuck=${u.stuckT[i].toFixed(1)} chase=${u.chaseT[i].toFixed(1)} ban=${u.banTarget[i]}/${u.banT[i].toFixed(1)} hold=${u.holdT[i].toFixed(1)} leashOff=${u.leashOffT[i].toFixed(1)} moving=${u.moving[i]}`;
    };
    const lastT = Math.max(...at);
    for (let s = 1; s <= lastT * 30 + 1 && b.winner === -1; s++) {
      b.step(1 / 30);
      if (only >= 0 && s >= (Math.min(...at) - 0) * 30 && s % 15 === 0 && u.alive[only]) {
        out.push(`t=${(s / 30).toFixed(1)} ${line(only)}`);
        const t = u.target[only];
        if (t >= 0 && u.alive[t]) out.push(`      hedef: ${line(t)}`);
        continue;
      }
      if (only >= 0 || !targets.has(s)) continue;
      out.push(`\n--- t=${(s / 30).toFixed(0)}sn canli=${b.alivePerTeam.slice(0, sc.config.teamCount).join('/')} hasar=${b.counters.damage.toFixed(0)} sifa=${b.counters.heal.toFixed(0)} ---`);
      for (let i = 0; i < u.count; i++) if (u.alive[i]) out.push(line(i));
    }
    mkdirSync('test-results', { recursive: true });
    writeFileSync(`test-results/debug-${id}.txt`, out.join('\n') + '\n');
  });
});
