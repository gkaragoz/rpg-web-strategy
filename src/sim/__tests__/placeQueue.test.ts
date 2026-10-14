import { describe, expect, it } from 'vitest';
import { PLACE_BATCH, PlaceQueue } from '../../app/online/placeQueue';
import { GuestSession, HostSession } from '../../net/client';
import { teamZones } from '../../net/economy';
import { HostLobby } from '../../net/host';
import type { ClientMsg, PlaceItem } from '../../net/protocol';
import { LoopbackHub } from '../../net/transport';
import { mulberry32 } from '../random';
import { Terrain } from '../terrain';

const item = (cid: number): PlaceItem => ({ cid, kind: 0, x: cid, y: 1 });

function drain(q: PlaceQueue): ClientMsg[] {
  const out: ClientMsg[] = [];
  for (let m = q.next(); m; m = q.next()) out.push(m);
  return out;
}

describe('placement outbox', () => {
  it('merges the tiny edits of a brush stroke into batches no bigger than the host accepts', () => {
    const q = new PlaceQueue();
    for (let i = 0; i < 300; i++) q.add([item(i)]);
    const msgs = drain(q);
    expect(msgs.length).toBe(Math.ceil(300 / PLACE_BATCH));
    for (const m of msgs) expect(m.t === 'place' && m.items.length <= PLACE_BATCH).toBe(true);
    // Order is kept.
    const cids = msgs.flatMap((m) => (m.t === 'place' ? m.items.map((i) => i.cid) : []));
    expect(cids).toEqual(Array.from({ length: 300 }, (_, i) => i));
  });

  it('keeps the order between placements and removals (the host must see the same sequence)', () => {
    const q = new PlaceQueue();
    q.add([item(1), item(2)]);
    q.remove([10]);
    q.add([item(3)]);
    q.remove([11, 12]);
    q.remove([13]);
    const msgs = drain(q);
    expect(msgs.map((m) => m.t)).toEqual(['place', 'unplace', 'place', 'unplace']);
    expect(msgs[3]).toEqual({ t: 'unplace', ids: [11, 12, 13] });
    expect(q.next()).toBeNull();
    expect(q.size).toBe(0);
  });

  it('clear drops everything that was not sent', () => {
    const q = new PlaceQueue();
    q.add([item(1)]);
    q.remove([2]);
    q.clear();
    expect(q.next()).toBeNull();
  });
});

describe('placement and the host rate limit', () => {
  function room(): { host: HostLobby; hs: HostSession; guest: GuestSession; clock: { t: number }; spots: Array<{ x: number; y: number }> } {
    const hub = new LoopbackHub();
    const clock = { t: 1000 };
    const host = new HostLobby(hub.host, 'Host', 0, { now: () => clock.t, rnd: mulberry32(5) });
    const hs = new HostSession(host, false);
    const guest = new GuestSession(hub.connect(), { name: 'G', color: 1 });
    guest.send({ t: 'ready', ready: true });
    hs.send({ t: 'start' });
    const init = hs.model.state!.init!;
    const t = new Terrain(init.size, { seed: init.seed, spec: init.spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
    const z = teamZones(init.size, init.teams, t)[guest.model.me!.team];
    const spots: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < init.size && spots.length < 150; y++)
      for (let x = 0; x < init.size && spots.length < 150; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        if (z.contains(px, py) && t.walkable(px, py) && t.reachable(px, py) && spots.every((o) => Math.hypot(o.x - px, o.y - py) >= 1.2)) spots.push({ x: px, y: py });
      }
    return { host, hs, guest, clock, spots };
  }

  it('one message per stamp is refused once the burst is used up, the merged batches are not', () => {
    const a = room();
    expect(a.spots.length).toBe(150);
    // One message per stamp, all within the same instant (a fast brush stroke on a slow connection).
    a.spots.forEach((s, i) => a.guest.send({ t: 'place', items: [{ cid: i + 1, kind: 0, x: s.x, y: s.y }] }));
    const refused = a.guest.model.lastFail;
    expect(refused?.reason).toBe('busy');
    const placedOneByOne = [...a.hs.model.placed.values()].length + a.guest.model.placed.size;
    expect(a.guest.model.placed.size).toBeLessThan(150);
    expect(placedOneByOne).toBeGreaterThan(0);

    const b = room();
    const q = new PlaceQueue();
    b.spots.forEach((s, i) => q.add([{ cid: i + 1, kind: 0, x: s.x, y: s.y }]));
    for (let m = q.next(); m; m = q.next()) b.guest.send(m);
    expect(b.guest.model.lastFail).toBeNull();
    expect(b.guest.model.placed.size).toBe(150);
  });
});
