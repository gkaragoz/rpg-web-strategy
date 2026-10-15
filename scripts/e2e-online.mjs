// Online-play e2e tests (imported by e2e.mjs): rematch behaviour and WebRTC peer loss in a real browser.
import { sleep } from './lib/browser.mjs';

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const noErrors = (page, label) => {
  const bad = page.errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  if (bad.length) throw new Error(`${label}: ${bad.length} page error(s): ${bad[0]}`);
};
// Own windows: a battle needs animation frames, which a background tab does not get.
const URL_Q = 'lang=en&view=2d&debug=1&tour=off';

/** Puts a small soldier group into the player's own zone through the debug handle. */
const placeSoldiers = (p, n = 6) =>
  p.eval(`(() => {
    const pl = window.__placement;
    const z = pl.zones.find((q) => q.team === pl.myTeam);
    const t = pl.env.world.terrain;
    const items = [];
    for (let y = 0; y < pl.init.size && items.length < ${n}; y++) for (let x = 0; x < pl.init.size && items.length < ${n}; x++) {
      const px = x + 0.5, py = y + 0.5;
      if (z.contains(px, py) && (!t || (t.walkable(px, py) && t.reachable(px, py))) && items.every((o) => Math.hypot(o.x - px, o.y - py) > 2)) items.push({ cid: 9000 + items.length, kind: 0, x: px, y: py });
    }
    window.__session.send({ t: 'place', items });
    return items.length;
  })()`);

export const onlineTests = [
  {
    // The host's own placement events (placed, vipSet) arrive before the placement screen of a rematch exists: the VIP crown must still show.
    name: 'online-vip-rematch-keeps-mark',
    async run({ stack }) {
      const host = await stack.page({ width: 1000, height: 640, window: true });
      const guest = await stack.page({ width: 1000, height: 640, window: true });
      await host.nav(`${stack.base}?${URL_Q}`);
      await host.eval(`(() => { const lan = [...document.querySelectorAll('#m-tp button')].find((b) => /lan/i.test(b.textContent)); lan?.click(); })()`);
      await host.clickSel('#m-host');
      const code = await host.waitFor(`document.querySelector('#l-code')?.textContent?.trim()`, 'lobby code', 20000);
      await host.eval(`document.querySelector('#l-mode .mode-card[data-mode="vip"]').click()`);
      await guest.nav(`${stack.base}?${URL_Q}`);
      await guest.eval(`(() => { const i = document.querySelector('#m-code'); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await guest.clickSel('#m-join');
      await guest.waitFor(`document.querySelector('#l-mode .mode-card[data-mode="vip"]')?.getAttribute('aria-checked') === 'true'`, 'guest sees vip', 20000);
      await guest.eval(`document.querySelector('#l-ready').click()`);
      await host.waitFor(`document.querySelectorAll('#l-players li').length >= 2`, 'two players');
      await host.eval(`document.querySelector('#l-start').click()`);
      for (const p of [host, guest]) await p.waitFor(`!!window.__placement && !!document.querySelector('.on-dock')`, 'placement', 30000);
      for (const p of [host, guest]) assert((await placeSoldiers(p)) >= 3, 'found no place to put soldiers');
      await sleep(1500);
      for (const p of [host, guest]) {
        await p.waitFor(`window.__placement.state.units.some((x) => x.id !== undefined)`, 'own soldiers confirmed', 15000);
        await p.eval(`(() => { const pl = window.__placement; pl.editor.setVip(pl.state.units.find((x) => x.id !== undefined)); })()`);
        await p.waitFor(`window.__session.model.vip >= 0`, 'host confirmed the VIP', 10000);
      }
      for (const p of [host, guest]) await p.eval(`document.querySelector('#pg-ready').click()`);
      for (const p of [host, guest]) await p.waitFor(`!!window.__sim && !!document.querySelector('#hud-teams')`, 'battle', 60000);
      await host.key('3', 'Digit3'); // speed x4
      for (const p of [host, guest]) await p.waitFor(`!!document.querySelector('#hud-result') && !document.querySelector('#hud-result').hidden`, 'result card', 100000);
      await host.eval(`document.querySelector('#res-restart').click()`);
      for (const p of [host, guest]) await p.waitFor(`!!window.__placement && !!document.querySelector('.on-dock')`, 'placement of the rematch', 30000);
      // The pick survives the rematch on both screens (crown on the unit, not just the model value).
      for (const p of [host, guest]) {
        await p.waitFor(`window.__session.model.vip >= 0 && window.__placement.state.units.filter((u) => u.vip && u.id === window.__session.model.vip).length === 1`, 'VIP mark restored after the rematch', 15000);
      }
      noErrors(host, 'host');
      noErrors(guest, 'guest');
    },
  },
  {
    // PeerJS keeps the data channel "open" after the other tab vanished; the host must still notice and show the player as offline.
    name: 'online-webrtc-peer-loss',
    async run({ stack }) {
      const host = await stack.page({ width: 1000, height: 640, window: true });
      const guest = await stack.page({ width: 1000, height: 640, window: true });
      await host.nav(`${stack.base}?${URL_Q}&relay=off`);
      await host.eval(`document.querySelector('#m-tp button[data-tp="net"]').click()`);
      await host.clickSel('#m-host');
      // The public signaling server may be unreachable (offline CI): then there is nothing to test.
      const code = await host.waitFor(`document.querySelector('#l-code')?.textContent?.trim() || (document.querySelector('#m-error') && !document.querySelector('#m-error').hidden && 'ERR')`, 'lobby code or signaling error', 40000);
      if (code === 'ERR') return;
      await guest.nav(`${stack.base}?${URL_Q}&relay=off`);
      await guest.eval(`(() => { const i = document.querySelector('#m-code'); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await guest.clickSel('#m-join');
      await host.waitFor(`document.querySelectorAll('#l-players li').length >= 2`, 'guest joined over WebRTC', 45000);
      assert(await host.eval(`document.querySelector('#l-via')?.textContent.length > 0`), 'transport shown');
      guest.close();
      // The lobby drops a vanished player; in the lobby phase the row disappears (a ghost would show during a game).
      await host.waitFor(`document.querySelectorAll('#l-players li').length === 1`, 'host notices the lost guest', 60000);
      noErrors(host, 'host');
    },
  },
];
