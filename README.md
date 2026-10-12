# RPG Web — Savaş Stüdyosu

Tarayıcıda çalışan izometrik, otomatik savaş oyunu. PixiJS v8 + Vite + TypeScript. Simülasyon bir Web Worker'da
çalışır; 20.000 askerlik (10k vs 10k) savaş ~160 FPS'te akar.

## Çalıştırma

```bash
npm install
npm run dev      # geliştirme sunucusu (http://localhost:5173)
npm run build    # tsc + üretim derlemesi
npm run check    # tsc --noEmit + testler
```

`SharedArrayBuffer` (worker) için sunucu `Cross-Origin-Opener-Policy: same-origin` ve
`Cross-Origin-Embedder-Policy: require-corp` başlıklarını göndermelidir (`vite.config.ts` bunu dev/preview için yapar;
üretim sunucusunda da gerekir). Yoksa sim otomatik olarak ana thread'e düşer.

## Kullanım

**Stüdyo (ana sayfa):** harita (çevre, tohum, boyut), vur-kaç, hız, görünüm/ses, birim ayarları, 2–6 takım, renk
paleti, asker yerleştirme ve benchmark.

| Girdi | İşlev |
|---|---|
| Sol tık / sürükle | Asker yerleştir (fırça: Tek / Küçük / Büyük) |
| Sağ tık / sürükle | Sil (Shift: yalnız seçili takım) |
| Q / E | Takım değiştir · 1–5: asker türü · B: fırça · X: yerleştir/sil |
| Ctrl+Z / Ctrl+Y (veya Z / Y) | Geri al / yinele |
| Tekerlek, WASD, orta tuş | Yakınlaş, kaydır |
| Space · R · Esc · 1-2-3 · F3 | (savaşta) duraklat · yeniden başlat · düzenle · hız · istatistik |

**URL parametreleri:** `?bench=10000&auto=30` (benchmark, 30 sn sonra rapor), `?sim=main` (sim ana thread),
`?env=off` (çevresiz), `?kite=off` (vur-kaç kapalı), `?seed=3`.

## Birimler

Savaşçı, Okçu (yay, vur-kaç), Rahip (şifa, vur-kaç), **Kalkan Tankı** (önünde koni itme, güçlü knockback),
**Çekiç Tankı** (çevresinde daire darbe, yarım knockback). Tüm değerler stüdyodaki *Birim ayarları* penceresinden
değiştirilebilir (`src/sim/units.ts` varsayılanlar).

## Mimari

```
src/sim/      saf TS simülasyon (Node'da da çalışır): battle, terrain, grid, units, worker, paylaşılan bellek
src/render/   PixiJS çizim: atlas (tek doku), unitView (ayrıntılı), massRenderer (toplu), fx, audio, terrainView
src/app/      stüdyo (DOM), editör, savaş sahnesi, durum/kalıcılık
```

- **Sim**: 30 Hz sabit adım, SoA tipli diziler, takım başına uniform grid; hedefleme puanlı ve yapışkan (titreme yok);
  nehir köprü rotasıyla geçilir, sıkışan birimler A* ile çözülür; ilerleme bekçisi ulaşılamaz hedefi yasaklar; hasar
  verilemez/uzun süre hasarsız savaşlar beraberlikle biter.
- **Çizim**: ≤150 birimde ayrıntılı (animasyonlu) `UnitView`, fazlasında atlas'tan `ParticleContainer`. Efektler ve sesler
  sim'den gelen olaylarla (`hit`, `death`, `heal`, `bash`, `slam`, `shot`, `land`) tetiklenir.
- **Ses**: dosyasız WebAudio sentezi; ilk kullanıcı hareketinde açılır, ≤14 eşzamanlı ses, ekrana göre kısılır/panlanır.

## Testler

```bash
npm test                                  # birim + kenar durum + 120 rastgele senaryo
FUZZ_N=600 FUZZ_START=300 npm test        # daha geniş rastgele tarama
HUNT=1 FUZZ_N=300 npx vitest run src/sim/__tests__/fuzz.test.ts   # hataları toplayıp raporla (test-results/fuzz-report.txt)
DEBUG_SCN=9 DEBUG_AT=20,30 npx vitest run src/sim/__tests__/debug.test.ts  # bir senaryonun birim dökümü
```

`src/sim/testing/stall.ts` takılma dedektörü (boşta kovalayıcı, vuramayan, salınım, ilerlemesizlik, ulaşılamaz hedef)
ve değişmezleri (yürünemez karo, NaN, harita dışı) içerir. Bilinen sınır: ~%0.3 senaryoda nadir kapalı-köşe takılması.
