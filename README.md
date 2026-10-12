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

**Haritalar:** stüdyoda *Harita → Harita seç…* ile önizlemeli kart galerisi açılır: 4 biyom (Orman, Çöl, Kar, Bataklık) ×
nehir (kıvrımlı, düz, adalı, göllü, nehirsiz), orman (yoğun, seyrek, koru, çevre ormanı, ormansız), köy (köy, dağınık evler,
harabe kale, kamp, köysüz) ve geçit (ahşap köprü, taş köprü, sığ geçit) çeşitleri. 12 hazır harita, *Özelleştir*
açılırları ve **Rastgele** kartı (her şey rastgele + tohum; *Yeniden çek* / *Kilitle*) vardır. Tarif `MapSpec`
(`src/sim/mapSpec.ts`) ile sim ve çizimde ortaktır; her tarif merkeze göre simetriktir.

**Debug katmanı:** stüdyoda *Görünüm ve ses → Hata ayıklama* anahtarı, savaşta HUD'daki *Debug* düğmesi veya `V` tuşu
(savaş aynı dizilimle yeniden başlar) ya da `?debug=1` ile açılır. Sim ana thread'de çalışır ve test paketindeki takılma dedektörü savaşı canlı izler.
Sorunlu birim kırmızı nabızlı halka, sıkışan birim turuncu halka, hedefi yasaklanan mor halka alır; sol üstteki panel
sayaçları (takılan, aktif A* yolu, yasak, leash kırılması) ve son bayrakları (`idleChaser`, `cannotHit`, `oscillation`,
`noProgress`...) gösterir. Tuşlar: `H` katmanı aç/kapat · `T` hedef çizgileri · `P` A* yolları · `G` kapalı bölgeler.

**URL parametreleri:** `?debug=1`, `?bench=10000&auto=30` (benchmark, 30 sn sonra rapor), `?sim=main` (sim ana thread),
`?env=off` (çevresiz), `?kite=off` (vur-kaç kapalı), `?seed=3`.

## Birimler

5 klasik tür (Savaşçı, Okçu, Rahip, **Kalkan Tankı**, **Çekiç Tankı**) ve [the reference roster](docs/UNITS.md)
(source terms) birimleri: **45 birim** (Yaygın/Nadir/Destansı/Efsanevi; İnsan/Karanlık/Kutsal/Vahşi). Veri `src/sim/data/troops.ts`
(10 seviyelik can/saldırı/savunma, hareket sınıfı, menzil, hasar şekli, yetenek), yetenek parametreleri `src/sim/data/skills.ts`.
Her birim tek askerdir (mangalar yok); roster değerleri oyun ölçeğine bölenle indirgenir (`HP_DIV`, `ATK_DIV`, savunma → zırh).

Stüdyoda **Birimler…** galerisi: nadirlik/ırk filtresi, arama, birim simgeleri, **seviye (1-10)** seçici. Tüm değerler
*Birim ayarları* penceresinden birim bazında değiştirilebilir. Roster sanatı kullanılmaz: çizimler `src/render/looks.ts` içinde
özgün, prosedürel tariflerdir.

Yetenekler (`src/sim/battle.ts`): alan/dikdörtgen/delici hasar, yavaşlatma-donma, sersemletme, korku, kışkırtma, kalkan,
yanma ve lanet bölgeleri, çağırma (Bone Caller → iskelet), yeniden doğma, iyileştirme/arındırma, öfke, yaşam çalma,
diken yansıtma, kritik, patlama, Hex bağı, ışığa dönüşme vb.

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
ROSTER_N=400 npx vitest run src/sim/__tests__/rosterfuzz.test.ts      # roster birimleriyle rastgele tarama
BALANCE=1 LEVEL=6 npx vitest run src/sim/__tests__/balance.test.ts  # round-robin kazanma oranları (test-results/balance.txt)
```
`skills.test.ts` yeteneklerin gerçekten çalıştığını (çağırma, yeniden doğma, patlama, yavaşlatma, kışkırtma, korku, bağ...), `troops.test.ts` her roster birimini 1. ve 10. seviyede takılma/döngü açısından sınar.

`src/sim/testing/stall.ts` takılma dedektörü (boşta kovalayıcı, vuramayan, salınım, ilerlemesizlik, ulaşılamaz hedef)
ve değişmezleri (yürünemez karo, NaN, harita dışı) içerir. Bilinen sınır: ~%0.3 senaryoda nadir kapalı-köşe takılması.
