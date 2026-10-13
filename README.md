# RPG Web — Savaş Stüdyosu

[![Lisans: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/lisans-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE)
[![Ticari kullanım: yasak](https://img.shields.io/badge/ticari%20kullan%C4%B1m-yasak-red)](LICENSING.md)
[![Release](https://github.com/gkaragoz/rpg-web-strategy/actions/workflows/release.yml/badge.svg)](https://github.com/gkaragoz/rpg-web-strategy/actions/workflows/release.yml)
[![Katkı: CLA gerekli](https://img.shields.io/badge/kat%C4%B1k-CLA%20gerekli-orange)](CONTRIBUTING.md)

Tarayıcıda çalışan izometrik, otomatik savaş oyunu. PixiJS v8 + Vite + TypeScript. Simülasyon bir Web Worker'da
çalışır; 20.000 askerlik (10k vs 10k) savaş ~160 FPS'te akar. Çevrimiçi mod (LAN / internet, en çok 6 oyuncu), mobil
dokunmatik desteği, 49 birim ve rastgele haritalar içerir.

## Lisans

Bu proje **kaynağı açık ama ticari kullanıma kapalıdır** (*source-available*). Kaynak kod
**[PolyForm Noncommercial License 1.0.0](LICENSE)** ve ek şartlar altındadır:

- ✅ Oynayabilir, kaynağı okuyabilir, **ticari olmayan** amaçla (kişisel, hobi, eğitim, araştırma, kâr amacı gütmeyen
  kuruluşlar) değiştirip paylaşabilirsin.
- ❌ Projeyi veya türevlerini **satamaz**, reklam/abonelik/oyun içi satın alma ile **gelir elde edemez**, ücretli ürün ya
  da hizmete (ücretli sunucu barındırma dahil) **dahil edemezsin**. Ticari kullanım için proje sahibinden yazılı izin gerekir.
- 📝 Her kopyada ve değiştirilmiş sürümde lisans ve **"© gkaragoz and Contributors"** bildirimi korunmalı, değiştirilmiş
  sürüm kendi kökenini yanlış göstermemeli ("RPG Web / Savaş Stüdyosu" adını resmi proje gibi kullanamaz).
- 🤝 İsteyen herkes **resmi projeye katkı** gönderebilir ([CONTRIBUTING.md](CONTRIBUTING.md)); katkılar [CLA](CLA.md) ile
  proje sahibine lisanslanır.
- Roster kaynaklı birim verisi (`src/sim/data/troops.ts`) **source terms**'dır, üçüncü taraf kütüphaneler kendi lisanslarındadır:
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Ayrıntılı özet: [LICENSING.md](LICENSING.md).

> AGPL gibi açık kaynak lisansları ticari kopyalamayı engelleyemediği için bu lisans seçildi; proje OSI tanımıyla "açık kaynak" değildir.


## Oyna / Kur

**Tarayıcıda (kurulumsuz):** https://gkaragoz.github.io/rpg-web-strategy/ — her sürümde otomatik yayınlanır. Sayfa ilk açılışta bir
service worker kaydedip bir kez yenilenir (SharedArrayBuffer / worker sim için); olmazsa sim ana thread'de çalışır.

**Kurulum sihirbazı (yerel sunucu, çevrimdışı oynanır; Node.js 18+ gerekir, yoksa sihirbaz kurmayı önerir):**

| Sistem | Komut |
|---|---|
| macOS / Linux | `curl -fsSL https://github.com/gkaragoz/rpg-web-strategy/releases/latest/download/install.sh \| bash` |
| Windows (PowerShell) | `iwr -useb https://github.com/gkaragoz/rpg-web-strategy/releases/latest/download/install.ps1 \| iex` |
| Windows (çift tık) | Releases sayfasından `install.bat` indirip çalıştır |

Sihirbaz kurulum klasörünü sorar, son sürümü indirir, `oyna.sh` / `oyna.bat` başlatıcısı ve masaüstü kısayolu oluşturur.
Güncelleme: `install.sh --update` · Kaldırma: `install.sh --uninstall` (Windows: `-Update` / `-Uninstall`).
Elle: sürüm zip'ini aç, `node server.mjs app --open` (`scripts/server.mjs`, bağımlılıksız, COOP/COEP başlıklı).

**Sürüm çıkarma:** `git tag v1.x.y && git push origin v1.x.y` → `.github/workflows/release.yml` test eder, derler, zip + sihirbaz
dosyalarıyla Release oluşturur ve Pages'e yayınlar.

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
| Space · R · Esc · 1-2-3 · F3 · V | (savaşta) duraklat · yeniden başlat · düzenle · hız · istatistik · debug |

**Haritalar:** stüdyoda *Harita → Harita seç…* ile önizlemeli kart galerisi açılır (21 hazır harita, biyom filtresi,
*Özelleştir* açılırları, **Rastgele** kartı: her şey rastgele + tohum; *Yeniden çek* / *Kilitle*). Tarif `MapSpec`
(`src/sim/mapSpec.ts`) ile sim ve çizimde ortaktır; her harita merkeze göre simetrik ve iki ordu birbirine ulaşabilir.
- **Biyom:** Orman, Çöl, Kar, Bataklık (zemin, ağaç/kaktüs/karlı çam/ölü ağaç, ev stili, su rengi).
- **Kurgu:** *Klasik* (nehir + kabartma), **Vadi ve geçit** (iki yüksek set, tek kapı), **Merkez kale** (rampalı plato, halka
  duvar, kuleler, hisar), **Adalar ve köprüler** (nehre dik iki kanal + köprüler), **Çapraz yol** (kavşak, mezralar).
- **Kabartma / yükselti:** Düz, Tepecikler, Sıradağ, Plato, Dağ. Yükselti yalnız görsel + yokuş yukarı yavaşlama (en çok %35);
  komşusundan ≥ 1,5 kademe yüksek tile uçurumdur (geçilmez). Zemin eğimli dörtgenlerle çizilir; birimler/dekor/mermiler
  yüksekliğe oturur.
- Nehir (kıvrımlı, düz, adalı, göllü, nehirsiz), orman (yoğun, seyrek, koru, çevre ormanı, ormansız), köy (köy, dağınık evler,
  harabe kale, kamp, köysüz), geçit (ahşap köprü, taş köprü, sığ geçit) seçenekleri.

**Komedi modu** (Totally Accurate Battle Simulator tadında; iki bağımsız anahtar — stüdyo *Görünüm ve ses → Komedi modu*,
savaşta HUD düğmeleri, `K` tuşu, ya da `?comedy=1` ile ikisi birden):
- **Komedi görünümü** (yalnız çizim/ses, anında açılıp kapanır): ölenler **ragdoll** olarak dönerek havaya uçar, sekip kayar,
  su üstüne düşenler batar (ara sıra şapka/yıldız ayrılıp uçar); yalpalayan yürüyüş, vuruşta squash-stretch, tökezleme;
  "BONK! / AAAH! / KABOOM!" yazıları, kartun sesler (bonk, boing, wail, splat, whoosh), büyütülmüş efektler, kamera sarsıntısı ve zoom darbesi.
- **Komedi fiziği** (sim'i değiştirir, savaşı yeniden başlatır): canın büyük kısmını alan vuruşlar, tank darbeleri ve alan
  yetenekleri birimi parabolik olarak havaya fırlatır (en çok 14 tile); suya inen **boğulur**, engel/uçuruma inen en yakın
  yürünebilir noktaya konur, yere inince kısa süre yatar ve altındakileri ezer. Mod kapalıyken sim hiç etkilenmez.

**Debug katmanı:** stüdyoda *Görünüm ve ses → Hata ayıklama* anahtarı, savaşta HUD'daki *Debug* düğmesi veya `V` tuşu
(savaş aynı dizilimle yeniden başlar) ya da `?debug=1` ile açılır. Sim ana thread'de çalışır ve test paketindeki takılma dedektörü savaşı canlı izler.
Sorunlu birim kırmızı nabızlı halka, sıkışan birim turuncu halka, hedefi yasaklanan mor halka alır; sol üstteki panel
sayaçları (takılan, aktif A* yolu, yasak, leash kırılması) ve son bayrakları (`idleChaser`, `cannotHit`, `oscillation`,
`noProgress`...) gösterir. Tuşlar: `H` katmanı aç/kapat · `T` hedef çizgileri · `P` A* yolları · `G` kapalı bölgeler.

**URL parametreleri:** `?debug=1`, `?bench=10000&auto=30` (benchmark, 30 sn sonra rapor), `?sim=main` (sim ana thread),
`?env=off` (çevresiz), `?kite=off` (vur-kaç kapalı), `?seed=3`.

## Çevrimiçi oyna

Stüdyodaki **Çevrimiçi** düğmesi: ad + renk seç, sonra **Lobi kur**, **Kodla katıl** ya da **Seyret**.

- **Lobi (host):** harita (seç ya da *Rastgele*), başlangıç gold'u, yerleştirme süresi, birim seviyesi, harita boyutu, *Açık yerleştirme*
  (herkes herkesin askerini anlık görür), komedi fiziği/görünümü, kapalı nadirlikler, parola; oyuncu **atma/susturma**. Oyuncu sayısı = takım sayısı (en çok 6).
- **Oyun akışı:** herkes *Hazırım* der → host *Oyunu başlat* → herkes kendi bölgesine, gold bütçesiyle asker koyar (her birimin otomatik gold maliyeti vardır) →
  herkes *HAZIR* deyince ya da süre dolunca savaş başlar. Hız ve duraklatma **yalnız host'ta**; diğerlerinde kilitli. Sonuçta host *Rövanş* başlatır.
- **Herkesin adı, rengi, imleci var:** imleçler haritada dünya koordinatında (kamera/zoom'dan bağımsız), lobide sayfa koordinatında görünür.
  Birim galerisi gibi bir panel açıksa imleç etiketi `Ad (Birim seçiyor)` olur. `Enter` ile oyun içi sohbet.
- **Seyirci** oyun ortasında girebilir; kopan oyuncu sayfayı yenileyip menüdeki **Yeniden bağlan** ile (≈1 dk içinde) aynı takıma döner.

**İnternet (varsayılan):** bir **WebSocket rölesi** üzerinden (`relay/`, ücretsiz Cloudflare Worker + Durable Object): iki cihaz farklı ağlarda/NAT arkasında olsa da bağlanır, TURN gerekmez. Röleye ulaşılamazsa doğrudan **WebRTC** (PeerJS) denenir. Lobide hangi yolun kullanıldığı kodun yanında yazar. Rölenin sonradan güncellenmesi için `relay/` içinde `npx wrangler login` (tarayıcıda izin verirsin) + `npx wrangler deploy` gerekir; çalışan röle için giriş gerekmez. Rölenin kendi adresini kullanmak için `relay/` içinde `npx wrangler deploy` çalıştırıp çıkan adresi `src/app/online/online.ts` içindeki `RELAY_URL`'e yaz.
Host oyunu yönetir; oyun mantığı herkeste aynı deterministik simülasyonla koşar, ağdan yalnız komutlar geçer (sapma olursa kontrol toplamı yakalar, host durum görüntüsü yollar).
**LAN:** kurulum sihirbazının `oyna-lan` başlatıcısı (ya da `node server.mjs app --open --lan`; geliştirmede `npm run dev` zaten `/ws` sunar) host'un bilgisayarında sunucuyu
LAN'a açar; arkadaşlar yazdırılan `http://<host-ip>:5174` adresini açıp koda katılır. Menüde bağlantı türünü *LAN* seç.

Sorun giderme: *Sinyal sunucusuna ulaşılamadı* → ağ/güvenlik duvarı PeerJS sinyal sunucusunu (`0.peerjs.com`) engelliyor, LAN'ı dene.
*Host bulundu ama doğrudan bağlantı kurulamadı* (yalnız röle ulaşılamazken WebRTC'ye düşüldüğünde) → iki cihaz farklı ağlarda ve NAT'lar doğrudan bağlantıya izin vermiyor; ücretsiz TURN sunucusu yok. Birincil yol olan **röle** bu durumda kullanılır; röle de erişilemiyorsa (ağ `workers.dev` adresini engelliyor) LAN'ı dene.
*LAN sunucusuna bağlanılamadı* → oyunu `--lan` ile başlatmadın ya da Pages'ten LAN seçtin (Pages https olduğundan `ws://` kuramaz).

## Mobil

Telefon ve tablette tarayıcıdan oynanır (Pages adresi). Dokunmatik kontroller:
- **Haritada:** tek parmak asker yerleştirir (sürüklersen boyar; *Sil* aracındaysa siler), **iki parmak kaydırır ve sıkıştırarak yakınlaştırır**. Savaşta tek parmak da kaydırır.
- **Alt çekmece:** yerleştirmede alttaki ince çubuk (takım, tür, araç, *Savaşı başlat* / *HAZIR*) yatay kaydırılır; tutamacına dokununca/sürükleyince tüm araçlar açılır. Silmede *Sil: seçili takım* masaüstündeki Shift+sağ tık'ın karşılığıdır.
- **Savaş HUD'u:** hız / duraklat / kamera (+ − ⌖) / istatistik düğmeleri tek satırda kaydırılır; istatistik paneli dokunmatikte varsayılan kapalıdır.
- **Çevrimiçi:** lobi dar ekranda *Oyuncular | Ayarlar* sekmeleri; sağ alttaki rozet bağlantı türünü ve lobi kodunu gösterir (dokununca davet linki kopyalanır); *Sohbet* düğmesi oyun içi sohbeti açar.
- Diyaloglar (birimler, harita) tam ekran sayfadır; dikey ve yatay ekran desteklenir.

Performans: ana cihazlarda (orta sınıf Android) 10.000 askerlik savaş ve ana iş parçacığındaki 8.000 askerlik simülasyon ~60 FPS çalışır. Kareler uzun süre yavaşlarsa çözünürlük otomatik düşürülür (Efektler: *Otomatik* iken).

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
src/app/online/  çevrimiçi arayüz: menü, lobi, yerleştirme, imleçler, sohbet
src/net/      protokol, host lobi durum makinesi, lockstep, taşımalar (loopback / WebSocket LAN / PeerJS)
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

## Katkıda bulunma

Hata düzeltmeleri, denge/oynanış iyileştirmeleri, çeviriler, testler ve dokümantasyon memnuniyetle karşılanır.
Önce [CONTRIBUTING.md](CONTRIBUTING.md)'yi ve [CLA.md](CLA.md)'yi oku; büyük değişiklikler için önce bir issue aç.
PR öncesi `npm run check` temiz olmalı ve PR şablonundaki **CLA kutusu** işaretlenmelidir.

## Telif

© 2026 gkaragoz and Contributors. Tüm hakları saklıdır; kullanım koşulları [LICENSE](LICENSE) dosyasındadır.
"the reference game" ilgili hak sahiplerinin ticari markasıdır; bu proje onlarla bağlantılı veya onaylı değildir.
