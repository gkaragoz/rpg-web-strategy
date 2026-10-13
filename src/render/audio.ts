import { comedy } from './comedyFlag';
import type { Camera } from '../camera';
import { isoX, isoY } from '../iso';
import type { SimEvent } from '../sim/battle';
import { isTank } from '../sim/units';

type Sfx = 'hit' | 'shot' | 'land' | 'heal' | 'bash' | 'slam' | 'death' | 'fire' | 'ice' | 'holy' | 'dark' | 'nature' | 'zap' | 'bonk' | 'boing' | 'wail' | 'splat' | 'whoosh';

const SFX_LIST: Sfx[] = ['hit', 'shot', 'land', 'heal', 'bash', 'slam', 'death', 'fire', 'ice', 'holy', 'dark', 'nature', 'zap', 'bonk', 'boing', 'wail', 'splat', 'whoosh'];
const zeroed = (): Record<Sfx, number> => Object.fromEntries(SFX_LIST.map((k) => [k, 0])) as Record<Sfx, number>;

/** Ses basina en kisa tekrar araligi (ms): kalabalikta ses yagmuru olmasin. */
const MIN_GAP: Record<Sfx, number> = { hit: 40, shot: 55, land: 110, heal: 120, bash: 130, slam: 160, death: 70, fire: 150, ice: 150, holy: 170, dark: 160, nature: 170, zap: 150, bonk: 45, boing: 90, wail: 110, splat: 90, whoosh: 120 };
const MAX_VOICES = 14;

/**
 * Dosyasiz, WebAudio ile sentezlenmis ses efektleri. Olaylar ekrandaki konuma gore
 * kisilir/panlanir, ayni anda en fazla MAX_VOICES ses calar. Tarayici politikasi
 * nedeniyle baglam ilk kullanici hareketinde acilir.
 */
export class AudioSystem {
  enabled = true;
  private volume = 0.6;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly lastPlay: Record<Sfx, number> = zeroed();
  private readonly endTimes: number[] = [];
  /** Test/dogrulama: calinan seslerin sayaci (ses duyulamayan ortamlarda olay->ses eslemesini kanitlar). */
  readonly played: Record<Sfx, number> = zeroed();

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master) this.master.gain.value = this.volume * 0.8;
  }

  /** Ilk kullanici hareketinde cagrilir (autoplay politikasi). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !document.hidden) void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
    } catch {
      return;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume * 0.8;
    this.master.connect(this.ctx.destination);
    // 1 sn'lik beyaz gurultu tamponu.
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** Sekme gizlenince sessizlestirir, donunce devam eder. */
  setHidden(hidden: boolean): void {
    if (!this.ctx) return;
    if (hidden) void this.ctx.suspend();
    else if (this.enabled) void this.ctx.resume();
  }

  /** Sim olaylarini ses efektlerine cevirir. */
  handle(events: SimEvent[], camera: Camera, screenW: number, screenH: number): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    for (const ev of events) {
      const sfx = this.map(ev.type, ev.element);
      if (!sfx) continue;
      const sx = (isoX(ev.x, ev.y) - camera.x) * camera.zoom + screenW / 2;
      const sy = (isoY(ev.x, ev.y) - camera.y) * camera.zoom + screenH / 2;
      const margin = 80;
      if (sx < -margin || sx > screenW + margin || sy < -margin || sy > screenH + margin) continue;
      // Uzaklastikca (zoom cikinca) sessizlesir; yakinlasinca netlesir.
      const zoomGain = Math.min(1, Math.max(0.25, camera.zoom * 0.9));
      const pan = Math.max(-1, Math.min(1, (sx - screenW / 2) / (screenW / 2))) * 0.8;
      const heavy = ev.kind !== undefined && isTank(ev.kind);
      this.play(sfx, zoomGain, pan, heavy, ev.value ?? 10);
    }
  }

  private map(t: SimEvent['type'], element?: number): Sfx | null {
    if (comedy.visual) {
      // Komedi gorunumu: kartun sesleri.
      if (t === 'hit') return 'bonk';
      if (t === 'shot') return 'boing';
      if (t === 'death') return 'wail';
      if (t === 'bash' || t === 'slam') return 'bonk';
      if (t === 'burst' && element === 7) return 'splat';
      if (t === 'burst' && element === 8) return 'whoosh';
    }
    switch (t) {
      case 'hit':
        return 'hit';
      case 'shot':
        return 'shot';
      case 'land':
        return 'land';
      case 'heal':
        return 'heal';
      case 'bash':
        return 'bash';
      case 'slam':
        return 'slam';
      case 'death':
        return 'death';
      case 'burst':
        // Unsur: 0 fiziksel, 1 ates, 2 buz, 3 kutsal, 4 karanlik, 5 doga, 6 enerji.
        return element === 1 ? 'fire' : element === 2 ? 'ice' : element === 3 ? 'holy' : element === 4 ? 'dark' : element === 5 ? 'nature' : element === 6 ? 'zap' : 'bash';
      default:
        return null;
    }
  }

  private play(sfx: Sfx, gain: number, pan: number, heavy: boolean, value: number): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const tms = performance.now();
    if (tms - this.lastPlay[sfx] < MIN_GAP[sfx]) return;
    while (this.endTimes.length && this.endTimes[0] < now) this.endTimes.shift();
    if (this.endTimes.length >= MAX_VOICES) return;
    this.lastPlay[sfx] = tms;
    this.played[sfx]++;

    const out = ctx.createGain();
    out.gain.value = gain;
    let node: AudioNode = out;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      out.connect(p);
      node = p;
    }
    node.connect(this.master!);
    const r = 0.9 + Math.random() * 0.2;
    let dur = 0.15;

    switch (sfx) {
      case 'hit': {
        dur = 0.09;
        this.burst(out, now, 0.07, 1700 * r * (heavy ? 0.6 : 1), 1.2, Math.min(0.45, 0.22 + value / 80));
        this.tone(out, now, 'triangle', 240 * r * (heavy ? 0.6 : 1), 90, 0.07, 0.22);
        break;
      }
      case 'shot': {
        dur = 0.16;
        this.tone(out, now, 'triangle', 560 * r, 170, 0.13, 0.16);
        this.burst(out, now, 0.05, 3200, 0.8, 0.07);
        break;
      }
      case 'land': {
        dur = 0.06;
        this.burst(out, now, 0.05, 500, 0.7, 0.14);
        break;
      }
      case 'heal': {
        dur = 0.32;
        this.tone(out, now, 'sine', 880 * r, 990 * r, 0.28, 0.1);
        this.tone(out, now + 0.06, 'sine', 1320 * r, 1480 * r, 0.26, 0.08);
        break;
      }
      case 'bash': {
        dur = 0.2;
        this.burst(out, now, 0.12, 420, 0.8, 0.3);
        this.tone(out, now, 'sine', 110, 55, 0.18, 0.36);
        break;
      }
      case 'slam': {
        dur = 0.45;
        this.tone(out, now, 'sine', 70, 32, 0.4, 0.55);
        this.burst(out, now, 0.28, 360, 0.7, 0.34);
        break;
      }
      case 'fire': {
        // Alev patlamasi: alcak gumbur + sicak gurultu + yukselen cizirti.
        dur = 0.36;
        this.tone(out, now, 'sawtooth', 130 * r, 48, 0.3, 0.2);
        this.burst(out, now, 0.3, 780, 0.6, 0.32);
        this.burst(out, now + 0.04, 0.2, 2400, 1.2, 0.1);
        break;
      }
      case 'ice': {
        // Buz kirilmasi: parlak cam tinlamasi + ince kirilma.
        dur = 0.34;
        this.tone(out, now, 'triangle', 2100 * r, 1500, 0.2, 0.12);
        this.tone(out, now + 0.03, 'sine', 3100 * r, 2300, 0.22, 0.07);
        this.burst(out, now, 0.12, 5200, 2, 0.22);
        break;
      }
      case 'holy': {
        // Kutsal isik: yukselen uclu cin.
        dur = 0.5;
        this.tone(out, now, 'sine', 660 * r, 700 * r, 0.4, 0.1);
        this.tone(out, now + 0.07, 'sine', 990 * r, 1040 * r, 0.38, 0.09);
        this.tone(out, now + 0.14, 'sine', 1320 * r, 1380 * r, 0.34, 0.08);
        break;
      }
      case 'dark': {
        // Karanlik buyu: alcak titresim + ters gurultu.
        dur = 0.42;
        this.tone(out, now, 'sawtooth', 90 * r, 52, 0.38, 0.17);
        this.tone(out, now, 'square', 61 * r, 40, 0.34, 0.07);
        this.burst(out, now + 0.05, 0.28, 300, 1.4, 0.2);
        break;
      }
      case 'nature': {
        // Doga/korku: hisirti ve alcalan nota.
        dur = 0.38;
        this.burst(out, now, 0.34, 1500, 0.9, 0.2);
        this.tone(out, now, 'triangle', 420 * r, 240, 0.3, 0.12);
        break;
      }
      case 'zap': {
        // Enerji: hizli yukselen/alcalan elektrik.
        dur = 0.3;
        this.tone(out, now, 'square', 900 * r, 220, 0.22, 0.1);
        this.tone(out, now + 0.02, 'sawtooth', 1500 * r, 300, 0.18, 0.08);
        this.burst(out, now, 0.14, 3600, 1.1, 0.16);
        break;
      }
      case 'bonk': {
        dur = 0.2;
        this.tone(out, now, 'sine', (heavy ? 210 : 360) * r, heavy ? 70 : 120, 0.16, 0.34);
        this.burst(out, now, 0.04, 1100, 1.2, 0.2);
        if (heavy) this.tone(out, now + 0.05, 'sine', 150, 60, 0.22, 0.3);
        break;
      }
      case 'boing': {
        dur = 0.4;
        this.tone(out, now, 'sine', 170 * r, 720 * r, 0.14, 0.18);
        this.tone(out, now + 0.13, 'sine', 720 * r, 190 * r, 0.24, 0.16);
        break;
      }
      case 'wail': {
        // "Aaaah!": perde yukselip duser; ikinci katman uyumlu.
        dur = 0.7;
        this.tone(out, now, 'triangle', 380 * r, 1050 * r, 0.26, 0.15);
        this.tone(out, now + 0.25, 'triangle', 1050 * r, 240 * r, 0.34, 0.14);
        this.tone(out, now, 'sine', 570 * r, 1500 * r, 0.26, 0.05);
        break;
      }
      case 'splat': {
        dur = 0.24;
        this.burst(out, now, 0.16, 650, 0.7, 0.36);
        this.tone(out, now, 'sine', 160, 55, 0.15, 0.3);
        break;
      }
      case 'whoosh': {
        dur = 0.3;
        this.burst(out, now, 0.26, 2100 * r, 0.5, 0.13);
        this.tone(out, now, 'sine', 300, 900, 0.22, 0.05);
        break;
      }
      case 'death': {
        dur = 0.16;
        this.tone(out, now, 'sine', 320 * r, 90, 0.13, 0.14);
        this.burst(out, now, 0.09, 900, 0.8, 0.1);
        break;
      }
    }
    this.endTimes.push(now + dur + 0.05);
    window.setTimeout(() => {
      try {
        out.disconnect();
      } catch {
        /* zaten kopmus */
      }
    }, (dur + 0.2) * 1000);
  }

  /** Bant gecirgenli gurultu patlamasi. */
  private burst(dest: AudioNode, t: number, dur: number, freq: number, q: number, peak: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 0.8);
    src.stop(t + dur + 0.02);
  }

  /** Perde kayan tek tonluk ses. */
  private tone(dest: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, dur: number, peak: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
}
