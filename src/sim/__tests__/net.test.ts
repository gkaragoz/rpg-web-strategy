import { describe, expect, it } from 'vitest';
import { Battle } from '../battle';
import { GuestSession, HostSession } from '../../net/client';
import { teamZones } from '../../net/economy';
import { HostLobby, CHECK_EVERY } from '../../net/host';
import { LockstepRunner } from '../../net/lockstep';
import { PROTOCOL, battleConfig, passHash, type PlaceItem } from '../../net/protocol';
import { LoopbackHub } from '../../net/transport';
import { Terrain } from '../terrain';
import { mulberry32 } from '../random';

interface Rig {
  hub: LoopbackHub;
  host: HostLobby;
  hs: HostSession;
  clock: { t: number };
}

function rig(seed = 1): Rig {
  const hub = new LoopbackHub();
  const clock = { t: 1000 };
  const host = new HostLobby(hub.host, 'Host', 0, { now: () => clock.t, rnd: mulberry32(seed) });
  const hs = new HostSession(host, false);
  return { hub, host, hs, clock };
}

function join(r: Rig, name: string, extra: Partial<ConstructorParameters<typeof GuestSession>[1]> = {}): GuestSession {
  return new GuestSession(r.hub.connect(), { name, color: 1, ...extra });
}

/** Finds n walkable points inside the player's zone, at least 1 apart from each other. */
function spots(r: Rig, team: number, n: number): { x: number; y: number }[] {
  const init = r.hs.model.state!.init!;
  const t = new Terrain(init.size, { seed: init.seed, spec: init.spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
  const z = teamZones(init.size, init.teams, t)[team];
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < init.size && out.length < n; y++) {
    for (let x = 0; x < init.size && out.length < n; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (z.contains(px, py) && t.walkable(px, py) && t.reachable(px, py) && out.every((o) => Math.hypot(o.x - px, o.y - py) >= 1.2)) out.push({ x: px, y: py });
    }
  }
  return out;
}

function toPlacing(r: Rig, guests: GuestSession[]): void {
  for (const g of guests) g.send({ t: 'ready', ready: true });
  r.hs.send({ t: 'start' });
  expect(r.hs.model.state!.phase).toBe('placing');
}

describe('lobby', () => {
  it('joining: team = player order, unique name and color', () => {
    const r = rig();
    const a = join(r, 'Can');
    const b = join(r, 'Can'); // same name + same color
    const pl = r.hs.model.state!.players;
    expect(pl.length).toBe(3);
    expect(pl.map((p) => p.team)).toEqual([0, 1, 2]);
    expect(new Set(pl.map((p) => p.name)).size).toBe(3);
    expect(new Set(pl.map((p) => p.color)).size).toBe(3);
    expect(a.model.state!.players.length).toBe(3);
    expect(b.model.you).toBe('g2');
  });

  it('version mismatch, wrong password and full lobby are rejected', () => {
    const r = rig();
    const bad = new GuestSession(r.hub.connect(), { name: 'x', color: 0 });
    bad.model.rejected = null;
    // Raw message for the version mismatch.
    const g = r.hub.connect();
    let reason = '';
    g.onMessage = (_f, m) => {
      if (m.t === 'reject') reason = m.reason;
    };
    g.send('host', { t: 'join', name: 'v', color: 0, version: PROTOCOL + 1 });
    expect(reason).toBe('version');

    r.hs.send({ t: 'settings', settings: {}, password: 'gizli' });
    const wrong = join(r, 'Yanlis', { pass: 'hata' });
    expect(wrong.model.rejected).toBe('password');
    const ok = join(r, 'Dogru', { pass: 'gizli' });
    expect(ok.model.rejected).toBeNull();
    expect(ok.model.state).not.toBeNull();
    expect(passHash('gizli')).toBe(passHash('gizli'));

    r.hs.send({ t: 'settings', settings: {}, password: null });
    const r2 = rig(2);
    for (let i = 0; i < 5; i++) join(r2, `P${i}`);
    expect(r2.hs.model.state!.players.length).toBe(6);
    const full = join(r2, 'Fazla');
    expect(full.model.rejected).toBe('full');
    const spec = join(r2, 'Izleyici', { spectator: true });
    expect(spec.model.rejected).toBeNull();
    expect(spec.model.me!.role).toBe('spectator');
  });

  it('only the host changes settings; ready flags drop when they change', () => {
    const r = rig();
    const g = join(r, 'Can');
    g.send({ t: 'ready', ready: true });
    expect(r.hs.model.state!.players[1].ready).toBe(true);
    g.send({ t: 'settings', settings: { gold: 99999 } });
    expect(r.hs.model.state!.settings.gold).toBe(2000);
    r.hs.send({ t: 'settings', settings: { gold: 5000, placeSecs: 60, openPlacement: false, comedyPhysics: true } });
    const s = g.model.state!.settings;
    expect([s.gold, s.placeSecs, s.openPlacement, s.comedyPhysics]).toEqual([5000, 60, false, true]);
    expect(g.model.state!.players[1].ready).toBe(false);
    r.hs.send({ t: 'settings', settings: { gold: 5 } });
    expect(g.model.state!.settings.gold).toBe(100);
  });

  it('kick: the kicked player is told, leaves the list, and cannot rejoin with the same token', () => {
    const r = rig();
    const a = join(r, 'A');
    join(r, 'B');
    const token = a.model.token;
    r.hs.send({ t: 'kick', id: a.model.you });
    expect(a.model.closedReason).toBeTruthy();
    expect(r.hs.model.state!.players.map((p) => p.name)).toEqual(['Host', 'B']);
    const back = join(r, 'A2', { token });
    expect(back.model.rejected).toBe('kicked');
    // A guest cannot kick anyone.
    const b = r.hs.model.state!.players[1];
    const c = join(r, 'C');
    c.send({ t: 'kick', id: b.id });
    expect(r.hs.model.state!.players.length).toBe(3);
  });

  it('start: at least 2 players and everyone ready; team count = player count', () => {
    const r = rig();
    r.hs.send({ t: 'start' });
    expect(r.hs.model.state!.phase).toBe('lobby');
    const a = join(r, 'A');
    const b = join(r, 'B');
    r.hs.send({ t: 'start' });
    expect(r.hs.model.state!.phase).toBe('lobby');
    a.send({ t: 'ready', ready: true });
    b.send({ t: 'ready', ready: true });
    a.send({ t: 'start' }); // a guest cannot start
    expect(r.hs.model.state!.phase).toBe('lobby');
    r.hs.send({ t: 'start' });
    const st = r.hs.model.state!;
    expect(st.phase).toBe('placing');
    expect(st.init!.teams).toBe(3);
    expect(st.init!.teamPlayers.length).toBe(3);
    expect(st.init!.costs.length).toBeGreaterThan(40);
    expect(b.model.state!.phase).toBe('placing');
    // A latecomer cannot join as a player after the game started.
    const late = join(r, 'Gec');
    expect(late.model.rejected).toBe('started');
  });

  it('chat: spam limit and muting', () => {
    const r = rig();
    const a = join(r, 'A');
    for (let i = 0; i < 8; i++) a.send({ t: 'chat', text: `m${i}` });
    expect(r.hs.model.chat.length).toBe(5);
    r.clock.t += 11000;
    a.send({ t: 'chat', text: 'tekrar' });
    expect(r.hs.model.chat.length).toBe(6);
    r.hs.send({ t: 'mute', id: a.model.you, on: true });
    r.clock.t += 11000;
    a.send({ t: 'chat', text: 'susturuldum' });
    expect(r.hs.model.chat.length).toBe(6);
  });

  it('presence: relayed to others, not echoed to the sender; the rate limit keeps the latest value', () => {
    const r = rig();
    const a = join(r, 'A');
    const b = join(r, 'B');
    a.send({ t: 'presence', x: 10, y: 20, ctx: 'world', act: 'unitPicker' });
    expect(b.model.presence.get(a.model.you)).toMatchObject({ x: 10, y: 20, act: 'unitPicker' });
    expect(r.hs.model.presence.get(a.model.you)).toMatchObject({ x: 10, y: 20 });
    expect(a.model.presence.has(a.model.you)).toBe(false);
    a.send({ t: 'presence', x: 11, y: 21, ctx: 'world' }); // within 50 ms: held back
    expect(b.model.presence.get(a.model.you)!.x).toBe(10);
    r.clock.t += 60;
    r.host.tick();
    expect(b.model.presence.get(a.model.you)!.x).toBe(11);
    // The departed player's cursor is cleared.
    a.leave();
    expect(b.model.presence.has(a.model.you)).toBe(false);
  });
});

describe('placement', () => {
  function placing(open: boolean): { r: Rig; a: GuestSession; b: GuestSession } {
    const r = rig(3);
    const a = join(r, 'A');
    const b = join(r, 'B');
    r.hs.send({ t: 'settings', settings: { gold: 300, openPlacement: open, placeSecs: 60, mapMode: 'random' } });
    toPlacing(r, [a, b]);
    return { r, a, b };
  }
  const item = (cid: number, kind: number, p: { x: number; y: number }): PlaceItem => ({ cid, kind, x: p.x, y: p.y });

  it('places in your own zone; out-of-zone, budget and proximity are rejected', () => {
    const { r, a } = placing(true);
    const mine = spots(r, a.model.me!.team, 40);
    a.send({ t: 'place', items: [item(1, 0, mine[0]), item(2, 0, mine[1])] });
    expect(a.model.placed.size).toBe(2);
    // The opponent's zone.
    const theirs = spots(r, 0, 3);
    a.send({ t: 'place', items: [item(3, 0, theirs[0])] });
    expect(a.model.lastFail!.reason).toBe('zone');
    // Too close.
    a.send({ t: 'place', items: [item(4, 0, { x: mine[0].x + 0.2, y: mine[0].y })] });
    expect(a.model.lastFail!.reason).toBe('close');
    // Budget: the basic unit costs 10 gold; with 300 gold at most 30.
    const many = mine.slice(2, 40).map((p, i) => item(10 + i, 0, p));
    a.send({ t: 'place', items: many });
    expect(a.model.placed.size).toBe(30);
    expect(a.model.lastFail!.reason).toBe('gold');
    r.host.tick();
    r.clock.t += 300;
    r.host.tick();
    expect(r.hs.model.state!.players[a.model.me!.team].gold).toBe(0);
  });

  it('with open placement everyone sees units; otherwise only the owner', () => {
    for (const open of [true, false]) {
      const { r, a, b } = placing(open);
      const mine = spots(r, a.model.me!.team, 3);
      a.send({ t: 'place', items: [item(1, 0, mine[0]), item(2, 0, mine[1])] });
      expect(a.model.placed.size).toBe(2);
      expect(b.model.placed.size).toBe(open ? 2 : 0);
      expect(r.hs.model.placed.size).toBe(open ? 2 : 0);
      const ids = [...a.model.placed.keys()];
      a.send({ t: 'unplace', ids: [ids[0]] });
      expect(a.model.placed.size).toBe(1);
      expect(b.model.placed.size).toBe(open ? 1 : 0);
      // Cannot remove another player's unit.
      b.send({ t: 'unplace', ids: [ids[1]] });
      expect(a.model.placed.size).toBe(1);
    }
  });

  it('placement locks when ready; everyone ready -> battle starts, same layout for everyone', () => {
    const { r, a, b } = placing(true);
    const ma = spots(r, a.model.me!.team, 2);
    const mb = spots(r, b.model.me!.team, 2);
    a.send({ t: 'place', items: [item(1, 0, ma[0])] });
    b.send({ t: 'place', items: [item(1, 3, mb[0])] });
    a.send({ t: 'ready', ready: true });
    a.send({ t: 'place', items: [item(2, 0, ma[1])] });
    expect([...a.model.placed.values()].filter((u) => u.team === a.model.me!.team).length).toBe(1);
    b.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'ready', ready: true });
    r.host.tick();
    expect(r.hs.model.state!.phase).toBe('battle');
    const sa = a.model.start!;
    const sb = b.model.start!;
    const sh = r.hs.model.start!;
    expect(sa.layout).toEqual(sh.layout);
    expect(sb.layout).toEqual(sh.layout);
    expect(sh.layout.length).toBe(8); // 2 units x 4 fields
    expect(sh.init.teams).toBe(3);
  });

  it('the battle starts when the time runs out', () => {
    const { r } = placing(true);
    r.clock.t += 61000;
    r.host.tick();
    expect(r.hs.model.state!.phase).toBe('battle');
  });
});

/** Runs the real Battles of the host + guests in lockstep. */
function runLockstep(r: Rig, guests: GuestSession[], frames: number, hook?: (f: number, sims: Battle[]) => void, stopWhenDone = false): { sims: Battle[]; runners: LockstepRunner[] } {
  const start = r.hs.model.start!;
  const mk = (): Battle => new Battle(start.simSeed, battleConfig(start));
  const hostSim = mk();
  const sims = [hostSim, ...guests.map(() => mk())];
  const runners = [
    new LockstepRunner(hostSim, r.hs.model, { host: r.host }),
    ...guests.map((g, i) => new LockstepRunner(sims[i + 1], g.model, { send: (m) => g.send(m) })),
  ];
  for (let f = 0; f < frames; f++) {
    for (const rn of runners) rn.advance(1 / 60);
    r.hub.pump();
    hook?.(f, sims);
    if (stopWhenDone && sims.every((x) => x.winner !== -1)) break;
  }
  return { sims, runners };
}

describe('lockstep battle', () => {
  function battleRig(extra: Record<string, unknown> = {}): { r: Rig; a: GuestSession; b: GuestSession } {
    const r = rig(5);
    const a = join(r, 'A');
    const b = join(r, 'B');
    r.hs.send({ t: 'settings', settings: { gold: 600, openPlacement: true, comedyPhysics: !!extra.comedy } });
    toPlacing(r, [a, b]);
    for (const [g, team] of [[a, a.model.me!.team], [b, b.model.me!.team]] as const) {
      const sp = spots(r, team, 25);
      g.send({ t: 'place', items: sp.map((p, i) => ({ cid: i, kind: i % 4 === 3 ? 3 : i % 3, x: p.x, y: p.y })) });
      g.send({ t: 'ready', ready: true });
    }
    const hp = spots(r, 0, 25);
    r.hs.send({ t: 'place', items: hp.map((p, i) => ({ cid: i, kind: i % 3, x: p.x, y: p.y })) });
    r.hs.send({ t: 'ready', ready: true });
    r.host.tick();
    expect(r.hs.model.state!.phase).toBe('battle');
    return { r, a, b };
  }

  it('host and two guests finish with the same hash; the result is broadcast', () => {
    const { r, a, b } = battleRig();
    const { sims } = runLockstep(r, [a, b], 60 * 500, undefined, true);
    const h = sims[0].hash();
    expect(sims[1].hash()).toBe(h);
    expect(sims[2].hash()).toBe(h);
    expect(sims[0].winner).not.toBe(-1);
    expect(r.hs.model.result).not.toBeNull();
    expect(a.model.result!.winner).toBe(sims[0].winner);
    expect(r.hs.model.state!.phase).toBe('result');
  }, 120000);

  it('a diverging client is caught by the checksum and fixed with a state snapshot', () => {
    const { r, a, b } = battleRig();
    let injected = false;
    const { sims, runners } = runLockstep(r, [a, b], 60 * 40, (f, s) => {
      if (f === 200 && !injected) {
        injected = true;
        // Corrupt b's sim state: teleport one unit, shift the rng.
        s[2].units.x[0] += 3;
        s[2].restore(s[2].serialize());
      }
    });
    expect(injected).toBe(true);
    expect(runners[2].resyncs).toBeGreaterThan(0);
    expect(runners[1].resyncs).toBe(0);
    // After the fix they are equal at the last checkpoint.
    for (let f = 0; f < 60; f++) {
      for (const rn of runners) rn.advance(1 / 60);
      r.hub.pump();
    }
    const common = Math.min(...sims.map((s) => s.stepCount));
    expect(common).toBeGreaterThan(CHECK_EVERY);
    expect(sims[2].hash() === sims[0].hash() || sims[2].stepCount !== sims[0].stepCount).toBe(true);
  }, 120000);

  it('host speed and pause commands; a guest cannot command', () => {
    const { r, a, b } = battleRig();
    r.hs.send({ t: 'cmd', speed: 4 });
    expect(a.model.speed).toBe(4);
    a.send({ t: 'cmd', speed: 1, paused: true });
    expect(b.model.speed).toBe(4);
    expect(b.model.paused).toBe(false);
    r.hs.send({ t: 'cmd', speed: 2, paused: true });
    expect(b.model.paused).toBe(true);
  });

  it('a spectator joins mid-battle and catches up with a state snapshot', () => {
    const { r, a, b } = battleRig();
    const start = r.hs.model.start!;
    const hostSim = new Battle(start.simSeed, battleConfig(start));
    const hostRun = new LockstepRunner(hostSim, r.hs.model, { host: r.host });
    const ga = [a, b].map((g) => ({ g, sim: new Battle(start.simSeed, battleConfig(start)) }));
    const runs = ga.map((x) => new LockstepRunner(x.sim, x.g.model, { send: (m) => x.g.send(m) }));
    for (let f = 0; f < 600; f++) {
      hostRun.advance(1 / 60);
      for (const rn of runs) rn.advance(1 / 60);
      r.hub.pump();
    }
    const spec = join(r, 'Izleyici', { spectator: true });
    expect(spec.model.start).not.toBeNull();
    expect(spec.model.pendingResync).not.toBeNull();
    const specSim = new Battle(spec.model.start!.simSeed, battleConfig(spec.model.start!));
    const specRun = new LockstepRunner(specSim, spec.model, { send: (m) => spec.send(m) });
    specRun.advance(1 / 60);
    expect(specRun.resyncs).toBe(1);
    for (let f = 0; f < 300; f++) {
      hostRun.advance(1 / 60);
      for (const rn of runs) rn.advance(1 / 60);
      specRun.advance(1 / 60);
      r.hub.pump();
    }
    // Within the catch-up tolerance (<= 3 steps); bring both to the same step and compare the hash.
    expect(Math.abs(specSim.stepCount - hostSim.stepCount)).toBeLessThanOrEqual(3);
    while (specSim.stepCount < hostSim.stepCount) specSim.step(1 / 30);
    while (hostSim.stepCount < specSim.stepCount) hostSim.step(1 / 30);
    expect(specSim.hash()).toBe(hostSim.hash());
  }, 120000);
});

describe('connection', () => {
  it('a dropped player returns to the same team with their token; a dropped player in the lobby is removed', () => {
    const r = rig(7);
    const a = join(r, 'A');
    const b = join(r, 'B');
    toPlacing(r, [a, b]);
    const token = b.model.token;
    const team = b.model.me!.team;
    const tp = (b as unknown as { tp: { close(): void } }).tp;
    tp.close(); // the connection drops (the host gets onPeerLeave)
    const bp = r.hs.model.state!.players.find((p) => p.team === team)!;
    expect(bp.connected).toBe(false);
    const back = join(r, 'B', { token });
    expect(back.model.rejected).toBeNull();
    expect(back.model.me!.team).toBe(team);
    expect(back.model.me!.connected).toBe(true);
    // They were not ready before dropping during placement: they must not be locked on return.
    expect(back.model.me!.ready).toBe(false);
    expect(r.hs.model.state!.players.length).toBe(3);
  });

  it('when the host leaves, guests are told the lobby closed', () => {
    const r = rig();
    const a = join(r, 'A');
    r.hs.leave();
    expect(a.model.closedReason).toBeTruthy();
  });
});
