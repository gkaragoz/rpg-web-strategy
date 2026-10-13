import { describe, expect, it } from 'vitest';
import { Battle } from '../battle';
import { GuestSession, HostSession } from '../../net/client';
import { teamZones } from '../../net/economy';
import { HostLobby } from '../../net/host';
import { LockstepRunner } from '../../net/lockstep';
import { battleConfig, type ClientMsg } from '../../net/protocol';
import { LoopbackHub } from '../../net/transport';
import { Terrain } from '../terrain';
import { mulberry32 } from '../random';

function rig(seed = 1): { hub: LoopbackHub; host: HostLobby; hs: HostSession; clock: { t: number } } {
  const hub = new LoopbackHub();
  const clock = { t: 1000 };
  const host = new HostLobby(hub.host, 'Host', 0, { now: () => clock.t, rnd: mulberry32(seed) });
  return { hub, host, hs: new HostSession(host, false), clock };
}
type Rig = ReturnType<typeof rig>;
const join = (r: Rig, name: string, extra: Partial<ConstructorParameters<typeof GuestSession>[1]> = {}): GuestSession => new GuestSession(r.hub.connect(), { name, color: 1, ...extra });

function spots(r: Rig, team: number, n: number): { x: number; y: number }[] {
  const init = r.hs.model.state!.init!;
  const t = new Terrain(init.size, { seed: init.seed, spec: init.spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
  const z = teamZones(init.size, init.teams, t)[team];
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < init.size && out.length < n; y++)
    for (let x = 0; x < init.size && out.length < n; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (z.contains(px, py) && t.walkable(px, py) && t.reachable(px, py) && out.every((o) => Math.hypot(o.x - px, o.y - py) >= 1.2)) out.push({ x: px, y: py });
    }
  return out;
}

function three(): { r: Rig; a: GuestSession; b: GuestSession } {
  const r = rig(11);
  const a = join(r, 'A');
  const b = join(r, 'B');
  for (const g of [a, b]) g.send({ t: 'ready', ready: true });
  r.hs.send({ t: 'start' });
  expect(r.hs.model.state!.phase).toBe('placing');
  return { r, a, b };
}

describe('oyun sirasinda ayrilma', () => {
  it('yerlestirmede oyuncu ayrilinca takim numaralari kaymaz; kalanlar yerlestirebilir', () => {
    const { r, a, b } = three();
    const teamB = b.model.me!.team;
    expect(teamB).toBe(2);
    a.leave();
    const st = r.hs.model.state!;
    expect(st.players.find((p) => p.name === 'B')!.team).toBe(teamB);
    expect(st.players.filter((p) => p.role === 'player').length).toBe(3); // ayrilan hayalet olarak kalir
    expect(st.players.some((p) => !p.connected)).toBe(true);
    const sp = spots(r, teamB, 3);
    b.send({ t: 'place', items: sp.map((p, i) => ({ cid: i, kind: 0, x: p.x, y: p.y })) });
    expect(b.model.placed.size).toBe(3);
    expect([...b.model.placed.values()].every((u) => u.team === teamB)).toBe(true);
    b.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'ready', ready: true });
    r.host.tick();
    expect(r.hs.model.state!.phase).toBe('battle');
    expect(r.hs.model.start!.init.teamPlayers.length).toBe(3);
  });

  it('kick yerlestirmede de takimlari kaydirmaz; lobiye donunce hayalet temizlenir', () => {
    const { r, a, b } = three();
    const teamB = b.model.me!.team;
    r.hs.send({ t: 'kick', id: a.model.you });
    expect(r.hs.model.state!.players.find((p) => p.name === 'B')!.team).toBe(teamB);
    b.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'ready', ready: true });
    r.host.tick();
    expect(r.hs.model.state!.phase).toBe('battle');
    r.hs.send({ t: 'rematch' });
    const st = r.hs.model.state!;
    expect(st.phase).toBe('lobby');
    expect(st.players.map((p) => p.name).sort()).toEqual(['B', 'Host']);
    expect(st.players.find((p) => p.name === 'B')!.team).toBe(1);
  });

  it('seyirci ayrilinca oyuncu takimlari etkilenmez', () => {
    const { r, b } = three();
    const s = join(r, 'S', { spectator: true });
    const team = b.model.me!.team;
    s.leave();
    expect(r.hs.model.state!.players.find((p) => p.name === 'B')!.team).toBe(team);
    expect(r.hs.model.state!.players.some((p) => p.name === 'S')).toBe(false);
  });
});

describe('baglanti kenar durumlari', () => {
  it('ayni baglantidan ikinci join yok sayilir (kopya oyuncu olusmaz)', () => {
    const r = rig();
    const ep = r.hub.connect();
    const g = new GuestSession(ep, { name: 'A', color: 1 });
    ep.send('host', { t: 'join', name: 'A', color: 1, version: 2 } as ClientMsg);
    expect(r.hs.model.state!.players.length).toBe(2);
    expect(g.model.me).not.toBeNull();
  });

  it('jetonla gelen yeni baglanti, yari acik eski baglantinin yerini alir', () => {
    const { r, b } = three();
    const token = b.model.token;
    const team = b.model.me!.team;
    const back = join(r, 'B', { token });
    expect(back.model.rejected).toBeNull();
    expect(back.model.me!.team).toBe(team);
    expect(r.hs.model.state!.players.filter((p) => p.role === 'player').length).toBe(3);
    expect(r.hs.model.state!.players.find((p) => p.team === team)!.connected).toBe(true);
    expect(back.model.me!.ready).toBe(false);
  });

  it('bozuk mesajlar host dusurmez', () => {
    const { r, a } = three();
    const ep = r.hub.connect();
    const g = new GuestSession(ep, { name: 'X', color: 2, spectator: true });
    const junk: unknown[] = [
      { t: 'place', items: 5 },
      { t: 'place', items: [null, 1, { cid: 'x' }] },
      { t: 'unplace', ids: 'abc' },
      { t: 'unplace', ids: [null, {}] },
      { t: 'check', step: NaN, hash: 'x' },
      { t: 'presence', x: 'a', y: null },
      { t: 'chat', text: 12345 },
      { t: 'nope' },
      null,
      42,
    ];
    for (const m of junk) expect(() => ep.send('host', m as ClientMsg)).not.toThrow();
    for (const m of junk) expect(() => a.send(m as ClientMsg)).not.toThrow();
    expect(r.hs.model.state!.phase).toBe('placing');
    expect(g.model.me).not.toBeNull();
  });

  it('mesaj seli hiz sinirina takilir ama normal akis bozulmaz', () => {
    const { r, a } = three();
    const sp = spots(r, a.model.me!.team, 1)[0];
    for (let i = 0; i < 2000; i++) a.send({ t: 'place', items: [{ cid: i, kind: 0, x: sp.x, y: sp.y }] });
    expect(r.hs.model.state!.phase).toBe('placing');
    expect([...a.model.placed.values()].length).toBe(1);
    r.clock.t += 5000; // jeton kovasi dolar
    a.send({ t: 'chat', text: 'selam' });
    expect(a.model.chat.length).toBeGreaterThan(0);
  });

  it('eski surum (1) istemci reddedilir', () => {
    const r = rig();
    const ep = r.hub.connect();
    let rej = '';
    ep.onMessage = (_f, m) => {
      if ((m as { t: string }).t === 'reject') rej = (m as { reason: string }).reason;
    };
    ep.send('host', { t: 'join', name: 'v1', color: 1, version: 1 } as ClientMsg);
    expect(rej).toBe('version');
  });
});

describe('sohbet siralamasi', () => {
  it('200 mesaji gecince sira numarasi artmaya devam eder', () => {
    const r = rig();
    const g = join(r, 'A');
    for (let i = 0; i < 260; i++) {
      r.clock.t += 3000; // spam sinirini asma
      g.send({ t: 'chat', text: `m${i}` });
    }
    const chat = g.model.chat;
    expect(chat.length).toBe(200);
    expect(chat[chat.length - 1].n).toBe(260);
    expect(chat[0].n).toBe(61);
    expect(chat.every((c, i) => i === 0 || c.n === chat[i - 1].n + 1)).toBe(true);
  });
});

describe('lockstep kenar durumlari', () => {
  function startBattle(): { r: Rig; a: GuestSession } {
    const r = rig(5);
    const a = join(r, 'A');
    r.hs.send({ t: 'settings', settings: { gold: 600, openPlacement: true } });
    a.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'start' });
    for (const [g, team] of [
      [a, 1],
      [r.hs, 0],
    ] as const) {
      const sp = spots(r, team, 10);
      g.send({ t: 'place', items: sp.map((p, i) => ({ cid: i, kind: 0, x: p.x, y: p.y })) });
      g.send({ t: 'ready', ready: true });
    }
    r.host.tick();
    expect(r.hs.model.state!.phase).toBe('battle');
    return { r, a };
  }

  it('host duraklayinca duraklama yayinlanir; misafir tahminle one gecmez', () => {
    const { r, a } = startBattle();
    const start = r.hs.model.start!;
    const hostSim = new Battle(start.simSeed, battleConfig(start));
    const guestSim = new Battle(start.simSeed, battleConfig(start));
    let t = 0;
    const hr = new LockstepRunner(hostSim, r.hs.model, { host: r.host, now: () => t });
    const gr = new LockstepRunner(guestSim, a.model, { send: (m) => a.send(m), now: () => t });
    for (let i = 0; i < 120; i++) {
      t += 16;
      hr.advance(1 / 60);
      gr.advance(1 / 60);
      r.hub.pump();
    }
    hr.paused = true; // ornegin sekme arka plana alindi
    const frozen = hostSim.stepCount;
    for (let i = 0; i < 600; i++) {
      t += 16;
      hr.advance(1 / 60);
      gr.advance(1 / 60);
      r.hub.pump();
    }
    expect(hostSim.stepCount).toBe(frozen);
    expect(a.model.paused).toBe(true);
    expect(guestSim.stepCount).toBeLessThanOrEqual(frozen + 3);
  });

  it('host sessizlesirse misafir tahmini 1.5 sn ile sinirli kalir', () => {
    const { r, a } = startBattle();
    const start = r.hs.model.start!;
    const hostSim = new Battle(start.simSeed, battleConfig(start));
    const guestSim = new Battle(start.simSeed, battleConfig(start));
    let t = 0;
    const hr = new LockstepRunner(hostSim, r.hs.model, { host: r.host, now: () => t });
    const gr = new LockstepRunner(guestSim, a.model, { send: (m) => a.send(m), now: () => t });
    for (let i = 0; i < 60; i++) {
      t += 16;
      hr.advance(1 / 60);
      gr.advance(1 / 60);
      r.hub.pump();
    }
    const hs = a.model.hostStep;
    for (let i = 0; i < 1800; i++) {
      t += 16;
      gr.advance(1 / 60); // host donmus: tick yok
      r.hub.pump();
    }
    expect(guestSim.stepCount).toBeLessThanOrEqual(hs + 30 * 1.5 + 12);
  });

  it('hic birim yerlestirilmezse savas takilmadan biter', () => {
    const r = rig(3);
    const a = join(r, 'A');
    a.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'start' });
    a.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'ready', ready: true });
    r.host.tick();
    const start = r.hs.model.start!;
    const sim = new Battle(start.simSeed, battleConfig(start));
    for (let i = 0; i < 30 * 60 && sim.winner === -1; i++) sim.step(1 / 30);
    expect(sim.winner).not.toBe(-1);
  });
});
